/**
 * @fileoverview Timer lifecycle for due schedule trigger processing.
 */

import type { TriggerPersistence } from '../types/triggerTypes.ts';
import type { TriggerDeliver } from './triggerServiceTypes.ts';
import { createTriggerScheduleRunner } from './triggerScheduleRunner.ts';

const DEFAULT_INTERVAL_MILLISECONDS = 30_000;

/** Dependencies and timing settings used by the schedule scheduler. */
export interface TriggerSchedulerOptions {
    delivery: TriggerDeliver;
    intervalMilliseconds?: number;
    now?: () => number;
    onError?: (message: string, error: unknown) => void;
    persistence: TriggerPersistence;
}

/** Lifecycle controls for the schedule scheduler. */
export interface TriggerScheduler {
    start: () => void;
    stop: () => void;
    tick: () => Promise<void>;
    wake: () => void;
}

/**
 * Creates a timer lifecycle that serializes schedule ticks.
 *
 * `start` performs an immediate wake and then schedules periodic wakes, while
 * concurrent wakes share the in-flight tick instead of running schedules twice.
 * The interval is clamped to one second; `stop` clears future timer wakes but
 * does not cancel a tick already in progress.
 */
export function createTriggerScheduler(
    options: TriggerSchedulerOptions,
): TriggerScheduler {
    const now = options.now ?? (() => Date.now());
    const intervalMilliseconds = Math.max(
        1_000,
        Math.floor(options.intervalMilliseconds ?? DEFAULT_INTERVAL_MILLISECONDS),
    );
    const runScheduleTick = createTriggerScheduleRunner(options, now);
    let timer: NodeJS.Timeout | undefined;
    let started = false;
    let tickInFlight: Promise<void> | undefined;

    const wake = () => {
        if (!started || tickInFlight != null) {
            return;
        }
        void tick().catch((error: unknown) => reportError(options, 'Scheduled trigger tick failed', error));
    };

    const start = () => {
        if (started) {
            return;
        }
        started = true;
        timer = setInterval(wake, intervalMilliseconds);
        timer.unref?.();
        wake();
    };

    const stop = () => {
        started = false;
        if (timer != null) {
            clearInterval(timer);
            timer = undefined;
        }
    };

    const tick = async () => {
        if (tickInFlight != null) {
            return tickInFlight;
        }
        const work = runScheduleTick();
        tickInFlight = work;
        try {
            await work;
        } finally {
            if (tickInFlight === work) {
                tickInFlight = undefined;
            }
        }
    };

    return { start, stop, tick, wake };
}

function reportError(
    options: TriggerSchedulerOptions,
    message: string,
    error: unknown,
): void {
    options.onError?.(message, error);
}
