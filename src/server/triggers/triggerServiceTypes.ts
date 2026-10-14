/**
 * @fileoverview Neutral runtime and delivery contracts shared by trigger sources.
 */

import type { RunSubmission, RunSubmissionResult } from '../types/pipelineServiceTypes.ts';
import type {
    CanonicalTriggerEvent,
    TriggerDefinition,
    TriggerIngestionItem,
    TriggerPersistence,
} from '../types/triggerTypes.ts';
import type {
    TriggerEventStatus,
} from '../../shared/status/trigger.ts';

/** Runtime dependencies shared by every trigger source. */
export interface TriggerRuntime {
    now: () => number;
    onError?: (message: string, error: unknown) => void;
    persistence: TriggerPersistence;
    submitRun: (submission: RunSubmission) => Promise<RunSubmissionResult>;
}

/** Optional wording overrides for source-specific audit and routing records. */
export interface TriggerDeliveryMessages {
    acceptedDetail?: string;
    acceptedRoutingReason?: string;
    deadLetterReplayDetail?: string;
    deadLetterReplayRoutingReason?: string;
    idempotentReplayDetail?: string;
    idempotentReplayRoutingReason?: string;
}

/** Optional metadata used when delivering one trigger event. */
export interface TriggerDeliveryOptions {
    correlationId?: string;
    idempotencyKey?: string;
    messages?: TriggerDeliveryMessages;
    replay?: boolean;
    requestSource?: string;
    updateEventStatus?: (status: TriggerEventStatus) => Promise<void>;
}

/** Function shape shared by event ingestion, schedules, and dead-letter replay. */
export type TriggerDeliver = (
    event: CanonicalTriggerEvent,
    trigger: TriggerDefinition,
    options?: TriggerDeliveryOptions,
) => Promise<TriggerIngestionItem>;
