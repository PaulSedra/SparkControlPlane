/**
 * @fileoverview Independent pipeline deploy, run, cancel, and live-progress actions.
 */

import { useCallback, useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type {
    PipelineDetail,
    PipelineRun,
    RunMode,
} from '../../../../shared/pipelineRegistryTypes.ts';
import {
    ACTIVE_PIPELINE_RUN_STATUSES,
    RunStatus,
} from '../../../../shared/status/run.ts';
import {
    monitorPipelineRun,
    PipelineApiError,
} from '../../../api/pipelineRegistryClient.ts';
import {
    cancelPipelineRunMutationOptions,
    deployPipelineMutationOptions,
    runPipelineMutationOptions,
} from '../../../query/pipelineMutations.ts';
import {
    refreshTerminalPipelineRunDetails,
    updatePipelineRunQueryCache,
} from '../../../query/pipelineQueries.ts';
import type { PipelineActionState, PipelineActionStates } from './pipelineControllerTypes.ts';

/**
 * Owns independent command mutation state and attaches the existing abortable
 * monitor to the active run. Live snapshots update query caches and only the
 * matching action's lifecycle state; commands are not automatically retried.
 */
export function usePipelineActions(
    routePipelineId: string | undefined,
    pipelineDetail: PipelineDetail | undefined,
    activeRunId: string | undefined,
    selectPipelineRun: (runId: string) => void,
) {
    const queryClient = useQueryClient();
    const [runProgressState, setRunProgressState] = useState<PipelineActionState>({ kind: 'idle' });
    const deployMutation = useMutation(deployPipelineMutationOptions(queryClient));
    const runMutation = useMutation(runPipelineMutationOptions(queryClient));
    const cancelMutation = useMutation(cancelPipelineRunMutationOptions(queryClient));
    const resetDeployMutation = deployMutation.reset;
    const resetRunMutation = runMutation.reset;
    const resetCancelMutation = cancelMutation.reset;

    const pipelineActionStates: PipelineActionStates = {
        deploy: pipelineDeployActionState(deployMutation),
        run: pipelineRunActionState(runMutation, runProgressState),
        cancel: pipelineCancelActionState(cancelMutation),
    };

    useEffect(() => {
        resetDeployMutation();
        resetRunMutation();
        resetCancelMutation();
        setRunProgressState({ kind: 'idle' });
    }, [routePipelineId, resetCancelMutation, resetDeployMutation, resetRunMutation]);

    const updateCachedRun = useCallback((run: PipelineRun): void => {
        updatePipelineRunQueryCache(queryClient, run);
        if (!ACTIVE_PIPELINE_RUN_STATUSES.includes(run.status)) {
            void refreshTerminalPipelineRunDetails(queryClient, run);
        }
    }, [queryClient]);

    const updateRunActionState = useCallback((run: PipelineRun): void => {
        setRunProgressState((current) => {
            if (current.runId !== run.runId) {
                return current;
            }
            if (run.status === RunStatus.SUCCEEDED) {
                return {
                    kind: 'succeeded',
                    operation: current.operation,
                    runId: run.runId,
                };
            }
            if (run.status === RunStatus.CANCELED &&
                current.operation === 'cancel') {
                return {
                    kind: 'succeeded',
                    operation: 'cancel',
                    runId: run.runId,
                };
            }
            if (run.status === RunStatus.FAILED) {
                return {
                    kind: 'failed',
                    operation: current.operation,
                    runId: run.runId,
                };
            }

            return {
                kind: 'running',
                operation: current.operation,
                runId: run.runId,
            };
        });
    }, []);

    useEffect(() => {
        if (activeRunId == null) {
            return undefined;
        }

        const controller = new AbortController();
        void monitorPipelineRun(
            activeRunId,
            controller.signal,
            (run) => {
                updateCachedRun(run);
                updateRunActionState(run);
            },
        )
            .then(updateRunActionState)
            .catch(() => {
                if (controller.signal.aborted) {
                    return;
                }

                setRunProgressState((current) => current.runId === activeRunId
                    ? {
                        kind: 'failed',
                        operation: current.operation,
                        runId: activeRunId,
                    }
                    : current);
            });

        return () => controller.abort();
    }, [activeRunId, updateCachedRun, updateRunActionState]);

    async function cancelPipelineRun(): Promise<void> {
        const runId = activeRunId ?? runProgressState.runId;
        const pipelineId = routePipelineId ?? pipelineDetail?.id;
        if (runId == null || pipelineId == null) {
            return;
        }

        setRunProgressState({
            kind: 'running',
            operation: 'cancel',
            runId,
        });
        try {
            const canceledRun = await cancelMutation.mutateAsync({
                pipelineId,
                runId,
                reason: 'Canceled from the pipeline detail page.',
            });
            updateCachedRun(canceledRun);
            updateRunActionState(canceledRun);
        } catch {
            setRunProgressState((current) => current.runId === runId
                ? {
                    ...current,
                    kind: 'running',
                    operation: 'run',
                }
                : current);
        }
    }

    async function deployPipeline(): Promise<void> {
        if (routePipelineId == null) {
            return;
        }

        try {
            await deployMutation.mutateAsync({ pipelineId: routePipelineId });
        } catch {
            // The deployment mutation exposes operation-specific error state.
        }
    }

    async function startPipelineRun(
        mode: RunMode = 'incremental',
        nodeNames?: string[],
    ): Promise<void> {
        if (routePipelineId == null) {
            return;
        }

        runMutation.reset();
        setRunProgressState({ kind: 'idle' });
        if (pipelineDetail?.currentVersionId == null) {
            setRunProgressState({
                kind: 'failed',
                operation: 'run',
            });
            return;
        }

        setRunProgressState({
            kind: 'running',
            operation: 'run',
        });
        try {
            const submittedRun = await runMutation.mutateAsync({
                pipelineId: routePipelineId,
                mode,
                nodeNames,
            });
            updateCachedRun(submittedRun);
            selectPipelineRun(submittedRun.runId);
            setRunProgressState({
                kind: 'running',
                operation: 'run',
                runId: submittedRun.runId,
            });
            if (!ACTIVE_PIPELINE_RUN_STATUSES.includes(submittedRun.status)) {
                updateRunActionState(submittedRun);
            }
        } catch {
            // The run mutation retains submission failure and failed-run data.
        }
    }

    return {
        cancelPipelineRun,
        deployPipeline,
        pipelineActionStates,
        startPipelineRun,
    };
}

function pipelineDeployActionState(mutation: {
    isError: boolean;
    isPending: boolean;
    isSuccess: boolean;
}): PipelineActionState {
    if (mutation.isPending) {
        return { kind: 'running', operation: 'deploy' };
    }
    if (mutation.isError) {
        return {
            kind: 'failed',
            operation: 'deploy',
        };
    }
    if (mutation.isSuccess) {
        return {
            kind: 'succeeded',
            operation: 'deploy',
        };
    }
    return { kind: 'idle' };
}

function pipelineRunActionState(
    mutation: {
        data?: PipelineRun;
        error: unknown;
        isError: boolean;
        isPending: boolean;
        isSuccess: boolean;
    },
    progressState: PipelineActionState,
): PipelineActionState {
    if (mutation.isPending) {
        return {
            kind: 'running',
            operation: 'run',
        };
    }
    if (mutation.isError) {
        const failedRun = mutation.error instanceof PipelineApiError
            ? mutation.error.run
            : undefined;
        return {
            kind: 'failed',
            operation: 'run',
            runId: failedRun?.runId,
        };
    }
    if (mutation.data != null) {
        if (progressState.operation === 'cancel' && progressState.runId === mutation.data.runId) {
            return { kind: 'idle' };
        }
        if (progressState.operation === 'run' && progressState.runId === mutation.data.runId) {
            return progressState;
        }
        if (ACTIVE_PIPELINE_RUN_STATUSES.includes(mutation.data.status)) {
            return {
                kind: 'running',
                operation: 'run',
                runId: mutation.data.runId,
            };
        }
        return mutation.data.status === RunStatus.SUCCEEDED
            ? {
                kind: 'succeeded',
                operation: 'run',
                runId: mutation.data.runId,
            }
            : {
                kind: 'failed',
                operation: 'run',
                runId: mutation.data.runId,
            };
    }
    return progressState;
}

function pipelineCancelActionState(mutation: {
    data?: PipelineRun;
    error: unknown;
    isError: boolean;
    isPending: boolean;
    isSuccess: boolean;
    variables?: { runId: string };
}): PipelineActionState {
    if (mutation.isPending) {
        return {
            kind: 'running',
            operation: 'cancel',
            runId: mutation.variables?.runId,
        };
    }
    if (mutation.isError) {
        return {
            kind: 'failed',
            operation: 'cancel',
            runId: mutation.variables?.runId,
        };
    }
    return mutation.isSuccess
        ? {
            kind: 'succeeded',
            operation: 'cancel',
            runId: mutation.data?.runId ?? mutation.variables?.runId,
        }
        : { kind: 'idle' };
}
