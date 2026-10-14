/**
 * @fileoverview Shared pipeline detail, run, source, and node-sample query contracts.
 *
 * Route controllers and the workspace use the same keys and abortable API
 * adapters. Callback-driven run monitoring writes each intermediate snapshot
 * into the detail, run-list, and selected-run caches so observers stay aligned.
 */

import { queryOptions } from '@tanstack/react-query';
import type { QueryClient } from '@tanstack/react-query';
import {
    getPipelineDetail,
    getPipelineNodeData,
    getPipelineRun,
    getPipelineRuns,
    getPipelineSourceFile,
} from '../api/pipelineRegistryClient.ts';
import type {
    PipelineDetail,
    PipelineNodeData,
    PipelineRun,
    PipelineSummary,
} from '../../shared/pipelineRegistryTypes.ts';
import {
    mergePipelineDetailSnapshot,
    mergePipelineRunIntoDetail,
    mergePipelineRunListSnapshots,
    mergePipelineRunSnapshot,
    mergePipelineRunIntoSummary,
} from '../lib/pipelineRunState.ts';
import { queryKeys } from './queryKeys.ts';

/** Creates the shared structural detail query without embedding run history. */
export function pipelineDetailQueryOptions(pipelineId: string) {
    return queryOptions({
        queryKey: queryKeys.pipelines.detail(pipelineId),
        queryFn: ({ signal }) => getPipelineDetail(
            pipelineId,
            signal,
            { includeRuns: false },
        ),
        structuralSharing: (current, incoming) => mergePipelineDetailSnapshot(
            current as PipelineDetail | undefined,
            incoming as PipelineDetail,
        ),
    });
}

/** Creates the abortable bounded run-history query for a pipeline. */
export function pipelineRunsQueryOptions(pipelineId: string) {
    return queryOptions({
        queryKey: queryKeys.pipelines.runs(pipelineId),
        queryFn: ({ signal }) => getPipelineRuns(pipelineId, signal),
        structuralSharing: (current, incoming) => mergePipelineRunListSnapshots(
            current as PipelineRun[] | undefined,
            incoming as PipelineRun[],
        ),
    });
}

/** Creates the abortable query for one Spark-capped, 100-row node sample. */
export function pipelineNodeDataQueryOptions(pipelineId: string, nodeId: string) {
    return queryOptions<PipelineNodeData>({
        queryKey: queryKeys.pipelines.nodeData(pipelineId, nodeId),
        queryFn: ({ signal }) => getPipelineNodeData(pipelineId, nodeId, signal),
        retry: false,
    });
}

/** Creates an abortable full-detail query for one persisted run. */
export function pipelineRunQueryOptions(pipelineId: string, runId: string) {
    return queryOptions({
        queryKey: queryKeys.pipelines.run(pipelineId, runId),
        queryFn: ({ signal }) => getPipelineRun(runId, signal),
        structuralSharing: (current, incoming) => mergePipelineRunSnapshot(
            current as PipelineRun | undefined,
            incoming as PipelineRun,
        ),
    });
}

/** Refetches one full persisted run after status monitoring reaches a terminal state. */
export function refreshTerminalPipelineRunDetails(
    queryClient: QueryClient,
    run: PipelineRun,
): Promise<void> {
    return queryClient.invalidateQueries({
        exact: true,
        queryKey: queryKeys.pipelines.run(run.pipelineId, run.runId),
    });
}

/** Creates a source query whose cache identity uses a normalized relative path. */
export function pipelineSourceFileQueryOptions(pipelineId: string, sourcePath: string) {
    const normalizedSourcePath = normalizePipelineSourcePath(sourcePath);
    return queryOptions({
        queryKey: queryKeys.pipelines.source(pipelineId, normalizedSourcePath),
        queryFn: ({ signal }) => getPipelineSourceFile(
            pipelineId,
            normalizedSourcePath,
            signal,
        ),
    });
}

/** Normalizes path separators and a leading relative marker for source identity. */
export function normalizePipelineSourcePath(sourcePath: string): string {
    return sourcePath.replaceAll('\\', '/').replace(/^\.\//, '');
}

/** Publishes a run snapshot into any matching detail, list, and run caches. */
export function updatePipelineRunQueryCache(
    queryClient: QueryClient,
    run: PipelineRun,
): PipelineRun {
    const pipelineSummary = queryClient.getQueryData<PipelineSummary[]>(
        queryKeys.pipelines.all,
    )?.find((pipeline) => pipeline.id === run.pipelineId);
    const pipelineDetail = queryClient.getQueryData<PipelineDetail>(
        queryKeys.pipelines.detail(run.pipelineId),
    );
    const cachedRuns = queryClient.getQueryData<PipelineRun[]>(
        queryKeys.pipelines.runs(run.pipelineId),
    );
    const cachedRunSnapshots = [
        queryClient.getQueryData<PipelineRun>(
            queryKeys.pipelines.run(run.pipelineId, run.runId),
        ),
        pipelineDetail?.runs.find((candidate) => candidate.runId === run.runId),
        pipelineDetail?.recentRuns.find((candidate) => candidate.runId === run.runId),
        pipelineDetail?.lastRun?.runId === run.runId ? pipelineDetail.lastRun : undefined,
        cachedRuns?.find((candidate) => candidate.runId === run.runId),
        pipelineSummary?.recentRuns.find((candidate) => candidate.runId === run.runId),
        pipelineSummary?.lastRun?.runId === run.runId ? pipelineSummary.lastRun : undefined,
    ].filter((candidate): candidate is PipelineRun => candidate != null);
    const cachedRun = cachedRunSnapshots.reduce<PipelineRun | undefined>(
        (current, candidate) => mergePipelineRunSnapshot(current, candidate),
        undefined,
    );
    const latestRun = mergePipelineRunSnapshot(cachedRun, run);

    queryClient.setQueryData<PipelineSummary[]>(
        queryKeys.pipelines.all,
        (current) => current?.map((pipeline) => pipeline.id === latestRun.pipelineId
            ? mergePipelineRunIntoSummary(pipeline, latestRun)
            : pipeline),
    );
    queryClient.setQueryData<PipelineDetail>(
        queryKeys.pipelines.detail(latestRun.pipelineId),
        (current) => current == null ? current : mergePipelineRunIntoDetail(current, latestRun),
    );
    queryClient.setQueryData<PipelineRun[]>(
        queryKeys.pipelines.runs(latestRun.pipelineId),
        (current) => current == null ? current : mergePipelineRunListSnapshots(current, [latestRun]),
    );
    queryClient.setQueryData<PipelineRun>(
        queryKeys.pipelines.run(latestRun.pipelineId, latestRun.runId),
        (current) => mergePipelineRunSnapshot(current, latestRun),
    );
    return latestRun;
}
