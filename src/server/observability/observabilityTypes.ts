/**
 * @fileoverview Metric snapshot types shared by observability adapters.
 */

/** Snapshot of in-process metrics exposed for health and diagnostics. */
export interface MetricsSnapshot {
    counters: Record<string, number>;
    gauges: Record<string, number>;
    durations: Record<string, { count: number; totalMs: number }>;
}
