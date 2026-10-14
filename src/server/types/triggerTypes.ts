/**
 * @fileoverview Shared trigger definitions, events, routing, and persistence types.
 */

import type { RunMode } from '../../shared/pipelineRegistryTypes.ts';
import type {
    TriggerDeadLetterStatus,
    TriggerDeliveryStatus,
    TriggerEventStatus,
    TriggerIngestionStatus,
    TriggerRoutingOutcome,
} from '../../shared/status/trigger.ts';

/** Trigger source supported by the control plane. */
export type TriggerType = 'FILE_ARRIVAL' | 'SCHEDULE' | 'WEBHOOK';

/** Misfire behavior currently supported for scheduled triggers. */
export type MisfirePolicy = 'CATCH_UP_ONCE';

/** Cron and time-zone settings for a scheduled trigger. */
export interface ScheduleConfiguration {
    cron: string;
    misfirePolicy: MisfirePolicy;
    timeZone: string;
}

/** One resolved scheduled occurrence and its local display time. */
export interface ScheduleOccurrence {
    at: Date;
    localTime: string;
}

/** Fields required to create a trigger. */
export interface TriggerDefinitionInput {
    callerMetadata?: Record<string, string>;
    configuration: Record<string, unknown>;
    enabled?: boolean;
    mode: RunMode;
    name: string;
    nodeNames?: string[];
    pipelineId: string;
    type: TriggerType;
}

/** Latest delivery outcome associated with a trigger. */
export interface TriggerOutcome {
    detail?: string;
    eventId: string;
    occurredAt: string;
    runId?: string;
    status: TriggerDeliveryStatus;
}

/** Persisted trigger definition and lifecycle metadata. */
export interface TriggerDefinition extends TriggerDefinitionInput {
    active: boolean;
    createdAt: string;
    enabled: boolean;
    id: string;
    lastOutcome?: TriggerOutcome;
    managedByYaml?: boolean;
    updatedAt: string;
}

/** Partial trigger update accepted by the API and persistence layer. */
export interface TriggerDefinitionPatch {
    callerMetadata?: Record<string, string>;
    configuration?: Record<string, unknown>;
    enabled?: boolean;
    mode?: RunMode;
    name?: string;
    nodeNames?: string[];
    pipelineId?: string;
    type?: TriggerType;
}

/** Normalized event shape used by all trigger sources. */
export interface CanonicalTriggerEvent {
    attributes: Record<string, string>;
    deduplicationKey: string;
    eventId: string;
    eventType: string;
    occurredAt: string;
    payload: Record<string, unknown>;
    source: string;
}

/** Persisted event envelope and its ingestion status. */
export interface TriggerEventRecord {
    duplicateCount: number;
    duplicateOfEventId?: string;
    event: CanonicalTriggerEvent;
    receivedAt: string;
    status: TriggerEventStatus;
}

/** Input used to persist one trigger-to-event routing decision. */
export interface TriggerRoutingDecisionInput {
    eventId: string;
    outcome: TriggerRoutingOutcome;
    reason?: string;
    runId?: string;
    triggerId: string;
}

/** Persisted routing decision with database identity and timestamp. */
export interface TriggerRoutingDecision extends TriggerRoutingDecisionInput {
    createdAt: string;
    decisionId: number;
}

/** Input used to record one trigger delivery attempt. */
export interface TriggerDeliveryAttemptInput {
    attemptNumber: number;
    completedAt?: string;
    correlationId?: string;
    eventId: string;
    failureReason?: string;
    runId?: string;
    startedAt?: string;
    status: TriggerDeliveryStatus;
    triggerId: string;
}

/** Persisted delivery attempt with database identity and creation time. */
export interface TriggerDeliveryAttempt extends TriggerDeliveryAttemptInput {
    attemptId: number;
    createdAt: string;
}

/** Per-event result included in an ingestion response. */
export interface TriggerIngestionItem {
    eventId: string;
    reason?: string;
    status: TriggerIngestionStatus;
    triggerIds?: string[];
}

/** Counts and item-level results for one ingestion request. */
export interface TriggerIngestionResult {
    accepted: number;
    duplicates: number;
    failed: number;
    ignored: number;
    items: TriggerIngestionItem[];
}

/** Stored trigger event that could not be delivered successfully. */
export interface TriggerDeadLetter {
    createdAt: string;
    event: CanonicalTriggerEvent;
    eventId: string;
    failureReason: string;
    id: string;
    replayCount: number;
    status: TriggerDeadLetterStatus;
    triggerId: string;
    updatedAt: string;
}

/** Fields required to create a trigger dead-letter record. */
export interface TriggerDeadLetterInput {
    event: CanonicalTriggerEvent;
    eventId: string;
    failureReason: string;
    triggerId: string;
}

/** Durable trigger-specific persistence operations. */
export interface TriggerPersistence {
    createTrigger(input: TriggerDefinitionInput): Promise<TriggerDefinition>;
    getTrigger(triggerId: string): Promise<TriggerDefinition | undefined>;
    listTriggers(): Promise<TriggerDefinition[]>;
    reconcileYamlTriggers(
        pipelineId: string,
        inputs: TriggerDefinitionInput[],
    ): Promise<TriggerDefinition[]>;
    updateTrigger(
        triggerId: string,
        patch: TriggerDefinitionPatch,
    ): Promise<TriggerDefinition>;
    updateTriggerOutcome(
        triggerId: string,
        outcome: TriggerOutcome,
    ): Promise<TriggerDefinition>;
    recordTriggerEvent(event: CanonicalTriggerEvent): Promise<{
        duplicate: boolean;
        event: TriggerEventRecord;
    }>;
    updateTriggerEventStatus(
        eventId: string,
        status: TriggerEventStatus,
    ): Promise<TriggerEventRecord>;
    listTriggerEvents(limit?: number): Promise<TriggerEventRecord[]>;
    recordRoutingDecision(
        input: TriggerRoutingDecisionInput,
    ): Promise<TriggerRoutingDecision>;
    listTriggerRoutingDecisions(
        eventId?: string,
        triggerId?: string,
        limit?: number,
    ): Promise<TriggerRoutingDecision[]>;
    recordTriggerDeliveryAttempt(
        input: TriggerDeliveryAttemptInput,
    ): Promise<TriggerDeliveryAttempt>;
    listTriggerDeliveryAttempts(
        triggerId?: string,
        limit?: number,
    ): Promise<TriggerDeliveryAttempt[]>;
    createTriggerDeadLetter(input: TriggerDeadLetterInput): Promise<TriggerDeadLetter>;
    getTriggerDeadLetter(deadLetterId: string): Promise<TriggerDeadLetter | undefined>;
    listTriggerDeadLetters(
        status?: TriggerDeadLetterStatus,
        limit?: number,
    ): Promise<TriggerDeadLetter[]>;
    updateTriggerDeadLetter(
        deadLetterId: string,
        patch: { failureReason?: string; replayCount?: number; status: TriggerDeadLetterStatus },
    ): Promise<TriggerDeadLetter>;
}
