import {
    CliExecutionState,
    type SparkStatus,
} from './execution.ts';
import { PipelineRunNodeStatus } from './node.ts';
import { RunStatus } from './run.ts';
import { TriggerDeliveryStatus } from './trigger.ts';

/** Shared visual state vocabulary for status icons and asset badges. */
export const StatusPresentationState = {
    CANCELED: 'canceled',
    FAILED: 'failed',
    RUNNING: 'running',
    SUCCEEDED: 'succeeded',
    UNKNOWN: 'unknown',
} as const;

/** Semantic presentation state derived from a domain status. */
export type StatusPresentationState =
    typeof StatusPresentationState[keyof typeof StatusPresentationState];

/** Additional state used when an asset has no observed run result yet. */
export const PipelineAssetState = {
    ...StatusPresentationState,
    DEFINED: 'defined',
} as const;

/** State values emitted for pipeline asset graph nodes. */
export type PipelineAssetState = typeof PipelineAssetState[keyof typeof PipelineAssetState];

/** Valid states accepted by status icons and asset badges. */
export const STATUS_PRESENTATION_STATES: readonly StatusPresentationState[] = [
    StatusPresentationState.CANCELED,
    StatusPresentationState.FAILED,
    StatusPresentationState.RUNNING,
    StatusPresentationState.SUCCEEDED,
    StatusPresentationState.UNKNOWN,
];

/** Badge labels for the shared presentation states. */
export const STATUS_PRESENTATION_LABELS: Readonly<Record<StatusPresentationState, string>> = {
    [StatusPresentationState.CANCELED]: 'Canceled',
    [StatusPresentationState.FAILED]: 'Failed',
    [StatusPresentationState.RUNNING]: 'Running',
    [StatusPresentationState.SUCCEEDED]: 'Completed',
    [StatusPresentationState.UNKNOWN]: 'Unknown',
};

/** Run status labels used by history, details, and action summaries. */
export const PIPELINE_RUN_STATUS_LABELS: Readonly<Record<RunStatus, string>> = {
    [RunStatus.QUEUED]: 'Queued',
    [RunStatus.SUBMITTING]: 'Submitting',
    [RunStatus.RUNNING]: 'Running',
    [RunStatus.SUCCEEDED]: 'Completed',
    [RunStatus.FAILED]: 'Failed',
    [RunStatus.CANCELED]: 'Canceled',
    [RunStatus.TIMED_OUT]: 'Timed Out',
    [RunStatus.UNKNOWN]: 'Outcome Unknown',
};

/** Labels for pipeline asset graph nodes. */
export const PIPELINE_ASSET_STATUS_LABELS: Readonly<Record<PipelineAssetState, string>> = {
    [StatusPresentationState.CANCELED]: 'Canceled',
    [StatusPresentationState.FAILED]: 'Failed',
    [StatusPresentationState.RUNNING]: 'Running',
    [StatusPresentationState.SUCCEEDED]: 'Succeeded',
    [StatusPresentationState.UNKNOWN]: 'Unknown',
    [PipelineAssetState.DEFINED]: 'Defined',
};

type PipelineStateToken = RunStatus | PipelineRunNodeStatus | CliExecutionState;

const PIPELINE_STATE_PRESENTATION_STATE: Readonly<Record<PipelineStateToken, StatusPresentationState>> = {
    [RunStatus.QUEUED]: StatusPresentationState.RUNNING,
    [RunStatus.SUBMITTING]: StatusPresentationState.RUNNING,
    [PipelineRunNodeStatus.PLANNING]: StatusPresentationState.RUNNING,
    [PipelineRunNodeStatus.STARTING]: StatusPresentationState.RUNNING,
    [RunStatus.RUNNING]: StatusPresentationState.RUNNING,
    [RunStatus.SUCCEEDED]: StatusPresentationState.SUCCEEDED,
    [PipelineRunNodeStatus.COMPLETED]: StatusPresentationState.SUCCEEDED,
    [RunStatus.FAILED]: StatusPresentationState.FAILED,
    [RunStatus.CANCELED]: StatusPresentationState.CANCELED,
    [RunStatus.TIMED_OUT]: StatusPresentationState.FAILED,
    [RunStatus.UNKNOWN]: StatusPresentationState.UNKNOWN,
};

/** Maps a run or node lifecycle token to the shared visual state vocabulary. */
export function statusPresentationForPipelineState(
    status?: string | null,
): StatusPresentationState {
    const normalized = status?.trim().toUpperCase();
    if (normalized == null || normalized === '') {
        return StatusPresentationState.UNKNOWN;
    }
    return isPipelineStateToken(normalized)
        ? PIPELINE_STATE_PRESENTATION_STATE[normalized]
        : StatusPresentationState.UNKNOWN;
}

/**
 * Maps a node result using its parent run outcome. Older canceled runs stored
 * unfinished nodes as FAILED without a completion time; present those as
 * canceled while keeping completed failures visible.
 */
export function statusPresentationForPipelineNodeStatus(
    status?: string | null,
    runStatus?: RunStatus | null,
    completedAt?: string | null,
): StatusPresentationState {
    if (
        runStatus === RunStatus.CANCELED &&
        status === PipelineRunNodeStatus.FAILED &&
        completedAt == null
    ) {
        return StatusPresentationState.CANCELED;
    }
    return statusPresentationForPipelineState(status);
}

function isPipelineStateToken(value: string): value is PipelineStateToken {
    return Object.hasOwn(PIPELINE_STATE_PRESENTATION_STATE, value);
}

/** Maps persisted run outcomes to badge states, presenting cancellation neutrally. */
export function statusPresentationForRunStatus(status: RunStatus): StatusPresentationState {
    return status === RunStatus.CANCELED
        ? StatusPresentationState.UNKNOWN
        : statusPresentationForPipelineState(status);
}

/** Labels for a trigger delivery grouped by its shared presentation state. */
export const TRIGGER_OUTCOME_PRESENTATION_LABELS:
Partial<Record<StatusPresentationState, string>> = {
    [StatusPresentationState.FAILED]: 'Last delivery failed',
    [StatusPresentationState.RUNNING]: 'Delivery pending',
};

const TRIGGER_DELIVERY_PRESENTATION_STATE:
Readonly<Partial<Record<TriggerDeliveryStatus, StatusPresentationState>>> = {
    [TriggerDeliveryStatus.FAILED]: StatusPresentationState.FAILED,
    [TriggerDeliveryStatus.PENDING]: StatusPresentationState.RUNNING,
};

/** Maps a trigger delivery outcome to the visual state used by trigger badges. */
export function statusPresentationForTriggerOutcome(
    status?: TriggerDeliveryStatus | null,
): StatusPresentationState | undefined {
    return status == null ? undefined : TRIGGER_DELIVERY_PRESENTATION_STATE[status];
}

/** Aggregates incoming pipeline-flow states into one asset result. */
export function pipelineAssetStateForIncomingFlows(
    statuses: readonly (StatusPresentationState | undefined)[],
): StatusPresentationState | undefined {
    if (statuses.length === 0) {
        return undefined;
    }
    if (statuses.includes(StatusPresentationState.FAILED)) {
        return StatusPresentationState.FAILED;
    }
    if (statuses.includes(StatusPresentationState.CANCELED)) {
        return StatusPresentationState.CANCELED;
    }
    if (statuses.includes(StatusPresentationState.RUNNING)) {
        return StatusPresentationState.RUNNING;
    }
    if (statuses.includes(StatusPresentationState.UNKNOWN)) {
        return StatusPresentationState.UNKNOWN;
    }
    return statuses.every((status) => status === StatusPresentationState.SUCCEEDED)
        ? StatusPresentationState.SUCCEEDED
        : undefined;
}

const SPARK_STATUS_PRESENTATION_STATE: Readonly<Record<string, StatusPresentationState>> = {
    ACTIVE: StatusPresentationState.RUNNING,
    RUNNING: StatusPresentationState.RUNNING,
    PENDING: StatusPresentationState.RUNNING,
    COMPLETE: StatusPresentationState.SUCCEEDED,
    COMPLETED: StatusPresentationState.SUCCEEDED,
    SUCCEEDED: StatusPresentationState.SUCCEEDED,
    SUCCESS: StatusPresentationState.SUCCEEDED,
    FAILED: StatusPresentationState.FAILED,
    KILLED: StatusPresentationState.FAILED,
    UNKNOWN: StatusPresentationState.UNKNOWN,
    SKIPPED: StatusPresentationState.UNKNOWN,
};

/** Converts Spark monitoring text into the shared visual status vocabulary. */
export function sparkStatusPresentationState(status: SparkStatus): StatusPresentationState {
    const normalized = status.trim().toUpperCase();
    return Object.hasOwn(SPARK_STATUS_PRESENTATION_STATE, normalized)
        ? SPARK_STATUS_PRESENTATION_STATE[normalized]
        : StatusPresentationState.UNKNOWN;
}
