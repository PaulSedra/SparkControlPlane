/**
 * @fileoverview Shared query options for registry pipeline and trigger lists.
 *
 * The same `['triggers']` cache is consumed by the jobs page and per-pipeline
 * trigger views. Polling is deliberately a separate option bundle so only the
 * registry page owns the existing visible five-second refresh cadence.
 */

import { queryOptions } from '@tanstack/react-query';
import type { PipelineSummary } from '../../shared/pipelineRegistryTypes.ts';
import { mergePipelineSummarySnapshots } from '../lib/pipelineRunState.ts';
import {
    getPipelines,
    getTriggerScheduleStatus,
    getTriggers,
} from '../api/pipelineRegistryClient.ts';
import { queryKeys } from './queryKeys.ts';

/** Five-second refresh interval retained for the visible registry page. */
export const REGISTRY_REFRESH_INTERVAL_MS = 5_000;

/**
 * Options that preserve the registry's visible polling and immediate return-
 * to-window refresh behavior. Other trigger consumers share the data key but
 * do not opt into this polling policy.
 */
export const registryPollingOptions = {
    refetchInterval: REGISTRY_REFRESH_INTERVAL_MS,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: 'always' as const,
    staleTime: 0,
};

/** Creates the abortable query for pipeline summaries. */
export function pipelinesQueryOptions() {
    return queryOptions({
        queryKey: queryKeys.pipelines.all,
        queryFn: ({ signal }) => getPipelines(signal),
        structuralSharing: (current, incoming) => mergePipelineSummarySnapshots(
            current as PipelineSummary[] | undefined,
            incoming as PipelineSummary[],
        ),
    });
}

/** Creates the shared abortable query for all trigger definitions. */
export function triggersQueryOptions() {
    return queryOptions({
        queryKey: queryKeys.triggers.all,
        queryFn: ({ signal }) => getTriggers(signal),
    });
}

/** Creates an abortable runtime schedule query scoped to one trigger. */
export function triggerScheduleStatusQueryOptions(triggerId: string) {
    return queryOptions({
        queryKey: queryKeys.triggers.scheduleStatus(triggerId),
        queryFn: ({ signal }) => getTriggerScheduleStatus(triggerId, signal),
    });
}
