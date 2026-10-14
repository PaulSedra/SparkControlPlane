import assert from 'node:assert/strict';
import test from 'node:test';
import type { PipelineDetail, PipelineRun } from '../../../../src/shared/pipelineRegistryTypes.ts';
import {
    nextSelectedPipelineRunId,
    resolvePipelineRunSelection,
} from '../../../../src/web/components/pipeline/hooks/usePipelineRunSelection.ts';

const succeededRun = pipelineRun({ runId: 'run-1', status: 'SUCCEEDED' });
const activeRun = pipelineRun({ runId: 'run-2', status: 'RUNNING' });
const detail = pipelineDetail({
    lastRun: succeededRun,
    runs: [succeededRun, activeRun],
});

test('deep-linked run ID remains selected even when absent from recent history', () => {
    const resolution = resolvePipelineRunSelection(detail, 'old-run', undefined);

    assert.equal(resolution.requestedRunId, 'old-run');
    assert.equal(resolution.selectedRunSummary, undefined);
    assert.equal(resolution.shouldLoadDetails, true);
});

test('active locally selected run does not request terminal diagnostics', () => {
    const resolution = resolvePipelineRunSelection(detail, undefined, activeRun.runId);

    assert.equal(resolution.requestedRunId, activeRun.runId);
    assert.equal(resolution.selectedRunSummary, activeRun);
    assert.equal(resolution.shouldLoadDetails, false);
});

test('leaving a run-specific route selects the latest run', () => {
    assert.equal(
        nextSelectedPipelineRunId(detail, undefined, 'older-run', 'run-1'),
        succeededRun.runId,
    );
});

test('valid local selection survives unrelated detail updates', () => {
    assert.equal(
        nextSelectedPipelineRunId(detail, undefined, activeRun.runId, undefined),
        activeRun.runId,
    );
});

function pipelineRun(overrides: Partial<PipelineRun>): PipelineRun {
    return {
        runId: 'default-run',
        pipelineId: 'pipeline-1',
        status: 'SUCCEEDED',
        mode: 'incremental',
        startedAt: '2026-09-22T12:00:00Z',
        ...overrides,
    } as PipelineRun;
}

function pipelineDetail(overrides: Partial<PipelineDetail>): PipelineDetail {
    return {
        id: 'pipeline-1',
        currentVersionId: 'version-1',
        nodes: [],
        runs: [],
        ...overrides,
    } as PipelineDetail;
}
