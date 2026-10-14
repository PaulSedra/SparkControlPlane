/**
 * @fileoverview Replay and discard operations for failed trigger deliveries.
 */

import { ControlPlaneApiError } from '../errors/controlPlaneApiError.ts';
import type {
    TriggerDeadLetter,
    TriggerDefinition,
    TriggerIngestionItem,
    TriggerIngestionResult,
} from '../types/triggerTypes.ts';
import {
    TriggerDeadLetterStatus,
    TriggerDeliveryStatus,
    TriggerEventStatus,
    TriggerIngestionStatus,
    TriggerRoutingOutcome,
} from '../../shared/status/trigger.ts';
import { nextTriggerAttemptNumber } from './triggerDelivery.ts';
import type {
    TriggerDeliver,
    TriggerRuntime,
} from './triggerServiceTypes.ts';

/** Recovery operations shared by event and scheduled trigger deliveries. */
export interface TriggerDeadLetterService {
    discardDeadLetter: (deadLetterId: string) => Promise<TriggerDeadLetter>;
    replayDeadLetter: (deadLetterId: string) => Promise<TriggerIngestionResult>;
}

/**
 * Creates handlers for recovering or closing failed trigger deliveries.
 *
 * Replay is allowed only for a pending dead letter whose trigger still exists,
 * is active, and is enabled; it reuses normal idempotent delivery and records
 * the replay count. Discard closes the pending record and writes an explicit
 * operator delivery outcome without submitting a run.
 */
export function createTriggerDeadLetterService(
    runtime: TriggerRuntime,
    deliver: TriggerDeliver,
): TriggerDeadLetterService {
    return {
        discardDeadLetter: (deadLetterId) => discardDeadLetter(runtime, deadLetterId),
        replayDeadLetter: (deadLetterId) => replayDeadLetter(runtime, deliver, deadLetterId),
    };
}

async function replayDeadLetter(
    runtime: TriggerRuntime,
    deliver: TriggerDeliver,
    deadLetterId: string,
): Promise<TriggerIngestionResult> {
    const { deadLetter, trigger } = await getReplayableDeadLetter(runtime, deadLetterId);
    const replayCount = deadLetter.replayCount + 1;
    await runtime.persistence.updateTriggerDeadLetter(deadLetter.id, {
        replayCount,
        status: TriggerDeadLetterStatus.PENDING,
    });
    const result = await deliver(deadLetter.event, trigger, { replay: true });
    if (result.status === TriggerIngestionStatus.ACCEPTED) {
        await runtime.persistence.updateTriggerEventStatus(
            deadLetter.eventId,
            TriggerEventStatus.ROUTED,
        );
        await runtime.persistence.updateTriggerDeadLetter(deadLetter.id, {
            replayCount,
            status: TriggerDeadLetterStatus.REPLAYED,
        });
        return resultFor({
            ...result,
            reason: 'The dead-letter event was replayed through the normal run-submission path.',
        });
    }
    await runtime.persistence.updateTriggerEventStatus(
        deadLetter.eventId,
        TriggerEventStatus.FAILED,
    );
    return resultFor(result);
}

async function getReplayableDeadLetter(
    runtime: TriggerRuntime,
    deadLetterId: string,
): Promise<{ deadLetter: TriggerDeadLetter; trigger: TriggerDefinition }> {
    const deadLetter = await getPendingDeadLetter(runtime, deadLetterId);
    const trigger = await runtime.persistence.getTrigger(deadLetter.triggerId);
    if (trigger == null) {
        throw new ControlPlaneApiError(
            409,
            'The trigger for this dead letter no longer exists.',
        );
    }
    if (!trigger.active) {
        throw new ControlPlaneApiError(
            409,
            'The trigger is no longer active; it is not present in the current definition.',
        );
    }
    if (!trigger.enabled) {
        throw new ControlPlaneApiError(
            409,
            'The trigger is disabled; enable it before replaying this dead letter.',
        );
    }
    return { deadLetter, trigger };
}

async function getPendingDeadLetter(
    runtime: TriggerRuntime,
    deadLetterId: string,
): Promise<TriggerDeadLetter> {
    const deadLetter = await runtime.persistence.getTriggerDeadLetter(deadLetterId);
    if (deadLetter == null) {
        throw new ControlPlaneApiError(404, `Unknown trigger dead letter: ${deadLetterId}`);
    }
    if (deadLetter.status !== TriggerDeadLetterStatus.PENDING) {
        throw new ControlPlaneApiError(
            409,
            `Trigger dead letter is already ${deadLetter.status.toLowerCase()}.`,
        );
    }
    return deadLetter;
}

async function discardDeadLetter(
    runtime: TriggerRuntime,
    deadLetterId: string,
): Promise<TriggerDeadLetter> {
    const deadLetter = await getPendingDeadLetter(runtime, deadLetterId);
    const reason = 'The dead-letter event was discarded by an operator.';
    await runtime.persistence.recordTriggerDeliveryAttempt({
        attemptNumber: await nextTriggerAttemptNumber(
            runtime.persistence,
            deadLetter.triggerId,
            deadLetter.eventId,
        ),
        completedAt: new Date(runtime.now()).toISOString(),
        eventId: deadLetter.eventId,
        failureReason: reason,
        status: TriggerDeliveryStatus.DISCARDED,
        triggerId: deadLetter.triggerId,
    });
    await runtime.persistence.recordRoutingDecision({
        eventId: deadLetter.eventId,
        outcome: TriggerRoutingOutcome.FAILED,
        reason,
        triggerId: deadLetter.triggerId,
    });
    await runtime.persistence.updateTriggerOutcome(deadLetter.triggerId, {
        detail: reason,
        eventId: deadLetter.eventId,
        occurredAt: deadLetter.event.occurredAt,
        status: TriggerDeliveryStatus.DISCARDED,
    });
    return runtime.persistence.updateTriggerDeadLetter(deadLetter.id, {
        status: TriggerDeadLetterStatus.DISCARDED,
    });
}

function resultFor(item: TriggerIngestionItem): TriggerIngestionResult {
    return {
        accepted: item.status === TriggerIngestionStatus.ACCEPTED ? 1 : 0,
        duplicates: 0,
        failed: item.status === TriggerIngestionStatus.FAILED ? 1 : 0,
        ignored: 0,
        items: [item],
    };
}
