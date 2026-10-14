/**
 * @fileoverview Presentation coverage for terminal pipeline run outcomes.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import type { PipelineRun } from '../../../../src/shared/pipelineRegistryTypes.ts';
import {
    PIPELINE_RUN_STATUS_LABELS,
    statusPresentationForPipelineState,
    statusPresentationForRunStatus,
} from '../../../../src/shared/status/presentation.ts';
import {
    ACTIVE_PIPELINE_RUN_STATUSES,
    RunStatus,
    TERMINAL_PIPELINE_RUN_STATUSES,
    pipelineRunFailureMessage,
} from '../../../../src/shared/status/run.ts';
import {
    pipelineRunHistoryStatusLabel,
    pipelineRunOutputSections,
} from '../../../../src/web/utils/pipelineRunPresentation.ts';

const unknownRun = { status: 'UNKNOWN' } as PipelineRun;

test('presents UNKNOWN as terminal with an explicit no-resubmit explanation', () => {
    assert.equal(statusPresentationForPipelineState('UNKNOWN'), 'unknown');
    assert.equal(statusPresentationForRunStatus('UNKNOWN'), 'unknown');
    assert.equal(PIPELINE_RUN_STATUS_LABELS.UNKNOWN, 'Outcome Unknown');
    assert.equal(TERMINAL_PIPELINE_RUN_STATUSES.includes('UNKNOWN'), true);
    assert.equal(ACTIVE_PIPELINE_RUN_STATUSES.includes('UNKNOWN'), false);
    assert.match(pipelineRunFailureMessage(unknownRun, 'pipeline'), /cannot verify whether Spark finished/);
    assert.match(pipelineRunFailureMessage(unknownRun, 'pipeline'), /was not resubmitted/);
});

test('presents canceled runs neutrally and canceled node states distinctly', () => {
    assert.equal(statusPresentationForRunStatus('CANCELED'), 'unknown');
    assert.equal(statusPresentationForPipelineState('CANCELED'), 'canceled');
    assert.equal(PIPELINE_RUN_STATUS_LABELS.CANCELED, 'Canceled');
});

test('run history keeps persisted terminal outcomes ahead of stale Spark attach states', () => {
    for (const status of TERMINAL_PIPELINE_RUN_STATUSES) {
        assert.equal(
            pipelineRunHistoryStatusLabel({
                sparkExecutionState: 'REATTACHING',
                status,
            }),
            PIPELINE_RUN_STATUS_LABELS[status],
        );
    }

    assert.equal(
        pipelineRunHistoryStatusLabel({
            sparkExecutionState: 'REATTACHING',
            status: RunStatus.RUNNING,
        }),
        'Reattaching',
    );
});

test('run output presents captured stdout and stderr separately without trimming text', () => {
    assert.deepEqual(
        pipelineRunOutputSections({
            stderr: 'CLI warning\n',
            stdout: 'Traceback (most recent call last):\n',
        }),
        [
            { label: 'Standard output', text: 'Traceback (most recent call last):\n' },
            { label: 'Standard error', text: 'CLI warning\n' },
        ],
    );
});

test('run output omits missing and whitespace-only streams', () => {
    assert.deepEqual(pipelineRunOutputSections({ stderr: '  \n', stdout: '' }), []);
    assert.deepEqual(pipelineRunOutputSections(), []);
});
