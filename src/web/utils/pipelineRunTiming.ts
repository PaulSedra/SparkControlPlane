/**
 * @fileoverview Calculates stable node durations for active and terminal run
 * states without mutating the run response.
 */

import {
    ACTIVE_PIPELINE_RUN_NODE_STATUS_GROUP,
    TERMINAL_PIPELINE_RUN_NODE_STATUS_GROUP,
} from '../../shared/status/node.ts';

interface PipelineNodeTiming {
    completedAt?: string;
    duration?: number;
    durationMs?: number;
    runStatus?: string;
    startedAt?: string;
    status?: string;
}

/** Resolves run-record and graph-node timing into one elapsed duration. */
export function pipelineNodeDurationMs(
    node?: PipelineNodeTiming,
    nowMs = Date.now(),
): number | undefined {
    if (node == null) {
        return undefined;
    }

    const recordedDuration = node.durationMs != null && Number.isFinite(node.durationMs)
        ? node.durationMs
        : node.duration;
    if (recordedDuration != null && Number.isFinite(recordedDuration)) {
        return Math.max(0, recordedDuration);
    }

    const status = node.runStatus ?? node.status;
    if (status != null && TERMINAL_PIPELINE_RUN_NODE_STATUS_GROUP.includes(status)) {
        const startedAt = parseTimestamp(node.startedAt);
        const completedAt = parseTimestamp(node.completedAt);
        if (startedAt != null && completedAt != null) {
            return Math.max(0, completedAt - startedAt);
        }

        return undefined;
    }

    if (status == null || !ACTIVE_PIPELINE_RUN_NODE_STATUS_GROUP.includes(status)) {
        return undefined;
    }

    const startedAt = parseTimestamp(node.startedAt);
    if (startedAt == null || !Number.isFinite(nowMs)) {
        return undefined;
    }

    return Math.max(0, nowMs - startedAt);
}

function parseTimestamp(value?: string): number | undefined {
    if (value == null || value.trim() === '') {
        return undefined;
    }

    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp) ? timestamp : undefined;
}
