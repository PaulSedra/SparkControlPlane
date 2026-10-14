/**
 * @fileoverview PostgreSQL persistence for trigger definitions, event
 * envelopes, routing decisions, deliveries, and dead letters.
 */

import crypto from 'node:crypto';
import type { Pool, PoolClient, QueryResultRow } from 'pg';
import { ControlPlaneApiError } from '../errors/controlPlaneApiError.ts';
import type {
    CanonicalTriggerEvent,
    TriggerDefinition,
    TriggerDefinitionInput,
    TriggerDefinitionPatch,
    TriggerDeadLetter,
    TriggerDeadLetterInput,
    TriggerDeliveryAttempt,
    TriggerDeliveryAttemptInput,
    TriggerEventRecord,
    TriggerOutcome,
    TriggerPersistence,
    TriggerRoutingDecision,
    TriggerRoutingDecisionInput,
} from '../types/triggerTypes.ts';
import {
    TriggerDeadLetterStatus,
    TriggerEventStatus,
} from '../../shared/status/trigger.ts';

type PostgresTimestamp = Date | string;
type NullablePostgresTimestamp = PostgresTimestamp | null;

interface TriggerDefinitionRow extends QueryResultRow {
    caller_metadata: Record<string, string> | null;
    configuration: Record<string, unknown>;
    created_at: PostgresTimestamp;
    active: boolean;
    enabled: boolean;
    managed_by_yaml: boolean;
    last_event_at: NullablePostgresTimestamp;
    last_outcome: TriggerOutcome | null;
    last_submission_at: NullablePostgresTimestamp;
    mode: TriggerDefinition['mode'];
    name: string;
    node_names: string[] | null;
    pipeline_id: string;
    trigger_id: string;
    trigger_type: TriggerDefinition['type'];
    updated_at: PostgresTimestamp;
}

interface TriggerEventRow extends QueryResultRow {
    attributes: Record<string, string>;
    deduplication_key: string;
    duplicate_count: number | string | null;
    event_id: string;
    event_type: string;
    occurred_at: PostgresTimestamp;
    payload: Record<string, unknown>;
    received_at: PostgresTimestamp;
    source: string;
    status: TriggerEventStatus;
}

interface TriggerRoutingDecisionRow extends QueryResultRow {
    created_at: PostgresTimestamp;
    decision_id: number | string;
    event_id: string;
    outcome: TriggerRoutingDecision['outcome'];
    reason: string | null;
    run_id: string | null;
    trigger_id: string;
}

interface TriggerDeliveryAttemptRow extends QueryResultRow {
    attempt_id: number | string;
    attempt_number: number;
    completed_at: NullablePostgresTimestamp;
    correlation_id: string | null;
    created_at: PostgresTimestamp;
    event_id: string;
    failure_reason: string | null;
    run_id: string | null;
    started_at: NullablePostgresTimestamp;
    status: TriggerDeliveryAttempt['status'];
    trigger_id: string;
}

interface TriggerDeadLetterRow extends QueryResultRow {
    created_at: PostgresTimestamp;
    event: CanonicalTriggerEvent;
    event_id: string;
    failure_reason: string;
    dead_letter_id: string;
    replay_count: number | string;
    status: TriggerDeadLetter['status'];
    trigger_id: string;
    updated_at: PostgresTimestamp;
}

/**
 * Binds trigger definitions, event deduplication, routing evidence, delivery
 * attempts, and dead letters to a shared PostgreSQL pool.
 *
 * Event recording serializes on the deduplication key, so concurrent provider
 * deliveries produce one durable event plus duplicate counts instead of
 * submitting the same logical event twice. The caller owns pool shutdown.
 */
export function createPostgresTriggerPersistence(pool: Pool): TriggerPersistence {
    return {
        createTrigger: (input) => createTrigger(pool, input),
        getTrigger: (triggerId) => getTrigger(pool, triggerId),
        listTriggers: () => listTriggers(pool),
        reconcileYamlTriggers: (pipelineId, inputs) => reconcileYamlTriggers(pool, pipelineId, inputs),
        updateTrigger: (triggerId, patch) => updateTrigger(pool, triggerId, patch),
        updateTriggerOutcome: (triggerId, outcome) =>
            updateTriggerOutcome(pool, triggerId, outcome),
        recordTriggerEvent: (event) => recordTriggerEvent(pool, event),
        updateTriggerEventStatus: (eventId, status) =>
            updateTriggerEventStatus(pool, eventId, status),
        listTriggerEvents: (limit) => listTriggerEvents(pool, limit),
        recordRoutingDecision: (input) => recordRoutingDecision(pool, input),
        listTriggerRoutingDecisions: (eventId, triggerId, limit) =>
            listTriggerRoutingDecisions(pool, eventId, triggerId, limit),
        recordTriggerDeliveryAttempt: (input) => recordTriggerDeliveryAttempt(pool, input),
        listTriggerDeliveryAttempts: (triggerId, limit) =>
            listTriggerDeliveryAttempts(pool, triggerId, limit),
        createTriggerDeadLetter: (input) => createTriggerDeadLetter(pool, input),
        getTriggerDeadLetter: (deadLetterId) => getTriggerDeadLetter(pool, deadLetterId),
        listTriggerDeadLetters: (status, limit) => listTriggerDeadLetters(pool, status, limit),
        updateTriggerDeadLetter: (deadLetterId, patch) =>
            updateTriggerDeadLetter(pool, deadLetterId, patch),
    };
}

async function createTriggerDeadLetter(
    pool: Pool,
    input: TriggerDeadLetterInput,
): Promise<TriggerDeadLetter> {
    const result = await pool.query<TriggerDeadLetterRow>(
        `
            INSERT INTO trigger_dead_letters (
                dead_letter_id, event_id, trigger_id, event, failure_reason,
                status, replay_count, created_at, updated_at
            ) VALUES ($1, $2, $3, $4::jsonb, $5, '${TriggerDeadLetterStatus.PENDING}', 0, NOW(), NOW())
            ON CONFLICT (event_id, trigger_id) DO UPDATE SET
                event = EXCLUDED.event,
                failure_reason = EXCLUDED.failure_reason,
                status = '${TriggerDeadLetterStatus.PENDING}',
                updated_at = NOW()
            RETURNING *
        `,
        [
            crypto.randomUUID(),
            input.eventId,
            input.triggerId,
            JSON.stringify(input.event),
            input.failureReason,
        ],
    );
    const row = result.rows[0];
    if (row == null) {
        throw new Error('PostgreSQL did not return the trigger dead letter.');
    }
    return mapDeadLetter(row);
}

async function getTriggerDeadLetter(
    pool: Pool,
    deadLetterId: string,
): Promise<TriggerDeadLetter | undefined> {
    const result = await pool.query<TriggerDeadLetterRow>(
        'SELECT * FROM trigger_dead_letters WHERE dead_letter_id = $1',
        [deadLetterId],
    );
    const row = result.rows[0];
    return row == null ? undefined : mapDeadLetter(row);
}

async function listTriggerDeadLetters(
    pool: Pool,
    status?: TriggerDeadLetter['status'],
    limit = 100,
): Promise<TriggerDeadLetter[]> {
    const result = await pool.query<TriggerDeadLetterRow>(
        `
            SELECT *
            FROM trigger_dead_letters
            WHERE $1::text IS NULL OR status = $1
            ORDER BY updated_at DESC, dead_letter_id DESC
            LIMIT $2
        `,
        [status ?? null, boundedLimit(limit)],
    );
    return result.rows.map(mapDeadLetter);
}

async function updateTriggerDeadLetter(
    pool: Pool,
    deadLetterId: string,
    patch: { failureReason?: string; replayCount?: number; status: TriggerDeadLetter['status'] },
): Promise<TriggerDeadLetter> {
    const current = await getTriggerDeadLetter(pool, deadLetterId);
    if (current == null) {
        throw new ControlPlaneApiError(404, `Unknown trigger dead letter: ${deadLetterId}`);
    }
    const result = await pool.query<TriggerDeadLetterRow>(
        `
            UPDATE trigger_dead_letters
            SET failure_reason = $2,
                replay_count = $3,
                status = $4,
                updated_at = NOW()
            WHERE dead_letter_id = $1
            RETURNING *
        `,
        [
            deadLetterId,
            patch.failureReason ?? current.failureReason,
            patch.replayCount ?? current.replayCount,
            patch.status,
        ],
    );
    const row = result.rows[0];
    if (row == null) {
        throw new ControlPlaneApiError(404, `Unknown trigger dead letter: ${deadLetterId}`);
    }
    return mapDeadLetter(row);
}

async function createTrigger(
    pool: Pool,
    input: TriggerDefinitionInput,
): Promise<TriggerDefinition> {
    const id = crypto.randomUUID();
    const result = await pool.query<TriggerDefinitionRow>(
        `
            INSERT INTO trigger_definitions (
                trigger_id, name, trigger_type, pipeline_id, active, enabled, mode,
                node_names, caller_metadata, configuration, created_at, updated_at
            ) VALUES ($1, $2, $3, $4, true, $5, $6, $7::jsonb, $8::jsonb, $9::jsonb, NOW(), NOW())
            RETURNING *
        `,
        [
            id,
            input.name,
            input.type,
            input.pipelineId,
            input.enabled ?? true,
            input.mode,
            input.nodeNames == null ? null : JSON.stringify(input.nodeNames),
            input.callerMetadata == null ? null : JSON.stringify(input.callerMetadata),
            JSON.stringify(input.configuration),
        ],
    );
    const row = result.rows[0];
    if (row == null) {
        throw new Error('PostgreSQL did not return the created trigger.');
    }
    return mapTrigger(row);
}

async function getTrigger(
    pool: Pool,
    triggerId: string,
): Promise<TriggerDefinition | undefined> {
    const result = await pool.query<TriggerDefinitionRow>(
        'SELECT * FROM trigger_definitions WHERE trigger_id = $1',
        [triggerId],
    );
    const row = result.rows[0];
    return row == null ? undefined : mapTrigger(row);
}

async function listTriggers(pool: Pool): Promise<TriggerDefinition[]> {
    const result = await pool.query<TriggerDefinitionRow>(
        'SELECT * FROM trigger_definitions ORDER BY name, trigger_id',
    );
    return result.rows.map(mapTrigger);
}

async function reconcileYamlTriggers(
    pool: Pool,
    pipelineId: string,
    inputs: TriggerDefinitionInput[],
): Promise<TriggerDefinition[]> {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        // Serialize explicit source refreshes for one pipeline so replacement
        // sets cannot interleave.
        await client.query(
            'SELECT pg_advisory_xact_lock(hashtext($1))',
            [`yaml-triggers:${pipelineId}`],
        );
        const existingResult = await client.query<TriggerDefinitionRow>(
            `
                SELECT *
                FROM trigger_definitions
                WHERE pipeline_id = $1 AND managed_by_yaml = true
                FOR UPDATE
            `,
            [pipelineId],
        );
        const existingByName = new Map(existingResult.rows.map((row) => [row.name, row]));
        const desiredNames = new Set(inputs.map((input) => input.name));
        const definitions: TriggerDefinition[] = [];

        for (const input of inputs) {
            const current = existingByName.get(input.name);
            if (current != null) {
                definitions.push(await updateYamlTrigger(client, current.trigger_id, input));
                continue;
            }

            const conflicting = await client.query<TriggerDefinitionRow>(
                'SELECT * FROM trigger_definitions WHERE name = $1 FOR UPDATE',
                [input.name],
            );
            if (conflicting.rows[0] != null) {
                throw new ControlPlaneApiError(
                    409,
                    `Trigger name "${input.name}" is already owned by an API or another YAML definition.`,
                );
            }
            definitions.push(await insertYamlTrigger(client, input));
        }

        for (const row of existingResult.rows) {
            if (!desiredNames.has(row.name)) {
                await client.query(
                    `
                        UPDATE trigger_definitions
                        SET active = false, enabled = false,
                            updated_at = NOW()
                        WHERE trigger_id = $1
                    `,
                    [row.trigger_id],
                );
            }
        }
        await client.query('COMMIT');
        return definitions;
    } catch (error) {
        await client.query('ROLLBACK');
        if (isUniqueViolation(error)) {
            throw new ControlPlaneApiError(
                409,
                'A trigger name is already owned by another trigger definition.',
            );
        }
        throw error;
    } finally {
        client.release();
    }
}

async function insertYamlTrigger(
    client: PoolClient,
    input: TriggerDefinitionInput,
): Promise<TriggerDefinition> {
    const result = await client.query<TriggerDefinitionRow>(
        `
            INSERT INTO trigger_definitions (
                trigger_id, name, trigger_type, pipeline_id, active, enabled, mode,
                node_names, caller_metadata, configuration, managed_by_yaml,
                created_at, updated_at
            ) VALUES ($1, $2, $3, $4, true, $5, $6, $7::jsonb, $8::jsonb, $9::jsonb, true, NOW(), NOW())
            RETURNING *
        `,
        triggerValues(crypto.randomUUID(), input),
    );
    const row = result.rows[0];
    if (row == null) {
        throw new Error('PostgreSQL did not return the YAML trigger.');
    }
    return mapTrigger(row);
}

async function updateYamlTrigger(
    client: PoolClient,
    triggerId: string,
    input: TriggerDefinitionInput,
): Promise<TriggerDefinition> {
    const result = await client.query<TriggerDefinitionRow>(
        `
            UPDATE trigger_definitions
            SET name = $2, trigger_type = $3, pipeline_id = $4, active = true, enabled = $5,
                mode = $6, node_names = $7::jsonb, caller_metadata = $8::jsonb,
                configuration = $9::jsonb, managed_by_yaml = true, updated_at = NOW()
            WHERE trigger_id = $1
            RETURNING *
        `,
        triggerValues(triggerId, input),
    );
    const row = result.rows[0];
    if (row == null) {
        throw new ControlPlaneApiError(404, `Unknown YAML trigger: ${triggerId}`);
    }
    return mapTrigger(row);
}

async function updateTrigger(
    pool: Pool,
    triggerId: string,
    patch: TriggerDefinitionPatch,
): Promise<TriggerDefinition> {
    const current = await getTrigger(pool, triggerId);
    if (current == null) {
        throw new ControlPlaneApiError(404, `Unknown trigger: ${triggerId}`);
    }
    const updated: TriggerDefinition = {
        ...current,
        ...patch,
        updatedAt: new Date().toISOString(),
    };
    const result = await pool.query<TriggerDefinitionRow>(
        `
            UPDATE trigger_definitions
            SET name = $2, trigger_type = $3, pipeline_id = $4,
                enabled = $5,
                mode = $6, node_names = $7::jsonb, caller_metadata = $8::jsonb,
                configuration = $9::jsonb, updated_at = NOW()
            WHERE trigger_id = $1
            RETURNING *
        `,
        [
            triggerId,
            updated.name,
            updated.type,
            updated.pipelineId,
            updated.enabled,
            updated.mode,
            updated.nodeNames == null ? null : JSON.stringify(updated.nodeNames),
            updated.callerMetadata == null ? null : JSON.stringify(updated.callerMetadata),
            JSON.stringify(updated.configuration),
        ],
    );
    const row = result.rows[0];
    if (row == null) {
        throw new ControlPlaneApiError(404, `Unknown trigger: ${triggerId}`);
    }
    return mapTrigger(row);
}

async function updateTriggerOutcome(
    pool: Pool,
    triggerId: string,
    outcome: TriggerOutcome,
): Promise<TriggerDefinition> {
    const result = await pool.query<TriggerDefinitionRow>(
        `
            UPDATE trigger_definitions
            SET last_outcome = $2::jsonb,
                last_event_at = $3,
                last_submission_at = CASE
                    WHEN $4::boolean THEN $3
                    ELSE last_submission_at
                END,
                updated_at = NOW()
            WHERE trigger_id = $1
            RETURNING *
        `,
        [triggerId, JSON.stringify(outcome), outcome.occurredAt, outcome.runId != null],
    );
    const row = result.rows[0];
    if (row == null) {
        throw new ControlPlaneApiError(404, `Unknown trigger: ${triggerId}`);
    }
    return mapTrigger(row);
}

async function recordTriggerEvent(
    pool: Pool,
    event: CanonicalTriggerEvent,
): Promise<{ duplicate: boolean; event: TriggerEventRecord }> {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        // The provider may retry the same notification concurrently. Lock on
        // its deduplication key before reading/inserting so exactly one caller
        // creates the event and the other caller receives duplicate evidence.
        await client.query(
            'SELECT pg_advisory_xact_lock(hashtext($1))',
            [event.deduplicationKey],
        );
        const existingById = await selectTriggerEvent(client, event.eventId);
        if (existingById != null) {
            if (existingById.event.deduplicationKey !== event.deduplicationKey) {
                throw new ControlPlaneApiError(
                    409,
                    'A trigger event id was already used for a different event.',
                );
            }
            const updated = await incrementDuplicateCount(client, event.eventId);
            await client.query('COMMIT');
            return {
                duplicate: true,
                event: duplicateEvent(updated, event.eventId),
            };
        }

        const existingKey = await client.query<{ event_id: string }>(
            `
                SELECT event_id
                FROM trigger_deduplication_keys
                WHERE deduplication_key = $1
                FOR UPDATE
            `,
            [event.deduplicationKey],
        );
        const existingEventId = existingKey.rows[0]?.event_id;
        if (existingEventId != null) {
            const updated = await incrementDuplicateCount(client, existingEventId);
            await client.query('COMMIT');
            return {
                duplicate: true,
                event: duplicateEvent(updated, event.eventId),
            };
        }

        const inserted = await client.query<TriggerEventRow>(
            `
                INSERT INTO trigger_events (
                    event_id, event_type, source, occurred_at, attributes, payload,
                    deduplication_key, status, received_at, updated_at
                ) VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, '${TriggerEventStatus.RECEIVED}', NOW(), NOW())
                RETURNING *, 0::bigint AS duplicate_count
            `,
            [
                event.eventId,
                event.eventType,
                event.source,
                event.occurredAt,
                JSON.stringify(event.attributes),
                JSON.stringify(event.payload),
                event.deduplicationKey,
            ],
        );
        const row = inserted.rows[0];
        if (row == null) {
            throw new Error('PostgreSQL did not return the received trigger event.');
        }
        await client.query(
            `
                INSERT INTO trigger_deduplication_keys (
                    deduplication_key, event_id, first_seen_at, last_seen_at, duplicate_count
                ) VALUES ($1, $2, NOW(), NOW(), 0)
            `,
            [event.deduplicationKey, event.eventId],
        );
        await client.query('COMMIT');
        return { duplicate: false, event: mapEvent(row) };
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }
}

async function listTriggerEvents(pool: Pool, limit = 100): Promise<TriggerEventRecord[]> {
    const result = await pool.query<TriggerEventRow>(
        `
            SELECT e.*, d.duplicate_count
            FROM trigger_events e
            JOIN trigger_deduplication_keys d ON d.event_id = e.event_id
            ORDER BY e.received_at DESC, e.event_id DESC
            LIMIT $1
        `,
        [boundedLimit(limit)],
    );
    return result.rows.map(mapEvent);
}

async function updateTriggerEventStatus(
    pool: Pool,
    eventId: string,
    status: TriggerEventStatus,
): Promise<TriggerEventRecord> {
    const result = await pool.query<{ event_id: string }>(
        `
            UPDATE trigger_events
            SET status = $2, updated_at = NOW()
            WHERE event_id = $1
            RETURNING event_id
        `,
        [eventId, status],
    );
    if (result.rowCount !== 1) {
        throw new ControlPlaneApiError(404, `Unknown trigger event: ${eventId}`);
    }
    const event = await selectTriggerEvent(pool, eventId);
    if (event == null) {
        throw new Error('PostgreSQL did not return the updated trigger event.');
    }
    return event;
}

async function recordRoutingDecision(
    pool: Pool,
    input: TriggerRoutingDecisionInput,
): Promise<TriggerRoutingDecision> {
    const result = await pool.query<TriggerRoutingDecisionRow>(
        `
            INSERT INTO trigger_routing_decisions (
                event_id, trigger_id, outcome, reason, run_id, created_at
            ) VALUES ($1, $2, $3, $4, $5, NOW())
            RETURNING *
        `,
        [input.eventId, input.triggerId, input.outcome, input.reason ?? null, input.runId ?? null],
    );
    const row = result.rows[0];
    if (row == null) {
        throw new Error('PostgreSQL did not return the trigger routing decision.');
    }
    return mapRoutingDecision(row);
}

async function listTriggerRoutingDecisions(
    pool: Pool,
    eventId?: string,
    triggerId?: string,
    limit = 100,
): Promise<TriggerRoutingDecision[]> {
    const result = await pool.query<TriggerRoutingDecisionRow>(
        `
            SELECT *
            FROM trigger_routing_decisions
            WHERE ($1::text IS NULL OR event_id = $1)
              AND ($2::uuid IS NULL OR trigger_id = $2)
            ORDER BY decision_id DESC
            LIMIT $3
        `,
        [eventId ?? null, triggerId ?? null, boundedLimit(limit)],
    );
    return result.rows.map(mapRoutingDecision);
}

async function recordTriggerDeliveryAttempt(
    pool: Pool,
    input: TriggerDeliveryAttemptInput,
): Promise<TriggerDeliveryAttempt> {
    const result = await pool.query<TriggerDeliveryAttemptRow>(
        `
            INSERT INTO trigger_delivery_attempts (
                event_id, trigger_id, attempt_number, status, run_id, failure_reason,
                correlation_id, started_at, completed_at, created_at
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
            RETURNING *
        `,
        [
            input.eventId,
            input.triggerId,
            input.attemptNumber,
            input.status,
            input.runId ?? null,
            input.failureReason ?? null,
            input.correlationId ?? null,
            input.startedAt ?? null,
            input.completedAt ?? null,
        ],
    );
    const row = result.rows[0];
    if (row == null) {
        throw new Error('PostgreSQL did not return the trigger delivery attempt.');
    }
    return mapDeliveryAttempt(row);
}

async function listTriggerDeliveryAttempts(
    pool: Pool,
    triggerId?: string,
    limit = 100,
): Promise<TriggerDeliveryAttempt[]> {
    const result = await pool.query<TriggerDeliveryAttemptRow>(
        `
            SELECT *
            FROM trigger_delivery_attempts
            WHERE $1::uuid IS NULL OR trigger_id = $1
            ORDER BY attempt_id DESC
            LIMIT $2
        `,
        [triggerId ?? null, boundedLimit(limit)],
    );
    return result.rows.map(mapDeliveryAttempt);
}

async function selectTriggerEvent(
    client: Pool | PoolClient,
    eventId: string,
): Promise<TriggerEventRecord | undefined> {
    const result = await client.query<TriggerEventRow>(
        `
            SELECT e.*, d.duplicate_count
            FROM trigger_events e
            JOIN trigger_deduplication_keys d ON d.event_id = e.event_id
            WHERE e.event_id = $1
            FOR UPDATE
        `,
        [eventId],
    );
    const row = result.rows[0];
    return row == null ? undefined : mapEvent(row);
}

async function incrementDuplicateCount(
    client: PoolClient,
    eventId: string,
): Promise<TriggerEventRecord> {
    await client.query(
        `
            UPDATE trigger_deduplication_keys
            SET last_seen_at = NOW(), duplicate_count = duplicate_count + 1
            WHERE event_id = $1
        `,
        [eventId],
    );
    const updated = await selectTriggerEvent(client, eventId);
    if (updated == null) {
        throw new Error('Trigger deduplication state references a missing event.');
    }
    return updated;
}

function mapTrigger(row: TriggerDefinitionRow): TriggerDefinition {
    return {
        active: row.active !== false,
        callerMetadata: row.caller_metadata == null ? undefined : clone(row.caller_metadata),
        configuration: clone(row.configuration),
        createdAt: dateString(row.created_at),
        enabled: row.active === false ? false : row.enabled,
        id: row.trigger_id,
        lastOutcome: row.last_outcome == null ? undefined : clone(row.last_outcome),
        managedByYaml: row.managed_by_yaml === true,
        mode: row.mode,
        name: row.name,
        nodeNames: row.node_names == null ? undefined : [...row.node_names],
        pipelineId: row.pipeline_id,
        type: row.trigger_type,
        updatedAt: dateString(row.updated_at),
    };
}

function isUniqueViolation(error: unknown): boolean {
    return typeof error === 'object' && error != null &&
        'code' in error && (error as { code?: unknown }).code === '23505';
}

function mapEvent(row: TriggerEventRow): TriggerEventRecord {
    return {
        duplicateCount: Number(row.duplicate_count ?? 0),
        event: {
            attributes: clone(row.attributes),
            deduplicationKey: row.deduplication_key,
            eventId: row.event_id,
            eventType: row.event_type,
            occurredAt: dateString(row.occurred_at),
            payload: clone(row.payload),
            source: row.source,
        },
        receivedAt: dateString(row.received_at),
        status: row.status,
    };
}

function mapRoutingDecision(row: TriggerRoutingDecisionRow): TriggerRoutingDecision {
    return {
        createdAt: dateString(row.created_at),
        decisionId: Number(row.decision_id),
        eventId: row.event_id,
        outcome: row.outcome,
        reason: row.reason ?? undefined,
        runId: row.run_id ?? undefined,
        triggerId: row.trigger_id,
    };
}

function mapDeliveryAttempt(row: TriggerDeliveryAttemptRow): TriggerDeliveryAttempt {
    return {
        attemptId: Number(row.attempt_id),
        attemptNumber: row.attempt_number,
        completedAt: row.completed_at == null ? undefined : dateString(row.completed_at),
        correlationId: row.correlation_id ?? undefined,
        createdAt: dateString(row.created_at),
        eventId: row.event_id,
        failureReason: row.failure_reason ?? undefined,
        runId: row.run_id ?? undefined,
        startedAt: row.started_at == null ? undefined : dateString(row.started_at),
        status: row.status,
        triggerId: row.trigger_id,
    };
}

function mapDeadLetter(row: TriggerDeadLetterRow): TriggerDeadLetter {
    return {
        createdAt: dateString(row.created_at),
        event: clone(row.event),
        eventId: row.event_id,
        failureReason: row.failure_reason,
        id: row.dead_letter_id,
        replayCount: Number(row.replay_count),
        status: row.status,
        triggerId: row.trigger_id,
        updatedAt: dateString(row.updated_at),
    };
}

function duplicateEvent(
    existing: TriggerEventRecord,
    incomingEventId: string,
): TriggerEventRecord {
    return {
        ...clone(existing),
        duplicateOfEventId: existing.event.eventId === incomingEventId
            ? undefined
            : existing.event.eventId,
        status: TriggerEventStatus.DUPLICATE,
    };
}

function boundedLimit(value: number): number {
    return Math.min(1000, Math.max(1, Math.floor(value)));
}

function dateString(value: PostgresTimestamp): string {
    return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function clone<T>(value: T): T {
    return structuredClone(value);
}

function triggerValues(id: string, input: TriggerDefinitionInput): unknown[] {
    return [
        id,
        input.name,
        input.type,
        input.pipelineId,
        input.enabled ?? true,
        input.mode,
        input.nodeNames == null ? null : JSON.stringify(input.nodeNames),
        input.callerMetadata == null ? null : JSON.stringify(input.callerMetadata),
        JSON.stringify(input.configuration),
    ];
}
