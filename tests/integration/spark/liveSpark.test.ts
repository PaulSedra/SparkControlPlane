/**
 * @fileoverview Optional live Spark Connect integration scenarios.
 */

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import { Pool } from 'pg';
import { delay, fetchJson, pollUntil } from '../../support/httpTestSupport.ts';
import { createSparkCatalogService } from '../../../src/server/catalog/sparkCatalogService.ts';
import {
    getManagedTestContext,
    requireManagedTestContext,
} from '../../support/managedTestContext.mjs';
import { postgresPoolConfig } from '../../support/postgresTestSupport.ts';
import { loadPostgresConfig } from '../../../src/server/config/postgresConfig.ts';

const acceptanceEnabled = getManagedTestContext()?.controlPlaneBaseUrl != null &&
    process.env.PIPELINES_DIR?.trim() !== '' &&
    process.env.SPARK_CONNECT_URL?.trim() !== '' &&
    hasDirectPostgresConfiguration();

const sparkConnectUrl = process.env.SPARK_CONNECT_URL?.trim();
const sparkCatalogEnabled = sparkConnectUrl != null && sparkConnectUrl !== '';
const sparkBackendEnabled = getManagedTestContext()?.controlPlaneBaseUrl != null &&
    process.env.CATALOG_BACKEND?.trim() === 'spark';
const defaultCatalogAcceptanceEnabled = acceptanceEnabled &&
    getManagedTestContext()?.demoPipelineName != null && sparkBackendEnabled;

async function refreshAllPipelines(baseUrl: string): Promise<void> {
    await fetchJson(`${baseUrl}/api/v1/pipelines/refresh-from-source`, 200, {
        method: 'POST',
    });
}

test('live Spark Connect catalog adapter returns listed catalogs', {
    skip: !sparkCatalogEnabled,
}, async () => {
    const service = createSparkCatalogService({
        sparkConnectUrl,
    });
    const catalogs = await service.listCatalogs();

    assert.ok(Array.isArray(catalogs));
    assert.ok(catalogs.every((catalog) => typeof catalog.name === 'string'));
});

test('Spark catalog backend exposes the built-in catalog through the app API', {
    skip: !sparkBackendEnabled,
}, async () => {
    const context = requireManagedTestContext('Spark catalog backend integration test');
    const baseUrl = context.controlPlaneBaseUrl.replace(/\/$/, '');
    const response = await fetchJson<{ catalogs: Array<{ name: string }> }>(
        `${baseUrl}/api/v1/catalogs`,
        200,
    );

    assert.ok(
        response.catalogs.some((catalog) => catalog.name === 'spark_catalog'),
        'Spark catalog backend should expose the built-in spark_catalog.',
    );
});

test('live Spark acceptance uses the container API and observes the run lifecycle', {
    skip: !acceptanceEnabled,
}, async () => {
    const context = requireManagedTestContext('Live Spark integration tests');
    const baseUrl = context.controlPlaneBaseUrl.replace(/\/$/, '');
    const pipelineName = context.pipelineName;
    const config = loadPostgresConfig();
    const cleanupPool = new Pool(postgresPoolConfig(config));
    const runIds: string[] = [];
    const correlations: string[] = [];

    try {
        await refreshAllPipelines(baseUrl);
        const list = await fetchJson<{ pipelines: unknown[] }>(`${baseUrl}/api/v1/pipelines`, 200);
        const pipelines = asArray<{ id: string; name: string }>(list.pipelines);
        const pipeline = pipelines.find((item) => item.name === pipelineName);
        assert.ok(pipeline, `Mounted pipeline was not discovered: ${pipelineName}`);

        const detail = await fetchJson<{
            nodes?: Array<{ id: string; nodeType: string }>;
            spec?: { storage?: string };
        }>(`${baseUrl}/api/v1/pipelines/${encodeURIComponent(pipeline.id)}`, 200);
        assert.ok(detail.spec?.storage, 'Pipeline storage must be present in the API detail.');
        assert.ok(Array.isArray(detail.nodes) && detail.nodes.length > 0, 'Pipeline must expose nodes.');

        const deployCorrelation = `spark-acceptance-${crypto.randomUUID()}`;
        correlations.push(deployCorrelation);
        await fetchJson(
            `${baseUrl}/api/v1/pipelines/${encodeURIComponent(pipeline.id)}/deploy`,
            200,
            {
                headers: {
                    'X-Correlation-ID': deployCorrelation,
                    'X-Request-Source': 'spark-acceptance-suite',
                },
                method: 'POST',
            },
        );

        const idempotencyKey = `spark-acceptance-${crypto.randomUUID()}`;
        const runCorrelation = `spark-acceptance-${crypto.randomUUID()}`;
        correlations.push(runCorrelation);
        const submitted = await fetchJson<{ runId: string; status: string }>(
            `${baseUrl}/api/v1/pipelines/${encodeURIComponent(pipeline.id)}/runs`,
            202,
            {
                body: JSON.stringify({
                    mode: 'incremental',
                    requestSource: 'spark-acceptance-suite',
                }),
                headers: {
                    'Content-Type': 'application/json',
                    'Idempotency-Key': idempotencyKey,
                    'X-Correlation-ID': runCorrelation,
                    'X-Request-Source': 'spark-acceptance-suite',
                },
                method: 'POST',
            },
        );
        assert.ok(submitted.runId);
        runIds.push(submitted.runId);
        assert.equal(submitted.status, 'QUEUED');

        const replay = await fetchJson<{ runId: string }>(
            `${baseUrl}/api/v1/pipelines/${encodeURIComponent(pipeline.id)}/runs`,
            202,
            {
                body: JSON.stringify({ mode: 'incremental' }),
                headers: {
                    'Content-Type': 'application/json',
                    'Idempotency-Key': idempotencyKey,
                    'X-Correlation-ID': runCorrelation,
                    'X-Request-Source': 'spark-acceptance-suite',
                },
                method: 'POST',
            },
        );
        assert.equal(replay.runId, submitted.runId);

        const observedStatuses: string[] = [];
        recordStatus(observedStatuses, submitted.status);
        const deadline = Date.now() + timeoutMilliseconds();
        let terminal: Record<string, unknown> | undefined;
        while (Date.now() < deadline) {
            const run = await fetchJson<{ status: string }>(
                `${baseUrl}/api/v1/runs/${encodeURIComponent(submitted.runId)}`,
                200,
            );
            recordStatus(observedStatuses, run.status);

            const eventResponse = await fetchJson<{ items: unknown[] }>(
                `${baseUrl}/api/v1/runs/${encodeURIComponent(submitted.runId)}/events?limit=100`,
                200,
            );
            for (const event of asArray<{ status?: string }>(eventResponse.items)) {
                if (event.status != null) {
                    recordStatus(observedStatuses, event.status);
                }
            }

            if (isTerminal(run.status)) {
                terminal = run;
                break;
            }
            await delay(100);
        }

        assert.ok(terminal, 'Container API run did not reach a terminal state.');
        assert.equal(terminal.status, 'SUCCEEDED');
        assertOrderedStatuses(observedStatuses, ['QUEUED', 'SUBMITTING', 'RUNNING', 'SUCCEEDED']);

        const expectedNodeName = context.expectedNodeName;
        const node = detail.nodes?.find((item) =>
            item.nodeType !== 'EXTERNAL_DATASET' &&
            (expectedNodeName == null || item.id === expectedNodeName ||
                (item as { name?: string }).name === expectedNodeName ||
                (item as { qualifiedName?: string }).qualifiedName === expectedNodeName),
        );
        assert.ok(node, 'A non-external output node is required for live data verification.');
        const dataResponse = await fetchJson<Record<string, unknown>>(
            `${baseUrl}/api/v1/pipelines/${encodeURIComponent(pipeline.id)}` +
                `/nodes/${encodeURIComponent(node.id)}/data`,
            200,
        );
        assert.ok(Array.isArray(dataResponse.columns));
        assert.ok(Array.isArray(dataResponse.rows));

        const cancelCorrelation = `spark-acceptance-${crypto.randomUUID()}`;
        correlations.push(cancelCorrelation);
        const cancelSubmission = await fetchJson<{ runId: string }>(
            `${baseUrl}/api/v1/pipelines/${encodeURIComponent(pipeline.id)}/runs`,
            202,
            {
                body: JSON.stringify({ mode: 'incremental' }),
                headers: {
                    'Content-Type': 'application/json',
                    'Idempotency-Key': `spark-acceptance-${crypto.randomUUID()}`,
                    'X-Correlation-ID': cancelCorrelation,
                    'X-Request-Source': 'spark-acceptance-suite',
                },
                method: 'POST',
            },
        );
        const cancelRunId = cancelSubmission.runId;
        runIds.push(cancelRunId);
        await fetchJson(
            `${baseUrl}/api/v1/runs/${encodeURIComponent(cancelRunId)}/cancel`,
            200,
            {
                body: JSON.stringify({ reason: 'Acceptance cancellation.' }),
                headers: {
                    'Content-Type': 'application/json',
                    'X-Correlation-ID': cancelCorrelation,
                    'X-Request-Source': 'spark-acceptance-suite',
                },
                method: 'POST',
            },
        );
        const canceled = await pollUntil(
            async () => {
                return fetchJson<{ status: string }>(
                    `${baseUrl}/api/v1/runs/${encodeURIComponent(cancelRunId)}`,
                    200,
                );
            },
            (run) => isTerminal(run.status),
            timeoutMilliseconds(),
            100,
            'Acceptance cancellation did not reach a terminal state.',
        );
        assert.equal(canceled.status, 'CANCELED');
    } finally {
        if (runIds.length > 0) {
            await cleanupPool.query(
                'DELETE FROM audit_events WHERE run_id = ANY($1::uuid[])',
                [runIds],
            );
            await cleanupPool.query(
                'DELETE FROM audit_events WHERE correlation_id = ANY($1::text[])',
                [correlations],
            );
            await cleanupPool.query(
                'DELETE FROM runs WHERE run_id = ANY($1::uuid[])',
                [runIds],
            );
        }
        await cleanupPool.end();
    }
});

test('live Spark runs a demo pipeline in spark_catalog.default', {
    skip: !defaultCatalogAcceptanceEnabled,
}, async () => {
    const context = requireManagedTestContext('Default catalog pipeline integration test');
    const baseUrl = context.controlPlaneBaseUrl.replace(/\/$/, '');
    const config = loadPostgresConfig();
    const cleanupPool = new Pool(postgresPoolConfig(config));
    const runIds: string[] = [];
    const correlations: string[] = [];

    try {
        await refreshAllPipelines(baseUrl);
        const list = await fetchJson<{ pipelines: unknown[] }>(`${baseUrl}/api/v1/pipelines`, 200);
        const pipelines = asArray<{ id: string; name: string }>(list.pipelines);
        const pipeline = pipelines.find((item) => item.name === context.demoPipelineName);
        assert.ok(pipeline, `Default catalog demo pipeline was not discovered: ${context.demoPipelineName}`);

        const detail = await fetchJson<{
            nodes?: Array<{ id: string; nodeType: string; name?: string; qualifiedName?: string }>;
            spec?: { catalog?: string; database?: string };
        }>(`${baseUrl}/api/v1/pipelines/${encodeURIComponent(pipeline.id)}`, 200);
        assert.equal(detail.spec?.catalog, 'spark_catalog');
        assert.equal(detail.spec?.database, 'default');
        const outputNode = detail.nodes?.find((node) =>
            node.nodeType !== 'EXTERNAL_DATASET' &&
            (node.id === context.expectedDemoNodeName ||
                node.name === context.expectedDemoNodeName ||
                node.qualifiedName === context.expectedDemoNodeName),
        );
        assert.ok(outputNode, 'The demo pipeline must expose its spark_catalog output node.');

        const deployCorrelation = `spark-default-catalog-${crypto.randomUUID()}`;
        correlations.push(deployCorrelation);
        await fetchJson(
            `${baseUrl}/api/v1/pipelines/${encodeURIComponent(pipeline.id)}/deploy`,
            200,
            {
                headers: {
                    'X-Correlation-ID': deployCorrelation,
                    'X-Request-Source': 'spark-default-catalog-suite',
                },
                method: 'POST',
            },
        );

        const runCorrelation = `spark-default-catalog-${crypto.randomUUID()}`;
        correlations.push(runCorrelation);
        const submitted = await fetchJson<{ runId: string; status: string }>(
            `${baseUrl}/api/v1/pipelines/${encodeURIComponent(pipeline.id)}/runs`,
            202,
            {
                body: JSON.stringify({ mode: 'incremental' }),
                headers: {
                    'Content-Type': 'application/json',
                    'Idempotency-Key': `spark-default-catalog-${crypto.randomUUID()}`,
                    'X-Correlation-ID': runCorrelation,
                    'X-Request-Source': 'spark-default-catalog-suite',
                },
                method: 'POST',
            },
        );
        runIds.push(submitted.runId);

        const terminal = await pollUntil(
            async () => fetchJson<{ status: string }>(
                `${baseUrl}/api/v1/runs/${encodeURIComponent(submitted.runId)}`,
                200,
            ),
            (run) => isTerminal(run.status),
            timeoutMilliseconds(),
            100,
            'Default catalog demo pipeline did not reach a terminal state.',
        );
        assert.equal(terminal.status, 'SUCCEEDED');

        const data = await fetchJson<{ rows: unknown[] }>(
            `${baseUrl}/api/v1/pipelines/${encodeURIComponent(pipeline.id)}` +
                `/nodes/${encodeURIComponent(outputNode.id)}/data`,
            200,
        );
        assert.ok(data.rows.length >= 2, 'Spark should return the sample rows from the demo output.');
    } finally {
        if (runIds.length > 0) {
            await cleanupPool.query(
                'DELETE FROM audit_events WHERE run_id = ANY($1::uuid[])',
                [runIds],
            );
        }
        if (correlations.length > 0) {
            await cleanupPool.query(
                'DELETE FROM audit_events WHERE correlation_id = ANY($1::text[])',
                [correlations],
            );
        }
        if (runIds.length > 0) {
            await cleanupPool.query(
                'DELETE FROM runs WHERE run_id = ANY($1::uuid[])',
                [runIds],
            );
        }
        await cleanupPool.end();
    }
});

function asArray<T>(value: unknown): T[] {
    return Array.isArray(value) ? value as T[] : [];
}

function assertOrderedStatuses(observed: string[], expected: string[]): void {
    let nextIndex = 0;
    for (const status of observed) {
        if (status === expected[nextIndex]) {
            nextIndex += 1;
        }
        if (nextIndex === expected.length) {
            return;
        }
    }
    assert.fail(`Run lifecycle order was ${observed.join(', ')}; expected ${expected.join(' -> ')}.`);
}

function recordStatus(observed: string[], status: string): void {
    if (observed.at(-1) !== status) {
        observed.push(status);
    }
}

function hasDirectPostgresConfiguration(): boolean {
    try {
        loadPostgresConfig();
        return true;
    } catch {
        return false;
    }
}

function isTerminal(status: string): boolean {
    return ['SUCCEEDED', 'FAILED', 'CANCELED', 'TIMED_OUT', 'UNKNOWN'].includes(status);
}

function timeoutMilliseconds(): number {
    const seconds = Number.parseInt(String(getManagedTestContext()?.timeoutSeconds ?? 1800), 10);
    return Math.max(1, Number.isFinite(seconds) ? seconds : 1800) * 1000;
}
