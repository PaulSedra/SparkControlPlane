import { RunStatus } from './run.ts';
import type { TerminalRunStatus } from './run.ts';

/** Persisted lifecycle values for a pipeline node in a run. */
export const PipelineRunNodeStatus = {
    QUEUED: 'QUEUED',
    PLANNING: 'PLANNING',
    STARTING: 'STARTING',
    RUNNING: 'RUNNING',
    COMPLETED: 'COMPLETED',
    FAILED: 'FAILED',
    CANCELED: 'CANCELED',
    UNKNOWN: 'UNKNOWN',
} as const;

/** Lifecycle status persisted for one pipeline node in a run. */
export type PipelineRunNodeStatus =
    typeof PipelineRunNodeStatus[keyof typeof PipelineRunNodeStatus];

/** Node states emitted by Spark while a pipeline flow is active. */
export const ACTIVE_PIPELINE_RUN_NODE_STATUSES: readonly PipelineRunNodeStatus[] = [
    PipelineRunNodeStatus.QUEUED,
    PipelineRunNodeStatus.PLANNING,
    PipelineRunNodeStatus.STARTING,
    PipelineRunNodeStatus.RUNNING,
];

/** Active pipeline-node status values for callers that receive plain strings. */
export const ACTIVE_PIPELINE_RUN_NODE_STATUS_GROUP: readonly string[] = [
    ...ACTIVE_PIPELINE_RUN_NODE_STATUSES,
];

/** Node states indicating Spark began processing the node. */
export const STARTED_PIPELINE_RUN_NODE_STATUSES: readonly PipelineRunNodeStatus[] = [
    PipelineRunNodeStatus.STARTING,
    PipelineRunNodeStatus.RUNNING,
    PipelineRunNodeStatus.COMPLETED,
    PipelineRunNodeStatus.FAILED,
    PipelineRunNodeStatus.CANCELED,
];

/** Terminal node states emitted in Spark flow lifecycle messages. */
export const TERMINAL_PIPELINE_RUN_NODE_EVENT_STATUSES: readonly PipelineRunNodeStatus[] = [
    PipelineRunNodeStatus.COMPLETED,
    PipelineRunNodeStatus.FAILED,
    PipelineRunNodeStatus.CANCELED,
];

/** All terminal node outcomes, including those inferred from run recovery. */
export const TERMINAL_PIPELINE_RUN_NODE_STATUSES: readonly PipelineRunNodeStatus[] = [
    ...TERMINAL_PIPELINE_RUN_NODE_EVENT_STATUSES,
    PipelineRunNodeStatus.UNKNOWN,
];

/** Terminal pipeline-node lifecycle values for consumers with string inputs. */
export const TERMINAL_PIPELINE_RUN_NODE_STATUS_GROUP: readonly string[] = [
    ...TERMINAL_PIPELINE_RUN_NODE_STATUSES,
];

/** Priority assigned when node snapshots have identical update timestamps. */
export const PIPELINE_RUN_NODE_STATUS_PRIORITY: Readonly<Record<PipelineRunNodeStatus, number>> = {
    [PipelineRunNodeStatus.QUEUED]: 1,
    [PipelineRunNodeStatus.PLANNING]: 1,
    [PipelineRunNodeStatus.STARTING]: 1,
    [PipelineRunNodeStatus.RUNNING]: 1,
    [PipelineRunNodeStatus.COMPLETED]: 2,
    [PipelineRunNodeStatus.FAILED]: 3,
    [PipelineRunNodeStatus.CANCELED]: 3,
    [PipelineRunNodeStatus.UNKNOWN]: 3,
};

const RUN_NODE_STATUS_BY_RUN_STATUS: Readonly<Record<TerminalRunStatus, PipelineRunNodeStatus>> = {
    [RunStatus.SUCCEEDED]: PipelineRunNodeStatus.COMPLETED,
    [RunStatus.FAILED]: PipelineRunNodeStatus.FAILED,
    [RunStatus.CANCELED]: PipelineRunNodeStatus.CANCELED,
    [RunStatus.TIMED_OUT]: PipelineRunNodeStatus.FAILED,
    [RunStatus.UNKNOWN]: PipelineRunNodeStatus.UNKNOWN,
};

/** Maps a persisted terminal run outcome to its final node status, when defined. */
export function pipelineRunNodeStatusForRun(
    status: RunStatus,
): PipelineRunNodeStatus | undefined {
    switch (status) {
        case RunStatus.QUEUED:
        case RunStatus.SUBMITTING:
        case RunStatus.RUNNING:
            return undefined;
        default:
            return RUN_NODE_STATUS_BY_RUN_STATUS[status];
    }
}
