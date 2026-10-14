/**
 * @fileoverview Lightweight labels and display helpers for pipeline runs.
 */

import type {
    PipelineRun,
    PipelineSummary,
    RunMode,
} from '../../shared/pipelineRegistryTypes.ts';
import { PIPELINE_RUN_STATUS_LABELS } from '../../shared/status/presentation.ts';
import { ACTIVE_PIPELINE_RUN_STATUSES } from '../../shared/status/run.ts';
import {
    RUN_LABEL_SPARK_EXECUTION_STATES,
    SPARK_EXECUTION_STATE_LABELS,
} from '../../shared/status/execution.ts';

/** Converts each supported run mode into its display label. */
const RUN_MODE_LABELS: Record<RunMode, string> = {
    incremental: 'Incremental',
    'full-refresh-all': 'Full refresh',
    'full-refresh-selected': 'Selected table full refresh',
    'refresh-selected': 'Selected table refresh',
    'repair-failed': 'Repair failed',
    'dry-run': 'Dry run',
};

/**
 * Derives one display tag from the normalized parent directory of a spec path.
 * Paths with no parent directory produce no tag; separators are normalized so
 * mounted Windows and POSIX paths present the same label.
 */
export function pipelineTags(pipeline: PipelineSummary): string[] {
    const parts = pipeline.specPath.replaceAll('\\', '/').split('/').filter(Boolean);
    if (parts.length < 2) {
        return [];
    }

    const parent = parts.at(-2);
    return parent == null || parent === '.' ? [] : [parent];
}

/** Returns the deliberate placeholder used until run-as identity is supported. */
export function runAsLabel(): string {
    return '-';
}

/** Maps the closed set of persisted run modes to stable UI labels. */
export function runModeLabel(mode: RunMode): string {
    return RUN_MODE_LABELS[mode];
}

/** Returns captured run streams in display order while preserving their text. */
export function pipelineRunOutputSections(
    run?: Pick<PipelineRun, 'stderr' | 'stdout'>,
): Array<{ label: string; text: string }> {
    const streams = [
        { label: 'Standard output', text: run?.stdout },
        { label: 'Standard error', text: run?.stderr },
    ];

    return streams.filter((stream): stream is { label: string; text: string } =>
        typeof stream.text === 'string' && stream.text.trim() !== '');
}

/** Uses Spark attach states only while the persisted run remains active. */
export function pipelineRunHistoryStatusLabel(
    run: Pick<PipelineRun, 'sparkExecutionState' | 'status'>,
): string {
    const sparkState = run.sparkExecutionState;
    if (ACTIVE_PIPELINE_RUN_STATUSES.includes(run.status) &&
        sparkState != null && RUN_LABEL_SPARK_EXECUTION_STATES.includes(sparkState)) {
        return SPARK_EXECUTION_STATE_LABELS[sparkState];
    }
    return PIPELINE_RUN_STATUS_LABELS[run.status];
}

/** Extracts an Error message without exposing arbitrary non-error values. */
export function errorMessage(error: unknown, fallback: string): string {
    return error instanceof Error ? error.message : fallback;
}
