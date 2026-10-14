/**
 * @fileoverview Shared trigger-to-run delivery and durable outcome recording.
 */

import type { RunSubmission, RunSubmissionResult } from '../types/pipelineServiceTypes.ts';
import type {
    CanonicalTriggerEvent,
    TriggerDefinition,
    TriggerIngestionItem,
    TriggerPersistence,
} from '../types/triggerTypes.ts';
import {
    TriggerDeliveryStatus,
    TriggerEventStatus,
    TriggerIngestionStatus,
    TriggerRoutingOutcome,
} from '../../shared/status/trigger.ts';
import type { TriggerDeliveryMessages } from './triggerServiceTypes.ts';

/** Dependencies required to submit a trigger event and persist its outcome. */
interface TriggerDeliveryDependencies {
    now: () => number;
    persistence: TriggerPersistence;
    submitRun: (submission: RunSubmission) => Promise<RunSubmissionResult>;
}

/** Request metadata used for one trigger event delivery attempt. */
interface TriggerDeliveryRequest {
    correlationId: string;
    event: CanonicalTriggerEvent;
    idempotencyKey: string;
    messages?: TriggerDeliveryMessages;
    replay?: boolean;
    requestSource: string;
    trigger: TriggerDefinition;
    updateEventStatus?: (status: TriggerEventStatus) => Promise<void>;
}

/**
 * Returns the next delivery-attempt number for one trigger/event pair.
 *
 * The number is derived from persisted attempts so retries, dead-letter replay,
 * and operator discard remain ordered in the audit trail. The persistence
 * adapter supplies the bounded attempt history used for this calculation.
 */
export async function nextTriggerAttemptNumber(
    persistence: TriggerPersistence,
    triggerId: string,
    eventId: string,
): Promise<number> {
    const attempts = await persistence.listTriggerDeliveryAttempts(triggerId, 1000);
    return 1 + attempts
        .filter((attempt) => attempt.eventId === eventId)
        .reduce((maximum, attempt) => Math.max(maximum, attempt.attemptNumber), 0);
}

/**
 * Submits one trigger event and records accepted, replayed, or failed delivery
 * evidence, including a dead letter for failures.
 */
export async function deliverTriggerEvent(
    dependencies: TriggerDeliveryDependencies,
    request: TriggerDeliveryRequest,
): Promise<TriggerIngestionItem> {
    const startedAt = new Date(dependencies.now()).toISOString();
    try {
        const result = await submitTriggerRun(dependencies, request);
        const outcome = deliveryOutcome(
            request.replay === true,
            result.replayed,
            request.messages,
        );
        await recordSuccessfulDelivery(dependencies, request, result, startedAt, outcome);
        return {
            eventId: request.event.eventId,
            status: TriggerIngestionStatus.ACCEPTED,
            triggerIds: [request.trigger.id],
        };
    } catch (error) {
        return recordFailedDelivery(dependencies, request, startedAt, error);
    }
}

async function submitTriggerRun(
    dependencies: TriggerDeliveryDependencies,
    request: TriggerDeliveryRequest,
): Promise<RunSubmissionResult> {
    return dependencies.submitRun({
        callerMetadata: {
            ...request.trigger.callerMetadata,
            triggerEventId: request.event.eventId,
            triggerId: request.trigger.id,
        },
        correlationId: request.correlationId,
        idempotencyKey: request.idempotencyKey,
        mode: request.trigger.mode,
        nodeNames: request.trigger.nodeNames,
        pipelineId: request.trigger.pipelineId,
        requestSource: request.requestSource,
    });
}

function deliveryOutcome(
    replay: boolean,
    idempotentReplay: boolean,
    overrides: TriggerDeliveryMessages = {},
): {
    detail: string;
    routingReason: string;
    status: TriggerDeliveryStatus;
} {
    const messages = {
        acceptedDetail: 'The event was accepted by the control plane.',
        acceptedRoutingReason: 'The event submitted a pipeline run.',
        deadLetterReplayDetail: 'The dead-letter event was replayed through the normal run-submission path.',
        deadLetterReplayRoutingReason: 'The dead-letter event was replayed through the normal run-submission path.',
        idempotentReplayDetail: 'The event delivery replayed an existing run.',
        idempotentReplayRoutingReason: 'The event replayed an existing idempotent run.',
        ...overrides,
    };
    if (replay) {
        return {
            detail: messages.deadLetterReplayDetail,
            routingReason: messages.deadLetterReplayRoutingReason,
            status: TriggerDeliveryStatus.REPLAYED,
        };
    }
    if (idempotentReplay) {
        return {
            detail: messages.idempotentReplayDetail,
            routingReason: messages.idempotentReplayRoutingReason,
            status: TriggerDeliveryStatus.REPLAYED,
        };
    }
    return {
        detail: messages.acceptedDetail,
        routingReason: messages.acceptedRoutingReason,
        status: TriggerDeliveryStatus.ACCEPTED,
    };
}

async function recordSuccessfulDelivery(
    dependencies: TriggerDeliveryDependencies,
    request: TriggerDeliveryRequest,
    result: RunSubmissionResult,
    startedAt: string,
    outcome: {
        detail: string;
        routingReason: string;
        status: TriggerDeliveryStatus;
    },
): Promise<void> {
    await dependencies.persistence.recordTriggerDeliveryAttempt({
        attemptNumber: await nextTriggerAttemptNumber(
            dependencies.persistence,
            request.trigger.id,
            request.event.eventId,
        ),
        completedAt: new Date(dependencies.now()).toISOString(),
        correlationId: request.correlationId,
        eventId: request.event.eventId,
        runId: result.run.runId,
        startedAt,
        status: outcome.status,
        triggerId: request.trigger.id,
    });
    await request.updateEventStatus?.(TriggerEventStatus.ROUTED);
    await dependencies.persistence.recordRoutingDecision({
        eventId: request.event.eventId,
        outcome: TriggerRoutingOutcome.MATCHED,
        reason: outcome.routingReason,
        runId: result.run.runId,
        triggerId: request.trigger.id,
    });
    await dependencies.persistence.updateTriggerOutcome(request.trigger.id, {
        detail: outcome.detail,
        eventId: request.event.eventId,
        occurredAt: request.event.occurredAt,
        runId: result.run.runId,
        status: outcome.status,
    });
}

async function recordFailedDelivery(
    dependencies: TriggerDeliveryDependencies,
    request: TriggerDeliveryRequest,
    startedAt: string,
    error: unknown,
): Promise<TriggerIngestionItem> {
    const reason = error instanceof Error ? error.message : String(error);
    await dependencies.persistence.recordTriggerDeliveryAttempt({
        attemptNumber: await nextTriggerAttemptNumber(
            dependencies.persistence,
            request.trigger.id,
            request.event.eventId,
        ),
        completedAt: new Date(dependencies.now()).toISOString(),
        eventId: request.event.eventId,
        failureReason: reason,
        startedAt,
        status: TriggerDeliveryStatus.FAILED,
        triggerId: request.trigger.id,
    });
    await request.updateEventStatus?.(TriggerEventStatus.FAILED);
    await dependencies.persistence.recordRoutingDecision({
        eventId: request.event.eventId,
        outcome: TriggerRoutingOutcome.FAILED,
        reason,
        triggerId: request.trigger.id,
    });
    await dependencies.persistence.updateTriggerOutcome(request.trigger.id, {
        detail: reason,
        eventId: request.event.eventId,
        occurredAt: request.event.occurredAt,
        status: TriggerDeliveryStatus.FAILED,
    });
    await dependencies.persistence.createTriggerDeadLetter({
        event: request.event,
        eventId: request.event.eventId,
        failureReason: reason,
        triggerId: request.trigger.id,
    });
    return {
        eventId: request.event.eventId,
        reason,
        status: TriggerIngestionStatus.FAILED,
        triggerIds: [request.trigger.id],
    };
}
