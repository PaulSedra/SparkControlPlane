/**
 * @fileoverview Immutable helpers for merging incremental run responses into
 * pipeline summary and detail state.
 */

import type {
    PipelineDetail,
    PipelineRun,
    PipelineSummary,
} from '../../shared/pipelineRegistryTypes.ts';
import {
    ACTIVE_PIPELINE_RUN_STATUSES,
    RunStatus,
    TERMINAL_PIPELINE_RUN_STATUSES,
} from '../../shared/status/run.ts';

/**
 * Upserts a run page into immutable pipeline detail state.
 *
 * Responses are deduplicated by run ID, newer fields replace older snapshots,
 * and all runs are sorted newest-first so `lastRun` and the five-item recent
 * window stay consistent after paginated or live updates.
 */
export function mergePipelineRunsIntoDetail(
    detail: PipelineDetail,
    runs: PipelineRun[],
): PipelineDetail {
    const orderedRuns = retainPipelineRunArray(
        detail.runs,
        mergeRunLists(
            [...detail.runs, ...detail.recentRuns, ...(detail.lastRun == null ? [] : [detail.lastRun])],
            runs,
        ),
    );

    return {
        ...detail,
        lastRun: orderedRuns[0],
        recentRuns: orderedRuns.slice(0, 5),
        runs: orderedRuns,
    };
}

/**
 * Upserts one run into a summary's newest-first five-run window without
 * mutating the existing summary or retaining duplicate run IDs.
 */
export function mergePipelineRunIntoSummary(
    pipeline: PipelineSummary,
    run: PipelineRun,
): PipelineSummary {
    const recentRuns = retainPipelineRunArray(
        pipeline.recentRuns,
        upsertPipelineRun(
            [...pipeline.recentRuns, ...(pipeline.lastRun == null ? [] : [pipeline.lastRun])],
            run,
        ).slice(0, 5),
    );
    const lastRun = recentRuns[0] ?? pipeline.lastRun;
    if (lastRun === pipeline.lastRun && recentRuns === pipeline.recentRuns) {
        return pipeline;
    }
    return {
        ...pipeline,
        lastRun,
        recentRuns,
    };
}

/**
 * Reconciles an incoming registry summary with cached run snapshots.
 * Registry refreshes may have started before a live status request completed;
 * lifecycle progress and server timestamps prevent those late responses from
 * moving a run back to an older state.
 */
export function mergePipelineSummarySnapshot(
    current: PipelineSummary,
    incoming: PipelineSummary,
): PipelineSummary {
    const orderedRuns = mergeRunLists(
        [...current.recentRuns, ...(current.lastRun == null ? [] : [current.lastRun])],
        [...incoming.recentRuns, ...(incoming.lastRun == null ? [] : [incoming.lastRun])],
    );

    const recentRuns = retainPipelineRunArray(current.recentRuns, orderedRuns.slice(0, 5));
    const merged = {
        ...current,
        ...incoming,
        lastRun: orderedRuns[0],
        recentRuns,
    };
    return sameObjectValues(current, merged) ? current : merged;
}

/** Merges registry summaries while preserving cached runs for matching IDs. */
export function mergePipelineSummarySnapshots(
    current: PipelineSummary[] | undefined,
    incoming: PipelineSummary[],
): PipelineSummary[] {
    if (current == null || current.length === 0) {
        return incoming;
    }

    const currentById = new Map(current.map((pipeline) => [pipeline.id, pipeline]));
    return incoming.map((pipeline) => {
        const previous = currentById.get(pipeline.id);
        return previous == null
            ? pipeline
            : mergePipelineSummarySnapshot(previous, pipeline);
    });
}

/**
 * Upserts one live run into detail state and recomputes `lastRun` plus the
 * newest five-run window, preserving any unrelated historical runs.
 */
export function mergePipelineRunIntoDetail(
    detail: PipelineDetail,
    run: PipelineRun,
): PipelineDetail {
    const runs = retainPipelineRunArray(
        detail.runs,
        upsertPipelineRun(
            [...detail.runs, ...detail.recentRuns, ...(detail.lastRun == null ? [] : [detail.lastRun])],
            run,
        ),
    );
    const recentRuns = retainPipelineRunArray(detail.recentRuns, runs.slice(0, 5));
    const lastRun = runs[0] ?? detail.lastRun;
    if (runs === detail.runs && recentRuns === detail.recentRuns && lastRun === detail.lastRun) {
        return detail;
    }
    return {
        ...detail,
        lastRun,
        recentRuns,
        runs,
    };
}

/** Merges a newly fetched detail response with cached run snapshots. */
export function mergePipelineDetailSnapshot(
    current: PipelineDetail | undefined,
    incoming: PipelineDetail,
): PipelineDetail {
    if (current == null) {
        return incoming;
    }

    const merged = mergePipelineRunsIntoDetail(incoming, [
        ...current.runs,
        ...current.recentRuns,
        ...(current.lastRun == null ? [] : [current.lastRun]),
    ]);
    return sameObjectValues(incoming, merged) ? incoming : merged;
}

/** Merges a bounded run-history response with cached state for the same page. */
export function mergePipelineRunListSnapshots(
    current: PipelineRun[] | undefined,
    incoming: PipelineRun[],
): PipelineRun[] {
    if (current == null || current.length === 0) {
        return incoming;
    }

    const merged = mergeRunLists(current, incoming)
        .slice(0, Math.max(current.length, incoming.length));
    return retainPipelineRunArray(current, merged);
}

/** Prefers lifecycle progress and timestamps over response arrival order. */
export function mergePipelineRunSnapshot(
    current: PipelineRun | undefined,
    incoming: PipelineRun,
): PipelineRun {
    if (current == null || current.runId !== incoming.runId) {
        return incoming;
    }

    if (isSameTerminalSnapshot(current, incoming)) {
        return mergeRunOutput(current, incoming);
    }
    if (isTerminalAfterActiveSnapshot(current, incoming)) {
        return { ...current, ...incoming };
    }
    if (shouldPreserveCurrentSnapshot(current, incoming)) {
        return current;
    }
    return mergeRunOutput({ ...current, ...incoming }, incoming, current);
}

function isSameTerminalSnapshot(current: PipelineRun, incoming: PipelineRun): boolean {
    return TERMINAL_PIPELINE_RUN_STATUSES.includes(current.status) &&
        TERMINAL_PIPELINE_RUN_STATUSES.includes(incoming.status) &&
        current.status === incoming.status &&
        pipelineRunSnapshotTimestamp(incoming) <= pipelineRunSnapshotTimestamp(current);
}

function shouldPreserveCurrentSnapshot(current: PipelineRun, incoming: PipelineRun): boolean {
    const currentIsTerminal = TERMINAL_PIPELINE_RUN_STATUSES.includes(current.status);
    const incomingIsTerminal = TERMINAL_PIPELINE_RUN_STATUSES.includes(incoming.status);
    const currentIsActive = ACTIVE_PIPELINE_RUN_STATUSES.includes(current.status);
    const incomingIsActive = ACTIVE_PIPELINE_RUN_STATUSES.includes(incoming.status);
    if (currentIsTerminal && (!incomingIsTerminal || incoming.status !== current.status)) {
        return true;
    }
    if (currentIsActive && incomingIsActive &&
        activeStatusRank(incoming.status) < activeStatusRank(current.status)) {
        return true;
    }

    const currentTimestamp = pipelineRunSnapshotTimestamp(current);
    const incomingTimestamp = pipelineRunSnapshotTimestamp(incoming);
    return (currentIsTerminal && incomingTimestamp <= currentTimestamp) ||
        incomingTimestamp < currentTimestamp ||
        (incomingTimestamp === currentTimestamp && currentIsActive && incomingIsActive);
}

function isTerminalAfterActiveSnapshot(current: PipelineRun, incoming: PipelineRun): boolean {
    return TERMINAL_PIPELINE_RUN_STATUSES.includes(incoming.status) &&
        ACTIVE_PIPELINE_RUN_STATUSES.includes(current.status);
}

function mergeRunOutput(
    result: PipelineRun,
    preferred: Pick<PipelineRun, 'stderr' | 'stdout'>,
    fallback?: Pick<PipelineRun, 'stderr' | 'stdout'>,
): PipelineRun {
    const stdout = preferred.stdout?.trim() ? preferred.stdout : fallback?.stdout ?? result.stdout;
    const stderr = preferred.stderr?.trim() ? preferred.stderr : fallback?.stderr ?? result.stderr;
    if (result.stdout === stdout && result.stderr === stderr) {
        return result;
    }
    return { ...result, stdout, stderr };
}

function upsertPipelineRun(
    runs: PipelineRun[],
    run: PipelineRun,
): PipelineRun[] {
    const runsById = new Map<string, PipelineRun>();
    for (const candidate of runs) {
        runsById.set(
            candidate.runId,
            mergePipelineRunSnapshot(runsById.get(candidate.runId), candidate),
        );
    }
    runsById.set(run.runId, mergePipelineRunSnapshot(runsById.get(run.runId), run));
    return sortPipelineRuns([...runsById.values()]);
}

function mergeRunLists(
    current: PipelineRun[],
    incoming: PipelineRun[],
): PipelineRun[] {
    const runsById = new Map(current.map((run) => [run.runId, run]));
    for (const run of incoming) {
        runsById.set(run.runId, mergePipelineRunSnapshot(runsById.get(run.runId), run));
    }
    return sortPipelineRuns([...runsById.values()]);
}

function sortPipelineRuns(runs: PipelineRun[]): PipelineRun[] {
    return runs.sort((left, right) => right.startedAt.localeCompare(left.startedAt));
}

function activeStatusRank(status: PipelineRun['status']): number {
    switch (status) {
        case RunStatus.QUEUED:
            return 0;
        case RunStatus.SUBMITTING:
            return 1;
        case RunStatus.RUNNING:
            return 2;
        default:
            return -1;
    }
}

function retainPipelineRunArray(
    previous: PipelineRun[],
    next: PipelineRun[],
): PipelineRun[] {
    return previous.length === next.length &&
        previous.every((run, index) => run === next[index])
        ? previous
        : next;
}

function sameObjectValues(left: object, right: object): boolean {
    const leftValues = left as Record<string, unknown>;
    const rightValues = right as Record<string, unknown>;
    const leftKeys = Object.keys(leftValues);
    const rightKeys = Object.keys(rightValues);
    return leftKeys.length === rightKeys.length &&
        leftKeys.every((key) => Object.hasOwn(rightValues, key) &&
            Object.is(leftValues[key], rightValues[key]));
}

function pipelineRunSnapshotTimestamp(run: PipelineRun): number {
    const timestampStrings = [
        run.startedAt,
        run.endedAt,
        run.terminalEventAt,
        run.sparkStageProgress?.observedAt,
        ...Object.values(run.nodeStatuses ?? {}).map((node) => node.lastUpdatedAt),
    ];
    return timestampStrings.reduce((latest, value) => {
        if (value == null) {
            return latest;
        }
        const timestamp = Date.parse(value);
        return Number.isNaN(timestamp) ? latest : Math.max(latest, timestamp);
    }, 0);
}
