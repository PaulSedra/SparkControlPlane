/**
 * @fileoverview In-memory audit persistence used by unit and contract tests.
 */

import type {
    AuditPersistence,
    PipelineAuditEvent,
    PipelineAuditEventInput,
} from '../../src/server/types/pipelinePersistenceTypes.ts';

/** Configuration for the deterministic in-memory audit adapter. */
export interface InMemoryAuditPersistenceOptions {
    now?: () => number;
}

/**
 * Creates an append-only audit persistence adapter with deterministic IDs and
 * timestamps for tests that need to inspect audit history.
 */
export function createInMemoryAuditPersistence(
    options: InMemoryAuditPersistenceOptions = {},
): AuditPersistence {
    const now = options.now ?? (() => Date.now());
    const auditEvents: PipelineAuditEvent[] = [];
    let nextAuditEventId = 1;

    return {
        async listAuditEventsAfter(eventId, limit = 100) {
            return auditEvents
                .filter((event) => event.eventId > eventId)
                .sort((left, right) => left.eventId - right.eventId)
                .slice(0, boundedLimit(limit))
                .map((event) => ({ ...event, payload: { ...event.payload } }));
        },
        async recordAuditEvent(input: PipelineAuditEventInput) {
            const event: PipelineAuditEvent = {
                ...input,
                actor: input.actor ?? 'control-plane',
                eventId: nextAuditEventId++,
                occurredAt: new Date(now()).toISOString(),
            };
            auditEvents.push(event);
            return { ...event, payload: { ...event.payload } };
        },
    };
}

function boundedLimit(value: number): number {
    return Math.min(1000, Math.max(1, Math.floor(value)));
}
