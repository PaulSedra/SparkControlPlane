/**
 * @fileoverview Durable, retryable success-dependency outbox operations.
 */

import type { Pool } from 'pg';
import type { RunSuccessDependency } from '../../types/pipelinePersistenceTypes.ts';
import { sanitizeText } from '../../utils/sanitization.ts';
import { dateString } from '../postgresPersistenceUtils.ts';
import { withRunTransaction } from './postgresRunTransactions.ts';

interface RunSuccessDependencyRow {
    attempt_count: number;
    next_attempt_at: Date | string;
    source_pipeline_id: string;
    source_run_id: string;
    target_pipeline_id: string;
}

interface RunSuccessDependencyStateRow {
    status: string;
    target_pipeline_id: string;
    target_run_id: string | null;
}

/** Returns due handoffs in deterministic order for an at-least-once dispatcher. */
export async function listReadyRunSuccessDependencies(
    pool: Pool,
    limit = 20,
): Promise<RunSuccessDependency[]> {
    const boundedLimit = Math.min(100, Math.max(1, Math.floor(limit)));
    const result = await pool.query<RunSuccessDependencyRow>(
        `
            SELECT source_run_id, source_pipeline_id, target_pipeline_id,
                   attempt_count, next_attempt_at
            FROM pipeline_run_success_dependencies
            WHERE status = 'READY' AND next_attempt_at <= NOW()
            ORDER BY next_attempt_at, created_at, source_run_id
            LIMIT $1
        `,
        [boundedLimit],
    );
    return result.rows.map((row) => ({
        attemptCount: row.attempt_count,
        nextAttemptAt: dateString(row.next_attempt_at),
        sourcePipelineId: row.source_pipeline_id,
        sourceRunId: row.source_run_id,
        targetPipelineId: row.target_pipeline_id,
    }));
}

/** Marks a handoff submitted after the target run has been persisted. */
export async function markRunSuccessDependencySubmitted(
    pool: Pool,
    sourceRunId: string,
    targetRunId: string,
): Promise<void> {
    await withRunTransaction(pool, async (client) => {
        const existing = await client.query<RunSuccessDependencyStateRow>(
            `
                SELECT status, target_pipeline_id, target_run_id
                FROM pipeline_run_success_dependencies
                WHERE source_run_id = $1
                FOR UPDATE
            `,
            [sourceRunId],
        );
        const row = existing.rows[0];
        if (row == null) {
            throw new Error(`Unknown pipeline success dependency for run ${sourceRunId}.`);
        }
        if (row.status === 'SUBMITTED' && row.target_run_id === targetRunId) {
            return;
        }
        if (row.status !== 'READY') {
            throw new Error(`Pipeline success dependency for run ${sourceRunId} is ${row.status}.`);
        }
        const targetRun = await client.query<{ pipeline_id: string }>(
            'SELECT pipeline_id FROM runs WHERE run_id = $1',
            [targetRunId],
        );
        if (targetRun.rows[0]?.pipeline_id !== row.target_pipeline_id) {
            throw new Error(`Pipeline success dependency for run ${sourceRunId} targeted the wrong pipeline.`);
        }
        await client.query(
            `
                UPDATE pipeline_run_success_dependencies
                SET status = 'SUBMITTED', target_run_id = $2, last_error = NULL,
                    updated_at = NOW()
                WHERE source_run_id = $1
            `,
            [sourceRunId, targetRunId],
        );
    });
}

/** Retains a failure and delays the next retry without consuming the handoff. */
export async function recordRunSuccessDependencyFailure(
    pool: Pool,
    sourceRunId: string,
    message: string,
    nextAttemptAt: string,
    secret: string,
): Promise<void> {
    const safeMessage = sanitizeText(message, [secret]).slice(0, 2000);
    await pool.query(
        `
            UPDATE pipeline_run_success_dependencies
            SET attempt_count = attempt_count + 1,
                next_attempt_at = $2,
                last_error = $3,
                updated_at = NOW()
            WHERE source_run_id = $1 AND status = 'READY'
        `,
        [sourceRunId, nextAttemptAt, safeMessage],
    );
}
