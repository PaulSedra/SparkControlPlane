/**
 * @fileoverview Lifecycle ordering and stale-snapshot protection coverage for
 * pipeline run cache merges.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import type { PipelineRun, PipelineSummary } from '../../../../src/shared/pipelineRegistryTypes.ts';
import {
    mergePipelineRunSnapshot,
    mergePipelineSummarySnapshots,
} from '../../../../src/web/lib/pipelineRunState.ts';

test('active run cache merges keep later lifecycle and progress snapshots', () => {
    const current = run('RUNNING', {
        sparkStageProgress: {
            completedStages: 4,
            observedAt: '2026-09-27T12:03:00.000Z',
            totalStages: 10,
        },
    });
    const oldProgress = run('RUNNING', {
        sparkStageProgress: {
            completedStages: 2,
            observedAt: '2026-09-27T12:02:00.000Z',
            totalStages: 10,
        },
    });
    const regressedPhase = run('SUBMITTING');
    const laterProgress = run('RUNNING', {
        sparkStageProgress: {
            completedStages: 6,
            observedAt: '2026-09-27T12:04:00.000Z',
            totalStages: 10,
        },
    });

    assert.equal(mergePipelineRunSnapshot(current, oldProgress), current);
    assert.equal(mergePipelineRunSnapshot(current, regressedPhase), current);
    assert.equal(
        mergePipelineRunSnapshot(current, laterProgress).sparkStageProgress?.completedStages,
        6,
    );
});

test('terminal outcomes cannot be overwritten by an older active registry snapshot', () => {
    const completed = run('SUCCEEDED', { endedAt: '2026-09-27T12:05:00.000Z' });
    const summary = pipeline(completed);
    const staleRegistryResponse = pipeline(run('RUNNING'));

    const merged = mergePipelineSummarySnapshots([summary], [staleRegistryResponse]);

    assert.equal(merged[0]?.lastRun?.status, 'SUCCEEDED');
    assert.equal(merged[0]?.recentRuns[0]?.status, 'SUCCEEDED');
});

function run(
    status: PipelineRun['status'],
    overrides: Partial<PipelineRun> = {},
): PipelineRun {
    return {
        mode: 'incremental',
        pipelineId: 'pipeline-1',
        runId: 'run-1',
        sparkAppName: 'app-1',
        startedAt: '2026-09-27T12:00:00.000Z',
        status,
        ...overrides,
    };
}

function pipeline(lastRun: PipelineRun): PipelineSummary {
    return {
        id: 'pipeline-1',
        lastRun,
        name: 'Example',
        nodeCount: 0,
        recentRuns: [lastRun],
        sourceHash: 'source-hash',
        specPath: 'pipelines/example.pipeline.yaml',
        status: 'DEPLOYED',
    };
}
