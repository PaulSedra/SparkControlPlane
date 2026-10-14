/**
 * @fileoverview Status contracts for Spark operations and the local CLI
 * supervisor. These vocabularies describe related but distinct lifecycle
 * layers and must not be interchanged.
 */

/** Spark-side operation states observed while a run is submitted or monitored. */
export const SparkExecutionState = {
    COMPLETED: 'COMPLETED',
    DETACHED: 'DETACHED',
    MONITORING: 'MONITORING',
    NOT_STARTED: 'NOT_STARTED',
    OPERATION_LOST: 'OPERATION_LOST',
    REATTACHING: 'REATTACHING',
    SUBMITTING: 'SUBMITTING',
} as const;

/** Identifies a Spark operation state observed for a pipeline run. */
export type SparkExecutionState = typeof SparkExecutionState[keyof typeof SparkExecutionState];

/** Spark states that override the persisted run label in history tables. */
export const RUN_LABEL_SPARK_EXECUTION_STATES: readonly SparkExecutionState[] = [
    SparkExecutionState.DETACHED,
    SparkExecutionState.REATTACHING,
];

/** User-facing labels for Spark-side execution states. */
export const SPARK_EXECUTION_STATE_LABELS: Readonly<Record<SparkExecutionState, string>> = {
    [SparkExecutionState.COMPLETED]: 'Completed',
    [SparkExecutionState.DETACHED]: 'Detached',
    [SparkExecutionState.MONITORING]: 'Monitoring',
    [SparkExecutionState.NOT_STARTED]: 'Not started',
    [SparkExecutionState.OPERATION_LOST]: 'Operation lost',
    [SparkExecutionState.REATTACHING]: 'Reattaching',
    [SparkExecutionState.SUBMITTING]: 'Submitting',
};

/** Spark monitoring text accepted from its casing-variant external API. */
export type SparkStatus = string;

/** Spark monitoring stage values that represent work in progress. */
export const ACTIVE_SPARK_MONITORING_STAGE_STATUSES: readonly string[] = [
    'ACTIVE',
    'RUNNING',
];

/** Values emitted by the local Spark Pipelines CLI supervisor. */
export const CliExecutionState = {
    STARTING: 'STARTING',
    RUNNING: 'RUNNING',
    COMPLETED: 'COMPLETED',
    FAILED: 'FAILED',
    CANCELED: 'CANCELED',
    TIMED_OUT: 'TIMED_OUT',
    UNKNOWN: 'UNKNOWN',
} as const;

/** State reported by the local stock Spark Pipelines CLI supervisor. */
export type CliExecutionState = typeof CliExecutionState[keyof typeof CliExecutionState];

/** CLI states that represent work a run worker can still be processing. */
export type ActiveCliExecutionState =
    | typeof CliExecutionState.STARTING
    | typeof CliExecutionState.RUNNING;

/** CLI states that represent a completed or unverifiable execution. */
export type TerminalCliExecutionState = Exclude<CliExecutionState, ActiveCliExecutionState>;

/** Closed CLI supervisor status vocabulary used to validate external output. */
export const CLI_EXECUTION_STATES: readonly CliExecutionState[] = Object.values(CliExecutionState);

/** Active CLI supervisor states used by run polling and recovery. */
export const ACTIVE_CLI_EXECUTION_STATUSES: readonly CliExecutionState[] = [
    CliExecutionState.STARTING,
    CliExecutionState.RUNNING,
];

/** CLI lifecycle outcomes that are no longer in progress. */
export const TERMINAL_CLI_EXECUTION_STATUSES: readonly TerminalCliExecutionState[] = [
    CliExecutionState.COMPLETED,
    CliExecutionState.FAILED,
    CliExecutionState.CANCELED,
    CliExecutionState.TIMED_OUT,
    CliExecutionState.UNKNOWN,
];

/** Narrows supervisor states to phases accepted by live worker updates. */
export function isActiveCliExecutionState(
    state: CliExecutionState,
): state is ActiveCliExecutionState {
    return state === CliExecutionState.STARTING || state === CliExecutionState.RUNNING;
}

/** Checks an untrusted supervisor token against the closed CLI state list. */
export function isCliExecutionState(value: string): value is CliExecutionState {
    return CLI_EXECUTION_STATES.some((state) => state === value);
}

/** Status protocol passed to the Python supervisor from the shared contract. */
export const CLI_EXECUTION_STATUS_PROTOCOL = {
    active: ACTIVE_CLI_EXECUTION_STATUSES,
    states: CliExecutionState,
} as const;
