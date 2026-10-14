/**
 * @fileoverview Small process-local metrics registry used by health and
 * diagnostics endpoints.
 */

import type { MetricsSnapshot } from './observabilityTypes.ts';

const counters = new Map<string, number>();
const gauges = new Map<string, number>();
const durations = new Map<string, { count: number; totalMs: number }>();

/**
 * Adds a caller-supplied delta to a process-local counter.
 *
 * Counters are intentionally kept in memory because this module supplies
 * lightweight health/diagnostic metrics for one control-plane process, not a
 * durable or cross-instance monitoring store. Signed deltas are accepted for
 * internal corrections; exported Prometheus output still reflects the value
 * currently accumulated in this process.
 */
export function incrementMetric(name: string, value = 1): void {
    counters.set(name, (counters.get(name) ?? 0) + value);
}

/**
 * Replaces a process-local gauge value.
 *
 * Unlike counters, gauges represent the latest state—such as an in-flight
 * queue depth—so callers should set the full value after state changes rather
 * than use this operation as an increment/decrement primitive.
 */
export function setMetric(name: string, value: number): void {
    gauges.set(name, value);
}

/**
 * Records one duration sample in the process-local aggregate.
 *
 * Only count and total milliseconds are retained; this registry intentionally
 * does not promise percentile or histogram data. Negative elapsed times are
 * clamped because clock adjustments must not make the aggregate decrease.
 */
export function observeDuration(name: string, durationMs: number): void {
    const current = durations.get(name) ?? { count: 0, totalMs: 0 };
    current.count += 1;
    current.totalMs += Math.max(0, durationMs);
    durations.set(name, current);
}

/**
 * Renders a snapshot of the process-local metrics in Prometheus text format.
 *
 * The output is a diagnostic exposition, not a reset or a scrape-consistent
 * distributed view: reading it leaves all counters, gauges, and duration
 * aggregates intact, and each server process maintains its own values.
 */
export function prometheusMetrics(): string {
    const snapshot = metricsSnapshot();
    const lines: string[] = [];
    for (const [name, value] of Object.entries(snapshot.counters)) {
        lines.push(`# TYPE ${name} counter`, `${name} ${value}`);
    }
    for (const [name, value] of Object.entries(snapshot.gauges)) {
        lines.push(`# TYPE ${name} gauge`, `${name} ${value}`);
    }
    for (const [name, value] of Object.entries(snapshot.durations)) {
        lines.push(`# TYPE ${name}_count counter`, `${name}_count ${value.count}`);
        lines.push(`# TYPE ${name}_sum gauge`, `${name}_sum ${value.totalMs}`);
    }
    return `${lines.join('\n')}\n`;
}

function metricsSnapshot(): MetricsSnapshot {
    return {
        counters: Object.fromEntries(counters),
        durations: Object.fromEntries(durations),
        gauges: Object.fromEntries(gauges),
    };
}
