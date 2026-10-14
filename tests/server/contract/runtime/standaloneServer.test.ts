/**
 * @fileoverview Contract checks for the standalone HTTP server.
 */

import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import test from 'node:test';
import {
    assertMethodNotAllowed,
    fetchJson,
} from '../../../support/httpTestSupport.ts';
import { createInMemoryPersistence } from '../../../support/inMemoryPersistence.ts';
import { createPipelineFixture } from '../../../support/pipelineFixture.ts';
import { captureEnvironment } from '../../../support/testEnvironment.ts';
import { loadProductionConfig } from '../../../../src/server/config/productionConfig.ts';
import { createPipelineRegistryService } from '../../../../src/server/pipeline/pipelineRegistryService.ts';
import { createStandaloneControlPlane } from '../../../../src/server/runtime/standaloneServer.ts';
import type { CatalogService } from '../../../../src/server/types/catalogServiceTypes.ts';

test('production configuration validates required values', () => {
    assert.throws(
        () => loadProductionConfig({}),
        /PIPELINES_DIR is required/,
    );
    assert.throws(
        () => loadProductionConfig({ PIPELINES_DIR: './pipelines' }),
        /SPARK_CONNECT_URL is required/,
    );
    assert.throws(
        () => loadProductionConfig({
            PIPELINES_DIR: './pipelines',
            SPARK_CONNECT_REMOTE: 'sc://legacy-spark:15002',
            SPARK_REMOTE: 'sc://older-spark:15002',
        }),
        /SPARK_CONNECT_URL is required/,
    );
    assert.throws(
        () => loadProductionConfig({
            CONTROL_PLANE_PORT: '70000',
            PIPELINES_DIR: './pipelines',
            SPARK_CONNECT_URL: 'sc://spark:15002',
        }),
        /CONTROL_PLANE_PORT must be between 1 and 65535/,
    );
    assert.throws(
        () => loadProductionConfig({
            PIPELINES_DIR: './pipelines',
            SPARK_CONNECT_URL: 'sc://spark:15002',
        }),
        /AISTOR_WEBHOOK_TOKEN is required/,
    );
});

test('standalone server serves the built UI, health, readiness, and versioned API', async () => {
    const originalCwd = process.cwd();
    const restore = captureEnvironment('PIPELINES_DIR');
    const repositoryRoot = path.resolve(import.meta.dirname, '../../../..');
    let pipelineListCalls = 0;
    let ownedServiceShutdowns = 0;
    let ownedCatalogShutdowns = 0;
    const fixture = await createPipelineFixture({
        files: [{
            content: 'CREATE MATERIALIZED VIEW example AS SELECT 1 AS value;\n',
            relativePath: 'sql/example.sql',
        }],
        name: 'Standalone Control Plane Test',
        pipelinePath: 'test-pipeline',
        prefix: 'spark-control-plane-standalone-test-',
        specFilename: 'standalone.pipeline.yaml',
    });

    process.chdir(fixture.root);
    process.env.PIPELINES_DIR = path.join(fixture.root, 'pipelines');
    const controlPlane = createStandaloneControlPlane({
        config: {
            aistorWebhookToken: 'test-aistor-token',
            drainMilliseconds: 100,
            host: '127.0.0.1',
            port: 0,
            sparkConnectUrl: 'sc://spark-connect:15002',
            staticDirectory: path.join(repositoryRoot, 'dist'),
        },
        serviceFactory: () => {
            const service = createPipelineRegistryService({
                persistence: createInMemoryPersistence(),
                sparkConnectUrl: undefined,
            });
            const listPipelines = service.listPipelines;
            service.listPipelines = async () => {
                pipelineListCalls += 1;
                return listPipelines();
            };
            const shutdown = service.shutdown;
            service.shutdown = async (drainMilliseconds) => {
                ownedServiceShutdowns += 1;
                await shutdown(drainMilliseconds);
            };
            return service;
        },
        catalogServiceFactory: () => createTestCatalogService(() => {
            ownedCatalogShutdowns += 1;
        }),
    });

    try {
        await controlPlane.start();
        const address = controlPlane.server.address() as AddressInfo;
        const baseUrl = `http://127.0.0.1:${address.port}`;

        assert.deepEqual(await fetchJson(`${baseUrl}/health`, 200), { status: 'ok' });

        const swaggerResponse = await fetch(`${baseUrl}/docs`);
        assert.equal(swaggerResponse.status, 200);
        assert.match(
            swaggerResponse.headers.get('content-type') ?? '',
            /^text\/html/,
        );
        const swaggerBody = await swaggerResponse.text();
        assert.match(swaggerBody, /SwaggerUIBundle/);
        assert.match(swaggerBody, /\/openapi\.json/);

        const openApiResponse = await fetch(`${baseUrl}/openapi.json`);
        assert.equal(openApiResponse.status, 200);
        assert.match(
            openApiResponse.headers.get('content-type') ?? '',
            /^application\/json/,
        );
        const openApiDocument = await openApiResponse.json() as {
            openapi?: string;
            paths?: Record<string, unknown>;
        };
        assert.equal(openApiDocument.openapi, '3.1.0');
        assert.ok(openApiDocument.paths?.['/api/v1/pipelines']);

        const removedRouteResponse = await fetch(`${baseUrl}/api/pipelines`);
        assert.equal(removedRouteResponse.status, 404);

        const metricsResponse = await fetch(`${baseUrl}/metrics`);
        assert.equal(metricsResponse.status, 200);
        assert.match(
            metricsResponse.headers.get('content-type') ?? '',
            /^text\/plain/,
        );
        const metricsBody = await metricsResponse.text();
        assert.ok(metricsBody.trim() === '' || metricsBody.includes('# TYPE'));

        const readyBody = await fetchJson<{ checks: { persistence: string; worker: string }; status: string }>(`${baseUrl}/ready`, 200);
        assert.equal((await fetch(`${baseUrl}/ready`)).status, 200);
        assert.equal(pipelineListCalls, 0);
        assert.equal(readyBody.status, 'ready');
        assert.equal(readyBody.checks.persistence, 'memory');
        assert.equal(readyBody.checks.worker, 'ready');

        const refreshBody = await fetchJson<{
            pipelines: Array<{ id: string }>;
            total: number;
        }>(`${baseUrl}/api/v1/pipelines/refresh-from-source`, 200, {
            method: 'POST',
        });
        assert.equal(refreshBody.total, 1);

        const uiResponse = await fetch(`${baseUrl}/pipelines/not-a-real-id`, {
            headers: { accept: 'text/html' },
        });
        assert.equal(uiResponse.status, 200);
        assert.match(
            uiResponse.headers.get('content-type') ?? '',
            /^text\/html/,
        );
        assert.match(await uiResponse.text(), /<div id="root"><\/div>/);

        const listResponse = await fetch(`${baseUrl}/api/v1/pipelines`, {
            headers: { 'X-Correlation-ID': 'contract-list-correlation' },
        });
        assert.equal(listResponse.status, 200);
        assert.equal(listResponse.headers.get('x-correlation-id'), 'contract-list-correlation');
        const listBody = await listResponse.json() as {
            items: Array<{ id: string; name: string }>;
            offset: number;
            pipelines: Array<{ id: string; name: string }>;
            total: number;
        };
        assert.equal(listBody.pipelines.length, 1);
        assert.deepEqual(listBody.items, listBody.pipelines);
        assert.equal(listBody.offset, 0);
        assert.equal(listBody.total, 1);
        assert.equal(
            listBody.pipelines[0]?.name,
            'Standalone Control Plane Test',
        );
        const pipelineId = listBody.pipelines[0]?.id;
        assert.ok(pipelineId);

        const detailResponse = await fetch(
            `${baseUrl}/api/v1/pipelines/${encodeURIComponent(pipelineId)}`,
        );
        assert.equal(detailResponse.status, 200);

        const structuralDetailResponse = await fetch(
            `${baseUrl}/api/v1/pipelines/${encodeURIComponent(pipelineId)}?includeRuns=false`,
        );
        assert.equal(structuralDetailResponse.status, 200);
        assert.match(
            structuralDetailResponse.headers.get('cache-control') ?? '',
            /max-age=5/,
        );
        const structuralDetail = await structuralDetailResponse.json() as {
            nodes: unknown[];
            runs: unknown[];
        };
        assert.ok(structuralDetail.nodes.length > 0);
        assert.deepEqual(structuralDetail.runs, []);

        assert.deepEqual(await fetchJson(
            `${baseUrl}/api/v1/pipelines/${encodeURIComponent(pipelineId)}/source?file=${encodeURIComponent('sql/example.sql')}`,
            200,
        ), {
            content: 'CREATE MATERIALIZED VIEW example AS SELECT 1 AS value;\n',
            language: 'sql',
            path: 'sql/example.sql',
        });

        assert.deepEqual(await fetchJson(
            `${baseUrl}/api/v1/pipelines/${encodeURIComponent(pipelineId)}/runs`,
            409,
            {
                body: '{}',
                headers: { 'Content-Type': 'application/json' },
                method: 'POST',
            },
        ), {
            code: 'CONFLICT',
            message: 'Deploy this pipeline before running it.',
        });

        const deployResponse = await fetch(
            `${baseUrl}/api/v1/pipelines/${encodeURIComponent(pipelineId)}/deploy`,
            { method: 'POST' },
        );
        assert.equal(deployResponse.status, 200);

        const submitResponse = await fetch(
            `${baseUrl}/api/v1/pipelines/${encodeURIComponent(pipelineId)}/runs`,
            {
                body: JSON.stringify({
                    callerMetadata: {
                        password: 'contract-test-secret',
                        ticket: 'contract-123',
                    },
                    mode: 'incremental',
                }),
                headers: {
                    'Content-Type': 'application/json',
                    'Idempotency-Key': 'standalone-test-1',
                    'X-Correlation-ID': 'contract-run-correlation',
                    'X-Request-Source': 'contract-test',
                },
                method: 'POST',
            },
        );
        assert.equal(submitResponse.status, 202);
        assert.equal(submitResponse.headers.get('x-correlation-id'), 'contract-run-correlation');
        assert.match(
            submitResponse.headers.get('location') ?? '',
            /^\/api\/v1\/runs\//,
        );
        const run = await submitResponse.json() as {
            callerMetadata?: Record<string, string>;
            correlationId?: string;
            requestSource?: string;
            runId: string;
        };
        assert.equal(run.correlationId, 'contract-run-correlation');
        assert.equal(run.requestSource, 'contract-test');
        assert.deepEqual(run.callerMetadata, {
            password: '[REDACTED]',
            ticket: 'contract-123',
        });
        const runResponse = await fetch(
            `${baseUrl}/api/v1/runs/${encodeURIComponent(run.runId)}`,
        );
        assert.equal(runResponse.status, 200);

        const runStatus = await fetchJson<{
            runId: string;
            stdout?: string;
            stderr?: string;
        }>(
            `${baseUrl}/api/v1/runs/${encodeURIComponent(run.runId)}/status`,
            200,
        );
        assert.equal(runStatus.runId, run.runId);
        assert.equal(runStatus.stdout, undefined);
        assert.equal(runStatus.stderr, undefined);

        const runsBody = await fetchJson<{
            items: Array<{ runId: string }>;
            offset: number;
            total: number;
        }>(
            `${baseUrl}/api/v1/pipelines/${encodeURIComponent(pipelineId)}/runs?limit=1&offset=0`,
            200,
        );
        assert.equal(runsBody.items[0]?.runId, run.runId);
        assert.equal(runsBody.offset, 0);
        assert.equal(runsBody.total, 1);

        const eventsBody = await fetchJson<{
            items: Array<{ correlationId?: string; eventType: string }>;
            total: number;
        }>(
            `${baseUrl}/api/v1/runs/${encodeURIComponent(run.runId)}/events?limit=100`,
            200,
        );
        assert.ok(eventsBody.total >= 1);
        assert.equal(eventsBody.items[0]?.correlationId, 'contract-run-correlation');

        assert.deepEqual(await fetchJson(
            `${baseUrl}/api/v1/pipelines/${encodeURIComponent(pipelineId)}/nodes/missing-node/data`,
            500,
        ), {
            code: 'INTERNAL_ERROR',
            message: 'No Spark Connect target is configured for data samples.',
        });

        assert.deepEqual(await fetchJson(
            `${baseUrl}/api/v1/pipelines/${encodeURIComponent(pipelineId)}/runs`,
            400,
            {
                body: JSON.stringify({ idempotencyKey: 'body-key' }),
                headers: {
                    'Content-Type': 'application/json',
                    'Idempotency-Key': 'header-key',
                },
                method: 'POST',
            },
        ), {
            code: 'INVALID_REQUEST',
            message: 'The body idempotencyKey and Idempotency-Key header must match.',
        });

        assert.deepEqual(await fetchJson(
            `${baseUrl}/api/v1/pipelines/${encodeURIComponent(pipelineId)}/runs`,
            400,
            {
                body: '{',
                headers: { 'Content-Type': 'application/json' },
                method: 'POST',
            },
        ), {
            code: 'INVALID_REQUEST',
            message: 'Request body must be valid JSON.',
        });

        assert.deepEqual(await fetchJson(
            `${baseUrl}/api/v1/pipelines/${encodeURIComponent(pipelineId)}/runs`,
            413,
            {
                body: 'x'.repeat(1024 * 1024 + 1),
                headers: { 'Content-Type': 'application/json' },
                method: 'POST',
            },
        ), {
            code: 'PAYLOAD_TOO_LARGE',
            message: 'Request body exceeds 1 MiB.',
        });

        assert.deepEqual(await fetchJson(
            `${baseUrl}/api/v1/pipelines?limit=not-a-number`,
            400,
        ), {
            code: 'INVALID_REQUEST',
            message: 'limit must be a non-negative integer.',
        });

        await assertMethodNotAllowed(`${baseUrl}/api/v1/pipelines`, 'POST', 'GET');

        const cancellationState = await fetchJson<{ status: string }>(
            `${baseUrl}/api/v1/runs/${encodeURIComponent(run.runId)}/cancel`,
            200,
            {
                body: JSON.stringify({ reason: 'standalone test cancellation' }),
                headers: { 'Content-Type': 'application/json' },
                method: 'POST',
            },
        );
        assert.ok(['CANCELED', 'FAILED', 'SUBMITTING', 'RUNNING'].includes(cancellationState.status));
        for (let attempt = 0; attempt < 50 &&
            !['CANCELED', 'FAILED', 'TIMED_OUT', 'UNKNOWN'].includes(cancellationState.status); attempt += 1) {
            const terminalRun = await fetchJson<{ status: string }>(
                `${baseUrl}/api/v1/runs/${encodeURIComponent(run.runId)}`,
                200,
            );
            cancellationState.status = terminalRun.status;
            if (['CANCELED', 'FAILED', 'TIMED_OUT', 'UNKNOWN'].includes(terminalRun.status)) {
                break;
            }
            await new Promise((resolve) => setTimeout(resolve, 20));
        }
        assert.ok(['CANCELED', 'FAILED', 'TIMED_OUT', 'UNKNOWN'].includes(cancellationState.status));

        assert.deepEqual(await fetchJson(
            `${baseUrl}/api/v1/runs/missing-run/cancel`,
            404,
            { method: 'POST' },
        ), {
            code: 'NOT_FOUND',
            message: 'Unknown pipeline run: missing-run',
        });

        assert.deepEqual(await fetchJson(
            `${baseUrl}/api/v1/unknown`,
            404,
        ), {
            code: 'NOT_FOUND',
            message: 'API route not found.',
        });
    } finally {
        await controlPlane.close();
        await controlPlane.close();
        assert.equal(ownedServiceShutdowns, 1);
        assert.equal(ownedCatalogShutdowns, 1);
        process.chdir(originalCwd);
        restore();
        await fixture.cleanup();
    }
});

test('standalone server leaves injected service lifecycle with its caller', async () => {
    const originalCwd = process.cwd();
    const restore = captureEnvironment('PIPELINES_DIR');
    const repositoryRoot = path.resolve(import.meta.dirname, '../../../..');
    const fixture = await createPipelineFixture({
        files: [{
            content: 'CREATE MATERIALIZED VIEW example AS SELECT 1 AS value;\n',
            relativePath: 'sql/example.sql',
        }],
        name: 'Injected Service Lifecycle Test',
        pipelinePath: 'test-pipeline',
        prefix: 'spark-control-plane-injected-service-test-',
        specFilename: 'injected.pipeline.yaml',
    });
    process.chdir(fixture.root);
    process.env.PIPELINES_DIR = path.join(fixture.root, 'pipelines');

    let initializeCalls = 0;
    let serviceShutdowns = 0;
    let catalogShutdowns = 0;
    const service = createPipelineRegistryService({
        persistence: createInMemoryPersistence(),
        sparkConnectUrl: undefined,
    });
    const initialize = service.initialize;
    service.initialize = async () => {
        initializeCalls += 1;
        await initialize();
    };
    const shutdown = service.shutdown;
    service.shutdown = async (drainMilliseconds) => {
        serviceShutdowns += 1;
        await shutdown(drainMilliseconds);
    };
    const catalogService = createTestCatalogService(() => {
        catalogShutdowns += 1;
    });
    const controlPlane = createStandaloneControlPlane({
        catalogService,
        config: {
            aistorWebhookToken: 'test-aistor-token',
            drainMilliseconds: 100,
            host: '127.0.0.1',
            port: 0,
            sparkConnectUrl: 'sc://spark-connect:15002',
            staticDirectory: path.join(repositoryRoot, 'dist'),
        },
        service,
    });

    try {
        await service.initialize();
        await controlPlane.start();
        const address = controlPlane.server.address() as AddressInfo;
        assert.equal((await fetch(`http://127.0.0.1:${address.port}/health`)).status, 200);
        assert.equal(initializeCalls, 1);
        await controlPlane.close();
        assert.equal(serviceShutdowns, 0);
        assert.equal(catalogShutdowns, 0);
    } finally {
        await controlPlane.close();
        await service.shutdown(100);
        await catalogService.shutdown?.();
        process.chdir(originalCwd);
        restore();
        await fixture.cleanup();
    }
    assert.equal(serviceShutdowns, 1);
    assert.equal(catalogShutdowns, 1);
});

test('listen failure removes startup listeners and shuts down owned services', async () => {
    const originalCwd = process.cwd();
    const restore = captureEnvironment('PIPELINES_DIR');
    const repositoryRoot = path.resolve(import.meta.dirname, '../../../..');
    const fixture = await createPipelineFixture({
        files: [{
            content: 'CREATE MATERIALIZED VIEW example AS SELECT 1 AS value;\n',
            relativePath: 'sql/example.sql',
        }],
        name: 'Standalone Listen Failure Test',
        pipelinePath: 'test-pipeline',
        prefix: 'spark-control-plane-listen-failure-test-',
        specFilename: 'listen-failure.pipeline.yaml',
    });
    process.chdir(fixture.root);
    process.env.PIPELINES_DIR = path.join(fixture.root, 'pipelines');

    const occupiedServer = createServer();
    await new Promise<void>((resolve, reject) => {
        occupiedServer.once('error', reject);
        occupiedServer.listen(0, '127.0.0.1', resolve);
    });
    const occupiedAddress = occupiedServer.address() as AddressInfo;
    let serviceShutdowns = 0;
    let catalogShutdowns = 0;
    const controlPlane = createStandaloneControlPlane({
        catalogServiceFactory: () => createTestCatalogService(() => {
            catalogShutdowns += 1;
        }),
        config: {
            aistorWebhookToken: 'test-aistor-token',
            drainMilliseconds: 100,
            host: '127.0.0.1',
            port: occupiedAddress.port,
            sparkConnectUrl: 'sc://spark-connect:15002',
            staticDirectory: path.join(repositoryRoot, 'dist'),
        },
        serviceFactory: () => {
            const service = createPipelineRegistryService({
                persistence: createInMemoryPersistence(),
                sparkConnectUrl: undefined,
            });
            const shutdown = service.shutdown;
            service.shutdown = async (drainMilliseconds) => {
                serviceShutdowns += 1;
                await shutdown(drainMilliseconds);
            };
            return service;
        },
    });
    const initialErrorListeners = controlPlane.server.listenerCount('error');
    const initialListeningListeners = controlPlane.server.listenerCount('listening');

    try {
        await assert.rejects(controlPlane.start(), /EADDRINUSE/);
        assert.equal(controlPlane.server.listening, false);
        assert.equal(controlPlane.server.listenerCount('error'), initialErrorListeners);
        assert.equal(controlPlane.server.listenerCount('listening'), initialListeningListeners);
        assert.equal(serviceShutdowns, 1);
        assert.equal(catalogShutdowns, 1);
    } finally {
        await controlPlane.close();
        await new Promise<void>((resolve) => occupiedServer.close(() => resolve()));
        process.chdir(originalCwd);
        restore();
        await fixture.cleanup();
    }
});

test('shutdown attempts every owned service when one shutdown rejects', async () => {
    const originalCwd = process.cwd();
    const restore = captureEnvironment('PIPELINES_DIR');
    const repositoryRoot = path.resolve(import.meta.dirname, '../../../..');
    const fixture = await createPipelineFixture({
        files: [{
            content: 'CREATE MATERIALIZED VIEW example AS SELECT 1 AS value;\n',
            relativePath: 'sql/example.sql',
        }],
        name: 'Standalone Shutdown Failure Test',
        pipelinePath: 'test-pipeline',
        prefix: 'spark-control-plane-shutdown-failure-test-',
        specFilename: 'shutdown-failure.pipeline.yaml',
    });
    process.chdir(fixture.root);
    process.env.PIPELINES_DIR = path.join(fixture.root, 'pipelines');

    let serviceShutdowns = 0;
    let catalogShutdowns = 0;
    const controlPlane = createStandaloneControlPlane({
        catalogServiceFactory: () => createTestCatalogService(() => {
            catalogShutdowns += 1;
        }),
        config: {
            aistorWebhookToken: 'test-aistor-token',
            drainMilliseconds: 100,
            host: '127.0.0.1',
            port: 0,
            sparkConnectUrl: 'sc://spark-connect:15002',
            staticDirectory: path.join(repositoryRoot, 'dist'),
        },
        serviceFactory: () => {
            const service = createPipelineRegistryService({
                persistence: createInMemoryPersistence(),
                sparkConnectUrl: undefined,
            });
            const shutdown = service.shutdown;
            service.shutdown = async (drainMilliseconds) => {
                serviceShutdowns += 1;
                await shutdown(drainMilliseconds);
                throw new Error('simulated registry shutdown failure');
            };
            return service;
        },
    });

    try {
        await controlPlane.start();
        await assert.rejects(controlPlane.close(), /Standalone server shutdown failed/);
        await assert.rejects(controlPlane.close(), /Standalone server shutdown failed/);
        assert.equal(serviceShutdowns, 1);
        assert.equal(catalogShutdowns, 1);
    } finally {
        await controlPlane.close().catch(() => undefined);
        process.chdir(originalCwd);
        restore();
        await fixture.cleanup();
    }
});

function createTestCatalogService(onShutdown: () => void): CatalogService {
    return {
        async getTable() {
            throw new Error('Catalog service was not expected to be called.');
        },
        async getTableData() {
            throw new Error('Catalog service was not expected to be called.');
        },
        async listCatalogs() {
            throw new Error('Catalog service was not expected to be called.');
        },
        async listSchemas() {
            throw new Error('Catalog service was not expected to be called.');
        },
        async listTables() {
            throw new Error('Catalog service was not expected to be called.');
        },
        async shutdown() {
            onShutdown();
        },
    };
}
