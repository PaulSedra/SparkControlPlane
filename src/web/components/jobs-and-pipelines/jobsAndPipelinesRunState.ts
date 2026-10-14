/**
 * @fileoverview Pending pipeline submissions and actionable submission errors.
 */

import type { PipelineRun } from '../../../shared/pipelineRegistryTypes.ts';
import {
    pipelineRunFailureMessage,
    RunStatus,
    TERMINAL_PIPELINE_RUN_STATUSES,
} from '../../../shared/status/run.ts';

/** Current state of a deploy or cancellation action. */
export type JobsAndPipelinesActionState =
    | {
        kind: 'idle' | 'running' | 'succeeded';
        message?: string;
        pipelineId?: string;
        runId?: string;
    }
    | {
        kind: 'failed';
        message: string;
        pipelineId?: string;
        runId?: string;
    };

/** Run feedback covers submission errors and terminal outcomes for page actions. */
export type JobsAndPipelinesRunActionFeedback =
    | { kind: 'idle' }
    | { kind: 'succeeded'; message: string }
    | { kind: 'failed'; message: string };

/** Independent feedback for deploy, run submission, and cancellation actions. */
export interface JobsAndPipelinesActionStates {
    cancel: JobsAndPipelinesActionState;
    deploy: JobsAndPipelinesActionState;
    run: JobsAndPipelinesRunActionFeedback;
}

/** One run request still awaiting its run ID from the API. */
export interface PendingPipelineRunSubmission {
    pipelineId: string;
}

/** Reducer state tracks pending requests and the latest actionable error. */
export interface JobsAndPipelinesRunActionState {
    actionState: JobsAndPipelinesRunActionFeedback;
    latestSubmissionId?: number;
    pendingSubmissions: ReadonlyMap<number, PendingPipelineRunSubmission>;
    submittedRuns: ReadonlyMap<string, number>;
}

/** Events that track pending run submissions and submission failures. */
export type JobsAndPipelinesRunAction =
    | {
        type: 'submission-started';
        requestId: number;
        pipelineId: string;
    }
    | {
        type: 'submission-succeeded';
        requestId: number;
        run: PipelineRun;
    }
    | {
        type: 'submission-failed';
        requestId: number;
        message: string;
    }
    | {
        type: 'run-updated';
        run: PipelineRun;
    };

/** Creates the initial local run-action state. */
export function createJobsAndPipelinesRunActionState(): JobsAndPipelinesRunActionState {
    return {
        actionState: { kind: 'idle' },
        pendingSubmissions: new Map(),
        submittedRuns: new Map(),
    };
}

/** Maps a run snapshot to the user-facing state for a submitted action. */
export function updateRunActionState(run: PipelineRun): JobsAndPipelinesRunActionFeedback {
    if (run.status === RunStatus.SUCCEEDED) {
        return { kind: 'succeeded', message: 'Pipeline run completed.' };
    }
    if (TERMINAL_PIPELINE_RUN_STATUSES.includes(run.status)) {
        return {
            kind: 'failed',
            message: pipelineRunFailureMessage(run, 'jobs'),
        };
    }
    return { kind: 'idle' };
}

/**
 * Tracks pending requests while allowing only the latest submission error to
 * appear. Run lifecycle snapshots are published directly to the registry cache.
 */
export function jobsAndPipelinesRunActionReducer(
    state: JobsAndPipelinesRunActionState,
    action: JobsAndPipelinesRunAction,
): JobsAndPipelinesRunActionState {
    switch (action.type) {
        case 'submission-started': {
            const pendingSubmissions = new Map(state.pendingSubmissions);
            pendingSubmissions.set(action.requestId, {
                pipelineId: action.pipelineId,
            });
            return {
                actionState: { kind: 'idle' },
                latestSubmissionId: action.requestId,
                pendingSubmissions,
                submittedRuns: state.submittedRuns,
            };
        }
        case 'submission-succeeded': {
            const pendingSubmissions = withoutSubmission(state.pendingSubmissions, action.requestId);
            const isLatest = state.latestSubmissionId === action.requestId;
            const submittedRuns = new Map(state.submittedRuns);
            if (TERMINAL_PIPELINE_RUN_STATUSES.includes(action.run.status)) {
                submittedRuns.delete(action.run.runId);
            } else {
                submittedRuns.set(action.run.runId, action.requestId);
            }
            return {
                ...state,
                actionState: isLatest ? updateRunActionState(action.run) : state.actionState,
                pendingSubmissions,
                submittedRuns,
            };
        }
        case 'submission-failed': {
            const pendingSubmissions = withoutSubmission(state.pendingSubmissions, action.requestId);
            const isLatest = state.latestSubmissionId === action.requestId;
            return {
                ...state,
                actionState: isLatest
                    ? {
                        kind: 'failed',
                        message: action.message,
                    }
                    : state.actionState,
                pendingSubmissions,
            };
        }
        case 'run-updated': {
            if (!TERMINAL_PIPELINE_RUN_STATUSES.includes(action.run.status)) {
                return state;
            }
            const requestId = state.submittedRuns.get(action.run.runId);
            if (requestId == null) {
                return state;
            }
            const submittedRuns = new Map(state.submittedRuns);
            submittedRuns.delete(action.run.runId);
            return {
                ...state,
                actionState: state.latestSubmissionId === requestId
                    ? updateRunActionState(action.run)
                    : state.actionState,
                submittedRuns,
            };
        }
    }
}

function withoutSubmission(
    submissions: ReadonlyMap<number, PendingPipelineRunSubmission>,
    requestId: number,
): ReadonlyMap<number, PendingPipelineRunSubmission> {
    const result = new Map(submissions);
    result.delete(requestId);
    return result;
}
