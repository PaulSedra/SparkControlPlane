/**
 * @fileoverview Coordinates bounded, abortable monitoring for active registry
 * runs and retries status reads after temporary failures.
 */

import { useEffect, useRef } from 'react';
import type { PipelineRun } from '../../../../shared/pipelineRegistryTypes.ts';
import { monitorPipelineRun } from '../../../api/pipelineRegistryClient.ts';
import { REGISTRY_REFRESH_INTERVAL_MS } from '../../../query/pipelineRegistryQueries.ts';

/** Maximum number of per-run status loops active in one registry page. */
export const MAX_CONCURRENT_PIPELINE_RUN_MONITORS = 4;

/** Status polling function injected into the coordinator for deterministic tests. */
export type PipelineRunMonitor = (
    runId: string,
    signal: AbortSignal,
    onUpdate?: (run: PipelineRun) => void,
) => Promise<PipelineRun>;

/** Callback that publishes monitor snapshots to the shared run caches. */
export interface PipelineRunMonitoringCallbacks {
    onRunUpdate: (run: PipelineRun) => void;
}

/**
 * Starts one monitor per active run, up to the configured per-worker concurrency limit.
 *
 * Completed runs are removed from the monitor set. An exhausted status read
 * is retried after the registry's five-second refresh interval; it never
 * changes the persisted run outcome. `dispose()` is the hook's unmount cleanup
 * and aborts both fetches and retry waits.
 */
export class PipelineRunMonitorCoordinator {
    private readonly controllers = new Map<string, AbortController>();
    private readonly terminalRunIds = new Set<string>();
    private readonly callbacks: PipelineRunMonitoringCallbacks;
    private readonly monitor: PipelineRunMonitor;
    private readonly maxConcurrentMonitors: number;
    private activeRunIds: string[] = [];
    private disposed = false;

    constructor(
        callbacks: PipelineRunMonitoringCallbacks,
        monitor: PipelineRunMonitor = monitorPipelineRun,
        maxConcurrentMonitors = MAX_CONCURRENT_PIPELINE_RUN_MONITORS,
    ) {
        this.callbacks = callbacks;
        this.monitor = monitor;
        this.maxConcurrentMonitors = maxConcurrentMonitors;
    }

    /** Synchronizes monitors with the current registry-derived active IDs. */
    updateActiveRuns(runIds: readonly string[]): void {
        this.disposed = false;
        this.activeRunIds = Array.from(new Set(runIds));
        const activeRunIdSet = new Set(this.activeRunIds);

        for (const [runId, controller] of this.controllers) {
            if (!activeRunIdSet.has(runId)) {
                controller.abort();
            }
        }
        for (const runId of this.terminalRunIds) {
            if (!activeRunIdSet.has(runId)) {
                this.terminalRunIds.delete(runId);
            }
        }

        this.startAvailableMonitors();
    }

    /** Aborts outstanding monitoring work when the owning component unmounts. */
    dispose(): void {
        this.disposed = true;
        this.activeRunIds = [];
        this.terminalRunIds.clear();
        for (const controller of this.controllers.values()) {
            controller.abort();
        }
    }

    private startAvailableMonitors(): void {
        if (this.disposed) {
            return;
        }

        while (this.controllers.size < this.maxConcurrentMonitors) {
            const runId = this.activeRunIds.find((candidate) =>
                !this.controllers.has(candidate) && !this.terminalRunIds.has(candidate));
            if (runId == null) {
                return;
            }

            const controller = new AbortController();
            this.controllers.set(runId, controller);
            void this.monitorUntilTerminal(runId, controller.signal).finally(() => {
                if (this.controllers.get(runId) === controller) {
                    this.controllers.delete(runId);
                }
                this.startAvailableMonitors();
            });
        }
    }

    private async monitorUntilTerminal(runId: string, signal: AbortSignal): Promise<void> {
        while (!signal.aborted && !this.disposed) {
            try {
                const finalRun = await this.monitor(
                    runId,
                    signal,
                    (run) => this.callbacks.onRunUpdate(run),
                );
                if (signal.aborted || this.disposed) {
                    return;
                }

                this.callbacks.onRunUpdate(finalRun);
                this.terminalRunIds.add(runId);
                return;
            } catch {
                if (signal.aborted || this.disposed) {
                    return;
                }

                try {
                    await abortableDelay(REGISTRY_REFRESH_INTERVAL_MS, signal);
                } catch {
                    return;
                }
            }
        }
    }
}

/**
 * Monitors each active run once and owns the abort controllers for its full
 * lifetime. Run IDs are reconciled independently so a newly discovered run
 * does not restart requests already in progress.
 */
export function usePipelineRunMonitoring(
    activeRunIds: readonly string[],
    callbacks: PipelineRunMonitoringCallbacks,
): void {
    const callbacksRef = useRef(callbacks);
    callbacksRef.current = callbacks;

    const coordinatorRef = useRef<PipelineRunMonitorCoordinator | undefined>(undefined);
    coordinatorRef.current ??= new PipelineRunMonitorCoordinator({
        onRunUpdate: (run) => callbacksRef.current.onRunUpdate(run),
    });
    const coordinator = coordinatorRef.current;

    useEffect(() => {
        coordinator.updateActiveRuns(activeRunIds);
    }, [activeRunIds, coordinator]);

    useEffect(() => () => coordinator.dispose(), [coordinator]);
}

function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
        if (signal.aborted) {
            reject(new DOMException('The operation was aborted.', 'AbortError'));
            return;
        }

        const timeoutId = setTimeout(() => {
            signal.removeEventListener('abort', onAbort);
            resolve();
        }, milliseconds);
        const onAbort = () => {
            clearTimeout(timeoutId);
            reject(new DOMException('The operation was aborted.', 'AbortError'));
        };
        signal.addEventListener('abort', onAbort, { once: true });
    });
}
