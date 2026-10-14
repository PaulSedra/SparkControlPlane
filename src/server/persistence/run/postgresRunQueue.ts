/**
 * @fileoverview PostgreSQL run submission, idempotency, and atomic claims.
 */

import crypto from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import {
    RunStatus,
} from '../../../shared/status/run.ts';
import { ControlPlaneApiError } from '../../errors/controlPlaneApiError.ts';
import type { PipelineRun } from '../../../shared/pipelineRegistryTypes.ts';
import type {
    PersistedRunSubmission,
    RunLease,
} from '../../types/pipelinePersistenceTypes.ts';
import type { RunSubmissionResult } from '../../types/pipelineServiceTypes.ts';
import { sanitizeFields, sanitizeText } from '../../utils/sanitization.ts';
import { insertAuditEvent } from '../postgresAuditPersistence.ts';
import { insertRunEvent, selectRun, upsertNodeStatuses } from './postgresRunQueries.ts';
import {
    DEFAULT_RUN_LEASE_MILLISECONDS,
    type DeploymentRow,
    type IdempotencyRow,
    type RunRow,
    WORKER_ACTIVE_RUN_STATUS_SQL_LIST,
} from './postgresRunMappers.ts';
import { withRunTransaction } from './postgresRunTransactions.ts';

/**
 * Persists a queued run and its idempotency mapping atomically. Equivalent
 * requests replay the original run; a reused key with different canonical
 * submission settings returns HTTP 409.
 */
export async function submitRun(
    pool: Pool,
    submission: PersistedRunSubmission,
    secret: string,
): Promise<RunSubmissionResult> {
    const fingerprint = runSubmissionFingerprint(submission);
    const safeCallerMetadata = submission.callerMetadata == null
        ? null
        : sanitizeFields(submission.callerMetadata, [secret]) as Record<string, string>;
    const requestSource = submission.requestSource == null
        ? null
        : sanitizeText(submission.requestSource, [secret]);
    const correlationId = submission.correlationId == null
        ? null
        : sanitizeText(submission.correlationId, [secret]);

    return withRunTransaction(pool, async (client) => {
        const existingRun = await findExistingIdempotentRun(
            client,
            submission.idempotencyKey,
            fingerprint,
            [secret],
        );
        if (existingRun != null) {
            return { replayed: true, run: existingRun };
        }

        await assertRunDeployment(client, submission);

        const runId = crypto.randomUUID();
        const now = new Date().toISOString();
        await client.query(
            `
                INSERT INTO runs (
                    run_id, pipeline_id, version_id, source_hash, idempotency_key,
                    mode, repaired_node_names, target_node_names, spark_app_name, status, started_at,
                    created_at, updated_at, allow_overlap, timeout_seconds,
                    caller_metadata, request_source, correlation_id
                ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9, '${RunStatus.QUEUED}', $10, $10, $10,
                    $11, $12, $13::jsonb, $14, $15)
            `,
            [
                runId,
                submission.pipelineId,
                submission.versionId,
                submission.sourceHash,
                submission.idempotencyKey ?? null,
                submission.mode,
                submission.repairedNodeNames == null
                    ? null
                    : JSON.stringify(submission.repairedNodeNames),
                submission.targetNodeNames == null
                    ? null
                    : JSON.stringify(submission.targetNodeNames),
                submission.sparkAppName,
                now,
                submission.policy?.allowOverlap ?? false,
                submission.policy?.timeoutSeconds ?? null,
                safeCallerMetadata == null ? null : JSON.stringify(safeCallerMetadata),
                requestSource,
                correlationId,
            ],
        );
        if (submission.successorPipelineId != null) {
            if (submission.successorPipelineId === submission.pipelineId) {
                throw new ControlPlaneApiError(400, 'A pipeline cannot be its own on_success successor.');
            }
            await client.query(
                `
                    INSERT INTO pipeline_run_success_dependencies (
                        source_run_id, source_pipeline_id, target_pipeline_id, status,
                        next_attempt_at, created_at, updated_at
                    ) VALUES ($1, $2, $3, 'WAITING', $4, $4, $4)
                `,
                [runId, submission.pipelineId, submission.successorPipelineId, now],
            );
        }
        await insertSubmissionMetadata(client, submission, fingerprint, runId, now);
        await insertRunEvent(client, runId, RunStatus.QUEUED, RunStatus.QUEUED, {
            mode: submission.mode,
            sourceHash: submission.sourceHash,
            versionId: submission.versionId,
        }, correlationId ?? undefined, [secret]);
        await insertAuditEvent(client, {
            eventType: 'RUN_SUBMITTED',
            payload: {
                mode: submission.mode,
                versionId: submission.versionId,
                callerMetadata: safeCallerMetadata ?? {},
            },
            pipelineId: submission.pipelineId,
            runId,
            correlationId: correlationId ?? undefined,
            requestSource: requestSource ?? undefined,
        }, [secret]);
        const run = await selectRun(client, runId, [secret]);
        if (run == null) {
            throw new Error('PostgreSQL did not return the queued pipeline run.');
        }
        return { replayed: false, run };
    });
}

/** Resolves the run already associated with an idempotency key for dependency recovery. */
export async function getRunByIdempotencyKey(
    pool: Pool,
    idempotencyKey: string,
    secret: string,
): Promise<PipelineRun | undefined> {
    return withRunTransaction(pool, async (client) => {
        const result = await client.query<{ run_id: string }>(
            'SELECT run_id FROM idempotency_keys WHERE idempotency_key = $1',
            [idempotencyKey],
        );
        const runId = result.rows[0]?.run_id;
        return runId == null ? undefined : selectRun(client, runId, [secret]);
    });
}

/**
 * Claims the oldest eligible queue row. Pipeline row locking and a second
 * eligibility check keep non-overlap runs atomic across concurrent workers;
 * opted-in runs may share a pipeline with existing active work.
 */
export async function claimNextQueuedRun(
    pool: Pool,
    ownerId: string,
    leaseMilliseconds: number,
    secret: string,
): Promise<{ lease: RunLease; run: PipelineRun } | undefined> {
    const leaseDuration = Math.max(1_000, leaseMilliseconds || DEFAULT_RUN_LEASE_MILLISECONDS);
    for (;;) {
        const result = await withRunTransaction(pool, async (client) => {
            const queued = await client.query<RunRow>(
                `
                    SELECT r.*
                    FROM runs r
                    WHERE r.status = '${RunStatus.QUEUED}'
                      AND NOT EXISTS (
                          SELECT 1 FROM run_cancellations c WHERE c.run_id = r.run_id
                      )
                      AND (
                          r.allow_overlap
                          OR NOT EXISTS (
                              SELECT 1
                              FROM runs active
                              WHERE active.pipeline_id = r.pipeline_id
                                AND active.status IN (${WORKER_ACTIVE_RUN_STATUS_SQL_LIST})
                          )
                      )
                    ORDER BY r.queue_sequence, r.created_at, r.run_id
                    FOR UPDATE SKIP LOCKED
                    LIMIT 1
                `,
            );
            let row = queued.rows[0];
            if (row == null) {
                return { kind: 'EMPTY' as const };
            }

            // Serialize same-pipeline decisions, then recheck after acquiring
            // the pipeline lock because the initial candidate snapshot may be stale.
            await client.query(
                'SELECT id FROM pipelines WHERE id = $1 FOR UPDATE',
                [row.pipeline_id],
            );
            const eligible = await client.query<RunRow>(
                `
                    SELECT r.*
                    FROM runs r
                    WHERE r.run_id = $1
                      AND r.status = '${RunStatus.QUEUED}'
                      AND NOT EXISTS (
                          SELECT 1 FROM run_cancellations c WHERE c.run_id = r.run_id
                      )
                      AND (
                          r.allow_overlap
                          OR NOT EXISTS (
                              SELECT 1
                              FROM runs active
                              WHERE active.pipeline_id = r.pipeline_id
                                AND active.status IN (${WORKER_ACTIVE_RUN_STATUS_SQL_LIST})
                          )
                      )
                    FOR UPDATE
                `,
                [row.run_id],
            );
            row = eligible.rows[0];
            if (row == null) {
                return { kind: 'RETRY' as const };
            }

            const leaseToken = crypto.randomUUID();
            await client.query(
                `
                    UPDATE runs
                    SET status = '${RunStatus.SUBMITTING}', updated_at = CURRENT_TIMESTAMP
                    WHERE run_id = $1
                `,
                [row.run_id],
            );
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
                throw new Error('PostgreSQL did not return the claimed lease expiration.');
            }
            const leaseExpiresAt = new Date(expiresAt).toISOString();
            await insertRunEvent(client, row.run_id, 'RUN_CLAIMED', RunStatus.SUBMITTING, {
                ownerId,
                leaseExpiresAt,
            }, row.correlation_id ?? undefined, [secret]);
            await insertAuditEvent(client, {
                eventType: 'RUN_CLAIMED',
                payload: { ownerId, leaseExpiresAt },
                pipelineId: row.pipeline_id,
                runId: row.run_id,
                correlationId: row.correlation_id ?? undefined,
                requestSource: row.request_source ?? undefined,
            }, [secret]);
            const run = await selectRun(client, row.run_id, [secret]);
            if (run == null) {
                throw new Error('PostgreSQL did not return the claimed pipeline run.');
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

function runSubmissionFingerprint(submission: PersistedRunSubmission): string {
    const settings = {
        allowOverlap: submission.policy?.allowOverlap ?? false,
        callerMetadata: submission.callerMetadata ?? {},
        mode: submission.mode,
        pipelineId: submission.pipelineId,
        repairedNodeNames: submission.repairedNodeNames ?? [],
        sparkAppName: submission.sparkAppName,
        targetNodeNames: submission.targetNodeNames ?? [],
        sourceHash: submission.sourceHash,
        requestSource: submission.requestSource ?? null,
        successorPipelineId: submission.successorPipelineId ?? null,
        timeoutSeconds: submission.policy?.timeoutSeconds ?? null,
        versionId: submission.versionId,
    };
    return crypto.createHash('sha256')
        .update(JSON.stringify(canonicalize(settings)))
        .digest('hex');
}

async function findExistingIdempotentRun(
    client: PoolClient,
    idempotencyKey: string | undefined,
    fingerprint: string,
    additionalSecrets: readonly string[],
): Promise<PipelineRun | undefined> {
    if (idempotencyKey == null) {
        return undefined;
    }
    await client.query(
        'SELECT pg_advisory_xact_lock(hashtext($1))',
        [idempotencyKey],
    );
    const existing = await client.query<IdempotencyRow>(
        'SELECT * FROM idempotency_keys WHERE idempotency_key = $1 FOR UPDATE',
        [idempotencyKey],
    );
    const existingKey = existing.rows[0];
    if (existingKey == null) {
        return undefined;
    }
    if (existingKey.request_fingerprint !== fingerprint) {
        throw new ControlPlaneApiError(
            409,
            'The idempotency key was already used for a different pipeline run request.',
        );
    }
    const existingRun = await selectRun(client, existingKey.run_id, additionalSecrets);
    if (existingRun == null) {
        throw new Error('Idempotency key references a missing pipeline run.');
    }
    return existingRun;
}

async function assertRunDeployment(
    client: PoolClient,
    submission: PersistedRunSubmission,
): Promise<void> {
    const deployment = await client.query<DeploymentRow>(
        `
            SELECT d.*, s.source_hash
            FROM pipeline_deployments d
            JOIN source_versions s
                ON s.pipeline_id = d.pipeline_id AND s.version_id = d.version_id
            WHERE d.pipeline_id = $1
              AND d.version_id = $2
            FOR UPDATE
        `,
        [submission.pipelineId, submission.versionId],
    );
    const deployed = deployment.rows[0];
    if (deployed == null) {
        throw new ControlPlaneApiError(409, 'Deploy this pipeline before running it.');
    }
    if (deployed.source_hash !== submission.sourceHash) {
        throw new ControlPlaneApiError(
            409,
            'Pipeline source has changed since deployment. Deploy the current version before running it.',
        );
    }
}

async function insertSubmissionMetadata(
    client: PoolClient,
    submission: PersistedRunSubmission,
    fingerprint: string,
    runId: string,
    now: string,
): Promise<void> {
    if (submission.idempotencyKey != null) {
        await client.query(
            `
                INSERT INTO idempotency_keys (
                    idempotency_key, pipeline_id, request_fingerprint, run_id, created_at
                ) VALUES ($1, $2, $3, $4, $5)
            `,
            [submission.idempotencyKey, submission.pipelineId, fingerprint, runId, now],
        );
    }
    if (submission.initialNodeStatuses != null) {
        await upsertNodeStatuses(client, runId, submission.initialNodeStatuses);
    }
}

function canonicalize(value: unknown): unknown {
    if (Array.isArray(value)) {
        return value.map(canonicalize);
    }
    if (value != null && typeof value === 'object') {
        return Object.fromEntries(Object.keys(value)
            .sort((left, right) => left.localeCompare(right))
            .map((key) => [key, canonicalize((value as Record<string, unknown>)[key])]));
    }
    return value;
}
