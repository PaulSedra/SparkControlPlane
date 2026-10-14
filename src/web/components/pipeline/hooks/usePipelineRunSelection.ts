/**
 * @fileoverview URL and local state boundary for selecting a pipeline run.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { PipelineDetail, PipelineRun } from '../../../../shared/pipelineRegistryTypes.ts';
import {
    ACTIVE_PIPELINE_RUN_STATUSES,
} from '../../../../shared/status/run.ts';

/** Derived run identity and detail-fetch policy for one pipeline route. */
export interface PipelineRunSelectionResolution {
    requestedRunId: string | undefined;
    selectedRunSummary: PipelineRun | undefined;
    shouldLoadDetails: boolean;
}

/**
 * Resolves route-selected or locally selected run identity without requiring
 * React, allowing the route-selection edge cases to be tested directly.
 */
export function resolvePipelineRunSelection(
    pipelineDetail: PipelineDetail | undefined,
    routeRunId: string | undefined,
    selectedRunId: string | undefined,
): PipelineRunSelectionResolution {
    const selectedRunSummary = routeRunId != null
        ? pipelineDetail?.runs.find((run) => run.runId === routeRunId)
        : pipelineDetail?.runs.find((run) => run.runId === selectedRunId) ?? pipelineDetail?.lastRun;

    return {
        requestedRunId: routeRunId ?? selectedRunSummary?.runId,
        selectedRunSummary,
        shouldLoadDetails: routeRunId != null ||
            (selectedRunSummary != null &&
                !ACTIVE_PIPELINE_RUN_STATUSES.includes(selectedRunSummary.status)),
    };
}

/**
 * Chooses the post-load selection while preserving explicit route IDs and
 * valid local picks; leaving a run-specific route falls back to the latest run.
 */
export function nextSelectedPipelineRunId(
    pipelineDetail: PipelineDetail,
    routeRunId: string | undefined,
    currentRunId: string | undefined,
    previousRouteRunId: string | undefined,
): string | undefined {
    if (routeRunId != null) {
        return routeRunId;
    }

    if (previousRouteRunId != null) {
        return pipelineDetail.lastRun?.runId ?? pipelineDetail.runs[0]?.runId;
    }

    if (currentRunId != null &&
        pipelineDetail.runs.some((run) => run.runId === currentRunId)) {
        return currentRunId;
    }

    return pipelineDetail.lastRun?.runId ?? pipelineDetail.runs[0]?.runId;
}

/**
 * Owns run selection state and notifies the route when a user selects a run.
 * Deep-linked IDs remain authoritative even when they are not in recent history.
 */
export function usePipelineRunSelection(
    routeRunId: string | undefined,
    pipelineDetail: PipelineDetail | undefined,
    onRunSelected?: (runId: string) => void,
) {
    const [selectedRunId, setSelectedRunId] = useState<string | undefined>(routeRunId);
    const previousRouteRunId = useRef(routeRunId);
    const resolution = resolvePipelineRunSelection(
        pipelineDetail,
        routeRunId,
        selectedRunId,
    );

    useEffect(() => {
        if (pipelineDetail == null) {
            return;
        }

        setSelectedRunId((current) => nextSelectedPipelineRunId(
            pipelineDetail,
            routeRunId,
            current,
            previousRouteRunId.current,
        ));
        previousRouteRunId.current = routeRunId;
    }, [pipelineDetail, routeRunId]);

    const selectPipelineRun = useCallback((runId: string): void => {
        setSelectedRunId(runId);
        onRunSelected?.(runId);
    }, [onRunSelected]);

    return {
        ...resolution,
        selectPipelineRun,
        selectedRunId,
    };
}
