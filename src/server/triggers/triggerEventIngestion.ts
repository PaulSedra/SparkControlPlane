/**
 * @fileoverview Normalizes, matches, deduplicates, and delivers trigger events.
 */

import type {
    CanonicalTriggerEvent,
    TriggerDefinition,
    TriggerIngestionItem,
    TriggerIngestionResult,
} from '../types/triggerTypes.ts';
import {
    ACCEPTED_TRIGGER_INGESTION_STATUSES,
    FINAL_TRIGGER_DELIVERY_STATUSES,
    TriggerEventStatus,
    TriggerIngestionStatus,
    TriggerRoutingOutcome,
} from '../../shared/status/trigger.ts';
import { normalizeAistorNotification } from './aistorAdapter.ts';
import type {
    TriggerDebounceCoordinator,
} from './triggerEventDebounce.ts';
import type {
    TriggerDeliver,
    TriggerRuntime,
} from './triggerServiceTypes.ts';
import { debounceMilliseconds, matchesTrigger } from './triggerRouting.ts';

interface TriggerMatchEvaluation {
    disabled: TriggerDefinition[];
    invalid: Array<{ reason: string; trigger: TriggerDefinition }>;
    matching: TriggerDefinition[];
    noMatch: TriggerDefinition[];
}

interface TriggerEventIngestion {
    ingestAistorNotification: (payload: unknown) => Promise<TriggerIngestionResult>;
    ingestCanonicalEvent: (event: CanonicalTriggerEvent) => Promise<TriggerIngestionResult>;
}

interface TriggerEventIngestionDependencies {
    debounce: TriggerDebounceCoordinator;
    deliver: TriggerDeliver;
    runtime: TriggerRuntime;
}

/**
 * Creates ingestion handlers for canonical events and AIStor notifications.
 *
 * Canonical events are recorded before selector evaluation so duplicate
 * provider deliveries can be reported without submitting another run. AIStor
 * records are normalized one at a time; invalid records are failed
 * independently, matching enabled triggers fan out, and configured
 * file-arrival matches enter the shared debounce coordinator.
 */
export function createTriggerEventIngestion(
    runtime: TriggerRuntime,
    debounce: TriggerDebounceCoordinator,
    deliver: TriggerDeliver,
): TriggerEventIngestion {
    const dependencies = { debounce, deliver, runtime };
    return {
        ingestAistorNotification: (payload) => ingestAistorNotification(dependencies, payload),
        ingestCanonicalEvent: (event) => ingestCanonicalEvent(dependencies, event),
    };
}

async function ingestCanonicalEvent(
    dependencies: TriggerEventIngestionDependencies,
    event: CanonicalTriggerEvent,
): Promise<TriggerIngestionResult> {
    const recorded = await dependencies.runtime.persistence.recordTriggerEvent(event);
    const canonicalEvent = recorded.event.event;
    const evaluation = evaluateTriggerMatches(
        await dependencies.runtime.persistence.listTriggers(),
        canonicalEvent,
    );
    await recordRoutingDecisions(dependencies.runtime, canonicalEvent.eventId, evaluation);
    if (recorded.duplicate) {
        return processDuplicate(dependencies, canonicalEvent, evaluation);
    }
    if (evaluation.matching.length === 0) {
        return handleUnmatchedEvent(dependencies.runtime, canonicalEvent.eventId, evaluation);
    }
    return deliverMatchingTriggers(dependencies, canonicalEvent, evaluation.matching);
}

async function ingestAistorNotification(
    dependencies: TriggerEventIngestionDependencies,
    payload: unknown,
): Promise<TriggerIngestionResult> {
    const normalized = normalizeAistorNotification(
        payload,
        new Date(dependencies.runtime.now()),
    );
    const items: TriggerIngestionItem[] = [];
    for (const record of normalized) {
        if (record.invalidReason != null) {
            items.push(await recordInvalidEvent(dependencies.runtime, record.event, record.invalidReason));
        } else {
            items.push(...(await ingestCanonicalEvent(dependencies, record.event)).items);
        }
    }
    return aggregate(items);
}

function evaluateTriggerMatches(
    triggers: TriggerDefinition[],
    event: CanonicalTriggerEvent,
): TriggerMatchEvaluation {
    const evaluation: TriggerMatchEvaluation = {
        disabled: [],
        invalid: [],
        matching: [],
        noMatch: [],
    };
    for (const trigger of triggers) {
        if (trigger.active === false || trigger.type === 'SCHEDULE') {
            continue;
        }
        try {
            if (!matchesTrigger(trigger, event)) {
                evaluation.noMatch.push(trigger);
            } else if (trigger.enabled) {
                evaluation.matching.push(trigger);
            } else {
                evaluation.disabled.push(trigger);
            }
        } catch (error) {
            evaluation.invalid.push({
                reason: error instanceof Error ? error.message : String(error),
                trigger,
            });
        }
    }
    return evaluation;
}

async function recordRoutingDecisions(
    runtime: TriggerRuntime,
    eventId: string,
    evaluation: TriggerMatchEvaluation,
): Promise<void> {
    for (const trigger of evaluation.invalid) {
        await runtime.persistence.recordRoutingDecision({
            eventId,
            outcome: TriggerRoutingOutcome.INVALID,
            reason: trigger.reason,
            triggerId: trigger.trigger.id,
        });
    }
    for (const trigger of evaluation.disabled) {
        await runtime.persistence.recordRoutingDecision({
            eventId,
            outcome: TriggerRoutingOutcome.DISABLED,
            reason: 'Trigger is disabled.',
            triggerId: trigger.id,
        });
    }
    for (const trigger of evaluation.noMatch) {
        await runtime.persistence.recordRoutingDecision({
            eventId,
            outcome: TriggerRoutingOutcome.NO_MATCH,
            reason: 'Event selectors did not match the trigger.',
            triggerId: trigger.id,
        });
    }
}

async function handleUnmatchedEvent(
    runtime: TriggerRuntime,
    eventId: string,
    evaluation: TriggerMatchEvaluation,
): Promise<TriggerIngestionResult> {
    const item = unmatchedEventItem(eventId, evaluation);
    await runtime.persistence.updateTriggerEventStatus(
        eventId,
        item.status === TriggerIngestionStatus.FAILED
            ? TriggerEventStatus.FAILED
            : TriggerEventStatus.IGNORED,
    );
    return resultFor(item);
}

async function deliverMatchingTriggers(
    dependencies: TriggerEventIngestionDependencies,
    event: CanonicalTriggerEvent,
    matching: TriggerDefinition[],
): Promise<TriggerIngestionResult> {
    const items: TriggerIngestionItem[] = [];
    const immediate: Array<{ event: CanonicalTriggerEvent; trigger: TriggerDefinition }> = [];
    for (const trigger of matching) {
        if (debounceMilliseconds(trigger) > 0) {
            dependencies.debounce.enqueue(trigger, event);
            items.push({
                eventId: event.eventId,
                reason: 'Matching file events are waiting for the debounce window.',
                status: TriggerIngestionStatus.DEBOUNCED,
                triggerIds: [trigger.id],
            });
        } else {
            immediate.push({ event, trigger });
        }
    }
    const delivered = await Promise.all(immediate.map(({ event: itemEvent, trigger }) =>
        dependencies.deliver(itemEvent, trigger)
    ));
    items.push(...delivered);
    await updateEventStatusFromDeliveries(dependencies.runtime, event.eventId, delivered);
    return aggregate(items);
}

async function updateEventStatusFromDeliveries(
    runtime: TriggerRuntime,
    eventId: string,
    delivered: TriggerIngestionItem[],
): Promise<void> {
    if (delivered.some((item) => item.status === TriggerIngestionStatus.FAILED)) {
        await runtime.persistence.updateTriggerEventStatus(eventId, TriggerEventStatus.FAILED);
    } else if (delivered.some((item) => item.status === TriggerIngestionStatus.ACCEPTED)) {
        await runtime.persistence.updateTriggerEventStatus(eventId, TriggerEventStatus.ROUTED);
    }
}

async function processDuplicate(
    dependencies: TriggerEventIngestionDependencies,
    event: CanonicalTriggerEvent,
    evaluation: TriggerMatchEvaluation,
): Promise<TriggerIngestionResult> {
    const items: TriggerIngestionItem[] = [];
    for (const trigger of evaluation.matching) {
        items.push(await processDuplicateTrigger(dependencies, event, trigger));
    }
    if (evaluation.matching.length === 0) {
        items.push(duplicateWithoutMatch(event.eventId, evaluation));
    }
    return aggregate(items);
}

async function processDuplicateTrigger(
    dependencies: TriggerEventIngestionDependencies,
    event: CanonicalTriggerEvent,
    trigger: TriggerDefinition,
): Promise<TriggerIngestionItem> {
    if (debounceMilliseconds(trigger) > 0 && dependencies.debounce.hasPending(trigger, event)) {
        return recordDuplicate(
            dependencies.runtime,
            event,
            trigger,
            'The event is already waiting in the debounce window.',
        );
    }
    if (await hasTerminalDelivery(dependencies.runtime, trigger.id, event.eventId)) {
        return recordDuplicate(
            dependencies.runtime,
            event,
            trigger,
            'The event was already delivered to this trigger.',
            false,
        );
    }
    return dependencies.deliver(event, trigger);
}

async function hasTerminalDelivery(
    runtime: TriggerRuntime,
    triggerId: string,
    eventId: string,
): Promise<boolean> {
    const attempts = await runtime.persistence.listTriggerDeliveryAttempts(triggerId, 1000);
    return attempts.some((attempt) =>
        attempt.eventId === eventId &&
        FINAL_TRIGGER_DELIVERY_STATUSES.includes(attempt.status)
    );
}

async function recordDuplicate(
    runtime: TriggerRuntime,
    event: CanonicalTriggerEvent,
    trigger: TriggerDefinition,
    reason: string,
    includeReason = true,
): Promise<TriggerIngestionItem> {
    await runtime.persistence.recordRoutingDecision({
        eventId: event.eventId,
        outcome: TriggerRoutingOutcome.DUPLICATE,
        reason,
        triggerId: trigger.id,
    });
    const item: TriggerIngestionItem = {
        eventId: event.eventId,
        status: TriggerIngestionStatus.DUPLICATE,
        triggerIds: [trigger.id],
    };
    if (includeReason) {
        item.reason = reason;
    }
    return item;
}

async function recordInvalidEvent(
    runtime: TriggerRuntime,
    event: CanonicalTriggerEvent,
    reason: string,
): Promise<TriggerIngestionItem> {
    const recorded = await runtime.persistence.recordTriggerEvent(event);
    if (!recorded.duplicate) {
        await runtime.persistence.updateTriggerEventStatus(
            event.eventId,
            TriggerEventStatus.FAILED,
        );
    }
    return {
        eventId: event.eventId,
        reason,
        status: recorded.duplicate
            ? TriggerIngestionStatus.DUPLICATE
            : TriggerIngestionStatus.FAILED,
    };
}

function unmatchedEventItem(
    eventId: string,
    evaluation: TriggerMatchEvaluation,
): TriggerIngestionItem {
    const hasInvalidTrigger = evaluation.invalid.length > 0;
    return {
        eventId,
        reason: hasInvalidTrigger
            ? evaluation.invalid.map((item) => item.reason).join('; ')
            : evaluation.disabled.length > 0
                ? 'Matching triggers are disabled.'
                : 'No enabled trigger matched the event.',
        status: hasInvalidTrigger
            ? TriggerIngestionStatus.FAILED
            : TriggerIngestionStatus.IGNORED,
        triggerIds: evaluation.disabled.map((trigger) => trigger.id),
    };
}

function duplicateWithoutMatch(
    eventId: string,
    evaluation: TriggerMatchEvaluation,
): TriggerIngestionItem {
    return {
        eventId,
        reason: evaluation.invalid.length > 0
            ? evaluation.invalid.map((item) => item.reason).join('; ')
            : evaluation.disabled.length > 0
                ? 'Matching triggers are disabled.'
                : 'The event was already received.',
        status: TriggerIngestionStatus.DUPLICATE,
        triggerIds: evaluation.disabled.map((trigger) => trigger.id),
    };
}

function aggregate(items: TriggerIngestionItem[]): TriggerIngestionResult {
    return {
        accepted: items.filter((item) =>
            ACCEPTED_TRIGGER_INGESTION_STATUSES.includes(item.status)).length,
        duplicates: items.filter((item) =>
            item.status === TriggerIngestionStatus.DUPLICATE).length,
        failed: items.filter((item) => item.status === TriggerIngestionStatus.FAILED).length,
        ignored: items.filter((item) => item.status === TriggerIngestionStatus.IGNORED).length,
        items,
    };
}

function resultFor(item: TriggerIngestionItem): TriggerIngestionResult {
    return aggregate([item]);
}
