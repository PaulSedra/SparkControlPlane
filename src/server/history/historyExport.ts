/**
 * @fileoverview Cursor-based export contracts for append-only run and audit
 * history.
 */

import type {
    PipelineAuditEvent,
    HistoryPersistence,
    PipelineRunEvent,
} from '../types/pipelinePersistenceTypes.ts';

/** Independent cursors for run-event and audit-event streams. */
export interface HistoryExportCursor {
    auditEventId: number;
    runEventId: number;
}
/** Portable history record derived from one persisted run event. */
export interface PipelineRunHistoryRecord {
    correlationId?: string;
    occurredAt: string;
    payload: Record<string, unknown>;
    pipelineId: string;
    requestSource?: string;
    runEventId: string;
    runId: string;
    status?: string;
    triggerSource?: string;
    eventType: string;
}

/** Portable history record derived from one persisted audit event. */
export interface PipelineAuditHistoryRecord {
    actor?: string;
    auditEventId: string;
    correlationId?: string;
    occurredAt: string;
    payload: Record<string, unknown>;
    pipelineId?: string;
    requestSource?: string;
    runId?: string;
    eventType: string;
}

/** One bounded history page and cursors for the next export request. */
export interface HistoryExportBatch {
    auditHistory: PipelineAuditHistoryRecord[];
    nextCursor: HistoryExportCursor;
    pipelineRunHistory: PipelineRunHistoryRecord[];
}

/**
 * Exports one bounded page from the independent run-event and audit streams.
 *
 * Each cursor advances only from the stream it belongs to, so an empty audit
 * page cannot skip run events (or vice versa). Run events are enriched with
 * their durable run identity, the page limit is clamped to 1..1000, and the
 * returned cursor can be sent unchanged to resume without rewriting evidence.
 */
export async function exportHistoryBatch(
    persistence: HistoryPersistence,
    cursor?: HistoryExportCursor,
    limit = 100,
): Promise<HistoryExportBatch> {
    const currentCursor = cursor ?? { auditEventId: 0, runEventId: 0 };
    const boundedLimit = Math.min(1000, Math.max(1, Math.floor(limit)));
    const [runEvents, auditEvents] = await Promise.all([
        persistence.listRunEventsAfter(currentCursor.runEventId, boundedLimit),
        persistence.listAuditEventsAfter(currentCursor.auditEventId, boundedLimit),
    ]);
    const pipelineRunHistory = await Promise.all(
        runEvents.map((event) => runHistoryRecord(persistence, event)),
    );
    return {
        auditHistory: auditEvents.map(auditHistoryRecord),
        nextCursor: {
            auditEventId: lastEventId(auditEvents, currentCursor.auditEventId),
            runEventId: lastEventId(runEvents, currentCursor.runEventId),
        },
        pipelineRunHistory,
    };
}

async function runHistoryRecord(
    persistence: HistoryPersistence,
    event: PipelineRunEvent,
): Promise<PipelineRunHistoryRecord> {
    const run = await persistence.getRun(event.runId);
    if (run == null) {
        throw new Error(`Unable to export run event ${event.eventId}: run ${event.runId} is missing.`);
    }
    return {
        correlationId: event.correlationId,
        eventType: event.eventType,
        occurredAt: event.occurredAt,
        payload: { ...event.payload },
        pipelineId: run.pipelineId,
        requestSource: run.requestSource,
        runEventId: String(event.eventId),
        runId: event.runId,
        status: event.status,
        triggerSource: run.requestSource?.startsWith('trigger:')
            ? run.requestSource
            : undefined,
    };
}

function auditHistoryRecord(event: PipelineAuditEvent): PipelineAuditHistoryRecord {
    return {
        actor: event.actor,
        auditEventId: String(event.eventId),
        correlationId: event.correlationId,
        eventType: event.eventType,
        occurredAt: event.occurredAt,
        payload: { ...event.payload },
        pipelineId: event.pipelineId,
        requestSource: event.requestSource,
        runId: event.runId,
    };
}

function lastEventId<T extends { eventId: number }>(events: T[], fallback: number): number {
    return events.at(-1)?.eventId ?? fallback;
}
