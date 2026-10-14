/**
 * @fileoverview Startup and shutdown lifecycle checks for the container.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { getManagedTestContext } from '../../support/managedTestContext.mjs';
import { createContainerTestSupport } from '../../support/containerTestSupport.mjs';

const context = getManagedTestContext();
const baseUrl = context?.controlPlaneBaseUrl;
const containerName = context?.containerName;
const docker = context?.docker || 'docker';
const pipelineName = context?.pipelineName;
const {
    dockerCommand,
    requestJson: request,
    waitForReady,
    waitForRun,
    waitForRunPredicate,
} = createContainerTestSupport({
    baseUrl,
    docker,
    readyMessage: 'Container did not become ready after lifecycle transition.',
    runTimeoutMs: 120_000,
});
const getJson = (path) => request(path, { method: 'GET' });

test('container AIStor receiver requires and accepts the configured Bearer token', async () => {
    assert.ok(baseUrl);
    const token = process.env.AISTOR_WEBHOOK_TOKEN?.trim();
    assert.ok(token);

    const unauthorized = await request('/api/v1/triggers/aistor/events', { method: 'POST' });
    assert.equal(unauthorized.status, 401);
    assert.equal(unauthorized.headers.get('www-authenticate'), 'Bearer');

    const authorized = await request('/api/v1/triggers/aistor/events', {
        body: { Records: [] },
        headers: { Authorization: `Bearer ${token}` },
        method: 'POST',
    });
    assert.equal(authorized.status, 202);
    assert.equal(authorized.body.accepted, 0);
});

test('isolated container exercises cancellation, idempotency, and unknown outcomes after container restart', async () => {
    assert.ok(baseUrl);
    assert.ok(containerName);
    assert.ok(pipelineName);

    const initial = await getJson('/api/v1/pipelines');
    assert.equal(initial.status, 200);
    const pipeline = initial.body.items.find((item) => item.name === pipelineName);
    assert.ok(pipeline, `Fixture pipeline ${pipelineName} was not discovered.`);

    const deployed = await request(`/api/v1/pipelines/${pipeline.id}/deploy`, { method: 'POST' });
    assert.equal(deployed.status, 200);
    const rediscovered = await getJson('/api/v1/pipelines');
    assert.equal(rediscovered.body.items.find((item) => item.name === pipelineName)?.id, pipeline.id);

    const first = await submit(pipeline.id, 'container-first');
    assert.equal(first.status, 202);
    assert.ok(['QUEUED', 'SUBMITTING', 'RUNNING'].includes(first.body.status));
    const replay = await submit(pipeline.id, 'container-first');
    assert.equal(replay.status, 202);
    assert.equal(replay.body.runId, first.body.runId);
    assert.equal(replay.headers.get('idempotent-replayed'), 'true');
    await waitForRun(first.body.runId, ['SUBMITTING', 'RUNNING']);

    const queued = await submit(pipeline.id, 'container-queued');
    assert.equal(queued.status, 202);
    const queuedCanceled = await cancel(queued.body.runId, 'queued fixture cancellation');
    assert.equal(queuedCanceled.status, 200);
    assert.equal((await waitForRun(queued.body.runId, ['CANCELED'])).status, 'CANCELED');
    const activeCanceled = await cancel(first.body.runId, 'active fixture cancellation');
    assert.equal(activeCanceled.status, 200);
    assert.equal((await waitForRun(first.body.runId, ['CANCELED'])).status, 'CANCELED');

    const restartActive = await submit(pipeline.id, 'container-restart-active');
    const restartRunning = await waitForRunPredicate(
        restartActive.body.runId,
        (run) => run.status === 'RUNNING' && run.cliState === 'RUNNING' &&
            typeof run.cliExecutionId === 'string',
    );
    const restartExecutionId = restartRunning.cliExecutionId;
    assert.ok(restartExecutionId);
    const restartQueued = await submit(pipeline.id, 'container-restart-queued');
    assert.equal(restartQueued.body.status, 'QUEUED');
    dockerCommand(['restart', containerName]);
    await waitForReady();
    const restartTerminal = await waitForRun(restartActive.body.runId, ['UNKNOWN']);
    assert.equal(restartTerminal.cliState, 'UNKNOWN');
    assert.equal(restartTerminal.cliExecutionId, restartExecutionId);
    assert.equal(restartTerminal.exitCode, undefined);
    assert.equal(restartTerminal.recoveryReason, 'CLI_SUPERVISOR_NOT_RUNNING');
    const restartEvents = await getJson(`/api/v1/runs/${restartActive.body.runId}/events?limit=100&offset=0`);
    assert.equal(restartEvents.status, 200);
    assert.equal(
        restartEvents.body.items.filter((event) => event.eventType === 'LOCAL_CLI_RECOVERY_CLAIMED').length,
        1,
    );
    assert.equal(
        restartEvents.body.items.filter((event) => event.eventType === 'UNKNOWN').length,
        1,
    );
    assert.equal(
        restartEvents.body.items.some((event) => ['ABANDONED', 'CANCELED', 'FAILED'].includes(event.eventType)),
        false,
    );
    await waitForRun(restartQueued.body.runId, ['SUBMITTING', 'RUNNING']);
    const recoveredQueued = await cancel(restartQueued.body.runId, 'recovered queued fixture cancellation');
    assert.equal(recoveredQueued.status, 200);
    assert.equal((await waitForRun(restartQueued.body.runId, ['CANCELED'])).status, 'CANCELED');

    const shutdownRun = await submit(pipeline.id, 'container-shutdown-active');
    const shutdownRunning = await waitForRunPredicate(
        shutdownRun.body.runId,
        (run) => run.status === 'RUNNING' && run.cliState === 'RUNNING' &&
            typeof run.cliExecutionId === 'string',
    );
    const shutdownExecutionId = shutdownRunning.cliExecutionId;
    assert.ok(shutdownExecutionId);
    dockerCommand(['stop', '--time', '2', containerName]);
    dockerCommand(['start', containerName]);
    await waitForReady();
    const shutdownTerminal = await waitForRun(shutdownRun.body.runId, ['UNKNOWN']);
    assert.equal(shutdownTerminal.cliState, 'UNKNOWN');
    assert.equal(shutdownTerminal.cliExecutionId, shutdownExecutionId);
    assert.equal(shutdownTerminal.recoveryReason, 'CLI_SUPERVISOR_NOT_RUNNING');

    const events = await getJson(`/api/v1/runs/${shutdownRun.body.runId}/events?limit=100&offset=0`);
    assert.equal(events.status, 200);
    assert.equal(
        events.body.items.filter((event) => event.eventType === 'LOCAL_CLI_RECOVERY_CLAIMED').length,
        1,
    );
    assert.equal(events.body.items.filter((event) => event.eventType === 'UNKNOWN').length, 1);
    assert.equal(events.body.items.some((event) => event.eventType === 'ABANDONED'), false);
});

async function submit(pipelineId, key) {
    return request(`/api/v1/pipelines/${pipelineId}/runs`, {
        body: { mode: 'incremental', callerMetadata: { test: 'container-lifecycle' } },
        headers: { 'Idempotency-Key': key, 'X-Request-Source': 'container-lifecycle-test' },
        method: 'POST',
    });
}

async function cancel(runId, reason) {
    return request(`/api/v1/runs/${runId}/cancel`, {
        body: { reason },
        headers: { 'X-Actor': 'container-lifecycle-test' },
        method: 'POST',
    });
}
