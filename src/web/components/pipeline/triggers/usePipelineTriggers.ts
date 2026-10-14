/**
 * @fileoverview Controller for shared trigger definitions, route-scoped
 * schedules, sorting, and trigger enablement.
 */

import { useCallback, useEffect, useMemo } from 'react';
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import {
    triggerScheduleStatusQueryOptions,
    triggersQueryOptions,
} from '../../../query/pipelineRegistryQueries.ts';
import { updateTriggerMutationOptions } from '../../../query/pipelineMutations.ts';
import type {
    TriggerDefinition,
    TriggerScheduleStatus,
} from '../../../types/triggerTypes.ts';

const EMPTY_TRIGGERS: TriggerDefinition[] = [];

/** Public state and actions returned by the trigger controller. */
export type PipelineTriggersController = ReturnType<typeof usePipelineTriggers>;

/** Loading state for trigger definitions. */
export type PipelineTriggersLoadState =
    | { kind: 'idle' | 'loading' | 'ready' }
    | { kind: 'error'; message: string };

/** State of one trigger enable/disable action. */
export type PipelineTriggersActionState =
    | { kind: 'idle' | 'running'; triggerId?: string }
    | { kind: 'succeeded' | 'failed'; message: string; triggerId?: string };

/**
 * Reads the shared trigger-definition query, then loads only route-relevant
 * runtime schedules. Definitions are cached across registry and pipeline
 * views; schedule requests are aborted when their route or trigger identity
 * changes, while the toggle feedback remains local until the mutation slice.
 */
export function usePipelineTriggers(pipelineId: string | undefined) {
    const queryClient = useQueryClient();
    const triggersQuery = useQuery({
        ...triggersQueryOptions(),
        enabled: pipelineId != null,
    });
    const toggleMutation = useMutation(updateTriggerMutationOptions(queryClient));
    const allTriggers = triggersQuery.data ?? EMPTY_TRIGGERS;
    const triggers = useMemo(
        () => pipelineId == null
            ? []
            : allTriggers.filter((trigger) =>
                trigger.pipelineId === pipelineId && trigger.active !== false),
        [allTriggers, pipelineId],
    );
    const scheduleTriggers = useMemo(
        () => triggers.filter((trigger) => trigger.type === 'SCHEDULE'),
        [triggers],
    );
    const scheduleQueries = useQueries({
        queries: scheduleTriggers.map((trigger) =>
            triggerScheduleStatusQueryOptions(trigger.id)),
    });
    const scheduleByTrigger = Object.fromEntries(scheduleQueries.flatMap((scheduleQueryResult, index) => {
        const triggerId = scheduleTriggers[index]?.id;
        return triggerId == null || scheduleQueryResult.data == null
            ? []
            : [[triggerId, scheduleQueryResult.data]];
    })) as Record<string, TriggerScheduleStatus>;
    const loadState = pipelineTriggersLoadState(
        pipelineId,
        triggersQuery,
        scheduleQueries,
    );
    const actionState = triggerActionState(toggleMutation);
    const refetchTriggers = triggersQuery.refetch;
    const resetToggleMutation = toggleMutation.reset;
    const mutateTrigger = toggleMutation.mutateAsync;

    const loadTriggers = useCallback(async (): Promise<void> => {
        if (pipelineId != null) {
            await refetchTriggers();
        }
    }, [pipelineId, refetchTriggers]);

    useEffect(() => {
        resetToggleMutation();
    }, [pipelineId, resetToggleMutation]);

    const sortedTriggers = useMemo(
        () => [...triggers].sort((left, right) => left.name.localeCompare(right.name)),
        [triggers],
    );

    const togglePipelineTrigger = useCallback(async (trigger: TriggerDefinition): Promise<void> => {
        try {
            await mutateTrigger({ triggerId: trigger.id, enabled: !trigger.enabled });
        } catch {
            // The mutation state exposes the failure to the trigger feedback region.
        }
    }, [mutateTrigger]);

    return {
        actionState,
        togglePipelineTrigger,
        loadState,
        loadTriggers,
        scheduleByTrigger,
        sortedTriggers,
    };
}

function triggerActionState(mutation: {
    data?: TriggerDefinition;
    error: unknown;
    isError: boolean;
    isPending: boolean;
    isSuccess: boolean;
    variables?: { triggerId: string };
}): PipelineTriggersActionState {
    const triggerId = mutation.variables?.triggerId;
    if (mutation.isPending) {
        return { kind: 'running', triggerId };
    }
    if (mutation.isError) {
        return {
            kind: 'failed',
            message: mutation.error instanceof Error
                ? mutation.error.message
                : 'Unable to update trigger.',
            triggerId,
        };
    }
    if (mutation.isSuccess && mutation.data != null) {
        return {
            kind: 'succeeded',
            message: `${mutation.data.name} ${mutation.data.enabled ? 'resumed' : 'paused'}.`,
            triggerId: mutation.data.id,
        };
    }
    return { kind: 'idle' };
}

function pipelineTriggersLoadState(
    pipelineId: string | undefined,
    triggerDefinitionsQuery: {
        data: unknown;
        error: unknown;
        isError: boolean;
        isFetching: boolean;
    },
    scheduleQueries: readonly {
        data: unknown;
        error: unknown;
        isError: boolean;
        isFetching: boolean;
    }[],
): PipelineTriggersLoadState {
    if (pipelineId == null) {
        return { kind: 'ready' };
    }
    if (triggerDefinitionsQuery.isError) {
        return {
            kind: 'error',
            message: triggerDefinitionsQuery.error instanceof Error
                ? triggerDefinitionsQuery.error.message
                : 'Unable to load triggers.',
        };
    }
    const failedSchedule = scheduleQueries.find((schedule) => schedule.isError);
    if (failedSchedule != null) {
        return {
            kind: 'error',
            message: failedSchedule.error instanceof Error
                ? failedSchedule.error.message
                : 'Unable to load trigger schedule.',
        };
    }
    if (triggerDefinitionsQuery.data !== undefined) {
        return triggerDefinitionsQuery.isFetching || scheduleQueries.some((schedule) =>
            schedule.isFetching || schedule.data === undefined)
            ? { kind: 'loading' }
            : { kind: 'ready' };
    }
    return triggerDefinitionsQuery.isFetching ? { kind: 'loading' } : { kind: 'idle' };
}
