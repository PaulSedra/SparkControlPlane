/**
 * @fileoverview HTTP acceptance scenarios for the running control-plane container.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { getManagedTestContext } from '../../support/managedTestContext.mjs';
import { createContainerTestSupport } from '../../support/containerTestSupport.mjs';

const context = getManagedTestContext();
const baseUrl = context?.controlPlaneBaseUrl?.replace(/\/$/, '');
const containerName = context?.containerName;
const docker = context?.docker || 'docker';
const pipelineName = context?.pipelineName;
const {
    dockerCommand,
    requestJson,
    waitForReady,
    waitForRun,
    waitForRunPredicate,
} = createContainerTestSupport({
    baseUrl,
    docker,
    readyMessage: 'Container did not become ready after restart.',
    readyTimeoutMs: 60_000,
    runTimeoutMs: 120_000,
});

async function refreshAllPipelines() {
    const refreshed = await requestJson(`${baseUrl}/api/v1/pipelines/refresh-from-source`, {
        method: 'POST',
    });
    assert.equal(refreshed.status, 200);
    return refreshed.body;
}

test('container AIStor receiver requires and accepts the configured Bearer token', async () => {
    assert.ok(baseUrl, 'The managed container test URL is required.');
    const token = process.env.AISTOR_WEBHOOK_TOKEN?.trim();
    assert.ok(token, 'AISTOR_WEBHOOK_TOKEN is required.');

    const unauthorized = await fetch(`${baseUrl}/api/v1/triggers/aistor/events`, {
        method: 'POST',
    });
    assert.equal(unauthorized.status, 401);

    const authorized = await requestJson(`${baseUrl}/api/v1/triggers/aistor/events`, {
        body: JSON.stringify({ Records: [] }),
        headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
        },
        method: 'POST',
    });
    assert.equal(authorized.status, 202);
    assert.equal(authorized.body.accepted, 0);
});

test('container serves health, readiness, built UI, and versioned discovery API', async () => {
    assert.ok(baseUrl, 'The managed container test URL is required.');

    const health = await fetch(`${baseUrl}/health`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { status: 'ok' });

    const ready = await fetch(`${baseUrl}/ready`);
    assert.equal(ready.status, 200);
    const readyBody = await ready.json();
    assert.equal(readyBody.status, 'ready');
    assert.equal(readyBody.checks.persistence, 'postgresql');
    assert.match(readyBody.checks.pipelineDiscovery, /^ready:\d+$/);

    await refreshAllPipelines();

    const ui = await fetch(`${baseUrl}/pipelines`, {
        headers: { accept: 'text/html' },
    });
    assert.equal(ui.status, 200);
    assert.match(ui.headers.get('content-type') ?? '', /^text\/html/);
    assert.match(await ui.text(), /<div id="root"><\/div>/);

    const registry = await fetch(`${baseUrl}/api/v1/pipelines`);
    assert.equal(registry.status, 200);
    const registryBody = await registry.json();
    assert.ok(Array.isArray(registryBody.pipelines));
    assert.ok(registryBody.pipelines.length > 0, 'The read-only pipeline mount must be discovered.');
    const requestedName = pipelineName;
    if (requestedName != null && requestedName !== '') {
        assert.ok(
            registryBody.pipelines.some((pipeline) => pipeline.name === requestedName),
            `Configured acceptance pipeline was not discovered: ${requestedName}`,
        );
    }
});

test('container restart records an unknown outcome without resubmitting the local CLI run', {
    skip: baseUrl == null || containerName == null || pipelineName == null,
}, async () => {
    await refreshAllPipelines();
    const list = await requestJson(`${baseUrl}/api/v1/pipelines`);
    assert.equal(list.status, 200);
    const pipeline = list.body.pipelines.find((item) => item.name === pipelineName);
    assert.ok(pipeline, `Mounted pipeline was not discovered: ${pipelineName}`);

    const deploy = await requestJson(
        `${baseUrl}/api/v1/pipelines/${encodeURIComponent(pipeline.id)}/deploy`,
        { method: 'POST' },
    );
    assert.equal(deploy.status, 200);

    let runId;
    try {
        const submitted = await requestJson(
            `${baseUrl}/api/v1/pipelines/${encodeURIComponent(pipeline.id)}/runs`,
            {
                body: JSON.stringify({ mode: 'full-refresh-all' }),
                headers: {
                    'Content-Type': 'application/json',
                    'Idempotency-Key': `container-restart-${Date.now()}`,
                    'X-Request-Source': 'container-restart-acceptance',
                },
                method: 'POST',
            },
        );
        assert.equal(submitted.status, 202);
        runId = submitted.body.runId;
        assert.ok(typeof runId === 'string' && runId !== '');

        const active = await waitForRunPredicate(
            runId,
            (run) => run.status === 'RUNNING' && run.cliState === 'RUNNING' &&
                typeof run.cliExecutionId === 'string',
        );
        const executionId = active.cliExecutionId;
        assert.ok(executionId);

        // Kill the CLI supervisor immediately so a fast Spark run cannot finish during a graceful stop.
        dockerCommand(['restart', '--signal', 'SIGKILL', containerName]);
        await waitForReady();
        const terminal = await waitForRun(runId, ['UNKNOWN']);
        assert.equal(terminal.cliState, 'UNKNOWN');
        assert.equal(terminal.cliExecutionId, executionId);
        assert.equal(terminal.exitCode, undefined);
        assert.equal(terminal.recoveryReason, 'CLI_SUPERVISOR_NOT_RUNNING');

        const events = await requestJson(`${baseUrl}/api/v1/runs/${runId}/events?limit=100`);
        assert.equal(events.status, 200);
        const eventItems = events.body.items;
        assert.equal(
            eventItems.filter((event) => event.eventType === 'LOCAL_CLI_RECOVERY_CLAIMED').length,
            1,
        );
        assert.equal(
            eventItems.filter((event) => event.eventType === 'UNKNOWN').length,
            1,
        );
        assert.equal(
            eventItems.some((event) => ['ABANDONED', 'CANCELED', 'FAILED'].includes(event.eventType)),
            false,
        );
    } finally {
        if (typeof runId === 'string') {
            const current = await requestJson(`${baseUrl}/api/v1/runs/${runId}`);
            if (current.status === 200 &&
                ['QUEUED', 'SUBMITTING', 'RUNNING'].includes(current.body.status)) {
                await requestJson(`${baseUrl}/api/v1/runs/${runId}/cancel`, {
                    body: JSON.stringify({ reason: 'Restart acceptance cleanup.' }),
                    headers: { 'Content-Type': 'application/json' },
                    method: 'POST',
                });
                await waitForRun(runId, ['SUCCEEDED', 'FAILED', 'CANCELED', 'TIMED_OUT', 'UNKNOWN']);
            }
        }
    }
});
