/**
 * @fileoverview Runs due schedule triggers and records their delivery state.
 */

import type {
    CanonicalTriggerEvent,
    ScheduleConfiguration,
    TriggerDefinition,
    TriggerPersistence,
} from '../types/triggerTypes.ts';
import {
    FINAL_TRIGGER_DELIVERY_STATUSES,
    TriggerRoutingOutcome,
} from '../../shared/status/trigger.ts';
import {
    latestOccurrenceAtOrBefore,
    parseScheduleConfiguration,
} from './cronSchedule.ts';
import type { TriggerSchedulerOptions } from './triggerScheduler.ts';

/**
 * Creates one schedule-tick operation for the timer lifecycle.
 *
 * Each tick evaluates active enabled schedule triggers from persisted registry
 * state and derives a deterministic event ID from the latest due occurrence.
 * A previously completed occurrence is skipped, while an interrupted
 * occurrence is safely retried through the normal idempotent delivery path.
 * One trigger's failure is reported without aborting the other schedules.
 */
export function createTriggerScheduleRunner(
    options: TriggerSchedulerOptions,
    now: () => number,
): () => Promise<void> {
    return () => runScheduleTick(options, now);
}

async function runScheduleTick(
    options: TriggerSchedulerOptions,
    now: () => number,
): Promise<void> {
    const triggers = await options.persistence.listTriggers();
    const schedules = triggers.filter(isRunnableSchedule);
    await Promise.all(schedules.map((trigger) => processScheduleSafely(options, now, trigger)));
}

function isRunnableSchedule(trigger: TriggerDefinition): boolean {
    return trigger.active && trigger.type === 'SCHEDULE' && trigger.enabled;
}

async function processScheduleSafely(
    options: TriggerSchedulerOptions,
    now: () => number,
    trigger: TriggerDefinition,
): Promise<void> {
    try {
        await processSchedule(options, now, trigger);
    } catch (error) {
        reportError(options, `Scheduled trigger ${trigger.id} failed`, error);
    }
}

async function processSchedule(
    options: TriggerSchedulerOptions,
    now: () => number,
    trigger: TriggerDefinition,
): Promise<void> {
    const configuration = parseScheduleTrigger(options, trigger);
    if (configuration == null) {
        return;
    }
    const occurrence = latestOccurrenceAtOrBefore(new Date(now()), configuration);
    if (occurrence == null) {
        return;
    }
    const event = scheduleEvent(trigger, configuration, occurrence.at, occurrence.localTime);
    const recorded = await options.persistence.recordTriggerEvent(event);
    if (recorded.duplicate && await hasTerminalDelivery(
        options.persistence,
        trigger.id,
        recorded.event.event.eventId,
    )) {
        return;
    }
    await options.persistence.recordRoutingDecision({
        eventId: recorded.event.event.eventId,
        outcome: TriggerRoutingOutcome.MATCHED,
        reason: recorded.duplicate
            ? 'Recovered a due schedule occurrence without a completed delivery.'
            : 'Schedule occurrence is due.',
        triggerId: trigger.id,
    });
    await options.delivery(recorded.event.event, trigger, {
        correlationId: `trigger-${trigger.id}-${occurrence.at.getTime()}`,
        idempotencyKey: recorded.event.event.deduplicationKey,
        messages: {
            acceptedDetail: 'The scheduled run was accepted by the control plane.',
            acceptedRoutingReason: 'Schedule submitted a pipeline run.',
            idempotentReplayDetail: 'The scheduled run submission was replayed.',
            idempotentReplayRoutingReason: 'Schedule submission replayed an existing idempotent run.',
        },
        updateEventStatus: async (status) => {
            await options.persistence.updateTriggerEventStatus(
                recorded.event.event.eventId,
                status,
            );
        },
        requestSource: 'trigger:schedule',
    });
}

function parseScheduleTrigger(
    options: TriggerSchedulerOptions,
    trigger: TriggerDefinition,
): ScheduleConfiguration | undefined {
    try {
        return parseScheduleConfiguration(trigger.configuration);
    } catch (error) {
        reportError(options, `Scheduled trigger ${trigger.id} has invalid configuration`, error);
        return undefined;
    }
}

function scheduleEvent(
    trigger: TriggerDefinition,
    configuration: ScheduleConfiguration,
    occurrenceAt: Date,
    localTime: string,
): CanonicalTriggerEvent {
    const occurrenceTimestamp = occurrenceAt.toISOString();
    const eventId = `schedule:${trigger.id}:${occurrenceTimestamp}`;
    return {
        attributes: {
            occurrenceAt: occurrenceTimestamp,
            triggerId: trigger.id,
        },
        deduplicationKey: eventId,
        eventId,
        eventType: 'schedule.due',
        occurredAt: occurrenceTimestamp,
        payload: {
            cron: configuration.cron,
            localTime,
            misfirePolicy: configuration.misfirePolicy,
            timeZone: configuration.timeZone,
            triggerId: trigger.id,
        },
        source: 'scheduler',
    };
}

async function hasTerminalDelivery(
    persistence: TriggerPersistence,
    triggerId: string,
    eventId: string,
): Promise<boolean> {
    const attempts = await persistence.listTriggerDeliveryAttempts(triggerId, 1000);
    return attempts.some((attempt) =>
        attempt.eventId === eventId &&
        FINAL_TRIGGER_DELIVERY_STATUSES.includes(attempt.status)
    );
}

function reportError(
    options: TriggerSchedulerOptions,
    message: string,
    error: unknown,
): void {
    options.onError?.(message, error);
}
