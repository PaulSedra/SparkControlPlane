/**
 * @fileoverview Registry query key, polling, signal, and request-deduplication
 * contracts.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { createAppQueryClient } from '../../../../src/web/query/queryClient.ts';
import {
    pipelinesQueryOptions,
    registryPollingOptions,
    REGISTRY_REFRESH_INTERVAL_MS,
    triggersQueryOptions,
} from '../../../../src/web/query/pipelineRegistryQueries.ts';
import { queryKeys } from '../../../../src/web/query/queryKeys.ts';
import { withMockFetch } from '../../../support/webFixtures.ts';

test('registry options preserve five-second visible polling and focus revalidation', () => {
    assert.equal(REGISTRY_REFRESH_INTERVAL_MS, 5_000);
    assert.equal(registryPollingOptions.refetchInterval, 5_000);
    assert.equal(registryPollingOptions.refetchIntervalInBackground, false);
    assert.equal(registryPollingOptions.refetchOnWindowFocus, 'always');
    assert.equal(registryPollingOptions.staleTime, 0);
});

test('pipeline and trigger query functions forward abort signals to existing clients', async () => {
    const client = createAppQueryClient();
    const requests: Array<{ signal: AbortSignal | undefined; url: string }> = [];

    await withMockFetch(async (input, init) => {
        requests.push({ signal: init?.signal ?? undefined, url: String(input) });
        return new Response(JSON.stringify(
            String(input).endsWith('/pipelines') ? { pipelines: [] } : { triggers: [] },
        ), {
            headers: { 'content-type': 'application/json' },
            status: 200,
        });
    }, async () => {
        await client.query(pipelinesQueryOptions());
        await client.query(triggersQueryOptions());
    });

    assert.equal(requests.length, 2);
    assert.ok(requests.every(({ signal }) => signal instanceof AbortSignal));
    assert.ok(requests.every(({ signal }) => signal?.aborted === false));
    assert.deepEqual(pipelinesQueryOptions().queryKey, queryKeys.pipelines.all);
    assert.deepEqual(triggersQueryOptions().queryKey, queryKeys.triggers.all);
    client.clear();
});

test('shared trigger key deduplicates concurrent registry and pipeline-view reads', async () => {
    const client = createAppQueryClient();
    let requestCount = 0;
    let resolveResponse: ((response: Response) => void) | undefined;
    const pendingResponse = new Promise<Response>((resolve) => {
        resolveResponse = resolve;
    });

    await withMockFetch(async () => {
        requestCount += 1;
        return pendingResponse;
    }, async () => {
        const registryRead = client.query(triggersQueryOptions());
        const pipelineViewRead = client.query(triggersQueryOptions());
        await new Promise((resolve) => setTimeout(resolve, 0));
        assert.equal(requestCount, 1);
        resolveResponse?.(new Response(JSON.stringify({ triggers: [] }), {
            headers: { 'content-type': 'application/json' },
            status: 200,
        }));
        await Promise.all([registryRead, pipelineViewRead]);
    });

    client.clear();
});

test('late registry responses do not regress a run already completed in the cache', async () => {
    const client = createAppQueryClient();
    const completedRun = registryRun('SUCCEEDED');
    const staleRun = registryRun('RUNNING');
    client.setQueryData(queryKeys.pipelines.all, [registryPipeline(completedRun)]);

    await withMockFetch(async () => new Response(JSON.stringify({
        pipelines: [registryPipeline(staleRun)],
    }), {
        headers: { 'content-type': 'application/json' },
        status: 200,
    }), async () => {
        await client.fetchQuery({ ...pipelinesQueryOptions(), staleTime: 0 });
    });

    assert.equal(
        client.getQueryData(queryKeys.pipelines.all)?.[0]?.lastRun?.status,
        'SUCCEEDED',
    );
    client.clear();
});

function registryRun(status: 'RUNNING' | 'SUCCEEDED') {
    return {
        mode: 'incremental',
        pipelineId: 'pipeline-1',
        runId: 'run-1',
        sparkAppName: 'app-1',
        startedAt: '2026-09-27T12:00:00.000Z',
        status,
        ...(status === 'SUCCEEDED' ? { endedAt: '2026-09-27T12:01:00.000Z' } : {}),
    } as const;
}

function registryPipeline(lastRun: ReturnType<typeof registryRun>) {
    return {
        id: 'pipeline-1',
        lastRun,
        name: 'Example',
        nodeCount: 0,
        recentRuns: [lastRun],
        sourceHash: 'source-hash',
        specPath: 'pipelines/example.pipeline.yaml',
        status: 'DEPLOYED',
    } as const;
}
