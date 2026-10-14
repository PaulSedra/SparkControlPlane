/**
 * @fileoverview Command retry safety and targeted cache reconciliation tests.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { createAppQueryClient } from '../../../../src/web/query/queryClient.ts';
import {
    cancelPipelineRunMutationOptions,
    deployPipelineMutationOptions,
    refreshPipelinesFromSourceMutationOptions,
    runPipelineMutationOptions,
    updateTriggerMutationOptions,
} from '../../../../src/web/query/pipelineMutations.ts';
import { queryKeys } from '../../../../src/web/query/queryKeys.ts';
import { withMockFetch } from '../../../support/webFixtures.ts';

test('source refresh mutation invalidates pipeline and trigger snapshots without retries', async () => {
    const client = createAppQueryClient();
    const mutation = client.getMutationCache().build(
        client,
        refreshPipelinesFromSourceMutationOptions(client),
    );
    client.setQueryData(queryKeys.pipelines.all, []);
    client.setQueryData(queryKeys.triggers.all, []);

    await withMockFetch(async () => new Response(JSON.stringify({ pipelines: [], total: 0 }), {
        headers: { 'content-type': 'application/json' },
        status: 200,
    }), async () => {
        await mutation.execute();
    });

    assert.equal(client.getQueryState(queryKeys.pipelines.all)?.isInvalidated, true);
    assert.equal(client.getQueryState(queryKeys.triggers.all)?.isInvalidated, true);
    assert.equal(mutation.options.retry, false);
    client.clear();
});

test('deployment mutation updates detail, refreshes the list, and disables retries', async () => {
    const client = createAppQueryClient();
    const pipelineSummary = {
        currentVersionId: undefined,
        id: 'pipeline-1',
        name: 'Example',
        nodeCount: 0,
        recentRuns: [],
        sourceHash: 'source-hash',
        specPath: 'example.pipeline.yaml',
        status: 'DISCOVERED',
    };
    client.setQueryData(queryKeys.pipelines.all, [pipelineSummary]);
    const options = deployPipelineMutationOptions(client);
    const mutation = client.getMutationCache().build(client, options);

    await withMockFetch(async () => new Response(JSON.stringify({
        ...pipelineSummary,
        currentVersionId: 'version-1',
        status: 'DEPLOYED',
    }), {
        headers: { 'content-type': 'application/json' },
        status: 200,
    }), async () => {
        await mutation.execute({ pipelineId: 'pipeline-1' });
    });

    assert.equal(options.retry, false);
    assert.equal(client.getQueryData(queryKeys.pipelines.detail('pipeline-1'))?.currentVersionId,
        'version-1');
    assert.equal(client.getQueryData(queryKeys.pipelines.all)?.[0]?.currentVersionId, 'version-1');
    assert.equal(client.getQueryState(queryKeys.pipelines.all)?.isInvalidated, true);
    client.clear();
});

test('run and cancel mutations update run caches and invalidate only pipeline run resources', async () => {
    const client = createAppQueryClient();
    const pipeline = {
        currentVersionId: 'version-1',
        id: 'pipeline-1',
        name: 'Example',
        nodeCount: 0,
        recentRuns: [],
        sourceHash: 'source-hash',
        specPath: 'example.pipeline.yaml',
        status: 'DEPLOYED',
    };
    const detail = { ...pipeline, edges: [], nodes: [], runs: [], sourceFiles: [], spec: {}, validationMessages: [] };
    client.setQueryData(queryKeys.pipelines.all, [pipeline]);
    client.setQueryData(queryKeys.pipelines.detail('pipeline-1'), detail);
    client.setQueryData(queryKeys.pipelines.runs('pipeline-1'), []);
    const run = {
        mode: 'incremental',
        pipelineId: 'pipeline-1',
        runId: 'run-1',
        sparkAppName: 'app-1',
        startedAt: '2026-09-22T12:00:00.000Z',
        status: 'RUNNING',
    };
    const runMutation = client.getMutationCache().build(
        client,
        runPipelineMutationOptions(client),
    );
    await withMockFetch(async () => new Response(JSON.stringify(run), {
        headers: { 'content-type': 'application/json' },
        status: 200,
    }), async () => {
        await runMutation.execute({ pipelineId: 'pipeline-1', mode: 'incremental' });
    });

    assert.equal(client.getQueryData(queryKeys.pipelines.runs('pipeline-1'))?.[0]?.runId, 'run-1');
    assert.equal(client.getQueryData(queryKeys.pipelines.detail('pipeline-1'))?.runs[0]?.runId, 'run-1');
    assert.equal(client.getQueryState(queryKeys.pipelines.all)?.isInvalidated, true);
    assert.equal(client.getQueryState(queryKeys.pipelines.detail('pipeline-1'))?.isInvalidated, true);
    assert.equal(client.getQueryState(queryKeys.pipelines.runs('pipeline-1'))?.isInvalidated, true);
    assert.equal(runMutation.options.retry, false);

    const cancelMutation = client.getMutationCache().build(
        client,
        cancelPipelineRunMutationOptions(client),
    );
    const canceledRun = { ...run, status: 'CANCELED' };
    await withMockFetch(async () => new Response(JSON.stringify(canceledRun), {
        headers: { 'content-type': 'application/json' },
        status: 200,
    }), async () => {
        await cancelMutation.execute({ pipelineId: 'pipeline-1', runId: 'run-1' });
    });

    assert.equal(client.getQueryData(queryKeys.pipelines.runs('pipeline-1'))?.[0]?.status, 'CANCELED');
    assert.equal(cancelMutation.options.retry, false);
    client.clear();
});

test('trigger mutation refreshes shared definitions and the affected schedule key', async () => {
    const client = createAppQueryClient();
    const trigger = { enabled: true, id: 'trigger-1', name: 'Hourly', pipelineId: 'pipeline-1' };
    const scheduleKey = queryKeys.triggers.scheduleStatus('trigger-1');
    client.setQueryData(queryKeys.triggers.all, [trigger]);
    client.setQueryData(scheduleKey, { triggerId: 'trigger-1' });
    const options = updateTriggerMutationOptions(client);
    const mutation = client.getMutationCache().build(client, options);

    await withMockFetch(async () => new Response(JSON.stringify({ ...trigger, enabled: false }), {
        headers: { 'content-type': 'application/json' },
        status: 200,
    }), async () => {
        await mutation.execute({ triggerId: 'trigger-1', enabled: false });
    });

    assert.equal(client.getQueryData(queryKeys.triggers.all)?.[0]?.enabled, false);
    assert.equal(client.getQueryState(queryKeys.triggers.all)?.isInvalidated, true);
    assert.equal(client.getQueryState(scheduleKey)?.isInvalidated, true);
    assert.equal(mutation.options.retry, false);
    client.clear();
});
