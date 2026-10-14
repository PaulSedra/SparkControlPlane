/**
 * @fileoverview PostgreSQL run cancellation, live updates, and completion.
 */

import type { Pool, PoolClient } from 'pg';
import {
    ACTIVE_CLI_EXECUTION_STATUSES,
    CliExecutionState,
} from '../../../shared/status/execution.ts';
import {
    ACTIVE_PIPELINE_RUN_STATUSES,
    RunStatus,
    auditEventTypeForRunStatus,
} from '../../../shared/status/run.ts';
import type { PipelineRun } from '../../../shared/pipelineRegistryTypes.ts';
import { ControlPlaneApiError } from '../../errors/controlPlaneApiError.ts';
import type {
    AuditContext,
    LocalCliExecutionUpdate,
    PersistenceMutationResult,
    RunCompletion,
    RunLease,
} from '../../types/pipelinePersistenceTypes.ts';
import { sanitizeCommand, sanitizeText } from '../../utils/sanitization.ts';
import { insertAuditEvent } from '../postgresAuditPersistence.ts';
import {
    finalizeActiveNodeStatuses,
    hasActiveLease,
    insertRunEvent,
    isCancellationRequested as readCancellationRequest,
    selectRun,
    upsertNodeStatuses,
} from './postgresRunQueries.ts';
import {
    TERMINAL_RUN_STATUS_SQL_LIST,
    type RunRow,
    runMutation,
} from './postgresRunMappers.ts';
import { dateString } from '../postgresPersistenceUtils.ts';
import { withRunTransaction } from './postgresRunTransactions.ts';

/**
 * Requests cancellation for active work, or terminalizes queued work
 * immediately. The run row lock serializes cancellation with completion.
 */
export async function cancelRun(
    pool: Pool,
    runId: string,
    requestedBy: string | undefined,
    reason: string | undefined,
    context: AuditContext | undefined,
    secret: string,
): Promise<PipelineRun> {
    return withRunTransaction(pool, async (client) => {
        const runResult = await client.query<RunRow>(
            'SELECT * FROM runs WHERE run_id = $1 FOR UPDATE',
            [runId],
        );
        const existingRun = runResult.rows[0];
        if (existingRun == null) {
            throw new ControlPlaneApiError(404, `Unknown pipeline run: ${runId}`);
        }
        if (!ACTIVE_PIPELINE_RUN_STATUSES.includes(existingRun.status)) {
            const terminalRun = await selectRun(client, runId, [secret]);
            if (terminalRun == null) {
                throw new Error('PostgreSQL did not return the terminal pipeline run.');
            }
            return terminalRun;
        }

        const now = new Date().toISOString();
        const safeReason = sanitizeText(
            reason?.trim() || 'Cancellation requested by the caller.',
            [secret],
        ).slice(0, 2000);
        const safeRequestedBy = requestedBy?.trim()
            ? sanitizeText(requestedBy.trim(), [secret]).slice(0, 200)
            : null;
        await client.query(
            `
                INSERT INTO run_cancellations (
                    run_id, requested_at, requested_by, reason, effective_at
                ) VALUES ($1, $2, $3, $4, $5)
                ON CONFLICT (run_id) DO UPDATE SET
                    requested_by = EXCLUDED.requested_by,
                    reason = EXCLUDED.reason
            `,
            [
                runId,
                now,
                safeRequestedBy,
                safeReason,
                existingRun.status === RunStatus.QUEUED ? now : null,
            ],
        );

        if (existingRun.status === RunStatus.QUEUED) {
            await client.query(
                `
                    UPDATE runs
                    SET status = '${RunStatus.CANCELED}', exit_code = 130, ended_at = $2,
                        stderr = $3, terminal_reason = $3,
                        terminal_event_at = $2, updated_at = $2
                    WHERE run_id = $1
                `,
                [runId, now, safeReason],
            );
            await updateRunSuccessDependency(client, runId, 'SKIPPED', now);
            await finalizeActiveNodeStatuses(client, runId, RunStatus.CANCELED, now);
            await client.query('DELETE FROM run_leases WHERE run_id = $1', [runId]);
            await insertRunEvent(client, runId, RunStatus.CANCELED, RunStatus.CANCELED, {
                reason: safeReason,
            }, context?.correlationId, [secret]);
            await insertAuditEvent(client, {
                eventType: auditEventTypeForRunStatus(RunStatus.CANCELED),
                payload: { reason: safeReason },
                pipelineId: existingRun.pipeline_id,
                runId,
                correlationId: context?.correlationId,
                requestSource: context?.requestSource,
                actor: safeRequestedBy ?? undefined,
            }, [secret]);
        } else {
            await insertRunEvent(client, runId, 'CANCELLATION_REQUESTED', existingRun.status, {
                reason: safeReason,
            }, context?.correlationId, [secret]);
            await insertAuditEvent(client, {
                eventType: 'RUN_CANCELLATION_REQUESTED',
                payload: { reason: safeReason },
                pipelineId: existingRun.pipeline_id,
                runId,
                correlationId: context?.correlationId,
                requestSource: context?.requestSource,
                actor: safeRequestedBy ?? undefined,
            }, [secret]);
        }

        const run = await selectRun(client, runId, [secret]);
        if (run == null) {
            throw new Error('PostgreSQL did not return the canceled pipeline run.');
        }
        return run;
    });
}

/** Returns whether an active worker should stop for a pending cancellation. */
export async function isCancellationRequested(pool: Pool, runId: string): Promise<boolean> {
    return readCancellationRequest(pool, runId);
}

/** Appends live output and node changes only when the projection changed. */
export async function appendLiveRun(
    pool: Pool,
    runId: string,
    lease: RunLease,
    status: typeof RunStatus.SUBMITTING | typeof RunStatus.RUNNING,
    stdout: string,
    nodeStatuses: Record<string, import('../../../shared/pipelineRegistryTypes.ts').PipelineRunNodeStatusRecord>,
    secret: string,
): Promise<PersistenceMutationResult> {
    return withRunTransaction(pool, async (client) => {
        const runResult = await client.query<RunRow>(
            'SELECT * FROM runs WHERE run_id = $1 FOR UPDATE',
            [runId],
        );
        const row = runResult.rows[0];
        if (row == null) {
            return runMutation('MISSING');
        }
        if (!ACTIVE_PIPELINE_RUN_STATUSES.includes(row.status)) {
            return runMutation('ALREADY_TERMINAL', await selectRun(client, runId, [secret]));
        }
        if (!await hasActiveLease(client, runId, lease)) {
            return runMutation('FENCED');
        }

        const sanitizedStdout = sanitizeText(stdout, [secret]);
        const runChanged = row.status !== status || row.stdout !== sanitizedStdout;
        if (runChanged) {
            await client.query(
                `
                    UPDATE runs
                    SET status = $2, stdout = $3, updated_at = CURRENT_TIMESTAMP
                    WHERE run_id = $1 AND status NOT IN (${TERMINAL_RUN_STATUS_SQL_LIST})
                `,
                [runId, status, sanitizedStdout],
            );
        }
        const nodesChanged = await upsertNodeStatuses(client, runId, nodeStatuses);
        if (runChanged || nodesChanged) {
            await insertRunEvent(client, runId, 'OUTPUT', status, {
                nodeCount: Object.keys(nodeStatuses).length,
                stdoutLength: sanitizedStdout.length,
            }, row.correlation_id ?? undefined, [secret]);
        }
        return runMutation('APPLIED', await selectRun(client, runId, [secret]));
    });
}

/**
 * Applies one local CLI snapshot after atomic execution-identity, lease, and
 * per-stream offset checks. A stale snapshot is acknowledged without changing
 * output or node state so it cannot roll back a newer projection.
 */
export async function updateLocalCliExecution(
    pool: Pool,
    runId: string,
    lease: RunLease,
    update: LocalCliExecutionUpdate,
    secret: string,
): Promise<PersistenceMutationResult> {
    return withRunTransaction(pool, async (client) => {
        const runResult = await client.query<RunRow>(
            'SELECT * FROM runs WHERE run_id = $1 FOR UPDATE',
            [runId],
        );
        const row = runResult.rows[0];
        if (row == null) {
            return runMutation('MISSING');
        }
        if (!ACTIVE_PIPELINE_RUN_STATUSES.includes(row.status)) {
            return runMutation('ALREADY_TERMINAL', await selectRun(client, runId, [secret]));
        }
        if (!await hasActiveLease(client, runId, lease)) {
            return runMutation('FENCED');
        }
        if (row.cli_execution_id != null && row.cli_execution_id !== update.executionId) {
            return runMutation('FENCED');
        }

        const outputProjection = localCliOutputProjection(row, update, secret);
        if (outputProjection.isStale) {
            return runMutation('APPLIED', await selectRun(client, runId, [secret]));
        }
        const projection = localCliExecutionProjection(row, update, outputProjection, secret);

        if (projection.runChanged) {
            await client.query(
                `
                    UPDATE runs
                    SET cli_execution_id = $2,
                        cli_state = $3,
                        cli_process_id = $4,
                        cli_run_directory = $5,
                        cli_started_at = $6,
                        cli_stdout_offset = $7,
                        cli_stderr_offset = $8,
                        command = $9::jsonb,
                        status = $10,
                        stdout = $11,
                        stderr = $12,
                        recovery_reason = CASE WHEN $3 = '${CliExecutionState.UNKNOWN}'
                            THEN COALESCE(recovery_reason, $13) ELSE recovery_reason END,
                        terminal_reason = CASE WHEN $3 = '${CliExecutionState.UNKNOWN}'
                            THEN COALESCE(terminal_reason, $13) ELSE terminal_reason END,
                        updated_at = CURRENT_TIMESTAMP
                    WHERE run_id = $1
                `,
                [
                    runId,
                    update.executionId,
                    update.state,
                    projection.nextProcessId,
                    projection.runDirectory,
                    projection.startedAt,
                    projection.stdoutOffset,
                    projection.stderrOffset,
                    JSON.stringify(projection.command),
                    projection.nextRunStatus,
                    projection.stdout,
                    projection.stderr,
                    projection.safeReason,
                ],
            );
        }
        const nodesChanged = await upsertNodeStatuses(client, runId, update.nodeStatuses);
        if (projection.previousState !== update.state) {
            await insertRunEvent(client, runId, 'LOCAL_CLI_STATE', update.state, {
                executionId: update.executionId,
                processId: update.processId,
                reason: projection.safeReason,
                state: update.state,
            }, row.correlation_id ?? undefined, [secret]);
        }
        if (projection.outputChanged || nodesChanged) {
            await insertRunEvent(client, runId, 'OUTPUT', update.runStatus, {
                nodeCount: Object.keys(update.nodeStatuses).length,
                stderrLength: projection.stderr.length,
                stdoutLength: projection.stdout.length,
            }, row.correlation_id ?? undefined, [secret]);
        }
        return runMutation('APPLIED', await selectRun(client, runId, [secret]));
    });
}

/** Completes a leased run, resolves a concurrent cancellation, and closes nodes. */
export async function completeRun(
    pool: Pool,
    runId: string,
    lease: RunLease,
    completion: RunCompletion,
    secret: string,
): Promise<PersistenceMutationResult> {
    return withRunTransaction(pool, async (client) => {
        const runResult = await client.query<RunRow>(
            'SELECT * FROM runs WHERE run_id = $1 FOR UPDATE',
            [runId],
        );
        const row = runResult.rows[0];
        if (row == null) {
            return runMutation('MISSING');
        }
        if (!ACTIVE_PIPELINE_RUN_STATUSES.includes(row.status)) {
            return runMutation('ALREADY_TERMINAL', await selectRun(client, runId, [secret]));
        }
        if (!await hasActiveLease(client, runId, lease)) {
            return runMutation('FENCED');
        }
        const now = completion.endedAt;
        const cancellation = await client.query<{ reason: string | null }>(
            `
                SELECT reason
                FROM run_cancellations
                WHERE run_id = $1 AND effective_at IS NULL
                FOR UPDATE
            `,
            [runId],
        );
        const outcome = resolveRunCompletion(
            completion,
            cancellation.rows[0]?.reason,
            cancellation.rowCount === 1,
            secret,
        );
        await client.query(
            `
                UPDATE runs
                SET status = $2, command = $3::jsonb, exit_code = $4,
                    ended_at = $5, stdout = $6, stderr = $7,
                    terminal_reason = $8, recovery_reason = $9,
                    lease_lost = $10, terminal_event_at = $5,
                    cli_state = COALESCE($11, cli_state), updated_at = $5
                WHERE run_id = $1
            `,
            [
                runId,
                outcome.status,
                JSON.stringify(sanitizeCommand(completion.command, [secret])),
                outcome.exitCode,
                now,
                outcome.stdout,
                outcome.stderr,
                outcome.terminalReason,
                outcome.recoveryReason,
                completion.leaseLost ?? false,
                completion.cliState ?? null,
            ],
        );
        await updateRunSuccessDependency(
            client,
            runId,
            outcome.status === RunStatus.SUCCEEDED && row.mode !== 'dry-run' ? 'READY' : 'SKIPPED',
            now,
        );
        await upsertNodeStatuses(client, runId, completion.nodeStatuses ?? {});
        await finalizeActiveNodeStatuses(client, runId, outcome.status, now);
        await client.query(
            'DELETE FROM run_leases WHERE run_id = $1 AND owner_id = $2 AND lease_token = $3',
            [runId, lease.ownerId, lease.leaseToken],
        );
        if (outcome.canceled) {
            await client.query(
                'UPDATE run_cancellations SET effective_at = $2 WHERE run_id = $1',
                [runId, now],
            );
        }
        const run = await selectRun(client, runId, [secret]);
        if (run == null) {
            throw new Error('PostgreSQL did not return the completed pipeline run.');
        }
        await insertRunEvent(client, runId, outcome.status, outcome.status, {
            exitCode: outcome.exitCode,
        }, run.correlationId, [secret]);
        await insertAuditEvent(client, {
            eventType: auditEventTypeForRunStatus(outcome.status),
            payload: { exitCode: outcome.exitCode },
            pipelineId: run.pipelineId,
            runId,
            correlationId: run.correlationId,
            requestSource: run.requestSource,
        }, [secret]);
        return runMutation('APPLIED', run);
    });
}

/** Fails work that cannot be prepared, and closes any initial active nodes. */
export async function failRunBeforeExecution(
    pool: Pool,
    runId: string,
    lease: RunLease,
    message: string,
    secret: string,
): Promise<PersistenceMutationResult> {
    return withRunTransaction(pool, async (client) => {
        const runResult = await client.query<RunRow>(
            'SELECT * FROM runs WHERE run_id = $1 FOR UPDATE',
            [runId],
        );
        const row = runResult.rows[0];
        if (row == null) {
            return runMutation('MISSING');
        }
        if (!ACTIVE_PIPELINE_RUN_STATUSES.includes(row.status)) {
            return runMutation('ALREADY_TERMINAL', await selectRun(client, runId, [secret]));
        }
        if (!await hasActiveLease(client, runId, lease)) {
            return runMutation('FENCED');
        }
        const now = new Date().toISOString();
        const stderr = sanitizeText(message, [secret]);
        await client.query(
            `
                UPDATE runs
                SET status = '${RunStatus.FAILED}', exit_code = 1, ended_at = $2,
                    stderr = $3, terminal_reason = 'PREPARATION',
                    terminal_event_at = $2, updated_at = $2
                WHERE run_id = $1
            `,
            [runId, now, stderr],
        );
        await updateRunSuccessDependency(client, runId, 'SKIPPED', now);
        await finalizeActiveNodeStatuses(client, runId, RunStatus.FAILED, now);
        await client.query(
            'DELETE FROM run_leases WHERE run_id = $1 AND owner_id = $2 AND lease_token = $3',
            [runId, lease.ownerId, lease.leaseToken],
        );
        const run = await selectRun(client, runId, [secret]);
        if (run == null) {
            throw new Error('PostgreSQL did not return the failed pipeline run.');
        }
        await insertRunEvent(
            client,
            runId,
            RunStatus.FAILED,
            RunStatus.FAILED,
            { reason: 'PREPARATION' },
            run.correlationId,
            [secret],
        );
        await insertAuditEvent(client, {
            eventType: 'RUN_FAILED_PREPARATION',
            payload: { message: stderr },
            pipelineId: run.pipelineId,
            runId,
            correlationId: run.correlationId,
            requestSource: run.requestSource,
        }, [secret]);
        return runMutation('APPLIED', run);
    });
}

async function updateRunSuccessDependency(
    client: PoolClient,
    runId: string,
    status: 'READY' | 'SKIPPED',
    now: string,
): Promise<void> {
    await client.query(
        `
            UPDATE pipeline_run_success_dependencies
            SET status = $2, next_attempt_at = $3, updated_at = $3
            WHERE source_run_id = $1 AND status = 'WAITING'
        `,
        [runId, status, now],
    );
}

function localCliOutputProjection(
    row: RunRow,
    update: LocalCliExecutionUpdate,
    secret: string,
) {
    const stdoutOffset = normalizedOffset(update.stdoutOffset);
    const stderrOffset = normalizedOffset(update.stderrOffset);
    const previousStdoutOffset = Number(row.cli_stdout_offset);
    const previousStderrOffset = Number(row.cli_stderr_offset);
    const stdout = sanitizeText(update.stdout, [secret]);
    const stderr = sanitizeText(update.stderr, [secret]);
    const outputConflictsAtSameOffset =
        (stdoutOffset === previousStdoutOffset && (row.stdout ?? '') !== stdout) ||
        (stderrOffset === previousStderrOffset && (row.stderr ?? '') !== stderr);
    return {
        isStale: stdoutOffset < previousStdoutOffset ||
            stderrOffset < previousStderrOffset ||
            outputConflictsAtSameOffset || cliStateRegresses(row.cli_state, update.state),
        previousStdoutOffset,
        previousStderrOffset,
        stderr,
        stderrOffset,
        stdout,
        stdoutOffset,
    };
}

function localCliExecutionProjection(
    row: RunRow,
    update: LocalCliExecutionUpdate,
    output: ReturnType<typeof localCliOutputProjection>,
    secret: string,
) {
    const outputChanged = row.stdout !== output.stdout || row.stderr !== output.stderr;
    const existingStartedAt = row.cli_started_at == null
        ? null
        : dateString(row.cli_started_at);
    const startedAt = update.startedAt ?? existingStartedAt;
    const nextProcessId = update.processId ?? (row.cli_process_id == null
        ? null
        : Number(row.cli_process_id));
    const nextRunStatus = row.status === RunStatus.RUNNING
        ? row.status
        : update.runStatus;
    const safeReason = update.reason == null
        ? null
        : sanitizeText(update.reason, [secret]).slice(0, 2000);
    const command = sanitizeCommand(update.command, [secret]);
    const runDirectory = sanitizeText(update.runDirectory, [secret]);

    return {
        command,
        nextProcessId,
        nextRunStatus,
        outputChanged,
        previousState: row.cli_state,
        runChanged: row.cli_execution_id !== update.executionId ||
            row.cli_state !== update.state ||
            (row.cli_process_id == null ? null : Number(row.cli_process_id)) !== nextProcessId ||
            row.cli_run_directory !== runDirectory ||
            existingStartedAt !== startedAt ||
            output.previousStdoutOffset !== output.stdoutOffset ||
            output.previousStderrOffset !== output.stderrOffset ||
            JSON.stringify(row.command) !== JSON.stringify(command) ||
            row.status !== nextRunStatus ||
            outputChanged ||
            (update.state === CliExecutionState.UNKNOWN && row.recovery_reason == null && safeReason != null) ||
            (update.state === CliExecutionState.UNKNOWN && row.terminal_reason == null && safeReason != null),
        runDirectory,
        safeReason,
        startedAt,
        stderr: output.stderr,
        stderrOffset: output.stderrOffset,
        stdout: output.stdout,
        stdoutOffset: output.stdoutOffset,
    };
}

function resolveRunCompletion(
    completion: RunCompletion,
    rawCancellationReason: string | null | undefined,
    cancellationRequested: boolean,
    secret: string,
) {
    const cancellationReason = rawCancellationReason == null
        ? undefined
        : sanitizeText(rawCancellationReason, [secret]);
    const canceled = cancellationRequested && completion.status !== RunStatus.UNKNOWN;
    const rawStderr = sanitizeText(completion.stderr, [secret]);
    const stderr = canceled
        ? [rawStderr, cancellationReason ?? 'Run canceled by the caller.']
            .filter(Boolean)
            .join('\n')
        : rawStderr;
    const terminalReason = completion.terminalReason == null
        ? canceled
            ? cancellationReason ?? 'Run canceled by the caller.'
            : null
        : sanitizeText(completion.terminalReason, [secret]).slice(0, 2000);
    return {
        canceled,
        exitCode: canceled ? 130 : completion.exitCode,
        recoveryReason: completion.recoveryReason == null
            ? null
            : sanitizeText(completion.recoveryReason, [secret]).slice(0, 2000),
        status: canceled ? RunStatus.CANCELED : completion.status,
        stderr,
        stdout: sanitizeText(completion.stdout, [secret]),
        terminalReason,
    };
}

function normalizedOffset(value: number): number {
    return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function cliStateRegresses(
    current: CliExecutionState | null,
    next: CliExecutionState,
): boolean {
    if (current == null || current === next) {
        return false;
    }
    if (!ACTIVE_CLI_EXECUTION_STATUSES.includes(current)) {
        return true;
    }
    return current === CliExecutionState.RUNNING && next === CliExecutionState.STARTING;
}
