/**
 * @fileoverview Pipeline detail and run query boundary for the detail page.
 */

import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { PipelineDetail, PipelineRun } from '../../../../shared/pipelineRegistryTypes.ts';
import {
    ACTIVE_PIPELINE_RUN_STATUSES,
} from '../../../../shared/status/run.ts';
import { mergePipelineRunsIntoDetail } from '../../../lib/pipelineRunState.ts';
import { errorMessage } from '../../../utils/pipelineRunPresentation.ts';
import {
    pipelineDetailQueryOptions,
    pipelineRunQueryOptions,
    pipelineRunsQueryOptions,
} from '../../../query/pipelineQueries.ts';
import type { PipelineLoadState } from './pipelineControllerTypes.ts';

/** Query data required to compose the pipeline detail view. */
export type PipelineQueries = ReturnType<typeof usePipelineQueries>;

/**
 * Loads pipeline structure before run history so a history failure remains
 * best-effort and cannot hide the graph. Query functions retain their abort
 * signals through the shared query-option factories.
 */
export function usePipelineQueries(routePipelineId: string | undefined) {
    const pipelineDetailQuery = useQuery({
        ...pipelineDetailQueryOptions(routePipelineId ?? ''),
        enabled: routePipelineId != null,
    });
    const pipelineRunsQuery = useQuery({
        ...pipelineRunsQueryOptions(routePipelineId ?? ''),
        enabled: routePipelineId != null && pipelineDetailQuery.isSuccess,
    });
    const pipelineDetail = useMemo(() => {
        if (pipelineDetailQuery.data == null) {
            return undefined;
        }
        return mergePipelineRunsIntoDetail(
            pipelineDetailQuery.data,
            pipelineRunsQuery.data ?? [],
        );
    }, [pipelineDetailQuery.data, pipelineRunsQuery.data]);
    const loadState: PipelineLoadState = routePipelineId == null
        ? { kind: 'error', message: 'Missing pipeline ID.' }
        : pipelineDetailQuery.isError
            ? {
                kind: 'error',
                message: errorMessage(pipelineDetailQuery.error, 'Unable to load pipeline.'),
            }
            : pipelineDetailQuery.isSuccess
                ? { kind: 'ready' }
                : { kind: 'loading' };

    return {
        pipelineDetail,
        loadState,
        runHistorySettled: pipelineRunsQuery.isSuccess || pipelineRunsQuery.isError,
    };
}

/**
 * Loads full diagnostics only for the selected run when the route or summary
 * state requires them; an explicit route ID is allowed even outside recent
 * history, and the request waits until history has settled.
 */
export function useSelectedPipelineRunQuery(
    routePipelineId: string | undefined,
    requestedRunId: string | undefined,
    shouldLoadDetails: boolean,
    runHistorySettled: boolean,
) {
    return useQuery({
        ...pipelineRunQueryOptions(routePipelineId ?? '', requestedRunId ?? ''),
        enabled: routePipelineId != null && requestedRunId != null && shouldLoadDetails &&
            runHistorySettled,
    });
}

/**
 * Identifies the first active run in the merged query detail, if any, so the
 * controller can attach its callback monitor to the current run only.
 */
export function findActivePipelineRunId(
    pipelineDetail: PipelineDetail | undefined,
): string | undefined {
    return pipelineDetail?.runs.find((run) =>
        ACTIVE_PIPELINE_RUN_STATUSES.includes(run.status))?.runId;
}

/** Narrows selected-run query data to a matching route pipeline identity. */
export function selectedRunForPipeline(
    routePipelineId: string | undefined,
    selectedRun: PipelineRun | undefined,
): PipelineRun | undefined {
    return selectedRun?.pipelineId === routePipelineId ? selectedRun : undefined;
}
