/**
 * @fileoverview Coordinates file-arrival debounce windows and their flushes.
 */

import type {
    CanonicalTriggerEvent,
    TriggerDefinition,
    TriggerIngestionItem,
} from '../types/triggerTypes.ts';
import {
    TriggerEventStatus,
    TriggerIngestionStatus,
    TriggerRoutingOutcome,
} from '../../shared/status/trigger.ts';
import { nextTriggerAttemptNumber } from './triggerDelivery.ts';
import type {
    TriggerDeliver,
    TriggerRuntime,
} from './triggerServiceTypes.ts';
import { debounceMilliseconds } from './triggerRouting.ts';

interface PendingDebounce {
    events: CanonicalTriggerEvent[];
    timer: NodeJS.Timeout;
    trigger: TriggerDefinition;
}

interface DebounceState {
    flushPromises: Set<Promise<void>>;
    pending: Map<string, PendingDebounce>;
    runtime: TriggerRuntime;
    deliver: TriggerDeliver;
}

/**
 * Controls independent debounce windows for trigger events.
 *
 * File-arrival events for one trigger share a window: each new event resets
 * that trigger's timer, only the latest event is delivered, and earlier events
 * are retained as ignored/debounced delivery evidence. `flush` delivers all
 * pending windows immediately, while `stop` cancels pending timers without
 * delivering them.
 */
export interface TriggerDebounceCoordinator {
    enqueue: (trigger: TriggerDefinition, event: CanonicalTriggerEvent) => void;
    flush: () => Promise<void>;
    hasPending: (trigger: TriggerDefinition, event: CanonicalTriggerEvent) => boolean;
    stop: () => void;
}

/**
 * Creates the coordinator that collapses bursty trigger events into one run.
 *
 * The returned object owns per-trigger pending state and timer lifecycles;
 * callers should use `flush` before shutdown when queued file-arrival work must
 * be delivered, because `stop` intentionally discards unsent windows.
 */
export function createTriggerDebounceCoordinator(
    runtime: TriggerRuntime,
    deliver: TriggerDeliver,
): TriggerDebounceCoordinator {
    const state: DebounceState = {
        deliver,
        flushPromises: new Set<Promise<void>>(),
        pending: new Map<string, PendingDebounce>(),
        runtime,
    };
    return {
        enqueue: (trigger, event) => enqueueDebounce(state, trigger, event),
        flush: () => flushDebounces(state),
        hasPending: (trigger, event) => state.pending.has(debounceKey(trigger, event)),
        stop: () => stopDebounces(state),
    };
}

function enqueueDebounce(
    state: DebounceState,
    trigger: TriggerDefinition,
    event: CanonicalTriggerEvent,
): void {
    const key = debounceKey(trigger, event);
    const current = state.pending.get(key);
    if (current != null) {
        clearTimeout(current.timer);
        current.events.push(event);
        current.timer = scheduleFlush(state, key, current, debounceMilliseconds(trigger));
        return;
    }
    const entry: PendingDebounce = {
        events: [event],
        timer: undefined as never,
        trigger,
    };
    entry.timer = scheduleFlush(state, key, entry, debounceMilliseconds(trigger));
    state.pending.set(key, entry);
}

function scheduleFlush(
    state: DebounceState,
    key: string,
    entry: PendingDebounce,
    delay: number,
): NodeJS.Timeout {
    const timer = setTimeout(() => {
        state.pending.delete(key);
        const work = flushDebounce(state, key, entry).catch((error: unknown) => {
            state.runtime.onError?.(`Debounced trigger ${entry.trigger.id} failed`, error);
        });
        state.flushPromises.add(work);
        void work.finally(() => state.flushPromises.delete(work));
    }, delay);
    // A pending debounce window should not keep a graceful-shutdown process
    // alive; `flush` is the explicit lifecycle operation that preserves work.
    timer.unref?.();
    return timer;
}

function stopDebounces(state: DebounceState): void {
    for (const entry of state.pending.values()) {
        clearTimeout(entry.timer);
    }
    state.pending.clear();
}

async function flushDebounces(state: DebounceState): Promise<void> {
    const entries = [...state.pending.entries()];
    await Promise.all(entries.map(async ([key, entry]) => {
        clearTimeout(entry.timer);
        state.pending.delete(key);
        await flushDebounce(state, key, entry);
    }));
    await Promise.all([...state.flushPromises]);
}

async function flushDebounce(
    state: DebounceState,
    key: string,
    entry: PendingDebounce,
): Promise<void> {
    const latest = entry.events.at(-1);
    if (latest == null) {
        return;
    }
    await recordDebouncedEvents(state, entry.events.slice(0, -1), latest, entry.trigger);
    const result = await state.deliver(latest, entry.trigger);
    await updateEventStatus(state, result);
    state.pending.delete(key);
}

async function recordDebouncedEvents(
    state: DebounceState,
    events: CanonicalTriggerEvent[],
    latest: CanonicalTriggerEvent,
    trigger: TriggerDefinition,
): Promise<void> {
    // Keep every provider event as audit evidence even though only the latest
    // event is delivered. This makes the coalescing decision observable and
    // prevents an operator from mistaking ignored burst members for loss.
    for (const event of events) {
        const reason = `Debounced into ${latest.eventId}.`;
        await state.runtime.persistence.recordRoutingDecision({
            eventId: event.eventId,
            outcome: TriggerRoutingOutcome.DEBOUNCED,
            reason,
            triggerId: trigger.id,
        });
        await state.runtime.persistence.recordTriggerDeliveryAttempt({
            attemptNumber: await nextTriggerAttemptNumber(
                state.runtime.persistence,
                trigger.id,
                event.eventId,
            ),
            completedAt: new Date(state.runtime.now()).toISOString(),
            eventId: event.eventId,
            failureReason: reason,
            status: TriggerIngestionStatus.IGNORED,
            triggerId: trigger.id,
        });
        await state.runtime.persistence.updateTriggerEventStatus(
            event.eventId,
            TriggerEventStatus.IGNORED,
        );
    }
}

async function updateEventStatus(
    state: DebounceState,
    item: TriggerIngestionItem,
): Promise<void> {
    if (item.status === TriggerIngestionStatus.ACCEPTED) {
        await state.runtime.persistence.updateTriggerEventStatus(
            item.eventId,
            TriggerEventStatus.ROUTED,
        );
    } else if (item.status === TriggerIngestionStatus.FAILED) {
        await state.runtime.persistence.updateTriggerEventStatus(
            item.eventId,
            TriggerEventStatus.FAILED,
        );
    }
}

function debounceKey(trigger: TriggerDefinition, event: CanonicalTriggerEvent): string {
    if (trigger.type === 'FILE_ARRIVAL') {
        // A file-arrival trigger may watch several locations, but its contract
        // is one logical debounce window across those locations.
        return trigger.id;
    }
    return `${trigger.id}:${event.source}:${event.attributes.bucket ?? ''}`;
}
