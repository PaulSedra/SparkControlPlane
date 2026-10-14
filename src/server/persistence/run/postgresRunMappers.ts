/**
 * @fileoverview PostgreSQL row types and safe mappings for persisted run state.
 */

import type { QueryResultRow } from 'pg';
import type {
    PipelineRun,
    PipelineRunNodeStatusRecord,
} from '../../../shared/pipelineRegistryTypes.ts';
import type {
    CliExecutionState,
} from '../../../shared/status/execution.ts';
import {
    ACTIVE_PIPELINE_RUN_NODE_STATUSES,
    pipelineRunNodeStatusForRun,
} from '../../../shared/status/node.ts';
import {
    TERMINAL_PIPELINE_RUN_STATUSES,
    WORKER_ACTIVE_PIPELINE_RUN_STATUSES,
} from '../../../shared/status/run.ts';
import type {
    PipelineDeployment,
    PipelineRunEvent,
    PersistenceMutationKind,
    PersistenceMutationResult,
} from '../../types/pipelinePersistenceTypes.ts';
import { sanitizeCommand, sanitizeFields, sanitizeText } from '../../utils/sanitization.ts';
import { dateString } from '../postgresPersistenceUtils.ts';

type PostgresTimestamp = Date | string;
type NullablePostgresTimestamp = PostgresTimestamp | null;

/** Default lease duration used when a worker passes zero or no usable value. */
export const DEFAULT_RUN_LEASE_MILLISECONDS = 30_000;

/** SQL list of statuses that are actively owned by a run worker. */
export const WORKER_ACTIVE_RUN_STATUS_SQL_LIST = WORKER_ACTIVE_PIPELINE_RUN_STATUSES
    .map((status) => `'${status}'`)
    .join(', ');

/** SQL list of run states that no longer accept worker mutations. */
export const TERMINAL_RUN_STATUS_SQL_LIST = TERMINAL_PIPELINE_RUN_STATUSES
    .map((status) => `'${status}'`)
    .join(', ');

/** SQL list of node states that must close with a terminal run. */
export const ACTIVE_NODE_STATUS_SQL_LIST = ACTIVE_PIPELINE_RUN_NODE_STATUSES
    .map((status) => `'${status}'`)
    .join(', ');

/** PostgreSQL row returned for a deployed pipeline source version. */
export interface DeploymentRow extends QueryResultRow {
    deployed_at: PostgresTimestamp;
    pipeline_id: string;
    source_hash: string;
    status: PipelineDeployment['status'];
    validation_messages: string[];
    version_id: string;
}

/** PostgreSQL idempotency record used to replay or reject a submission. */
export interface IdempotencyRow extends QueryResultRow {
    request_fingerprint: string;
    run_id: string;
}

/** Complete PostgreSQL projection for a pipeline run. */
export interface RunRow extends QueryResultRow {
    allow_overlap: boolean;
    caller_metadata: Record<string, string> | null;
    command: string[] | null;
    correlation_id: string | null;
    ended_at: NullablePostgresTimestamp;
    exit_code: number | null;
    idempotency_key: string | null;
    lease_lost: boolean;
    mode: PipelineRun['mode'];
    pipeline_id: string;
    repaired_node_names: string[] | null;
    target_node_names: string[] | null;
    recovery_reason: string | null;
    run_id: string;
    source_hash: string;
    spark_app_name: string;
    spark_execution_state: PipelineRun['sparkExecutionState'] | null;
    spark_last_response_id: string | null;
    spark_operation_id: string | null;
    spark_session_id: string | null;
    started_at: PostgresTimestamp;
    status: PipelineRun['status'];
    stderr: string | null;
    stdout: string | null;
    terminal_event_at: NullablePostgresTimestamp;
    terminal_reason: string | null;
    request_source: string | null;
    timeout_seconds: number | null;
    cli_execution_id: string | null;
    cli_state: CliExecutionState | null;
    cli_process_id: number | string | null;
    cli_run_directory: string | null;
    cli_started_at: NullablePostgresTimestamp;
    cli_stderr_offset: number | string;
    cli_stdout_offset: number | string;
    remote_execution_id: string | null;
    version_id: string;
}

/** PostgreSQL row returned for one run's node status projection. */
export interface NodeStateRow extends QueryResultRow {
    run_id: string;
    completed_at: NullablePostgresTimestamp;
    duration_ms: number | null;
    last_updated_at: PostgresTimestamp;
    qualified_name: string;
    started_at: NullablePostgresTimestamp;
    status: PipelineRunNodeStatusRecord['status'];
}

/** PostgreSQL row returned for one append-only run event. */
export interface RunEventRow extends QueryResultRow {
    correlation_id: string | null;
    event_id: number | string;
    event_type: string;
    occurred_at: PostgresTimestamp;
    payload: Record<string, unknown>;
    run_id: string;
    status: string | null;
}

/**
 * Maps a run row to the public contract and sanitizes legacy persisted values
 * before returning them to API or history callers.
 */
export function mapRun(
    row: RunRow,
    nodeStatuses: Record<string, PipelineRunNodeStatusRecord>,
    additionalSecrets: readonly string[] = [],
): PipelineRun {
    const endedAt = row.ended_at == null ? undefined : dateString(row.ended_at);
    const normalizedNodeStatuses = normalizeTerminalNodeStatuses(
        row.status,
        nodeStatuses,
        endedAt,
    );
    return {
        allowOverlap: row.allow_overlap,
        callerMetadata: row.caller_metadata == null
            ? undefined
            : sanitizeFields(row.caller_metadata, additionalSecrets) as Record<string, string>,
        command: row.command == null ? undefined : sanitizeCommand(row.command, additionalSecrets),
        correlationId: row.correlation_id == null
            ? undefined
            : sanitizeText(row.correlation_id, additionalSecrets),
        endedAt,
        exitCode: row.exit_code ?? undefined,
        idempotencyKey: row.idempotency_key ?? undefined,
        leaseLost: row.lease_lost || undefined,
        mode: row.mode,
        nodeStatuses: Object.keys(normalizedNodeStatuses).length === 0
            ? undefined
            : normalizedNodeStatuses,
        pipelineId: row.pipeline_id,
        repairedNodeNames: row.repaired_node_names ?? undefined,
        targetNodeNames: row.target_node_names ?? undefined,
        recoveryReason: row.recovery_reason == null
            ? undefined
            : sanitizeText(row.recovery_reason, additionalSecrets),
        cliExecutionId: row.cli_execution_id ?? undefined,
        cliState: row.cli_state ?? undefined,
        cliProcessId: row.cli_process_id == null ? undefined : Number(row.cli_process_id),
        cliRunDirectory: row.cli_run_directory ?? undefined,
        cliStartedAt: row.cli_started_at == null ? undefined : dateString(row.cli_started_at),
        cliStdoutOffset: Number(row.cli_stdout_offset),
        cliStderrOffset: Number(row.cli_stderr_offset),
        requestSource: row.request_source == null
            ? undefined
            : sanitizeText(row.request_source, additionalSecrets),
        runId: row.run_id,
        sourceHash: row.source_hash,
        sparkAppName: row.spark_app_name,
        sparkExecutionState: row.spark_execution_state ?? undefined,
        sparkLastResponseId: row.spark_last_response_id ?? undefined,
        sparkOperationId: row.spark_operation_id ?? undefined,
        sparkSessionId: row.spark_session_id ?? undefined,
        startedAt: dateString(row.started_at),
        status: row.status,
        stderr: row.stderr == null ? undefined : sanitizeText(row.stderr, additionalSecrets),
        stdout: row.stdout == null ? undefined : sanitizeText(row.stdout, additionalSecrets),
        terminalEventAt: row.terminal_event_at == null
            ? undefined
            : dateString(row.terminal_event_at),
        terminalReason: row.terminal_reason == null
            ? undefined
            : sanitizeText(row.terminal_reason, additionalSecrets),
        versionId: row.version_id,
        ...(row.timeout_seconds == null ? {} : { timeoutSeconds: row.timeout_seconds }),
    };
}

/** Maps a node row to the shared status record used by history responses. */
export function mapNodeStatus(row: NodeStateRow): PipelineRunNodeStatusRecord {
    return {
        completedAt: row.completed_at == null ? undefined : dateString(row.completed_at),
        durationMs: row.duration_ms ?? undefined,
        lastUpdatedAt: dateString(row.last_updated_at),
        qualifiedName: row.qualified_name,
        startedAt: row.started_at == null ? undefined : dateString(row.started_at),
        status: row.status,
    };
}

/** Maps an event row to the append-only event contract with safe payload data. */
export function mapRunEvent(
    row: RunEventRow,
    additionalSecrets: readonly string[] = [],
): PipelineRunEvent {
    return {
        correlationId: row.correlation_id == null
            ? undefined
            : sanitizeText(row.correlation_id, additionalSecrets),
        eventId: Number(row.event_id),
        eventType: row.event_type,
        occurredAt: dateString(row.occurred_at),
        payload: sanitizeFields(row.payload, additionalSecrets) as Record<string, unknown>,
        runId: row.run_id,
        status: row.status ?? undefined,
    };
}

/** Maps active node rows to the terminal run outcome and preserves their timing. */
export function normalizeTerminalNodeStatuses(
    runStatus: PipelineRun['status'],
    nodeStatuses: Record<string, PipelineRunNodeStatusRecord>,
    endedAt: string | undefined,
): Record<string, PipelineRunNodeStatusRecord> {
    const terminalStatus = pipelineRunNodeStatusForRun(runStatus);
    if (terminalStatus == null || endedAt == null) {
        return nodeStatuses;
    }

    return Object.fromEntries(Object.entries(nodeStatuses).map(([name, node]) => {
        if (!ACTIVE_PIPELINE_RUN_NODE_STATUSES.includes(node.status)) {
            return [name, node];
        }

        const completedAt = node.completedAt ?? endedAt;
        const durationMs = node.startedAt == null
            ? node.durationMs
            : Math.max(0, Date.parse(completedAt) - Date.parse(node.startedAt));
        return [name, {
            ...node,
            completedAt,
            durationMs,
            lastUpdatedAt: endedAt,
            status: terminalStatus,
        }];
    }));
}

/** Creates a typed outcome for a fenced run mutation. */
export function runMutation(
    kind: PersistenceMutationKind,
    run?: PipelineRun,
): PersistenceMutationResult {
    return { kind, run };
}
