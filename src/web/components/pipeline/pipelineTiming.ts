/**
 * @fileoverview Pipeline run timing presentation helpers.
 */

import type { PipelineRun } from '../../../shared/pipelineRegistryTypes.ts';
import {
    ACTIVE_PIPELINE_RUN_NODE_STATUS_GROUP,
} from '../../../shared/status/node.ts';
import {
    ACTIVE_PIPELINE_RUN_STATUSES,
} from '../../../shared/status/run.ts';
import { formatDuration } from '../../lib/format.ts';

/**
 * Determines whether the duration should keep advancing in the UI.
 *
 * A run is live while its persisted status is active, but terminal runs with
 * an active node status also remain live so partially completed node work is
 * visible until the backend records its final duration.
 */
export function hasActiveRunTiming(
    run?: Pick<PipelineRun, 'status' | 'nodeStatuses'>,
): boolean {
    if (run == null) {
        return false;
    }

    if (ACTIVE_PIPELINE_RUN_STATUSES.includes(run.status)) {
        return true;
    }

    return Object.values(run.nodeStatuses ?? {})
        .some((node) => ACTIVE_PIPELINE_RUN_NODE_STATUS_GROUP.includes(node.status));
}

/** Formats a known duration for the detail rail and uses `-` when unavailable. */
export function formatPipelineDuration(durationMs?: number): string {
    return durationMs == null ? '-' : formatDuration(durationMs);
}

/** Formats persisted or live elapsed time for a selected pipeline run. */
export function formatPipelineRunDuration(run: PipelineRun | undefined, nowMs: number): string {
    if (run == null) {
        return '—';
    }

    const startedAtMs = Date.parse(run.startedAt);
    let endedAtMs = run.endedAt == null ? undefined : Date.parse(run.endedAt);
    if (endedAtMs == null && hasActiveRunTiming(run)) {
        endedAtMs = nowMs;
    }
    if (endedAtMs == null) {
        return 'Running';
    }

    return formatDuration(Math.max(0, endedAtMs - startedAtMs));
}
