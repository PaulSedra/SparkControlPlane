/**
 * @fileoverview Pipeline detail composition over remote queries, run selection,
 * independent commands, and local node selection.
 */

import { useMemo } from 'react';
import type { PipelineRun } from '../../../../shared/pipelineRegistryTypes.ts';
import { mergePipelineRunsIntoDetail } from '../../../lib/pipelineRunState.ts';
import {
    findActivePipelineRunId,
    selectedRunForPipeline,
    usePipelineQueries,
    useSelectedPipelineRunQuery,
} from './usePipelineQueries.ts';
import { usePipelineActions } from './usePipelineActions.ts';
import { usePipelineNodeSelection } from './usePipelineNodeSelection.ts';
import { usePipelineRunSelection } from './usePipelineRunSelection.ts';

/** Public state and actions returned by the pipeline controller. */
export type PipelineController = ReturnType<typeof usePipelineController>;

/**
 * Composes query data, URL-aware run selection, pipeline commands, and local
 * node selection for the detail route. The returned view model preserves the
 * existing page contract while each feature hook owns one lifecycle boundary.
 */
export function usePipelineController(
    routePipelineId: string | undefined,
    routeRunId?: string,
    onRunSelected?: (runId: string) => void,
) {
    const pipelineQueries = usePipelineQueries(routePipelineId);
    const runSelection = usePipelineRunSelection(
        routeRunId,
        pipelineQueries.pipelineDetail,
        onRunSelected,
    );
    const selectedRunQuery = useSelectedPipelineRunQuery(
        routePipelineId,
        runSelection.requestedRunId,
        runSelection.shouldLoadDetails,
        pipelineQueries.runHistorySettled,
    );
    const selectedRunDetails = selectedRunForPipeline(
        routePipelineId,
        selectedRunQuery.data,
    );
    const pipelineDetail = useMemo(() => {
        if (pipelineQueries.pipelineDetail == null) {
            return undefined;
        }
        return selectedRunDetails == null
            ? pipelineQueries.pipelineDetail
            : mergePipelineRunsIntoDetail(pipelineQueries.pipelineDetail, [selectedRunDetails]);
    }, [pipelineQueries.pipelineDetail, selectedRunDetails]);
    const activePipelineRunId = useMemo(() => findActivePipelineRunId(pipelineDetail), [pipelineDetail]);
    const actions = usePipelineActions(
        routePipelineId,
        pipelineDetail,
        activePipelineRunId,
        runSelection.selectPipelineRun,
    );
    const nodeSelection = usePipelineNodeSelection(pipelineDetail);
    const selectedRun = useMemo((): PipelineRun | undefined => routeRunId != null
        ? pipelineDetail?.runs.find((run) => run.runId === routeRunId)
        : pipelineDetail?.runs.find((run) => run.runId === runSelection.selectedRunId) ??
            pipelineDetail?.lastRun,
    [pipelineDetail, routeRunId, runSelection.selectedRunId]);

    return {
        ...actions,
        ...nodeSelection,
        activePipelineRunId,
        isPipelineRunnable: pipelineDetail?.currentVersionId != null,
        pipelineDetail,
        pipelineLoadState: pipelineQueries.loadState,
        selectedRun,
        selectedRunId: runSelection.selectedRunId,
        selectPipelineRun: runSelection.selectPipelineRun,
    };
}
