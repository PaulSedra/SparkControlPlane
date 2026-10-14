/**
 * @fileoverview Safe command mutations and targeted cache reconciliation for
 * pipeline and trigger operations.
 *
 * Commands never retry automatically. Successful deploy/run/cancel operations
 * update the narrow cached representation when possible, then invalidate the
 * authoritative list/detail/run resources; trigger changes also invalidate the
 * affected runtime schedule status.
 */

import { mutationOptions } from '@tanstack/react-query';
import type { QueryClient } from '@tanstack/react-query';
import {
    cancelPipelineRun,
    deployPipeline,
    refreshPipelinesFromSource,
    runPipeline,
    updateTrigger,
} from '../api/pipelineRegistryClient.ts';
import type {
    PipelineDetail,
    PipelineRun,
    PipelineSummary,
    RunMode,
} from '../../shared/pipelineRegistryTypes.ts';
import {
    mergePipelineDetailSnapshot,
    mergePipelineSummarySnapshot,
} from '../lib/pipelineRunState.ts';
import type { TriggerDefinition } from '../types/triggerTypes.ts';
import { queryKeys } from './queryKeys.ts';
import { updatePipelineRunQueryCache } from './pipelineQueries.ts';

/** Variables accepted by a pipeline deployment command. */
export interface DeployPipelineVariables {
    pipelineId: string;
}

/** Variables accepted by a pipeline run command. */
export interface RunPipelineVariables {
    mode: RunMode;
    nodeNames?: string[];
    pipelineId: string;
}

/** Variables accepted by a run cancellation command. */
export interface CancelPipelineRunVariables {
    pipelineId: string;
    reason?: string;
    runId: string;
}

/** Variables accepted by a trigger enablement command. */
export interface UpdateTriggerVariables {
    enabled: boolean;
    triggerId: string;
}

/** Creates a no-retry mutation that refreshes the entire source-backed registry. */
export function refreshPipelinesFromSourceMutationOptions(queryClient: QueryClient) {
    return mutationOptions({
        mutationFn: refreshPipelinesFromSource,
        onSuccess: async () => {
            await Promise.all([
                queryClient.invalidateQueries({ queryKey: queryKeys.pipelines.all }),
                queryClient.invalidateQueries({ queryKey: queryKeys.triggers.all }),
            ]);
        },
        retry: false,
    });
}

/** Creates a no-retry deployment mutation and reconciles pipeline caches. */
export function deployPipelineMutationOptions(queryClient: QueryClient) {
    return mutationOptions({
        mutationFn: ({ pipelineId }: DeployPipelineVariables) => deployPipeline(pipelineId),
        onSuccess: async (detail, { pipelineId }) => {
            queryClient.setQueryData<PipelineDetail>(
                queryKeys.pipelines.detail(pipelineId),
                (current) => mergePipelineDetailSnapshot(current, detail),
            );
            queryClient.setQueryData<PipelineSummary[]>(
                queryKeys.pipelines.all,
                (current) => current?.map((pipeline) => pipeline.id === pipelineId
                    ? mergePipelineSummarySnapshot(pipeline, detail)
                    : pipeline),
            );
            await queryClient.invalidateQueries({ queryKey: queryKeys.pipelines.all });
        },
        retry: false,
    });
}

/** Creates a no-retry run mutation and reconciles list/detail/run caches. */
export function runPipelineMutationOptions(queryClient: QueryClient) {
    return mutationOptions({
        mutationFn: ({ pipelineId, mode, nodeNames }: RunPipelineVariables) =>
            runPipeline(pipelineId, mode, nodeNames),
        onSuccess: async (run, { pipelineId }) => {
            updatePipelineRunCaches(queryClient, run);
            await invalidatePipelineRunCaches(queryClient, pipelineId);
        },
        retry: false,
    });
}

/** Creates a no-retry cancellation mutation and reconciles list/detail/run caches. */
export function cancelPipelineRunMutationOptions(queryClient: QueryClient) {
    return mutationOptions({
        mutationFn: ({ runId, reason }: CancelPipelineRunVariables) =>
            cancelPipelineRun(runId, reason),
        onSuccess: async (run, { pipelineId }) => {
            updatePipelineRunCaches(queryClient, run);
            await invalidatePipelineRunCaches(queryClient, pipelineId);
        },
        retry: false,
    });
}

/** Creates a no-retry trigger mutation and invalidates its runtime status. */
export function updateTriggerMutationOptions(queryClient: QueryClient) {
    return mutationOptions({
        mutationFn: ({ triggerId, enabled }: UpdateTriggerVariables) =>
            updateTrigger(triggerId, { enabled }),
        onSuccess: async (updated, { triggerId }) => {
            queryClient.setQueryData<TriggerDefinition[]>(
                queryKeys.triggers.all,
                (current) => current?.map((trigger) => trigger.id === updated.id ? updated : trigger),
            );
            await Promise.all([
                queryClient.invalidateQueries({ queryKey: queryKeys.triggers.all }),
                queryClient.invalidateQueries({
                    queryKey: queryKeys.triggers.scheduleStatus(triggerId),
                }),
            ]);
        },
        retry: false,
    });
}

function updatePipelineRunCaches(queryClient: QueryClient, run: PipelineRun): void {
    updatePipelineRunQueryCache(queryClient, run);
}

function invalidatePipelineRunCaches(
    queryClient: QueryClient,
    pipelineId: string,
): Promise<void[]> {
    return Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.pipelines.all }),
        queryClient.invalidateQueries({ queryKey: queryKeys.pipelines.detail(pipelineId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.pipelines.runs(pipelineId) }),
    ]);
}
