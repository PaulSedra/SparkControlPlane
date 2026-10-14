/**
 * @fileoverview Pipeline detail, run, source, node-sample, and live-cache
 * query contracts.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { QueryObserver } from '@tanstack/react-query';
import type { PipelineRun } from '../../../../src/shared/pipelineRegistryTypes.ts';
import { createAppQueryClient } from '../../../../src/web/query/queryClient.ts';
import {
    normalizePipelineSourcePath,
    pipelineDetailQueryOptions,
    pipelineNodeDataQueryOptions,
    pipelineRunQueryOptions,
    pipelineRunsQueryOptions,
    pipelineSourceFileQueryOptions,
    refreshTerminalPipelineRunDetails,
    updatePipelineRunQueryCache,
} from '../../../../src/web/query/pipelineQueries.ts';
import { queryKeys } from '../../../../src/web/query/queryKeys.ts';
import { withMockFetch } from '../../../support/webFixtures.ts';

test('pipeline detail, run history, selected run, and source queries forward abort signals', async () => {
    const client = createAppQueryClient();
    const requests: Array<{ signal: AbortSignal | undefined; url: string }> = [];
    const pipelineId = 'pipeline-1';
    const runId = 'run-1';

    await withMockFetch(async (input, init) => {
        const url = String(input);
        requests.push({ signal: init?.signal ?? undefined, url });
        const body = url.includes('/runs?')
            ? { items: [] }
            : url.includes('/api/v1/runs/')
                ? { mode: 'incremental', pipelineId, runId, sparkAppName: 'app-1', startedAt: '2026-09-22T12:00:00Z', status: 'SUCCEEDED' }
                : url.includes('/source?')
                    ? { content: 'select 1', language: 'sql', path: 'src/pipelines/a.sql' }
                    : {};
        return new Response(JSON.stringify(body), {
            headers: { 'content-type': 'application/json' },
            status: 200,
        });
    }, async () => {
        await client.query(pipelineDetailQueryOptions(pipelineId));
        await client.query(pipelineRunsQueryOptions(pipelineId));
        await client.query(pipelineRunQueryOptions(pipelineId, runId));
        await client.query(pipelineSourceFileQueryOptions(pipelineId, '.\\src\\pipelines\\a.sql'));
    });

    assert.equal(requests.length, 4);
    assert.ok(requests.every(({ signal }) => signal instanceof AbortSignal));
    assert.ok(requests.every(({ signal }) => signal?.aborted === false));
    assert.ok(requests[0]?.url.endsWith('?includeRuns=false'));
    assert.ok(requests[1]?.url.includes('/runs?limit=100&offset=0'));
    assert.ok(requests[2]?.url.endsWith('/api/v1/runs/run-1'));
    assert.equal(
        new URL(requests[3]?.url ?? '', 'http://localhost').searchParams.get('file'),
        'src/pipelines/a.sql',
    );
    assert.deepEqual(pipelineDetailQueryOptions(pipelineId).queryKey, queryKeys.pipelines.detail(pipelineId));
    assert.deepEqual(pipelineRunsQueryOptions(pipelineId).queryKey, queryKeys.pipelines.runs(pipelineId));
    assert.deepEqual(pipelineRunQueryOptions(pipelineId, runId).queryKey, queryKeys.pipelines.run(pipelineId, runId));
    client.clear();
});

test('source paths normalize to one cache key and keep relative-path identity', () => {
    const first = pipelineSourceFileQueryOptions('pipeline-1', '.\\src\\pipelines\\a.sql');
    const second = pipelineSourceFileQueryOptions('pipeline-1', 'src/pipelines/a.sql');

    assert.equal(normalizePipelineSourcePath('.\\src\\pipelines\\a.sql'), 'src/pipelines/a.sql');
    assert.deepEqual(first.queryKey, second.queryKey);
    assert.notDeepEqual(
        first.queryKey,
        pipelineSourceFileQueryOptions('pipeline-2', 'src/pipelines/a.sql').queryKey,
    );
});

test('node sample query requests the selected pipeline node and forwards its abort signal', async () => {
    const client = createAppQueryClient();
    const pipelineId = 'pipeline-1';
    const nodeId = 'node-1';
    let request: { signal: AbortSignal | undefined; url: string } | undefined;
    const sample = {
        columns: [{ name: 'id', type: 'int' }],
        rows: Array.from({ length: 100 }, (_value, index) => [index]),
    };

    await withMockFetch(async (input, init) => {
        request = { signal: init?.signal ?? undefined, url: String(input) };
        return new Response(JSON.stringify(sample), {
            headers: { 'content-type': 'application/json' },
            status: 200,
        });
    }, async () => {
        const data = await client.query(pipelineNodeDataQueryOptions(pipelineId, nodeId));
        assert.equal(data.rows.length, 100);
    });

    assert.equal(
        request?.url,
        '/api/v1/pipelines/pipeline-1/nodes/node-1/data',
    );
    assert.ok(request?.signal instanceof AbortSignal);
    assert.equal(request?.signal?.aborted, false);
    assert.deepEqual(
        pipelineNodeDataQueryOptions(pipelineId, nodeId).queryKey,
        queryKeys.pipelines.nodeData(pipelineId, nodeId),
    );
    client.clear();
});

test('changing pipeline route identity aborts the previous detail request', async () => {
    const client = createAppQueryClient();
    let previousSignal: AbortSignal | undefined;

    await withMockFetch(async (input, init) => {
        const url = String(input);
        if (url.includes('/pipelines/pipeline-1?includeRuns=false')) {
            previousSignal = init?.signal ?? undefined;
            return new Promise<Response>((_resolve, reject) => {
                init?.signal?.addEventListener('abort', () => {
                    reject(new DOMException('Request aborted', 'AbortError'));
                }, { once: true });
            });
        }
        return new Response(JSON.stringify({ id: 'pipeline-2' }), {
            headers: { 'content-type': 'application/json' },
            status: 200,
        });
    }, async () => {
        const observer = new QueryObserver(client, {
            ...pipelineDetailQueryOptions('pipeline-1'),
            enabled: true,
        });
        const unsubscribe = observer.subscribe(() => undefined);
        await new Promise((resolve) => setTimeout(resolve, 0));
        assert.ok(previousSignal instanceof AbortSignal);

        observer.setOptions({
            ...pipelineDetailQueryOptions('pipeline-2'),
            enabled: true,
        });
        assert.equal(previousSignal.aborted, true);
        const result = await observer.refetch();
        assert.equal(result.data?.id, 'pipeline-2');
        unsubscribe();
    });

    client.clear();
});

test('changing workspace source identity aborts the stale file request', async () => {
    const client = createAppQueryClient();
    let previousSignal: AbortSignal | undefined;

    await withMockFetch(async (input, init) => {
        const url = String(input);
        if (url.includes('file=src%2Fa.sql')) {
            previousSignal = init?.signal ?? undefined;
            return new Promise<Response>((_resolve, reject) => {
                init?.signal?.addEventListener('abort', () => {
                    reject(new DOMException('Request aborted', 'AbortError'));
                }, { once: true });
            });
        }
        return new Response(JSON.stringify({
            content: 'select 2',
            language: 'sql',
            path: 'src/b.sql',
        }), {
            headers: { 'content-type': 'application/json' },
            status: 200,
        });
    }, async () => {
        const observer = new QueryObserver(client, {
            ...pipelineSourceFileQueryOptions('pipeline-1', 'src/a.sql'),
            enabled: true,
        });
        const unsubscribe = observer.subscribe(() => undefined);
        await new Promise((resolve) => setTimeout(resolve, 0));
        assert.ok(previousSignal instanceof AbortSignal);

        observer.setOptions({
            ...pipelineSourceFileQueryOptions('pipeline-1', 'src/b.sql'),
            enabled: true,
        });
        assert.equal(previousSignal.aborted, true);
        const result = await observer.refetch();
        assert.equal(result.data?.path, 'src/b.sql');
        unsubscribe();
    });

    client.clear();
});

test('live run snapshots update detail, history, and selected-run caches together', () => {
    const client = createAppQueryClient();
    const pipelineId = 'pipeline-1';
    const run = {
        mode: 'incremental',
        pipelineId,
        runId: 'run-1',
        sparkAppName: 'app-1',
        startedAt: '2026-09-22T12:00:00Z',
        status: 'RUNNING',
    } as const;
    const detailKey = queryKeys.pipelines.detail(pipelineId);
    const runsKey = queryKeys.pipelines.runs(pipelineId);
    const runKey = queryKeys.pipelines.run(pipelineId, run.runId);
    client.setQueryData(detailKey, {
        id: pipelineId,
        recentRuns: [run],
        runs: [run],
    });
    client.setQueryData(queryKeys.pipelines.all, [{
        id: pipelineId,
        lastRun: run,
        name: 'Example',
        nodeCount: 0,
        recentRuns: [run],
        sourceHash: 'source-hash',
        specPath: 'pipelines/example.pipeline.yaml',
        status: 'DEPLOYED',
    }]);
    client.setQueryData(runsKey, [run]);

    updatePipelineRunQueryCache(client, { ...run, status: 'SUCCEEDED', stdout: 'complete' });
    const staleUpdate = updatePipelineRunQueryCache(client, run);

    assert.equal(staleUpdate.status, 'SUCCEEDED');
    assert.equal(client.getQueryData(detailKey)?.runs[0]?.status, 'SUCCEEDED');
    assert.equal(client.getQueryData(runsKey)?.[0]?.stdout, 'complete');
    assert.equal(client.getQueryData(runKey)?.status, 'SUCCEEDED');
    assert.equal(client.getQueryData(queryKeys.pipelines.all)?.[0]?.lastRun?.status, 'SUCCEEDED');
    client.clear();
});

test('terminal monitoring refreshes the selected run details to load captured output', async () => {
    const client = createAppQueryClient();
    const run: PipelineRun = {
        exitCode: 1,
        mode: 'incremental',
        pipelineId: 'pipeline-1',
        runId: 'run-1',
        startedAt: '2026-09-22T12:00:00Z',
        status: 'FAILED',
    };
    const runKey = queryKeys.pipelines.run(run.pipelineId, run.runId);
    const fullRun = { ...run, stderr: 'ValueError: invalid input' };
    let requestCount = 0;
    client.setQueryData(runKey, run);

    await withMockFetch(async () => {
        requestCount += 1;
        return new Response(JSON.stringify(fullRun), {
            headers: { 'content-type': 'application/json' },
            status: 200,
        });
    }, async () => {
        const observer = new QueryObserver(client, {
            ...pipelineRunQueryOptions(run.pipelineId, run.runId),
            enabled: true,
            staleTime: Infinity,
        });
        const unsubscribe = observer.subscribe(() => undefined);
        try {
            await refreshTerminalPipelineRunDetails(client, run);

            assert.equal(client.getQueryData<PipelineRun>(runKey)?.stderr, fullRun.stderr);
            assert.equal(requestCount, 1);
        } finally {
            unsubscribe();
        }
    });

    client.clear();
});
