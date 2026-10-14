/**
 * @fileoverview Dispatches durable successor runs after successful parent runs.
 */

import type { RunSuccessDependency, ControlPlanePersistence } from '../../types/pipelinePersistenceTypes.ts';
import type { RunSubmission, RunSubmissionResult } from '../../types/pipelineServiceTypes.ts';

const DEFAULT_POLL_INTERVAL_MILLISECONDS = 1_000;
const BASE_RETRY_DELAY_MILLISECONDS = 5_000;
const MAX_RETRY_DELAY_MILLISECONDS = 5 * 60_000;

/**
 * Persistence, submission, and error-reporting dependencies for successor runs.
 *
 * `submitRun` must use the normal managed submission path. `now` supplies the
 * retry clock so scheduling can be controlled in tests.
 */
export interface RunSuccessDependencyDispatcherOptions {
    now?: () => number;
    onError: (message: string, error: unknown) => void;
    persistence: ControlPlanePersistence;
    submitRun: (submission: RunSubmission) => Promise<RunSubmissionResult>;
}

/**
 * Operations for dispatching durable successor handoffs.
 *
 * `start` dispatches immediately and polls every second. Concurrent
 * `dispatchAvailable` calls share one cycle. `stop` disables polling and waits
 * for any in-flight cycle to finish.
 */
export interface RunSuccessDependencyDispatcher {
    dispatchAvailable: () => Promise<void>;
    start: () => void;
    stop: () => Promise<void>;
}

/**
 * Retries durable handoffs until a child run is persisted. The child uses the
 * normal submission path, preserving its deployment and overlap policy.
 */
export function createRunSuccessDependencyDispatcher(
    options: RunSuccessDependencyDispatcherOptions,
): RunSuccessDependencyDispatcher {
    const now = options.now ?? (() => Date.now());
    let timer: NodeJS.Timeout | undefined;
    let inFlight: Promise<void> | undefined;
    let stopped = false;

    return {
        dispatchAvailable,
        start() {
            if (timer != null) {
                return;
            }
            stopped = false;
            void dispatchAvailable().catch((error: unknown) => {
                options.onError('Could not read ready pipeline success dependencies.', error);
            });
            timer = setInterval(() => {
                void dispatchAvailable().catch((error: unknown) => {
                    options.onError('Could not read ready pipeline success dependencies.', error);
                });
            }, DEFAULT_POLL_INTERVAL_MILLISECONDS);
            timer.unref();
        },
        async stop() {
            stopped = true;
            if (timer != null) {
                clearInterval(timer);
                timer = undefined;
            }
            await inFlight;
        },
    };

    function dispatchAvailable(): Promise<void> {
        if (inFlight != null) {
            return inFlight;
        }
        if (stopped) {
            return Promise.resolve();
        }
        inFlight = dispatchBatch().finally(() => {
            inFlight = undefined;
        });
        return inFlight;
    }

    async function dispatchBatch(): Promise<void> {
        const dependencies = await options.persistence.listReadyRunSuccessDependencies();
        for (const dependency of dependencies) {
            if (stopped) {
                return;
            }
            await dispatchDependency(dependency);
        }
    }

    async function dispatchDependency(dependency: RunSuccessDependency): Promise<void> {
        const idempotencyKey = successDependencyIdempotencyKey(dependency);
        try {
            const existing = await options.persistence.getRunByIdempotencyKey(idempotencyKey);
            if (existing != null) {
                await markExistingRun(dependency, existing.pipelineId, existing.runId);
                return;
            }

            const submission: RunSubmission = {
                callerMetadata: {
                    sourcePipelineId: dependency.sourcePipelineId,
                    sourceRunId: dependency.sourceRunId,
                },
                idempotencyKey,
                mode: 'incremental',
                pipelineId: dependency.targetPipelineId,
                requestSource: 'pipeline-success-dependency',
            };
            const result = await options.submitRun(submission);
            await markExistingRun(dependency, result.run.pipelineId, result.run.runId);
        } catch (error) {
            try {
                // Recover a child accepted just before a response or outbox update failed.
                const existing = await options.persistence.getRunByIdempotencyKey(idempotencyKey);
                if (existing != null) {
                    await markExistingRun(dependency, existing.pipelineId, existing.runId);
                    return;
                }
            } catch (recoveryError) {
                options.onError(
                    `Could not recover successor submission for parent run ${dependency.sourceRunId}.`,
                    recoveryError,
                );
            }

            const nextAttemptAt = new Date(
                now() + retryDelayMilliseconds(dependency.attemptCount),
            ).toISOString();
            try {
                await options.persistence.recordRunSuccessDependencyFailure(
                    dependency.sourceRunId,
                    error instanceof Error ? error.message : String(error),
                    nextAttemptAt,
                );
            } catch (recordError) {
                options.onError(
                    `Could not schedule successor retry for parent run ${dependency.sourceRunId}.`,
                    recordError,
                );
            }
            options.onError(
                `Could not submit successor pipeline ${dependency.targetPipelineId} for parent run ${dependency.sourceRunId}.`,
                error,
            );
        }
    }

    async function markExistingRun(
        dependency: RunSuccessDependency,
        pipelineId: string,
        runId: string,
    ): Promise<void> {
        if (pipelineId !== dependency.targetPipelineId) {
            throw new Error(
                `Success dependency idempotency key resolved to pipeline ${pipelineId}, expected ${dependency.targetPipelineId}.`,
            );
        }
        await options.persistence.markRunSuccessDependencySubmitted(
            dependency.sourceRunId,
            runId,
        );
    }
}

/**
 * Builds the stable retry key from the parent run and target pipeline IDs.
 */
export function successDependencyIdempotencyKey(
    dependency: Pick<RunSuccessDependency, 'sourceRunId' | 'targetPipelineId'>,
): string {
    return `pipeline-success:${dependency.sourceRunId}:${dependency.targetPipelineId}`;
}

function retryDelayMilliseconds(attemptCount: number): number {
    const exponent = Math.min(20, Math.max(0, Math.floor(attemptCount)));
    return Math.min(
        MAX_RETRY_DELAY_MILLISECONDS,
        BASE_RETRY_DELAY_MILLISECONDS * (2 ** exponent),
    );
}
