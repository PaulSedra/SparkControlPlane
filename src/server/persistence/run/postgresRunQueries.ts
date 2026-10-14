/**
 * @fileoverview PostgreSQL run-history queries and shared run SQL operations.
 */

import type { Pool, PoolClient } from 'pg';
import type {
    PipelineRun,
    PipelineRunNodeStatusRecord,
} from '../../../shared/pipelineRegistryTypes.ts';
import {
    pipelineRunNodeStatusForRun,
} from '../../../shared/status/node.ts';
import {
    ACTIVE_NODE_STATUS_SQL_LIST,
    type NodeStateRow,
    mapNodeStatus,
    mapRun,
    mapRunEvent,
    type RunEventRow,
    type RunRow,
    WORKER_ACTIVE_RUN_STATUS_SQL_LIST,
} from './postgresRunMappers.ts';
import type {
    OperationalSnapshot,
    PersistedRunPage,
    PipelineRunEvent,
    RunLease,
} from '../../types/pipelinePersistenceTypes.ts';
import { sanitizeFields, sanitizeText } from '../../utils/sanitization.ts';
import { boundedLimit, dateString } from '../postgresPersistenceUtils.ts';

interface RunPageRow extends RunRow {
    total_count: string;
}

/** Returns a run and its node projection, if the run is present. */
export async function getRun(
    pool: Pool,
    runId: string,
    additionalSecrets: readonly string[] = [],
): Promise<PipelineRun | undefined> {
    return selectRun(pool, runId, additionalSecrets);
}

/** Returns the most recently submitted run and its node projection. */
export async function getLatestRun(
    pool: Pool,
    pipelineId: string,
    additionalSecrets: readonly string[] = [],
): Promise<PipelineRun | undefined> {
    const result = await pool.query<RunRow>(
        `
            SELECT * FROM runs
            WHERE pipeline_id = $1
            ORDER BY started_at DESC, run_id DESC
            LIMIT 1
        `,
        [pipelineId],
    );
    const row = result.rows[0];
    return row == null ? undefined : selectRun(pool, row.run_id, additionalSecrets);
}

/** Returns all runs for a pipeline with node rows fetched in one batch. */
export async function listRuns(
    pool: Pool,
    pipelineId: string,
    additionalSecrets: readonly string[] = [],
): Promise<PipelineRun[]> {
    const result = await pool.query<RunRow>(
        `
            SELECT * FROM runs
            WHERE pipeline_id = $1
            ORDER BY started_at DESC, run_id DESC
        `,
        [pipelineId],
    );
    return selectRuns(pool, result.rows, additionalSecrets);
}

/**
 * Returns one offset page of runs and their node rows without materializing
 * unrelated history. The total count shares the page query snapshot whenever
 * the requested offset has results.
 */
export async function listRunsPage(
    pool: Pool,
    pipelineId: string,
    limit: number,
    offset: number,
    additionalSecrets: readonly string[] = [],
): Promise<PersistedRunPage> {
    const boundedPageLimit = boundedLimit(limit);
    const boundedPageOffset = boundedOffset(offset);
    const result = await pool.query<RunPageRow>(
        `
            SELECT r.*, COUNT(*) OVER()::text AS total_count
            FROM runs r
            WHERE r.pipeline_id = $1
            ORDER BY r.started_at DESC, r.run_id DESC
            LIMIT $2 OFFSET $3
        `,
        [pipelineId, boundedPageLimit, boundedPageOffset],
    );
    const firstRow = result.rows[0];
    const total = firstRow == null
        ? await countPipelineRuns(pool, pipelineId)
        : Number(firstRow.total_count);
    return {
        items: await selectRuns(pool, result.rows, additionalSecrets),
        offset: boundedPageOffset,
        total,
    };
}

/** Returns lifecycle events for one run in append order. */
export async function listRunEvents(
    pool: Pool,
    runId: string,
    additionalSecrets: readonly string[] = [],
): Promise<PipelineRunEvent[]> {
    const result = await pool.query<RunEventRow>(
        `
            SELECT event_id, run_id, event_type, status, payload, occurred_at, correlation_id
            FROM run_events
            WHERE run_id = $1
            ORDER BY event_id
        `,
        [runId],
    );
    return result.rows.map((row) => mapRunEvent(row, additionalSecrets));
}

/** Returns globally ordered run events after a stable event cursor. */
export async function listRunEventsAfter(
    pool: Pool,
    eventId: number,
    limit = 100,
    additionalSecrets: readonly string[] = [],
): Promise<PipelineRunEvent[]> {
    const result = await pool.query<RunEventRow>(
        `
            SELECT event_id, run_id, event_type, status, payload, occurred_at, correlation_id
            FROM run_events
            WHERE event_id > $1
            ORDER BY event_id
            LIMIT $2
        `,
        [eventId, boundedLimit(limit)],
    );
    return result.rows.map((row) => mapRunEvent(row, additionalSecrets));
}

/** Returns whether an unacknowledged cancellation is pending for active work. */
export async function isCancellationRequested(pool: Pool, runId: string): Promise<boolean> {
    const result = await pool.query(
        `
            SELECT 1
            FROM run_cancellations c
            JOIN runs r ON r.run_id = c.run_id
            WHERE c.run_id = $1
              AND c.effective_at IS NULL
              AND r.status IN (${WORKER_ACTIVE_RUN_STATUS_SQL_LIST})
            LIMIT 1
        `,
        [runId],
    );
    return result.rowCount === 1;
}

/** Returns aggregate active, queued, and overdue run counts for operations. */
export async function operationalSnapshot(pool: Pool): Promise<OperationalSnapshot> {
    const result = await pool.query<{
        active_runs: string;
        oldest_queued_at: Date | string | null;
        queued_runs: string;
        stuck_runs: string;
    }>(
        `
            SELECT
                COUNT(*) FILTER (WHERE r.status IN ('SUBMITTING', 'RUNNING'))::text AS active_runs,
                COUNT(*) FILTER (WHERE r.status = 'QUEUED')::text AS queued_runs,
                COUNT(*) FILTER (
                    WHERE r.status IN ('SUBMITTING', 'RUNNING')
                      AND COALESCE(l.acquired_at, r.started_at) +
                          make_interval(secs => r.timeout_seconds) < NOW()
                )::text AS stuck_runs,
                MIN(r.started_at) FILTER (WHERE r.status = 'QUEUED') AS oldest_queued_at
            FROM runs r
            LEFT JOIN run_leases l ON l.run_id = r.run_id
        `,
    );
    const row = result.rows[0];
    return {
        activeRuns: Number(row?.active_runs ?? 0),
        oldestQueuedAt: row?.oldest_queued_at == null
            ? undefined
            : dateString(row.oldest_queued_at),
        queuedRuns: Number(row?.queued_runs ?? 0),
        stuckRuns: Number(row?.stuck_runs ?? 0),
    };
}

/** Selects a run row plus its node states for a caller-owned transaction. */
export async function selectRun(
    client: Pool | PoolClient,
    runId: string,
    additionalSecrets: readonly string[] = [],
): Promise<PipelineRun | undefined> {
    const result = await client.query<RunRow>(
        'SELECT * FROM runs WHERE run_id = $1',
        [runId],
    );
    const row = result.rows[0];
    if (row == null) {
        return undefined;
    }
    const nodeStatuses = await selectNodeStatuses(client, [runId]);
    return mapRun(row, nodeStatuses.get(runId) ?? {}, additionalSecrets);
}

/** Maps already-selected run rows with one query for all associated nodes. */
export async function selectRuns(
    client: Pool | PoolClient,
    rows: RunRow[],
    additionalSecrets: readonly string[] = [],
): Promise<PipelineRun[]> {
    if (rows.length === 0) {
        return [];
    }
    const runIds = rows.map((row) => row.run_id);
    const nodeStatusesByRun = await selectNodeStatuses(client, runIds);
    return rows.map((row) => mapRun(
        row,
        nodeStatusesByRun.get(row.run_id) ?? {},
        additionalSecrets,
    ));
}

/** Writes a sanitized append-only run event within the caller's transaction. */
export async function insertRunEvent(
    client: PoolClient,
    runId: string,
    eventType: string,
    status: string,
    payload: Record<string, unknown>,
    correlationId?: string,
    additionalSecrets: readonly string[] = [],
): Promise<void> {
    await client.query(
        `
            INSERT INTO run_events (run_id, event_type, status, payload, occurred_at, correlation_id)
            VALUES ($1, $2, $3, $4::jsonb, NOW(), $5)
        `,
        [
            runId,
            eventType,
            status,
            JSON.stringify(sanitizeFields(payload, additionalSecrets)),
            correlationId == null ? null : sanitizeText(correlationId, additionalSecrets),
        ],
    );
}

/**
 * Upserts a set of node projections in one PostgreSQL statement and skips
 * unchanged or older status observations.
 */
export async function upsertNodeStatuses(
    client: PoolClient,
    runId: string,
    nodeStatuses: Record<string, PipelineRunNodeStatusRecord>,
): Promise<boolean> {
    const nodes = Object.values(nodeStatuses);
    if (nodes.length === 0) {
        return false;
    }
    const result = await client.query(
        `
            INSERT INTO run_node_states (
                run_id, qualified_name, status, started_at, completed_at,
                duration_ms, last_updated_at
            )
            SELECT $1, node.qualified_name, node.status, node.started_at,
                   node.completed_at, node.duration_ms, node.last_updated_at
            FROM jsonb_to_recordset($2::jsonb) AS node(
                qualified_name text,
                status text,
                started_at timestamptz,
                completed_at timestamptz,
                duration_ms integer,
                last_updated_at timestamptz
            )
            ON CONFLICT (run_id, qualified_name) DO UPDATE SET
                status = EXCLUDED.status,
                started_at = EXCLUDED.started_at,
                completed_at = EXCLUDED.completed_at,
                duration_ms = EXCLUDED.duration_ms,
                last_updated_at = EXCLUDED.last_updated_at
            WHERE EXCLUDED.last_updated_at >= run_node_states.last_updated_at
              AND ROW(
                  run_node_states.status,
                  run_node_states.started_at,
                  run_node_states.completed_at,
                  run_node_states.duration_ms,
                  run_node_states.last_updated_at
              ) IS DISTINCT FROM ROW(
                  EXCLUDED.status,
                  EXCLUDED.started_at,
                  EXCLUDED.completed_at,
                  EXCLUDED.duration_ms,
                  EXCLUDED.last_updated_at
              )
        `,
        [runId, JSON.stringify(nodes.map((node) => ({
            completed_at: node.completedAt ?? null,
            duration_ms: node.durationMs ?? null,
            last_updated_at: node.lastUpdatedAt,
            qualified_name: node.qualifiedName,
            started_at: node.startedAt ?? null,
            status: node.status,
        })))],
    );
    return (result.rowCount ?? 0) > 0;
}

/** Closes active node rows with the node outcome mapped from a terminal run. */
export async function finalizeActiveNodeStatuses(
    client: PoolClient,
    runId: string,
    runStatus: PipelineRun['status'],
    completedAt: string,
): Promise<void> {
    const nodeStatus = pipelineRunNodeStatusForRun(runStatus);
    if (nodeStatus == null) {
        return;
    }
    await client.query(
        `
            UPDATE run_node_states
            SET status = $2,
                completed_at = $3,
                duration_ms = CASE
                    WHEN started_at IS NULL THEN NULL
                    ELSE GREATEST(
                        0,
                        LEAST(
                            2147483647,
                            EXTRACT(EPOCH FROM ($3::timestamptz - started_at)) * 1000
                        )
                    )::integer
                END,
                last_updated_at = $3
            WHERE run_id = $1
              AND status IN (${ACTIVE_NODE_STATUS_SQL_LIST})
        `,
        [runId, nodeStatus, completedAt],
    );
}

/** Locks and verifies the active lease that fences a worker mutation. */
export async function hasActiveLease(
    client: PoolClient,
    runId: string,
    lease: RunLease,
): Promise<boolean> {
    const result = await client.query(
        `
            SELECT 1
            FROM run_leases
            WHERE run_id = $1 AND owner_id = $2 AND lease_token = $3
              AND expires_at > NOW()
            FOR UPDATE
        `,
        [runId, lease.ownerId, lease.leaseToken],
    );
    return result.rowCount === 1;
}

async function selectNodeStatuses(
    client: Pool | PoolClient,
    runIds: string[],
): Promise<Map<string, Record<string, PipelineRunNodeStatusRecord>>> {
    const result = await client.query<NodeStateRow>(
        `
            SELECT run_id, qualified_name, status, started_at, completed_at,
                   duration_ms, last_updated_at
            FROM run_node_states
            WHERE run_id = ANY($1::uuid[])
            ORDER BY run_id, qualified_name
        `,
        [runIds],
    );
    const statuses = new Map<string, Record<string, PipelineRunNodeStatusRecord>>();
    for (const row of result.rows) {
        const nodes = statuses.get(row.run_id) ?? {};
        nodes[row.qualified_name] = mapNodeStatus(row);
        statuses.set(row.run_id, nodes);
    }
    return statuses;
}

async function countPipelineRuns(pool: Pool, pipelineId: string): Promise<number> {
    const result = await pool.query<{ count: string }>(
        'SELECT COUNT(*)::text AS count FROM runs WHERE pipeline_id = $1',
        [pipelineId],
    );
    return Number(result.rows[0]?.count ?? 0);
}

function boundedOffset(value: number): number {
    return Number.isFinite(value)
        ? Math.min(2_147_483_647, Math.max(0, Math.floor(value)))
        : 0;
}
