import {
    CliExecutionState,
    isActiveCliExecutionState,
    type ActiveCliExecutionState,
    type CliExecutionState as CliExecutionStateValue,
    type TerminalCliExecutionState,
} from './execution.ts';

/** Persisted lifecycle values for a pipeline run. */
export const RunStatus = {
    QUEUED: 'QUEUED',
    SUBMITTING: 'SUBMITTING',
    RUNNING: 'RUNNING',
    SUCCEEDED: 'SUCCEEDED',
    FAILED: 'FAILED',
    CANCELED: 'CANCELED',
    TIMED_OUT: 'TIMED_OUT',
    UNKNOWN: 'UNKNOWN',
} as const;

/** Lifecycle status persisted for a pipeline run. */
export type RunStatus = typeof RunStatus[keyof typeof RunStatus];

/** A run status for which the worker has recorded its final outcome. */
export type TerminalRunStatus = Exclude<
    RunStatus,
    typeof RunStatus.QUEUED | typeof RunStatus.SUBMITTING | typeof RunStatus.RUNNING
>;

/** Run states accepted by persistence while appending live worker output. */
export type WorkerActiveRunStatus = typeof RunStatus.SUBMITTING | typeof RunStatus.RUNNING;

/** Status values that still represent work in progress for a persisted run. */
export const ACTIVE_PIPELINE_RUN_STATUSES: readonly RunStatus[] = [
    RunStatus.QUEUED,
    RunStatus.SUBMITTING,
    RunStatus.RUNNING,
];

/** Persisted statuses that no longer accept live run updates. */
export const TERMINAL_PIPELINE_RUN_STATUSES: readonly RunStatus[] = [
    RunStatus.SUCCEEDED,
    RunStatus.FAILED,
    RunStatus.CANCELED,
    RunStatus.TIMED_OUT,
    RunStatus.UNKNOWN,
];

/** Status values that represent work being executed by a run worker. */
export const WORKER_ACTIVE_PIPELINE_RUN_STATUSES: readonly RunStatus[] = [
    RunStatus.SUBMITTING,
    RunStatus.RUNNING,
];

/** Context selecting the user-facing wording for a run failure explanation. */
export type PipelineRunFailureContext = 'diagnostic' | 'jobs' | 'pipeline' | 'registry';

/** Status and lifecycle details used to describe why a run did not succeed. */
export interface PipelineRunFailureDetails {
    exitCode?: number;
    recoveryReason?: string;
    status: RunStatus;
    terminalReason?: string;
}

type PipelineRunFailureStatus = Exclude<
    RunStatus,
    typeof RunStatus.QUEUED | typeof RunStatus.SUBMITTING | typeof RunStatus.RUNNING | typeof RunStatus.SUCCEEDED
>;

type CancellationOrTimeoutRunStatus =
    | typeof RunStatus.CANCELED
    | typeof RunStatus.TIMED_OUT;

const FAILURE_TITLE_BY_RUN_STATUS: Readonly<Record<PipelineRunFailureStatus, string>> = {
    [RunStatus.CANCELED]: 'Pipeline run canceled',
    [RunStatus.FAILED]: 'Pipeline run failed',
    [RunStatus.TIMED_OUT]: 'Pipeline run timed out',
    [RunStatus.UNKNOWN]: 'Pipeline run outcome unknown',
};

const FAILURE_MESSAGE_BY_RUN_STATUS: Readonly<Record<CancellationOrTimeoutRunStatus, string>> = {
    [RunStatus.CANCELED]: 'Pipeline run was canceled.',
    [RunStatus.TIMED_OUT]: 'Pipeline run timed out.',
};

const WORKER_RUN_STATUS_BY_CLI_STATE: Readonly<Record<ActiveCliExecutionState, WorkerActiveRunStatus>> = {
    [CliExecutionState.STARTING]: RunStatus.SUBMITTING,
    [CliExecutionState.RUNNING]: RunStatus.RUNNING,
};

const RUN_STATUS_BY_TERMINAL_CLI_STATE: Readonly<Record<TerminalCliExecutionState, TerminalRunStatus>> = {
    [CliExecutionState.COMPLETED]: RunStatus.SUCCEEDED,
    [CliExecutionState.FAILED]: RunStatus.FAILED,
    [CliExecutionState.CANCELED]: RunStatus.CANCELED,
    [CliExecutionState.TIMED_OUT]: RunStatus.TIMED_OUT,
    [CliExecutionState.UNKNOWN]: RunStatus.UNKNOWN,
};

const RUN_AUDIT_EVENT_TYPE_BY_STATUS: Readonly<Record<TerminalRunStatus, string>> = {
    [RunStatus.SUCCEEDED]: 'RUN_SUCCEEDED',
    [RunStatus.FAILED]: 'RUN_FAILED',
    [RunStatus.CANCELED]: 'RUN_CANCELED',
    [RunStatus.TIMED_OUT]: 'RUN_TIMED_OUT',
    [RunStatus.UNKNOWN]: 'RUN_OUTCOME_UNKNOWN',
};

/** Maps a failed run status to the canonical title used by failure views. */
export function pipelineRunFailureTitle(status: RunStatus): string {
    if (!isPipelineRunFailureStatus(status)) {
        throw new Error('Run status ' + status + ' has no failure title.');
    }
    return FAILURE_TITLE_BY_RUN_STATUS[status];
}

/** Maps run status and lifecycle reasons to the shared failure explanation. */
export function pipelineRunFailureMessage(
    run: PipelineRunFailureDetails,
    context: PipelineRunFailureContext,
): string {
    if (!isPipelineRunFailureStatus(run.status)) {
        throw new Error('Run status ' + run.status + ' is not a failed outcome.');
    }
    return runFailureLifecycleMessage(run, context) ??
        runFailureRecoveryMessage(run, context) ??
        'Pipeline run failed with exit code ' + (run.exitCode ?? 'unknown') + '.';
}

function runFailureLifecycleMessage(
    run: PipelineRunFailureDetails,
    context: PipelineRunFailureContext,
): string | undefined {
    if (context === 'diagnostic' && run.recoveryReason === 'LEASE_EXPIRED') {
        return 'The worker lease expired before this run completed; run classified as abandoned.';
    }
    if (run.status === RunStatus.UNKNOWN) {
        return context === 'registry'
            ? 'SCP lost the local CLI state and cannot verify whether Spark finished. The run was not resubmitted.'
            : 'SCP cannot verify whether Spark finished. The run was not resubmitted.';
    }
    if (run.terminalReason === 'CONTROL_PLANE_SHUTDOWN') {
        return context === 'diagnostic'
            ? 'The run was canceled during control-plane shutdown.'
            : 'Pipeline run was canceled during control-plane shutdown.';
    }
    if (run.status === RunStatus.CANCELED || run.status === RunStatus.TIMED_OUT) {
        return FAILURE_MESSAGE_BY_RUN_STATUS[run.status];
    }
    return undefined;
}

function runFailureRecoveryMessage(
    run: PipelineRunFailureDetails,
    context: PipelineRunFailureContext,
): string | undefined {
    if (run.recoveryReason === 'LEASE_EXPIRED') {
        return context === 'pipeline'
            ? 'Pipeline run failed after its worker lease expired; it was recovered as abandoned.'
            : 'Pipeline run was recovered after its worker lease expired.';
    }
    if (run.recoveryReason === 'SPARK_OPERATION_LOST') {
        return context === 'diagnostic'
            ? 'Spark no longer had the persisted operation for this run.'
            : 'Pipeline run failed because Spark no longer had the persisted operation.';
    }
    return undefined;
}

/** Maps a live supervisor state to the persisted run phase reported to polling clients. */
export function workerRunStatusForCliState(state: CliExecutionStateValue): WorkerActiveRunStatus {
    if (!isActiveCliExecutionState(state)) {
        throw new Error('CLI state ' + state + ' cannot be mapped to an active run status.');
    }
    return WORKER_RUN_STATUS_BY_CLI_STATE[state];
}

/**
 * Maps the CLI result into a terminal outcome. Cancellation wins over timeout,
 * and both flags take precedence over the reported supervisor state.
 */
export function pipelineRunStatusForCliExecution(result: Readonly<{
    canceled?: boolean;
    exitCode?: number;
    state: CliExecutionStateValue;
    timedOut?: boolean;
}>): TerminalRunStatus {
    if (result.canceled) {
        return RunStatus.CANCELED;
    }
    if (result.timedOut) {
        return RunStatus.TIMED_OUT;
    }
    if (isActiveCliExecutionState(result.state)) {
        throw new Error('CLI state ' + result.state + ' is still active and has no terminal run outcome.');
    }
    return RUN_STATUS_BY_TERMINAL_CLI_STATE[result.state];
}

/** Maps each persisted terminal outcome to its canonical audit event type. */
export function auditEventTypeForRunStatus(status: TerminalRunStatus): string {
    return RUN_AUDIT_EVENT_TYPE_BY_STATUS[status];
}

function isPipelineRunFailureStatus(status: RunStatus): status is PipelineRunFailureStatus {
    return status === RunStatus.CANCELED || status === RunStatus.FAILED ||
        status === RunStatus.TIMED_OUT || status === RunStatus.UNKNOWN;
}
