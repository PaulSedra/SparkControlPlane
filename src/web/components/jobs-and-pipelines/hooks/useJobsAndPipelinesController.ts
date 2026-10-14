/**
 * @fileoverview Controller for pipeline list filtering, favorites, deployment,
 * run submission, monitoring, and cancellation.
 */

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
    PipelineRun,
    PipelineSummary,
    RunMode,
} from '../../../../shared/pipelineRegistryTypes.ts';
import {
    ACTIVE_PIPELINE_RUN_STATUSES,
} from '../../../../shared/status/run.ts';
import { PipelineApiError } from '../../../api/pipelineRegistryClient.ts';
import type { TriggerDefinition } from '../../../types/triggerTypes.ts';
import { queryKeys } from '../../../query/queryKeys.ts';
import { mergePipelineRunSnapshot } from '../../../lib/pipelineRunState.ts';
import {
    pipelinesQueryOptions,
    registryPollingOptions,
    triggersQueryOptions,
} from '../../../query/pipelineRegistryQueries.ts';
import {
    cancelPipelineRunMutationOptions,
    deployPipelineMutationOptions,
    runPipelineMutationOptions,
} from '../../../query/pipelineMutations.ts';
import { updatePipelineRunQueryCache } from '../../../query/pipelineQueries.ts';
import {
    errorMessage,
    pipelineTags,
} from '../../../utils/pipelineRunPresentation';
import {
    filterAndSortPipelines,
    parseFavoriteIds,
    toggleFavoriteId,
    uniqueSortedValues,
} from '../jobsAndPipelinesFilters.ts';
import {
    createJobsAndPipelinesRunActionState,
    jobsAndPipelinesRunActionReducer,
    updateRunActionState,
} from '../jobsAndPipelinesRunState.ts';
import type {
    JobsAndPipelinesActionState,
    JobsAndPipelinesActionStates,
} from '../jobsAndPipelinesRunState.ts';
import { usePipelineRunMonitoring } from './usePipelineRunMonitoring.ts';

const FAVORITES_STORAGE_KEY = 'spark-control-plane.jobs-and-pipelines-favorites';
const EMPTY_PIPELINES: PipelineSummary[] = [];
const EMPTY_TRIGGERS: TriggerDefinition[] = [];
const EMPTY_RUN_AS_OPTIONS: string[] = [];

/** Loading state for the jobs and pipelines list. */
export type JobsAndPipelinesLoadState =
    | { kind: 'idle' | 'loading' | 'ready' }
    | { kind: 'error'; message: string };

/** Top-level tab shown on the jobs and pipelines page. */
export type JobsAndPipelinesTab = 'jobs-pipelines' | 'job-runs';
/** Filter grouping for job and pipeline rows. */
export type JobsAndPipelinesType = 'all' | 'jobs' | 'pipelines';
/** Ownership scope selector retained for the current UI contract. */
export type JobsAndPipelinesScope = 'owned' | 'accessible';
/** Direction used for name sorting. */
export type JobsAndPipelinesSortDirection = 'ascending' | 'descending';

/** Public state and actions returned by the jobs-and-pipelines controller. */
export type JobsAndPipelinesController = ReturnType<typeof useJobsAndPipelinesController>;

/**
 * Coordinates the jobs-and-pipelines list and its run actions.
 *
 * The hook keeps filtering/sorting/favorites local to the page, persists
 * favorites opportunistically in browser storage, and reports storage failure
 * without making the registry unusable. Pending run submissions keep their
 * row actions disabled; run status is published to the Recent runs cache.
 * Active listed runs are monitored with bounded concurrency and merged into
 * pipeline caches. Periodic registry refreshes also discover trigger-created
 * runs and recover status monitoring after temporary read failures.
 */
export function useJobsAndPipelinesController() {
    const queryClient = useQueryClient();
    const [runActionState, dispatchRunAction] = useReducer(
        jobsAndPipelinesRunActionReducer,
        undefined,
        createJobsAndPipelinesRunActionState,
    );
    const runSubmissionIdRef = useRef(0);
    const [activeTab, setActiveTab] = useState<JobsAndPipelinesTab>('jobs-pipelines');
    const [favoriteIds, setFavoriteIds] = useState<Set<string>>(readFavoriteIds);
    const [favoritesOnly, setFavoritesOnly] = useState(false);
    const [openMenuId, setOpenMenuId] = useState<string>();
    const [searchQuery, setSearchQuery] = useState('');
    const [runAsFilter, setRunAsFilter] = useState('all');
    const [scope, setScope] = useState<JobsAndPipelinesScope>('owned');
    const [sortDirection, setSortDirection] = useState<JobsAndPipelinesSortDirection>('ascending');
    const [tagFilter, setTagFilter] = useState('all');
    const [typeFilter, setTypeFilter] = useState<JobsAndPipelinesType>('all');
    const pipelinesQuery = useQuery({ ...pipelinesQueryOptions(), ...registryPollingOptions });
    const triggersQuery = useQuery({ ...triggersQueryOptions(), ...registryPollingOptions });
    const deployMutation = useMutation(deployPipelineMutationOptions(queryClient));
    const runMutation = useMutation(runPipelineMutationOptions(queryClient));
    const cancelMutation = useMutation(cancelPipelineRunMutationOptions(queryClient));
    const pipelines = pipelinesQuery.data ?? EMPTY_PIPELINES;
    const triggers = triggersQuery.data ?? EMPTY_TRIGGERS;
    const loadState = registryLoadState(pipelinesQuery, triggersQuery);
    const actionStates: JobsAndPipelinesActionStates = {
        deploy: mutationActionState(
            deployMutation,
            'Deploying pipeline...',
            'Pipeline deployed.',
            'Deploy failed.',
        ),
        run: runActionState.actionState,
        cancel: mutationActionState(
            cancelMutation,
            'Canceling pipeline run...',
            'Cancellation requested.',
            'Unable to cancel the run.',
        ),
    };
    useEffect(() => {
        try {
            window.localStorage.setItem(
                FAVORITES_STORAGE_KEY,
                JSON.stringify(Array.from(favoriteIds)),
            );
        } catch {
            // Local favorites are an enhancement; the registry remains usable when storage is unavailable.
        }
    }, [favoriteIds]);

    const tagOptions = useMemo(
        () => uniqueSortedValues(pipelines.flatMap((pipeline) => pipelineTags(pipeline))),
        [pipelines],
    );
    const runAsOptions = EMPTY_RUN_AS_OPTIONS;
    const filteredPipelines = useMemo(() => filterAndSortPipelines(pipelines, {
        favoriteIds,
        favoritesOnly,
        searchQuery,
        sortDirection,
        tagFilter,
        typeFilter,
    }), [
        favoriteIds,
        favoritesOnly,
        pipelines,
        searchQuery,
        sortDirection,
        tagFilter,
        typeFilter,
    ]);
    const jobRuns = useMemo(
        () => filteredPipelines
            .flatMap((pipeline) => pipeline.recentRuns.map((run) => ({ pipeline, run })))
            .sort((left, right) => right.run.startedAt.localeCompare(left.run.startedAt)),
        [filteredPipelines],
    );
    const allPipelineRuns = useMemo(() => {
        const runsById = new Map<string, PipelineRun>();
        for (const pipeline of pipelines) {
            for (const run of [pipeline.lastRun, ...pipeline.recentRuns]) {
                if (run != null) {
                    runsById.set(
                        run.runId,
                        mergePipelineRunSnapshot(runsById.get(run.runId), run),
                    );
                }
            }
        }
        return Array.from(runsById.values());
    }, [pipelines]);
    const activeRuns = useMemo(
        () => allPipelineRuns.filter((run) => ACTIVE_PIPELINE_RUN_STATUSES.includes(run.status)),
        [allPipelineRuns],
    );
    const activeRunIds = useMemo(() => activeRuns.map((run) => run.runId), [activeRuns]);
    const runningPipelineIds = useMemo(() => Array.from(new Set([
        ...activeRuns.map((run) => run.pipelineId),
        ...Array.from(runActionState.pendingSubmissions.values())
            .map((submission) => submission.pipelineId),
    ])), [activeRuns, runActionState.pendingSubmissions]);

    const updateRunCache = useCallback((run: PipelineRun): void => {
        const latestRun = updatePipelineRunQueryCache(queryClient, run);
        dispatchRunAction({ type: 'run-updated', run: latestRun });
    }, [queryClient]);
    usePipelineRunMonitoring(activeRunIds, {
        onRunUpdate: updateRunCache,
    });

    const showInitialLoading =
        pipelines.length === 0 &&
        (loadState.kind === 'idle' || loadState.kind === 'loading');

    async function deployPipeline(pipelineId: string): Promise<void> {
        setOpenMenuId(undefined);
        try {
            await deployMutation.mutateAsync({ pipelineId });
        } catch {
            // The deployment mutation owns its error and retry state.
        }
    }

    async function startPipelineRun(
        pipelineId: string,
        mode: RunMode = 'incremental',
    ): Promise<void> {
        setOpenMenuId(undefined);
        const requestId = ++runSubmissionIdRef.current;
        dispatchRunAction({
            type: 'submission-started',
            requestId,
            pipelineId,
        });
        try {
            const run = await runMutation.mutateAsync({ pipelineId, mode });
            const cachedPipeline = queryClient.getQueryData<PipelineSummary[]>(
                queryKeys.pipelines.all,
            )?.find((pipeline) => pipeline.id === run.pipelineId);
            const cachedRun = [cachedPipeline?.lastRun, ...(cachedPipeline?.recentRuns ?? [])]
                .find((candidate) => candidate?.runId === run.runId);
            const latestRun = cachedRun == null
                ? run
                : mergePipelineRunSnapshot(run, cachedRun);
            const currentRun = updatePipelineRunQueryCache(queryClient, latestRun);
            dispatchRunAction({
                type: 'submission-succeeded',
                requestId,
                run: currentRun,
            });
        } catch (error) {
            const failedRun = error instanceof PipelineApiError ? error.run : undefined;
            const latestFailedRun = failedRun == null
                ? undefined
                : updatePipelineRunQueryCache(queryClient, failedRun);
            const runActionState = latestFailedRun == null
                ? undefined
                : updateRunActionState(latestFailedRun);
            dispatchRunAction({
                type: 'submission-failed',
                requestId,
                message: runActionState?.kind === 'failed'
                    ? runActionState.message
                    : errorMessage(error, 'Run failed.'),
            });
        }
    }

    async function cancelPipelineRun(
        pipelineId: string,
        runId: string,
    ): Promise<void> {
        try {
            await cancelMutation.mutateAsync({
                pipelineId,
                reason: 'Canceled from the Jobs & Pipelines page.',
                runId,
            });
        } catch {
            // The cancellation mutation owns its error and pending state.
        }
    }

    function toggleFavorite(pipelineId: string): void {
        setFavoriteIds((current) => toggleFavoriteId(current, pipelineId));
    }

    return {
        actionStates,
        activeTab,
        favoriteIds,
        favoritesOnly,
        filteredPipelines,
        cancelPipelineRun,
        deployPipeline,
        searchQuery,
        setSearchQuery,
        startPipelineRun,
        loadState,
        openMenuId,
        pipelines,
        runAsFilter,
        runAsOptions,
        runningPipelineIds,
        scope,
        setActiveTab,
        setFavoritesOnly,
        setOpenMenuId,
        setRunAsFilter,
        setScope,
        setSortDirection,
        setTagFilter,
        setTypeFilter,
        showInitialLoading,
        sortDirection,
        tagFilter,
        tagOptions,
        toggleFavorite,
        triggers,
        typeFilter,
        jobRuns,
    };
}

function registryLoadState(
    pipelinesQuery: { data: unknown; error: unknown; isError: boolean; isFetching: boolean },
    triggersQuery: { data: unknown; error: unknown; isError: boolean; isFetching: boolean },
): JobsAndPipelinesLoadState {
    const failedQueryResult = [pipelinesQuery, triggersQuery]
        .find((queryResult) => queryResult.isError);
    if (failedQueryResult != null) {
        return {
            kind: 'error',
            message: errorMessage(failedQueryResult.error, 'Unable to load jobs and pipelines.'),
        };
    }
    if (pipelinesQuery.data !== undefined && triggersQuery.data !== undefined) {
        return { kind: 'ready' };
    }
    return pipelinesQuery.isFetching || triggersQuery.isFetching
        ? { kind: 'loading' }
        : { kind: 'idle' };
}

function mutationActionState(
    mutation: {
        error: unknown;
        isError: boolean;
        isPending: boolean;
        isSuccess: boolean;
        variables?: { pipelineId?: string; runId?: string };
    },
    runningMessage: string,
    successMessage: string,
    errorFallback: string,
): JobsAndPipelinesActionState {
    const { pipelineId, runId } = mutation.variables ?? {};
    if (mutation.isPending) {
        return { kind: 'running', message: runningMessage, pipelineId, runId };
    }
    if (mutation.isError) {
        return {
            kind: 'failed',
            message: errorMessage(mutation.error, errorFallback),
            pipelineId,
            runId,
        };
    }
    return mutation.isSuccess
        ? { kind: 'succeeded', message: successMessage, pipelineId, runId }
        : { kind: 'idle' };
}

function readFavoriteIds(): Set<string> {
    try {
        const raw = window.localStorage.getItem(FAVORITES_STORAGE_KEY);
        return parseFavoriteIds(raw);
    } catch {
        return new Set();
    }
}
