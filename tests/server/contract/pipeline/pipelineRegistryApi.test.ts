/**
 * @fileoverview HTTP contract coverage for pipeline registry operations.
 */

import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import test from 'node:test';
import { createServer } from 'vite';
import {
    assertMethodNotAllowed,
    fetchJson,
    pollUntil,
    requestJson,
} from '../../../support/httpTestSupport.ts';
import { createInMemoryPersistence } from '../../../support/inMemoryPersistence.ts';
import { createPipelineFixture } from '../../../support/pipelineFixture.ts';
import { createTestDataLoader } from '../../../support/testData.ts';
import { captureEnvironment } from '../../../support/testEnvironment.ts';
import { createPipelineRegistryService } from '../../../../src/server/pipeline/pipelineRegistryService.ts';
import { pipelineRegistryApiPlugin } from '../../../../src/server/api/pipelineRegistryVitePlugin.ts';
import type { CanonicalTriggerEvent } from '../../../../src/server/types/triggerTypes.ts';

const testData = createTestDataLoader('server/contract');

interface PipelineRunResponse {
    mode?: string;
    runId: string;
    status: string;
    targetNodeNames?: string[];
    terminalEventAt?: string;
    terminalReason?: string;
}

interface PipelineRegistryFixture {
    errors: Record<string, Record<string, string>>;
    events: Record<string, CanonicalTriggerEvent>;
    patches: Record<string, Record<string, unknown>>;
    runBodies: Record<string, Record<string, unknown>>;
    triggers: Record<string, Record<string, unknown>>;
}

const testFixture = testData.loadData<PipelineRegistryFixture>('pipeline-registry.json');

test('pipeline submissions are asynchronous, queued, and idempotent', async () => {
    const originalCwd = process.cwd();
    const restore = captureEnvironment('PIPELINES_DIR');
    const fixture = await createPipelineFixture({
        files: [{
            content: 'CREATE MATERIALIZED VIEW example AS SELECT 1 AS value;\n',
            relativePath: 'sql/example.sql',
        }],
        name: 'Control Plane Test',
        pipelinePath: 'test-pipeline',
        prefix: 'spark-control-plane-api-test-',
        specFilename: 'control-plane.pipeline.yaml',
    });

    process.chdir(fixture.root);
    process.env.PIPELINES_DIR = path.join(fixture.root, 'pipelines');
    const server = await createServer({
        configFile: false,
        logLevel: 'silent',
        plugins: [pipelineRegistryApiPlugin({
            aistorWebhookToken: 'test-aistor-token',
            persistence: createInMemoryPersistence(),
        })],
        server: { host: '127.0.0.1', port: 0 },
    });

    try {
        await server.listen();
        const address = server.httpServer?.address() as AddressInfo;
        const baseUrl = `http://127.0.0.1:${address.port}`;

        const swaggerResponse = await fetch(`${baseUrl}/docs`);
        assert.equal(swaggerResponse.status, 200);
        assert.match(await swaggerResponse.text(), /SwaggerUIBundle/);

        const openApiResponse = await fetch(`${baseUrl}/openapi.json`);
        assert.equal(openApiResponse.status, 200);
        const openApiDocument = await openApiResponse.json() as {
            paths?: Record<string, unknown>;
        };
        assert.ok(openApiDocument.paths?.['/api/v1/catalogs']);

        for (const removedRoute of [
            '/api/pipelines',
            '/api/pipelines/detail',
            '/api/pipelines/deploy',
            '/api/pipelines/run',
            '/api/pipelines/data',
        ]) {
            const removedResponse = await fetch(`${baseUrl}${removedRoute}`);
            assert.equal(removedResponse.status, 404, `Route must be removed: ${removedRoute}`);
        }

        const refreshed = await fetchJson<{
            pipelines: Array<{ id: string }>;
            total: number;
        }>(`${baseUrl}/api/v1/pipelines/refresh-from-source`, 200, {
            method: 'POST',
        });
        assert.equal(refreshed.total, 1);

        const pipelinesBody = await fetchJson<{
            pipelines: Array<{ id: string }>;
        }>(`${baseUrl}/api/v1/pipelines`, 200);
        const pipelineId = pipelinesBody.pipelines[0]?.id;
        assert.ok(pipelineId);
        const pipelinePath = `/api/v1/pipelines/${encodeURIComponent(pipelineId)}`;

        const trigger = await fetchJson<{
            id: string;
            enabled: boolean;
        }>(`${baseUrl}/api/v1/triggers`, 201, {
                body: JSON.stringify({ ...testFixture.triggers.schedule, pipelineId }),
            headers: { 'Content-Type': 'application/json' },
            method: 'POST',
        });
        assert.equal(trigger.enabled, false);

        const triggerList = await fetchJson<{
            triggers: Array<{ id: string }>;
        }>(`${baseUrl}/api/v1/triggers`, 200);
        assert.ok(triggerList.triggers.some((item) => item.id === trigger.id));

        const disabledSchedule = await fetchJson<{
            nextOccurrenceAt?: string;
        }>(
            `${baseUrl}/api/v1/triggers/${encodeURIComponent(trigger.id)}/schedule`,
            200,
        );
        assert.equal(disabledSchedule.nextOccurrenceAt, undefined);

        const enableTriggerResponse = await fetch(
            `${baseUrl}/api/v1/triggers/${encodeURIComponent(trigger.id)}`,
            {
                body: JSON.stringify(testFixture.patches.enable),
                headers: { 'Content-Type': 'application/json' },
                method: 'PATCH',
            },
        );
        assert.equal(enableTriggerResponse.status, 200);
        const enabledSchedule = await fetchJson<{
            nextOccurrenceAt?: string;
        }>(
            `${baseUrl}/api/v1/triggers/${encodeURIComponent(trigger.id)}/schedule`,
            200,
        );
        assert.ok(enabledSchedule.nextOccurrenceAt);

        await fetch(
            `${baseUrl}/api/v1/triggers/${encodeURIComponent(trigger.id)}`,
            {
                body: JSON.stringify(testFixture.patches.disable),
                headers: { 'Content-Type': 'application/json' },
                method: 'PATCH',
            },
        );

        await assertMethodNotAllowed(
            `${baseUrl}/api/v1/pipelines`,
            'POST',
            'GET',
        );

        const detailBody = await fetchJson<{
            id: string;
            nodes: Array<{ id: string; qualifiedName: string }>;
            status: string;
        }>(`${baseUrl}${pipelinePath}`, 200);
        assert.equal(detailBody.id, pipelineId);
        assert.equal(detailBody.status, 'DRAFT');
        assert.equal(detailBody.nodes.length, 1);
        await assertMethodNotAllowed(
            `${baseUrl}${pipelinePath}`,
            'POST',
            'GET',
        );

        const deployResponse = await fetch(
            `${baseUrl}${pipelinePath}/deploy`,
            { method: 'POST' },
        );
        assert.equal(deployResponse.status, 200);

        const webhookResponse = await fetch(`${baseUrl}/api/v1/triggers`, {
            body: JSON.stringify({ ...testFixture.triggers.webhook, pipelineId }),
            headers: { 'Content-Type': 'application/json' },
            method: 'POST',
        });
        assert.equal(webhookResponse.status, 201);

        const canonicalEvent = testFixture.events.canonical;
        const webhookEvent = await fetchJson<{
            accepted: number;
            duplicates: number;
        }>(`${baseUrl}/api/v1/triggers/events`, 202, {
            body: JSON.stringify(canonicalEvent),
            headers: { 'Content-Type': 'application/json' },
            method: 'POST',
        });
        assert.equal(webhookEvent.accepted, 1);
        assert.equal(webhookEvent.duplicates, 0);

        const duplicateWebhook = await fetchJson<{
            duplicates: number;
        }>(`${baseUrl}/api/v1/triggers/events`, 202, {
            body: JSON.stringify(testFixture.events.canonicalDuplicate),
            headers: { 'Content-Type': 'application/json' },
            method: 'POST',
        });
        assert.equal(duplicateWebhook.duplicates, 1);

        const triggerEvents = await fetchJson<{
            events: Array<{ event: { eventId: string } }>;
        }>(`${baseUrl}/api/v1/triggers/events?limit=10`, 200);
        assert.ok(triggerEvents.events.some((item) => item.event.eventId === 'warehouse-event-1'));

        const routingDecisions = await fetchJson<{
            decisions: Array<{ outcome: string }>;
        }>(
            `${baseUrl}/api/v1/triggers/routing-decisions?eventId=warehouse-event-1`,
            200,
        );
        assert.ok(routingDecisions.decisions.some((item) => item.outcome === 'MATCHED'));

        const deliveryAttempts = await fetchJson<{
            attempts: Array<{ eventId: string }>;
        }>(`${baseUrl}/api/v1/triggers/delivery-attempts?limit=10`, 200);
        assert.ok(deliveryAttempts.attempts.some((item) => item.eventId === 'warehouse-event-1'));

        const fileTriggerResponse = await fetch(`${baseUrl}/api/v1/triggers`, {
            body: JSON.stringify({ ...testFixture.triggers.fileArrival, pipelineId }),
            headers: { 'Content-Type': 'application/json' },
            method: 'POST',
        });
        assert.equal(fileTriggerResponse.status, 201);
        const unauthorizedAistorResponse = await fetch(`${baseUrl}/api/v1/triggers/aistor/events`, {
            method: 'POST',
        });
        assert.equal(unauthorizedAistorResponse.status, 401);
        assert.equal(unauthorizedAistorResponse.headers.get('www-authenticate'), 'Bearer');
        assert.deepEqual(
            await unauthorizedAistorResponse.json(),
            testFixture.errors.unauthorizedAistor,
        );
        const aistorBody = await fetchJson<{
            accepted: number;
        }>(`${baseUrl}/api/v1/triggers/aistor/events`, 202, {
            body: JSON.stringify(testData.loadData<Record<string, unknown>>('aistor/object-created-put.json')),
            headers: {
                Authorization: 'Bearer test-aistor-token',
                'Content-Type': 'application/json',
            },
            method: 'POST',
        });
        assert.equal(aistorBody.accepted, 1);

        const failedTrigger = await fetchJson<{ id: string }>(`${baseUrl}/api/v1/triggers`, 201, {
            body: JSON.stringify(testFixture.triggers.failed),
            headers: { 'Content-Type': 'application/json' },
            method: 'POST',
        });
        const failedEvent = testFixture.events.failed;
        const failedEventBody = await fetchJson<{ failed: number }>(`${baseUrl}/api/v1/triggers/events`, 202, {
            body: JSON.stringify(failedEvent),
            headers: { 'Content-Type': 'application/json' },
            method: 'POST',
        });
        assert.equal(failedEventBody.failed, 1);

        const pendingDeadLetters = await fetchJson<{
            deadLetters: Array<{ event: typeof failedEvent; eventId: string; id: string; replayCount: number }>;
        }>(
            `${baseUrl}/api/v1/triggers/dead-letters?status=PENDING`,
            200,
        );
        const pendingDeadLetter = pendingDeadLetters.deadLetters.find((item) =>
            item.eventId === failedEvent.eventId
        );
        assert.ok(pendingDeadLetter);
        assert.deepEqual(pendingDeadLetter.event, failedEvent);
        assert.equal(pendingDeadLetter.replayCount, 0);

        const repairTriggerResponse = await fetch(
            `${baseUrl}/api/v1/triggers/${encodeURIComponent(failedTrigger.id)}`,
            {
                body: JSON.stringify({ ...testFixture.patches.repair, pipelineId }),
                headers: { 'Content-Type': 'application/json' },
                method: 'PATCH',
            },
        );
        assert.equal(repairTriggerResponse.status, 200);
        const replayDeadLetterBody = await fetchJson<{ accepted: number }>(
            `${baseUrl}/api/v1/triggers/dead-letters/${encodeURIComponent(pendingDeadLetter.id)}/replay`,
            202,
            { method: 'POST' },
        );
        assert.equal(replayDeadLetterBody.accepted, 1);
        const replayedDeadLetters = await fetchJson<{
            deadLetters: Array<{ eventId: string; replayCount: number; status: string }>;
        }>(`${baseUrl}/api/v1/triggers/dead-letters?status=REPLAYED`, 200);
        const replayedDeadLetter = replayedDeadLetters.deadLetters.find((item) =>
            item.eventId === failedEvent.eventId
        );
        assert.equal(replayedDeadLetter?.status, 'REPLAYED');
        assert.equal(replayedDeadLetter?.replayCount, 1);

        const breakTriggerResponse = await fetch(
            `${baseUrl}/api/v1/triggers/${encodeURIComponent(failedTrigger.id)}`,
            {
            body: JSON.stringify(testFixture.patches.break),
                headers: { 'Content-Type': 'application/json' },
                method: 'PATCH',
            },
        );
        assert.equal(breakTriggerResponse.status, 200);

        const failedEventTwo = testFixture.events.failedSecond;
        const failedEventTwoResponse = await fetch(`${baseUrl}/api/v1/triggers/events`, {
            body: JSON.stringify(failedEventTwo),
            headers: { 'Content-Type': 'application/json' },
            method: 'POST',
        });
        assert.equal(failedEventTwoResponse.status, 202);
        const pendingAfterReplay = await fetchJson<{
            deadLetters: Array<{ eventId: string; id: string }>;
        }>(`${baseUrl}/api/v1/triggers/dead-letters?status=PENDING`, 200);
        const secondDeadLetter = pendingAfterReplay.deadLetters.find((item) =>
            item.eventId === failedEventTwo.eventId
        );
        assert.ok(secondDeadLetter);
        const discardedDeadLetter = await fetchJson<{ status: string }>(
            `${baseUrl}/api/v1/triggers/dead-letters/${encodeURIComponent(secondDeadLetter.id)}/discard`,
            200,
            { method: 'POST' },
        );
        assert.equal(discardedDeadLetter.status, 'DISCARDED');

        const historyBody = await fetchJson<{
            auditHistory: Array<{ auditEventId: string }>;
            nextCursor: { auditEventId: number; runEventId: number };
            pipelineRunHistory: Array<{ runEventId: string }>;
        }>(`${baseUrl}/api/v1/history/export?limit=2`, 200);
        assert.ok(historyBody.pipelineRunHistory.length > 0);
        assert.ok(historyBody.nextCursor.runEventId > 0);
        await fetchJson(
            `${baseUrl}/api/v1/history/export?limit=2` +
                `&runEventId=${historyBody.nextCursor.runEventId}` +
                `&auditEventId=${historyBody.nextCursor.auditEventId}`,
            200,
        );

        const selectedNodeName = detailBody.nodes[0]?.qualifiedName;
        assert.ok(selectedNodeName);
        const selectedRefreshRun = await fetchJson<PipelineRunResponse>(
            `${baseUrl}${pipelinePath}/runs`,
            202,
            {
                body: JSON.stringify({
                    ...testFixture.runBodies.selectedRefresh,
                    nodeNames: [selectedNodeName],
                }),
                headers: { 'Content-Type': 'application/json' },
                method: 'POST',
            },
        );
        assert.equal(selectedRefreshRun.mode, 'refresh-selected');
        assert.deepEqual(selectedRefreshRun.targetNodeNames, [selectedNodeName]);

        const dryRun = await fetchJson<PipelineRunResponse>(
            `${baseUrl}${pipelinePath}/runs`,
            202,
            {
                body: JSON.stringify(testFixture.runBodies.dryRun),
                headers: { 'Content-Type': 'application/json' },
                method: 'POST',
            },
        );
        assert.equal(dryRun.mode, 'dry-run');
        await assertMethodNotAllowed(
            `${baseUrl}${pipelinePath}/deploy`,
            'GET',
            'POST',
        );

        const selectedNodeId = detailBody.nodes[0]?.id;
        assert.ok(selectedNodeId);
        assert.deepEqual(await fetchJson(
            `${baseUrl}${pipelinePath}/nodes/${encodeURIComponent(selectedNodeId)}/data`,
            500,
        ), testFixture.errors.noSparkConnect);
        await assertMethodNotAllowed(
            `${baseUrl}${pipelinePath}/nodes/${encodeURIComponent(selectedNodeId)}/data`,
            'POST',
            'GET',
        );

        const submitUrl = `${baseUrl}${pipelinePath}/runs`;
        const submitRun = (
            idempotencyKey: string,
            mode = String(testFixture.runBodies.default.mode),
        ) => fetch(
            submitUrl,
            {
                body: JSON.stringify({ mode }),
                headers: {
                    'Content-Type': 'application/json',
                    'Idempotency-Key': idempotencyKey,
                },
                method: 'POST',
            },
        );
        const firstResponse = await submitRun('arrival-event-1');
        assert.equal(firstResponse.status, 202);
        assert.equal(firstResponse.headers.get('retry-after'), '1');
        assert.match(firstResponse.headers.get('location') ?? '', /\/api\/v1\/runs\//);
        const firstRun = await firstResponse.json() as PipelineRunResponse;
        assert.ok(firstRun.runId);

        const replayResponse = await submitRun('arrival-event-1');
        assert.equal(replayResponse.status, 202);
        assert.equal(replayResponse.headers.get('idempotent-replayed'), 'true');
        const replayedRun = await replayResponse.json() as PipelineRunResponse;
        assert.equal(replayedRun.runId, firstRun.runId);

        const conflictingResponse = await submitRun('arrival-event-1', 'full-refresh-all');
        assert.equal(conflictingResponse.status, 409);
        assert.deepEqual(await conflictingResponse.json(), testFixture.errors.idempotencyConflict);

        const secondResponse = await submitRun('arrival-event-2');
        assert.equal(secondResponse.status, 202);
        const secondRun = await secondResponse.json() as PipelineRunResponse;
        assert.notEqual(secondRun.runId, firstRun.runId);

        const completedFirstRun = await waitForTerminalRun(
            baseUrl,
            firstRun.runId,
        );
        const completedSecondRun = await waitForTerminalRun(
            baseUrl,
            secondRun.runId,
        );
        assert.equal(completedFirstRun.status, 'FAILED');
        assert.equal(completedSecondRun.status, 'FAILED');
        assert.ok(completedFirstRun.terminalEventAt);
        assert.ok(completedSecondRun.terminalEventAt);

        const invalidModeResponse = await submitRun('arrival-event-invalid', 'unknown');
        assert.equal(invalidModeResponse.status, 400);
        assert.deepEqual(await invalidModeResponse.json(), testFixture.errors.invalidMode);

        const unknownRunResponse = await fetch(`${baseUrl}/api/v1/runs/missing-run`);
        assert.equal(unknownRunResponse.status, 404);
        await assertMethodNotAllowed(
            submitUrl,
            'DELETE',
            'GET, POST',
        );

        await fixture.writeFile(
            'sql/example.sql',
            'CREATE MATERIALIZED VIEW example AS SELECT 2 AS value;\n',
        );
        const unchangedDetail = await fetchJson<{
            currentVersionId?: string;
            status: string;
        }>(`${baseUrl}${pipelinePath}`, 200);
        assert.ok(unchangedDetail.currentVersionId);
        assert.equal(unchangedDetail.status, 'DEPLOYED');

        await fetchJson(`${baseUrl}/api/v1/pipelines/refresh-from-source`, 200, {
            method: 'POST',
        });
        const refreshedDetail = await fetchJson<{
            currentVersionId?: string;
            status: string;
        }>(`${baseUrl}${pipelinePath}`, 200);
        assert.equal(refreshedDetail.currentVersionId, undefined);
        assert.equal(refreshedDetail.status, 'DRAFT');

        const staleRunResponse = await submitRun('arrival-event-3');
        assert.equal(staleRunResponse.status, 409);
    } finally {
        await server.close();
        process.chdir(originalCwd);
        restore();
        await fixture.cleanup();
    }
});

test('discovers only resources pipeline specs with the canonical filename', async () => {
    const restore = captureEnvironment('PIPELINES_DIR');
    const fixture = await createPipelineFixture({
        libraryInclude: null,
        name: 'Orders Pipeline',
        pipelinePath: 'bundle',
        prefix: 'spark-control-plane-spec-discovery-',
        specFilename: 'orders.pipeline.yaml',
        storage: 's3://checkpoints/orders',
    });
    await fixture.writeFile(
        'resources/returns.pipeline.yaml',
        ['name: Returns Pipeline', 'storage: s3://checkpoints/returns', ''].join('\n'),
    );
    for (const fileName of ['root.pipeline.yaml', 'spark-pipeline.yml']) {
        await fixture.writeFile(
            fileName,
            ['name: Ignored Root Pipeline', 'storage: s3://checkpoints/ignored-root', ''].join('\n'),
        );
    }
    await fixture.writeFile(
        'resources/legacy.pipeline.yml',
        ['name: Ignored Legacy Pipeline', 'storage: s3://checkpoints/ignored-legacy', ''].join('\n'),
    );

    process.env.PIPELINES_DIR = path.join(fixture.root, 'pipelines');
    const service = createPipelineRegistryService({
        persistence: createInMemoryPersistence(),
    });
    try {
        await service.initialize();
        await service.refreshPipelinesFromSource();
        const pipelines = await service.listPipelines();

        assert.equal(pipelines.length, 2);
        assert.deepEqual(
            pipelines.map((pipeline) => pipeline.name).sort(),
            ['Orders Pipeline', 'Returns Pipeline'],
        );
        assert.ok(pipelines.every((pipeline) =>
            pipeline.specPath.includes(`${path.sep}resources${path.sep}`),
        ));
        assert.ok(pipelines.every((pipeline) => pipeline.specPath.endsWith('.pipeline.yaml')));
        assert.ok(pipelines.some((pipeline) => pipeline.specPath.endsWith('orders.pipeline.yaml')));
        assert.ok(pipelines.some((pipeline) => pipeline.specPath.endsWith('returns.pipeline.yaml')));
    } finally {
        await service.shutdown(100);
        restore();
        await fixture.cleanup();
    }
});

test('resolves source libraries from the bundle root for specs under resources', async () => {
    const restore = captureEnvironment('PIPELINES_DIR');
    const sourceContent = 'CREATE MATERIALIZED VIEW example AS SELECT 1 AS value;\n';
    const fixture = await createPipelineFixture({
        files: [{ content: sourceContent, relativePath: 'src/example.sql' }],
        libraryInclude: '../src/**',
        name: 'Bundle Layout Test',
        pipelinePath: 'examples/bundle-layout',
        prefix: 'spark-control-plane-bundle-layout-',
        specFilename: 'example.pipeline.yaml',
        storage: 's3://checkpoints/bundle-layout',
    });

    process.env.PIPELINES_DIR = path.join(fixture.root, 'pipelines');
    const service = createPipelineRegistryService({
        persistence: createInMemoryPersistence(),
    });
    try {
        await service.initialize();
        await service.refreshPipelinesFromSource();
        const pipelines = await service.listPipelines();
        assert.equal(pipelines.length, 1);
        const pipelineId = pipelines[0]?.id;
        assert.ok(pipelineId);

        const detail = await service.getPipeline(pipelineId);
        assert.deepEqual(detail.sourceFiles, [path.join('src', 'example.sql')]);
        assert.deepEqual(detail.validationMessages, []);
        assert.equal(detail.nodeCount, 1);

        const source = await service.getPipelineSourceFile(pipelineId, 'src/example.sql');
        assert.equal(source.path, 'src/example.sql');
        assert.equal(source.content, sourceContent);
    } finally {
        await service.shutdown(100);
        restore();
        await fixture.cleanup();
    }
});

test('keeps SQL flow nodes distinct from their streaming-table targets', async () => {
    const restore = captureEnvironment('PIPELINES_DIR');
    const flowNames = Array.from({ length: 11 }, (_, index) => `append_flow_${index + 1}`);
    const sqlContent = [
        'CREATE STREAMING TABLE sample_catalog.bronze.events (payload STRING);',
        ...flowNames.map((flowName) => [
            `CREATE FLOW ${flowName} AS INSERT INTO sample_catalog.bronze.events`,
            'SELECT payload FROM sample_catalog.raw.source_events;',
        ].join('\n')),
        '',
    ].join('\n');
    const fixture = await createPipelineFixture({
        files: [{ content: sqlContent, relativePath: 'src/flows.sql' }],
        libraryInclude: '../src/**',
        name: 'SQL Flow Graph Test',
        pipelinePath: 'examples/flow-graph',
        prefix: 'spark-control-plane-sql-flow-graph-',
        specExtras: [
            'catalog: sample_catalog',
            'database: bronze',
        ],
        specFilename: 'flow-graph.pipeline.yaml',
    });

    process.env.PIPELINES_DIR = path.join(fixture.root, 'pipelines');
    const service = createPipelineRegistryService({
        persistence: createInMemoryPersistence(),
    });
    try {
        await service.initialize();
        await service.refreshPipelinesFromSource();
        const pipelines = await service.listPipelines();
        assert.equal(pipelines.length, 1);
        const pipelineId = pipelines[0]?.id;
        assert.ok(pipelineId);

        const detail = await service.getPipeline(pipelineId);
        const target = detail.nodes.find((node) =>
            node.qualifiedName === 'sample_catalog.bronze.events'
        );
        const flows = detail.nodes.filter((node) => node.nodeType === 'FLOW');

        assert.equal(target?.nodeType, 'STREAMING_TABLE');
        assert.deepEqual(
            flows.map((flow) => flow.qualifiedName).sort(),
            flowNames.map((flowName) => `sample_catalog.bronze.${flowName}`).sort(),
        );
        assert.equal(detail.nodeCount, 1 + flowNames.length);
        assert.deepEqual(
            detail.edges
                .filter((edge) => edge.targetNodeId === target?.id)
                .map((edge) => [edge.sourceNodeId, edge.targetNodeId])
                .sort(),
            flowNames
                .map((flowName) => [
                    `flow:sample_catalog.bronze.${flowName}`,
                    'dataset:sample_catalog.bronze.events',
                ])
                .sort(),
        );
    } finally {
        await service.shutdown(100);
        restore();
        await fixture.cleanup();
    }
});

async function waitForTerminalRun(
    baseUrl: string,
    runId: string,
): Promise<PipelineRunResponse> {
    return pollUntil(
        async () => {
            const response = await requestJson<PipelineRunResponse>(
                `${baseUrl}/api/v1/runs/${encodeURIComponent(runId)}`,
            );
            assert.equal(response.status, 200);
            return response.body;
        },
        (run) => run.status === 'SUCCEEDED' || run.status === 'FAILED',
        1_000,
        20,
        `Pipeline run ${runId} did not finish.`,
    );
}
