/**
 * @fileoverview PostgreSQL run lease renewal, release, and recovery.
 */

import crypto from 'node:crypto';
import type { Pool } from 'pg';
import {
    ACTIVE_PIPELINE_RUN_STATUSES,
    RunStatus,
    auditEventTypeForRunStatus,
} from '../../../shared/status/run.ts';
import type { PipelineRun } from '../../../shared/pipelineRegistryTypes.ts';
import type {
    PersistenceMutationResult,
    RunLease,
} from '../../types/pipelinePersistenceTypes.ts';
import { logStructured } from '../../utils/structuredLogging.ts';
import { sanitizeText } from '../../utils/sanitization.ts';
import { dateString } from '../postgresPersistenceUtils.ts';
import { insertAuditEvent } from '../postgresAuditPersistence.ts';
import {
    finalizeActiveNodeStatuses,
    getRun,
    hasActiveLease,
    insertRunEvent,
    selectRun,
} from './postgresRunQueries.ts';
import {
    DEFAULT_RUN_LEASE_MILLISECONDS,
    type RunRow,
    WORKER_ACTIVE_RUN_STATUS_SQL_LIST,
    runMutation,
} from './postgresRunMappers.ts';
import { withRunTransaction } from './postgresRunTransactions.ts';

/** Claims an expired local CLI execution for inspection without resubmitting it. */
export async function claimNextRecoverableRun(
    pool: Pool,
    ownerId: string,
    leaseMilliseconds: number,
    secret: string,
): Promise<{ lease: RunLease; run: PipelineRun } | undefined> {
    const leaseDuration = Math.max(1_000, leaseMilliseconds || DEFAULT_RUN_LEASE_MILLISECONDS);
    for (;;) {
        const result = await withRunTransaction(pool, async (client) => {
            const candidateResult = await client.query<RunRow>(
                `
                    SELECT r.*
                    FROM runs r
                    WHERE r.status IN (${WORKER_ACTIVE_RUN_STATUS_SQL_LIST})
                      AND r.cli_execution_id IS NOT NULL
                      AND NOT EXISTS (
                          SELECT 1
                          FROM run_leases l
                          WHERE l.run_id = r.run_id
                            AND l.expires_at > CURRENT_TIMESTAMP
                      )
                    ORDER BY r.started_at, r.run_id
                    FOR UPDATE OF r SKIP LOCKED
                    LIMIT 1
                `,
            );
            const row = candidateResult.rows[0];
            if (row == null) {
                return { kind: 'EMPTY' as const };
            }

            const existingLease = await client.query<{ active: boolean }>(
                `
                    SELECT expires_at > CURRENT_TIMESTAMP AS active
                    FROM run_leases
                    WHERE run_id = $1
                    FOR UPDATE
                `,
                [row.run_id],
            );
            if (existingLease.rows[0]?.active) {
                return { kind: 'RETRY' as const };
            }

            const leaseToken = crypto.randomUUID();
            await client.query('DELETE FROM run_leases WHERE run_id = $1', [row.run_id]);
            const leaseResult = await client.query<{ expires_at: Date | string }>(
                `
                    INSERT INTO run_leases (
                        run_id, owner_id, lease_token, acquired_at, heartbeat_at, expires_at
                    ) VALUES (
                        $1, $2, $3, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP,
                        CURRENT_TIMESTAMP + ($4 * INTERVAL '1 millisecond')
                    )
                    RETURNING expires_at
                `,
                [row.run_id, ownerId, leaseToken, leaseDuration],
            );
            const expiresAt = leaseResult.rows[0]?.expires_at;
            if (expiresAt == null) {
                throw new Error('PostgreSQL did not return the local CLI recovery lease expiration.');
            }
            const leaseExpiresAt = dateString(expiresAt);
            const cliExecutionId = sanitizeText(row.cli_execution_id!, [secret]);
            await insertRunEvent(client, row.run_id, 'LOCAL_CLI_RECOVERY_CLAIMED', row.status, {
                leaseExpiresAt,
                ownerId,
                cliExecutionId,
                cliProcessId: row.cli_process_id,
            }, row.correlation_id ?? undefined, [secret]);
            await insertAuditEvent(client, {
                eventType: 'LOCAL_CLI_RECOVERY_CLAIMED',
                payload: {
                    leaseExpiresAt,
                    ownerId,
                    cliExecutionId,
                    cliProcessId: row.cli_process_id,
                },
                pipelineId: row.pipeline_id,
                runId: row.run_id,
                correlationId: row.correlation_id ?? undefined,
                requestSource: row.request_source ?? undefined,
            }, [secret]);
            const run = await selectRun(client, row.run_id, [secret]);
            if (run == null) {
                throw new Error('PostgreSQL did not return the reattached pipeline run.');
            }
            return {
                kind: 'CLAIMED' as const,
                claim: { lease: { leaseToken, ownerId }, run },
            };
        });
        if (result.kind === 'RETRY') {
            continue;
        }
        return result.kind === 'CLAIMED' ? result.claim : undefined;
    }
}

/** Renews a live run lease only while the token remains unexpired and active. */
export async function renewLease(
    pool: Pool,
    runId: string,
    lease: RunLease,
    leaseMilliseconds: number,
): Promise<PersistenceMutationResult> {
    const leaseDuration = Math.max(1_000, leaseMilliseconds || DEFAULT_RUN_LEASE_MILLISECONDS);
    const result = await pool.query<{ run_id: string }>(
        `
            UPDATE run_leases
            SET heartbeat_at = CURRENT_TIMESTAMP,
                expires_at = CURRENT_TIMESTAMP + ($4 * INTERVAL '1 millisecond')
            WHERE run_id = $1 AND owner_id = $2 AND lease_token = $3
              AND expires_at > CURRENT_TIMESTAMP
              AND EXISTS (
                  SELECT 1
                  FROM runs
                  WHERE runs.run_id = $1
                    AND runs.status IN (${WORKER_ACTIVE_RUN_STATUS_SQL_LIST})
              )
            RETURNING run_id
        `,
        [runId, lease.ownerId, lease.leaseToken, leaseDuration],
    );
    if (result.rowCount === 1) {
        return runMutation('APPLIED');
    }

    const run = await getRun(pool, runId);
    if (run == null) {
        return runMutation('MISSING');
    }
    return !ACTIVE_PIPELINE_RUN_STATUSES.includes(run.status)
        ? runMutation('ALREADY_TERMINAL', run)
        : runMutation('FENCED');
}

/**
 * Releases a lease for an identified local execution so another worker can
 * inspect it. Before an execution identity is recorded, it leaves the lease
 * in place to expire and be reconciled instead of stranding an active row.
 */
export async function releaseLease(
    pool: Pool,
    runId: string,
    lease: RunLease,
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
            return runMutation('ALREADY_TERMINAL', await selectRun(client, runId));
        }
        if (!await hasActiveLease(client, runId, lease)) {
            return runMutation('FENCED');
        }
        if (row.cli_execution_id != null) {
            await client.query(
                'DELETE FROM run_leases WHERE run_id = $1 AND owner_id = $2 AND lease_token = $3',
                [runId, lease.ownerId, lease.leaseToken],
            );
        }
        return runMutation('APPLIED', await selectRun(client, runId));
    });
}

/**
 * Closes expired or missing leases for active runs without a local CLI
 * identity. Persisted legacy execution identities become UNKNOWN; runs with no
 * execution identity are failed as not yet dispatched. Identified local CLI
 * runs remain eligible for monitor-only recovery claims.
 */
export async function reconcileExpiredLeases(
    pool: Pool,
    secret: string,
    batchSize = 100,
): Promise<void> {
    const boundedBatchSize = Math.min(1_000, Math.max(1, Math.floor(batchSize)));
    await withRunTransaction(pool, async (client) => {
        const result = await client.query<RunRow>(
            `
                SELECT r.*
                FROM runs r
                WHERE r.status IN (${WORKER_ACTIVE_RUN_STATUS_SQL_LIST})
                  AND r.cli_execution_id IS NULL
                  AND NOT EXISTS (
                      SELECT 1
                      FROM run_leases l
                      WHERE l.run_id = r.run_id
                        AND l.expires_at > CURRENT_TIMESTAMP
                  )
                ORDER BY r.updated_at, r.run_id
                FOR UPDATE OF r SKIP LOCKED
                LIMIT $1
            `,
            [boundedBatchSize],
        );
        for (const row of result.rows) {
            const hasLegacyExecutionIdentity = row.remote_execution_id != null ||
                row.spark_session_id != null || row.spark_operation_id != null;
            const terminalStatus: PipelineRun['status'] = hasLegacyExecutionIdentity
                ? RunStatus.UNKNOWN
                : RunStatus.FAILED;
            const recoveryReason = hasLegacyExecutionIdentity
                ? 'LOCAL_CLI_IDENTITY_UNAVAILABLE'
                : 'LEASE_EXPIRED';
            const diagnostic = sanitizeText(
                hasLegacyExecutionIdentity
                    ? 'The previous execution identity cannot be monitored by the local CLI runtime; the outcome is unknown.'
                    : 'The worker lease expired before a local CLI execution was recorded; run classified as abandoned.',
                [secret],
            );
            const now = new Date().toISOString();
            await client.query(
                `
                    UPDATE runs
                    SET status = $4, exit_code = CASE WHEN $4 = '${RunStatus.UNKNOWN}' THEN NULL ELSE 1 END,
                        ended_at = $2,
                        stderr = CASE
                            WHEN stderr IS NULL OR stderr = '' THEN $3
                            ELSE stderr || E'\\n' || $3
                        END,
                        recovery_reason = $5,
                        lease_lost = true,
                        terminal_reason = $5,
                        terminal_event_at = $2,
                        updated_at = $2
                    WHERE run_id = $1
                `,
                [row.run_id, now, diagnostic, terminalStatus, recoveryReason],
            );
            await client.query(
                `
                    UPDATE pipeline_run_success_dependencies
                    SET status = 'SKIPPED', updated_at = $2
                    WHERE source_run_id = $1 AND status = 'WAITING'
                `,
                [row.run_id, now],
            );
            await finalizeActiveNodeStatuses(client, row.run_id, terminalStatus, now);
            await client.query('DELETE FROM run_leases WHERE run_id = $1', [row.run_id]);
            const eventType = hasLegacyExecutionIdentity ? RunStatus.UNKNOWN : 'ABANDONED';
            await insertRunEvent(client, row.run_id, eventType, terminalStatus, {
                reason: recoveryReason,
            }, row.correlation_id ?? undefined, [secret]);
            await insertAuditEvent(client, {
                eventType: hasLegacyExecutionIdentity
                    ? auditEventTypeForRunStatus(RunStatus.UNKNOWN)
                    : 'RUN_ABANDONED',
                payload: { reason: recoveryReason },
                pipelineId: row.pipeline_id,
                runId: row.run_id,
                correlationId: row.correlation_id ?? undefined,
                requestSource: row.request_source ?? undefined,
            }, [secret]);
            logStructured('run_recovered', {
                correlationId: row.correlation_id ?? undefined,
                pipelineId: row.pipeline_id,
                reason: recoveryReason,
                requestSource: row.request_source ?? undefined,
                runId: row.run_id,
            });
        }
    });
}
