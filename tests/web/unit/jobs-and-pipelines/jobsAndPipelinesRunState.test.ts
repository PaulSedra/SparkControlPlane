/**
 * @fileoverview Submission state and concurrent request regression tests for
 * the jobs-and-pipelines page.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import type { PipelineRun } from '../../../../src/shared/pipelineRegistryTypes.ts';
import { RunStatus } from '../../../../src/shared/status/run.ts';
import {
    createJobsAndPipelinesRunActionState,
    jobsAndPipelinesRunActionReducer,
    updateRunActionState,
} from '../../../../src/web/components/jobs-and-pipelines/jobsAndPipelinesRunState.ts';

test('run submission progress and success stay out of page-level action feedback', () => {
    let state = createJobsAndPipelinesRunActionState();
    state = jobsAndPipelinesRunActionReducer(state, {
        type: 'submission-started',
        requestId: 1,
        pipelineId: 'pipeline-1',
    });
    assert.equal(state.actionState.kind, 'idle');
    assert.equal(state.pendingSubmissions.get(1)?.pipelineId, 'pipeline-1');

    state = jobsAndPipelinesRunActionReducer(state, {
        type: 'submission-succeeded',
        requestId: 1,
        run: run('RUNNING'),
    });
    assert.equal(state.actionState.kind, 'idle');
    assert.equal(state.pendingSubmissions.size, 0);
    assert.equal(state.submittedRuns.get('run-1'), 1);
});

test('only the latest failed submission is surfaced and a retry clears the error', () => {
    let state = createJobsAndPipelinesRunActionState();
    state = jobsAndPipelinesRunActionReducer(state, {
        type: 'submission-started',
        requestId: 1,
        pipelineId: 'pipeline-1',
    });
    state = jobsAndPipelinesRunActionReducer(state, {
        type: 'submission-started',
        requestId: 2,
        pipelineId: 'pipeline-2',
    });
    state = jobsAndPipelinesRunActionReducer(state, {
        type: 'submission-failed',
        requestId: 1,
        message: 'Older request failed.',
    });
    assert.equal(state.actionState.kind, 'idle');

    state = jobsAndPipelinesRunActionReducer(state, {
        type: 'submission-failed',
        requestId: 2,
        message: 'Latest request failed.',
    });
    assert.equal(state.actionState.kind, 'failed');
    assert.equal(state.actionState.message, 'Latest request failed.');

    state = jobsAndPipelinesRunActionReducer(state, {
        type: 'submission-started',
        requestId: 3,
        pipelineId: 'pipeline-3',
    });
    assert.equal(state.actionState.kind, 'idle');
    assert.deepEqual(Array.from(state.pendingSubmissions.values()), [
        { pipelineId: 'pipeline-3' },
    ]);
});

test('every terminal run outcome has a distinct user-facing action state', () => {
    const outcomes = [
        [RunStatus.SUCCEEDED, 'succeeded', 'Pipeline run completed.'],
        [RunStatus.FAILED, 'failed', 'Pipeline run failed with exit code 42.'],
        [RunStatus.CANCELED, 'failed', 'Pipeline run was canceled.'],
        [RunStatus.TIMED_OUT, 'failed', 'Pipeline run timed out.'],
        [
            RunStatus.UNKNOWN,
            'failed',
            'SCP cannot verify whether Spark finished. The run was not resubmitted.',
        ],
    ] as const;

    for (const [status, kind, message] of outcomes) {
        assert.deepEqual(updateRunActionState(run(status)), { kind, message });
    }
    assert.deepEqual(updateRunActionState(run(RunStatus.RUNNING)), { kind: 'idle' });
});

test('out-of-order submissions keep run outcomes associated with their own request', () => {
    let state = createJobsAndPipelinesRunActionState();
    state = jobsAndPipelinesRunActionReducer(state, {
        type: 'submission-started',
        requestId: 1,
        pipelineId: 'pipeline-1',
    });
    state = jobsAndPipelinesRunActionReducer(state, {
        type: 'submission-started',
        requestId: 2,
        pipelineId: 'pipeline-2',
    });
    state = jobsAndPipelinesRunActionReducer(state, {
        type: 'submission-succeeded',
        requestId: 2,
        run: run('RUNNING', 'run-2', 'pipeline-2'),
    });
    state = jobsAndPipelinesRunActionReducer(state, {
        type: 'submission-succeeded',
        requestId: 1,
        run: run('RUNNING', 'run-1', 'pipeline-1'),
    });

    state = jobsAndPipelinesRunActionReducer(state, {
        type: 'run-updated',
        run: run(RunStatus.SUCCEEDED, 'run-1', 'pipeline-1'),
    });
    assert.equal(state.actionState.kind, 'idle');

    state = jobsAndPipelinesRunActionReducer(state, {
        type: 'run-updated',
        run: run(RunStatus.CANCELED, 'run-2', 'pipeline-2'),
    });
    assert.deepEqual(state.actionState, {
        kind: 'failed',
        message: 'Pipeline run was canceled.',
    });
    assert.equal(state.submittedRuns.size, 0);
});

test('monitoring errors stay separate from actual terminal pipeline failures', () => {
    let state = createJobsAndPipelinesRunActionState();
    state = jobsAndPipelinesRunActionReducer(state, {
        type: 'submission-started',
        requestId: 1,
        pipelineId: 'pipeline-1',
    });
    state = jobsAndPipelinesRunActionReducer(state, {
        type: 'submission-succeeded',
        requestId: 1,
        run: run(RunStatus.RUNNING),
    });

    // A rejected status request dispatches no run snapshot and cannot mark the execution failed.
    assert.deepEqual(state.actionState, { kind: 'idle' });

    state = jobsAndPipelinesRunActionReducer(state, {
        type: 'run-updated',
        run: run(RunStatus.FAILED),
    });
    assert.deepEqual(state.actionState, {
        kind: 'failed',
        message: 'Pipeline run failed with exit code 42.',
    });
});

function run(
    status: PipelineRun['status'],
    runId = 'run-1',
    pipelineId = 'pipeline-1',
): PipelineRun {
    return {
        exitCode: 42,
        mode: 'incremental',
        pipelineId,
        runId,
        sparkAppName: 'app-1',
        startedAt: '2026-09-27T12:00:00.000Z',
        status,
    };
}
