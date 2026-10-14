/** @fileoverview Claims persisted work and coordinates queue, lease, and shutdown behavior. */

import crypto from 'node:crypto';
import type { PipelineRun } from '../../../shared/pipelineRegistryTypes.ts';
import type {
    ControlPlanePersistence,
    RunLease,
} from '../../types/pipelinePersistenceTypes.ts';
import { incrementMetric, observeDuration, setMetric } from '../../observability/observability.ts';
import { publicErrorMessage } from '../../utils/sanitization.ts';
import { logStructured } from '../../utils/structuredLogging.ts';
import {
    startRunExecution,
    type LocalCliRunExecutor,
    type RunExecutionHandle,
} from './runExecution.ts';
import { runSparkProcess } from '../spark/sparkProcess.ts';
import { loadRunCoordinatorConfig } from './runCoordinatorConfig.ts';

/** Lifecycle controls exposed to the registry service for the worker queue. */
export interface RunCoordinator {
    isAcceptingWork: () => boolean;
    shutdown: (drainMilliseconds: number) => Promise<void>;
    start: () => void;
    wake: () => void;
}

interface ActiveRunHandle extends RunExecutionHandle {
    lease: RunLease;
    run: PipelineRun;
}

/**
 * Creates the worker lifecycle used by the registry service. Startup wakes the
 * normal queue independently of lease reconciliation. Shutdown stops admission,
 * waits for active execution promises until its deadline, then fences and detaches
 * remaining monitors before releasing their leases.
 */
export function createRunCoordinator(
    sparkConnectUrl: string | undefined,
    persistence: ControlPlanePersistence,
    runExecutor: LocalCliRunExecutor = runSparkProcess,
): RunCoordinator {
    const {
        leaseMilliseconds,
        maxConcurrentRuns,
        recoveryBatchSize,
        recoveryIntervalMilliseconds,
    } = loadRunCoordinatorConfig();
    const ownerId = `${process.pid}:${crypto.randomUUID()}`;
    const activeRuns = new Map<string, ActiveRunHandle>();
    let acceptingWork = true;
    let pumpRunning = false;
    let wakePending = false;
    let recoveryInFlight = false;
    let recoveryCompletion: Promise<void> | undefined;
    let pumpCompletion: Promise<void> = Promise.resolve();
    let recoveryTimer: NodeJS.Timeout | undefined;
    let started = false;
    let shutdownCompletion: Promise<void> | undefined;

    const wake = () => {
        if (!acceptingWork || !started) {
            return;
        }
        wakePending = true;
        if (pumpRunning) {
            return;
        }
        pumpRunning = true;
        let finishPump!: () => void;
        pumpCompletion = new Promise<void>((resolve) => {
            finishPump = resolve;
        });
        queueMicrotask(() => {
            void (async () => {
                try {
                    do {
                        wakePending = false;
                        await drain();
                    } while (wakePending && acceptingWork);
                } catch (error) {
                    reportCoordinatorError('Run queue failed', error);
                } finally {
                    pumpRunning = false;
                    finishPump();
                    if (wakePending && acceptingWork) {
                        wake();
                    }
                }
            })();
        });
    };

    const recover = (): Promise<void> => {
        if (recoveryInFlight || !acceptingWork) {
            return Promise.resolve();
        }
        recoveryInFlight = true;
        incrementMetric('control_plane_recovery_attempts_total');
        const completion = (async () => {
            try {
                await persistence.reconcileExpiredLeases(recoveryBatchSize);
                incrementMetric('control_plane_recovery_successes_total');
                wake();
            } catch (error) {
                reportCoordinatorError('Run recovery failed', error);
            } finally {
                recoveryInFlight = false;
            }
        })();
        recoveryCompletion = completion;
        void completion.then(() => {
            if (recoveryCompletion === completion) {
                recoveryCompletion = undefined;
            }
        });
        return completion;
    };

    const start = () => {
        if (started) {
            return;
        }
        started = true;
        recoveryTimer = setInterval(() => {
            void recover();
        }, recoveryIntervalMilliseconds);
        wake();
        void recover();
    };

    const drain = async () => {
        while (acceptingWork && activeRuns.size < maxConcurrentRuns) {
            const recovered = await persistence.claimNextRecoverableRun(
                ownerId,
                leaseMilliseconds,
            );
            const claimed = recovered ?? await persistence.claimNextQueuedRun(
                ownerId,
                leaseMilliseconds,
            );
            if (claimed == null) {
                return;
            }

            if (!acceptingWork) {
                await persistence.releaseLease(claimed.run.runId, claimed.lease);
                return;
            }

            incrementMetric('control_plane_claims_total');
            observeDuration(
                'control_plane_queue_wait_ms',
                Math.max(0, Date.now() - Date.parse(claimed.run.startedAt)),
            );
            logStructured('run_claimed', {
                correlationId: claimed.run.correlationId,
                pipelineId: claimed.run.pipelineId,
                requestSource: claimed.run.requestSource,
                runId: claimed.run.runId,
            });
            const execution = startRunExecution({
                executionMode: recovered == null ? 'submit' : 'monitor',
                lease: claimed.lease,
                leaseMilliseconds,
                persistence,
                run: claimed.run,
                runExecutor,
                sparkConnectUrl,
            });
            const active: ActiveRunHandle = {
                ...execution,
                lease: claimed.lease,
                run: claimed.run,
            };
            activeRuns.set(claimed.run.runId, active);
            setMetric('control_plane_active_runs', activeRuns.size);
            void active.completion
                .catch((error: unknown) => {
                    reportCoordinatorError('Pipeline execution failed', error);
                })
                .finally(() => {
                    activeRuns.delete(claimed.run.runId);
                    setMetric('control_plane_active_runs', activeRuns.size);
                    wake();
                });
        }
    };

    const shutdown = (drainMilliseconds: number): Promise<void> => {
        if (shutdownCompletion != null) {
            return shutdownCompletion;
        }
        acceptingWork = false;
        if (recoveryTimer != null) {
            clearInterval(recoveryTimer);
            recoveryTimer = undefined;
        }
        const pendingWork = Promise.allSettled([
            pumpCompletion,
            recoveryCompletion ?? Promise.resolve(),
            ...Array.from(activeRuns.values(), (active) => active.completion),
        ]).then(() => undefined);
        shutdownCompletion = (async () => {
            const drained = await waitForCompletion(
                pendingWork,
                Math.max(0, drainMilliseconds),
            );
            if (drained) {
                return;
            }
            for (const active of activeRuns.values()) {
                active.fence();
                active.detach();
                try {
                    await persistence.releaseLease(active.run.runId, active.lease);
                } catch (error) {
                    reportCoordinatorError(
                        `Shutdown lease release failed for ${active.run.runId}`,
                        error,
                    );
                }
            }
        })();
        return shutdownCompletion;
    };

    return {
        isAcceptingWork: () => acceptingWork,
        shutdown,
        start,
        wake,
    };
}

async function waitForCompletion(completion: Promise<void>, timeoutMilliseconds: number): Promise<boolean> {
    if (timeoutMilliseconds <= 0) {
        return false;
    }
    let timeout: NodeJS.Timeout | undefined;
    const result = await Promise.race([
        completion.then(() => true),
        new Promise<boolean>((resolve) => {
            timeout = setTimeout(() => resolve(false), timeoutMilliseconds);
        }),
    ]);
    if (timeout != null) {
        clearTimeout(timeout);
    }
    return result;
}

function reportCoordinatorError(message: string, error: unknown): void {
    const detail = publicErrorMessage(error);
    console.error(`${message}: ${detail}`);
}
