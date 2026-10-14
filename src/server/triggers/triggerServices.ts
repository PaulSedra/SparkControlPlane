/**
 * @fileoverview Composes the runtime, delivery, and recovery services shared
 * by every trigger source.
 */

import type { RunSubmission, RunSubmissionResult } from '../types/pipelineServiceTypes.ts';
import type {
    CanonicalTriggerEvent,
    TriggerDefinition,
    TriggerPersistence,
} from '../types/triggerTypes.ts';
import { createTriggerDeadLetterService, type TriggerDeadLetterService } from './triggerDeadLetterService.ts';
import { deliverTriggerEvent } from './triggerDelivery.ts';
import type {
    TriggerDeliver,
    TriggerDeliveryOptions,
    TriggerRuntime,
} from './triggerServiceTypes.ts';

/** Dependencies used to compose shared trigger operations. */
export interface TriggerServicesOptions {
    now?: () => number;
    onError?: (message: string, error: unknown) => void;
    persistence: TriggerPersistence;
    submitRun: (submission: RunSubmission) => Promise<RunSubmissionResult>;
}

/** Shared operations consumed by event ingestion, schedules, and the API. */
export interface TriggerServices {
    deadLetters: TriggerDeadLetterService;
    deliver: TriggerDeliver;
    runtime: TriggerRuntime;
}

/**
 * Creates one shared trigger runtime and its source-neutral operations.
 *
 * Event ingestion and schedule execution must use the returned `deliver`
 * function so their delivery attempts, failures, dead letters, and replay
 * behavior use the same persistence and run-submission path. The registry API
 * uses `deadLetters` directly because recovery is not owned by either source.
 */
export function createTriggerServices(options: TriggerServicesOptions): TriggerServices {
    const runtime: TriggerRuntime = {
        now: options.now ?? (() => Date.now()),
        onError: options.onError,
        persistence: options.persistence,
        submitRun: options.submitRun,
    };
    const deliver: TriggerDeliver = (event, trigger, deliveryOptions = {}) =>
        deliverTriggerEvent(runtime, createDeliveryRequest(event, trigger, deliveryOptions));
    return {
        deadLetters: createTriggerDeadLetterService(runtime, deliver),
        deliver,
        runtime,
    };
}

function createDeliveryRequest(
    event: CanonicalTriggerEvent,
    trigger: TriggerDefinition,
    options: TriggerDeliveryOptions,
) {
    return {
        correlationId: options.correlationId ?? `trigger-${trigger.id}-${event.eventId}`,
        event,
        idempotencyKey: options.idempotencyKey ?? defaultIdempotencyKey(event, trigger),
        messages: options.messages,
        replay: options.replay,
        requestSource: options.requestSource ?? triggerRequestSource(trigger),
        trigger,
        updateEventStatus: options.updateEventStatus,
    };
}

function defaultIdempotencyKey(
    event: CanonicalTriggerEvent,
    trigger: TriggerDefinition,
): string {
    return trigger.type === 'SCHEDULE'
        ? event.deduplicationKey
        : `trigger:${trigger.id}:${event.deduplicationKey}`;
}

function triggerRequestSource(trigger: TriggerDefinition): string {
    if (trigger.type === 'FILE_ARRIVAL') {
        return 'trigger:file-arrival';
    }
    if (trigger.type === 'SCHEDULE') {
        return 'trigger:schedule';
    }
    return 'trigger:webhook';
}
