/**
 * @fileoverview Retry, cancellation, recovery, and concurrency coverage for
 * per-run pipeline status monitoring.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import type { PipelineRun } from '../../../../src/shared/pipelineRegistryTypes.ts';
import { monitorPipelineRun } from '../../../../src/web/api/pipelineRegistryClient.ts';
import {
    MAX_CONCURRENT_PIPELINE_RUN_MONITORS,
    PipelineRunMonitorCoordinator,
} from '../../../../src/web/components/jobs-and-pipelines/hooks/usePipelineRunMonitoring.ts';
import { withMockFetch } from '../../../support/webFixtures.ts';

test('a temporary status request failure retries and returns the terminal run', async () => {
    let requestCount = 0;
    const updates: PipelineRun['status'][] = [];

    await withMockFetch(async () => {
        requestCount += 1;
        if (requestCount === 1) {
            return new Response(JSON.stringify({ message: 'temporarily unavailable' }), {
                headers: { 'content-type': 'application/json' },
                status: 503,
            });
        }
        return jsonResponse(run('SUCCEEDED'));
    }, async () => {
        const result = await monitorPipelineRun(
            'run-1',
            new AbortController().signal,
            (snapshot) => updates.push(snapshot.status),
        );

        assert.equal(result.status, 'SUCCEEDED');
    });

    assert.equal(requestCount, 2);
    assert.deepEqual(updates, ['SUCCEEDED']);
});

test('status monitoring bounds retries after a persistent server failure', async () => {
    let requestCount = 0;

    await withMockFetch(async () => {
        requestCount += 1;
        return new Response(JSON.stringify({ message: 'temporarily unavailable' }), {
            headers: { 'content-type': 'application/json' },
            status: 503,
        });
    }, async () => {
        await assert.rejects(
            monitorPipelineRun('run-1', new AbortController().signal),
            /temporarily unavailable/,
        );
    });

    assert.equal(requestCount, 3);
});

test('aborting a run monitor cancels its in-flight status request', async () => {
    const controller = new AbortController();
    let requestSignal: AbortSignal | undefined;
    const monitoring = withMockFetch((_input, init) => {
        requestSignal = init?.signal ?? undefined;
        return new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => {
                reject(new DOMException('The operation was aborted.', 'AbortError'));
            }, { once: true });
        });
    }, () => monitorPipelineRun('run-1', controller.signal));

    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.ok(requestSignal instanceof AbortSignal);
    controller.abort();

    await assert.rejects(monitoring, { name: 'AbortError' });
    assert.equal(requestSignal?.aborted, true);
});

test('monitor coordination deduplicates run IDs and limits concurrent polling', async () => {
    const requestedRunIds: string[] = [];
    const resolvers = new Map<string, (value: PipelineRun) => void>();
    const signals = new Map<string, AbortSignal>();
    const coordinator = new PipelineRunMonitorCoordinator({
        onRunUpdate: () => undefined,
    }, (runId, signal) => {
        requestedRunIds.push(runId);
        signals.set(runId, signal);
        return new Promise<PipelineRun>((resolve, reject) => {
            resolvers.set(runId, resolve);
            signal.addEventListener('abort', () => {
                reject(new DOMException('The operation was aborted.', 'AbortError'));
            }, { once: true });
        });
    }, 1);

    coordinator.updateActiveRuns(['run-1', 'run-2', 'run-1']);
    coordinator.updateActiveRuns(['run-1', 'run-2']);
    assert.deepEqual(requestedRunIds, ['run-1']);
    assert.equal(MAX_CONCURRENT_PIPELINE_RUN_MONITORS, 4);

    resolvers.get('run-1')?.(run('SUCCEEDED'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(requestedRunIds, ['run-1', 'run-2']);

    coordinator.updateActiveRuns([]);
    assert.equal(signals.get('run-2')?.aborted, true);
    coordinator.dispose();
});

test('monitor cleanup aborts outstanding requests on terminal removal and unmount', async () => {
    for (const cleanup of ['terminal', 'unmount'] as const) {
        const signals: AbortSignal[] = [];
        const coordinator = new PipelineRunMonitorCoordinator({
            onRunUpdate: () => undefined,
        }, (_runId, signal) => {
            signals.push(signal);
            return new Promise<PipelineRun>((_resolve, reject) => {
                signal.addEventListener('abort', () => {
                    reject(new DOMException('The operation was aborted.', 'AbortError'));
                }, { once: true });
            });
        });

        coordinator.updateActiveRuns(['run-1']);
        assert.equal(signals.length, 1);
        if (cleanup === 'terminal') {
            coordinator.updateActiveRuns([]);
        } else {
            coordinator.dispose();
        }
        assert.equal(signals[0]?.aborted, true);
        coordinator.dispose();
    }
});

function run(status: PipelineRun['status']): PipelineRun {
    return {
        mode: 'incremental',
        pipelineId: 'pipeline-1',
        runId: 'run-1',
        sparkAppName: 'app-1',
        startedAt: '2026-09-27T12:00:00.000Z',
        status,
    };
}

function jsonResponse(body: unknown): Response {
    return new Response(JSON.stringify(body), {
        headers: { 'content-type': 'application/json' },
        status: 200,
    });
}
