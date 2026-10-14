/**
 * @fileoverview PostgreSQL persistence for audit records and shared audit
 * writes used by transactional domain adapters.
 */

import type { Pool, PoolClient, QueryResultRow } from 'pg';
import type {
    AuditPersistence,
    PipelineAuditEvent,
    PipelineAuditEventInput,
} from '../types/pipelinePersistenceTypes.ts';
import { boundedLimit, dateString } from './postgresPersistenceUtils.ts';
import { sanitizeFields, sanitizeText } from '../utils/sanitization.ts';

interface AuditEventRow extends QueryResultRow {
    actor: string | null;
    correlation_id: string | null;
    event_id: number | string;
    event_type: string;
    occurred_at: Date | string;
    payload: Record<string, unknown>;
    pipeline_id: string | null;
    request_source: string | null;
    run_id: string | null;
}

/**
 * Binds append-only audit listing and recording to a PostgreSQL pool.
 *
 * The exported insert operation also accepts a caller-owned transaction client
 * so domain mutations can commit their audit evidence atomically with state.
 */
export function createPostgresAuditPersistence(pool: Pool, secret = ''): AuditPersistence {
    return {
        listAuditEventsAfter: (eventId, limit) => listAuditEventsAfter(pool, eventId, limit, [secret]),
        recordAuditEvent: (input) => insertAuditEvent(pool, input, [secret]),
    };
}

/**
 * Appends one audit record and maps the database row to the API contract.
 *
 * Accepting either a pool or transaction client lets callers include audit
 * evidence in the same transaction as the domain mutation. A missing RETURNING
 * row is treated as a persistence failure rather than returning a fabricated
 * event identity, and the payload is serialized as JSONB at the boundary.
 */
export async function insertAuditEvent(
    poolOrClient: Pool | PoolClient,
    input: PipelineAuditEventInput,
    additionalSecrets: readonly string[] = [],
): Promise<PipelineAuditEvent> {
    const result = await poolOrClient.query<AuditEventRow>(
        `
            INSERT INTO audit_events (
                event_type, pipeline_id, run_id, actor, payload, occurred_at,
                request_source, correlation_id
            ) VALUES ($1, $2, $3, $4, $5::jsonb, NOW(), $6, $7)
            RETURNING event_id, event_type, pipeline_id, run_id, actor, payload,
                      occurred_at, request_source, correlation_id
        `,
        [
            input.eventType,
            input.pipelineId ?? null,
            input.runId ?? null,
            input.actor == null ? 'control-plane' : sanitizeText(input.actor, additionalSecrets),
            JSON.stringify(sanitizeFields(input.payload, additionalSecrets)),
            input.requestSource == null ? null : sanitizeText(input.requestSource, additionalSecrets),
            input.correlationId == null ? null : sanitizeText(input.correlationId, additionalSecrets),
        ],
    );
    const row = result.rows[0];
    if (row == null) {
        throw new Error('PostgreSQL did not return the recorded audit event.');
    }
    return mapAuditEvent(row);
}

async function listAuditEventsAfter(
    pool: Pool,
    eventId: number,
    limit = 100,
    additionalSecrets: readonly string[] = [],
): Promise<PipelineAuditEvent[]> {
    const result = await pool.query<AuditEventRow>(
        `
            SELECT event_id, event_type, pipeline_id, run_id, actor, payload,
                   occurred_at, request_source, correlation_id
            FROM audit_events
            WHERE event_id > $1
            ORDER BY event_id
            LIMIT $2
        `,
        [eventId, boundedLimit(limit)],
    );
    return result.rows.map((row) => mapAuditEvent(row, additionalSecrets));
}

function mapAuditEvent(
    row: AuditEventRow,
    additionalSecrets: readonly string[] = [],
): PipelineAuditEvent {
    return {
        actor: row.actor == null ? undefined : sanitizeText(row.actor, additionalSecrets),
        correlationId: row.correlation_id == null
            ? undefined
            : sanitizeText(row.correlation_id, additionalSecrets),
        eventId: Number(row.event_id),
        eventType: row.event_type,
        occurredAt: dateString(row.occurred_at),
        payload: sanitizeFields(row.payload, additionalSecrets) as Record<string, unknown>,
        pipelineId: row.pipeline_id ?? undefined,
        requestSource: row.request_source == null
            ? undefined
            : sanitizeText(row.request_source, additionalSecrets),
        runId: row.run_id ?? undefined,
    };
}
