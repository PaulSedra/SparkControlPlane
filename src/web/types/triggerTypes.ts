/**
 * @fileoverview Web-facing trigger and dead-letter response contracts.
 */

import type {
    TriggerDeadLetterStatus,
    TriggerDeliveryStatus,
} from '../../shared/status/trigger.ts';

/** Trigger source displayed in the web application. */
export type TriggerType = 'FILE_ARRIVAL' | 'SCHEDULE' | 'WEBHOOK';

/** Latest trigger delivery outcome returned by the API. */
export interface TriggerOutcome {
    detail?: string;
    eventId: string;
    occurredAt: string;
    runId?: string;
    status: TriggerDeliveryStatus;
}

/** Trigger definition shown in pipeline detail and trigger management views. */
export interface TriggerDefinition {
    active: boolean;
    configuration: Record<string, unknown>;
    createdAt: string;
    enabled: boolean;
    id: string;
    lastOutcome?: TriggerOutcome;
    mode: string;
    name: string;
    nodeNames?: string[];
    pipelineId: string;
    type: TriggerType;
    updatedAt: string;
}

/** Schedule state returned for a trigger. */
export interface TriggerScheduleStatus {
    lastOccurrenceAt?: string;
    lastOutcome?: TriggerOutcome;
    nextOccurrenceAt?: string;
    triggerId: string;
}

/** One persisted delivery attempt shown in trigger diagnostics. */
export interface TriggerDeliveryAttempt {
    attemptId: number;
    attemptNumber: number;
    completedAt?: string;
    eventId: string;
    failureReason?: string;
    runId?: string;
    status: TriggerDeliveryStatus;
    triggerId: string;
}

/** Canonical event payload retained for trigger diagnostics. */
export interface TriggerEvent {
    attributes: Record<string, string>;
    deduplicationKey: string;
    eventId: string;
    eventType: string;
    occurredAt: string;
    payload: Record<string, unknown>;
    source: string;
}

/** Trigger event that requires replay or explicit discard. */
export interface TriggerDeadLetter {
    createdAt: string;
    event: TriggerEvent;
    eventId: string;
    failureReason: string;
    id: string;
    replayCount: number;
    status: TriggerDeadLetterStatus;
    triggerId: string;
    updatedAt: string;
}
