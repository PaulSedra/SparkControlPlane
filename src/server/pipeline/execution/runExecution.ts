/** @fileoverview Owns one claimed run's preparation, heartbeat, CLI, and finalization. */

import type { PipelineRun } from '../../../shared/pipelineRegistryTypes.ts';
import { CliExecutionState } from '../../../shared/status/execution.ts';
import {
    RunStatus,
    pipelineRunStatusForCliExecution,
} from '../../../shared/status/run.ts';
import type {
    ControlPlanePersistence,
    RunLease,
} from '../../types/pipelinePersistenceTypes.ts';
import {
    hydratePersistedPipelineSnapshot,
    type HydratedPipeline,
} from '../discovery/pipelineRegistryDiscovery.ts';
import { createVerifiedPipelineExecutionSnapshot } from './pipelineExecutionSnapshot.ts';
import type {
    LocalCliCommandResult,
    LocalCliRunController,
} from '../spark/sparkCliProcess.ts';
import { runSparkProcess } from '../spark/sparkProcess.ts';
import { parseRunNodeStatuses } from './runStatusParser.ts';
import { createLocalCliExecutionPublisher } from './localCliExecutionPublisher.ts';
import {
    incrementMetric,
    observeDuration,
} from '../../observability/observability.ts';
import { publicErrorMessage } from '../../utils/sanitization.ts';
import { logStructured } from '../../utils/structuredLogging.ts';

/** Injectable local CLI boundary used to exercise run recovery without Spark. */
export type LocalCliRunExecutor = typeof runSparkProcess;

/**
 * Persistence, lease, policy, and executor inputs for one claimed run.
 *
 * `submit` starts new CLI work; `monitor` reconnects to a saved local CLI
 * identity without starting another process.
 */
export interface RunExecutionDependencies {
    executionMode: 'monitor' | 'submit';
    lease: RunLease;
    leaseMilliseconds: number;
    persistence: ControlPlanePersistence;
    run: PipelineRun;
    runExecutor: LocalCliRunExecutor;
    sparkConnectUrl?: string;
}

/**
 * Completion and worker controls returned to the queue coordinator.
 *
 * Completion tracks the persisted run result. `detach` stops local monitoring;
 * `fence` prevents this worker from publishing further updates.
 */
export interface RunExecutionHandle {
    completion: Promise<PipelineRun>;
    detach: () => void;
    fence: () => void;
}

interface RunExecutionControls {
    attachController: (controller: LocalCliRunController) => void;
    fence: () => void;
    fenceAndDetach: () => void;
    isFenced: () => boolean;
    detach: () => void;
}

/** Starts execution and returns the exact controls held by the coordinator. */
export function startRunExecution(
    dependencies: RunExecutionDependencies,
): RunExecutionHandle {
    let localController: LocalCliRunController | undefined;
    let fenced = false;
    let heartbeat: NodeJS.Timeout | undefined;
    let heartbeatInFlight = false;

    const stopHeartbeat = () => {
        if (heartbeat != null) {
            clearInterval(heartbeat);
            heartbeat = undefined;
        }
    };
    const detach = () => {
        try {
            localController?.detach();
        } catch (error) {
            reportExecutionError(`Run monitor detach failed for ${dependencies.run.runId}`, error);
        }
    };
    const fence = () => {
        if (fenced) {
            return;
        }
        fenced = true;
        stopHeartbeat();
    };
    const fenceAndDetach = () => {
        fence();
        detach();
    };
    const controls: RunExecutionControls = {
        attachController: (controller) => {
            localController = controller;
            if (fenced) {
                detach();
            }
        },
        fence,
        fenceAndDetach,
        isFenced: () => fenced,
        detach,
    };

    heartbeat = setInterval(() => {
        if (fenced || heartbeatInFlight) {
            return;
        }
        heartbeatInFlight = true;
        void dependencies.persistence.renewLease(
            dependencies.run.runId,
            dependencies.lease,
            dependencies.leaseMilliseconds,
        )
            .then((result) => {
                if (result.kind === 'FENCED' || result.kind === 'ALREADY_TERMINAL') {
                    fenceAndDetach();
                }
            })
            .catch((error: unknown) => reportExecutionError('Run lease renewal failed', error))
            .finally(() => {
                heartbeatInFlight = false;
            });
    }, Math.max(1_000, Math.floor(dependencies.leaseMilliseconds / 3)));

    const completion = executeRunLifecycle(dependencies, controls)
        .finally(stopHeartbeat);
    return { completion, detach, fence };
}

async function executeRunLifecycle(
    dependencies: RunExecutionDependencies,
    controls: RunExecutionControls,
): Promise<PipelineRun> {
    let executionCompleted = false;
    try {
        const preparation = await prepareRunExecution(dependencies, controls.fenceAndDetach);
        if (preparation.kind === 'FAILED') {
            executionCompleted = true;
            return preparation.run;
        }
        const localPublisher = createLocalCliExecutionPublisher({
            fence: controls.fenceAndDetach,
            isFenced: controls.isFenced,
            lease: dependencies.lease,
            persistence: dependencies.persistence,
            run: dependencies.run,
        });

        const result = await dependencies.runExecutor(
            dependencies.run,
            preparation.parsed,
            dependencies.executionMode,
            dependencies.sparkConnectUrl,
            () => dependencies.persistence.isCancellationRequested(dependencies.run.runId),
            (snapshot, output) => localPublisher.publish({ snapshot, output }),
            (controller) => controls.attachController(controller),
        );
        await localPublisher.wait();
        if (controls.isFenced()) {
            executionCompleted = true;
            return await dependencies.persistence.getRun(dependencies.run.runId) ?? dependencies.run;
        }
        const completed = await finalizeRunExecution(
            dependencies,
            result,
            controls.fenceAndDetach,
        );
        executionCompleted = true;
        return completed;
    } finally {
        if (!executionCompleted) {
            controls.detach();
        }
    }
}

type RunPreparationResult =
    | { kind: 'FAILED'; run: PipelineRun }
    | { kind: 'READY'; parsed?: HydratedPipeline };

async function prepareRunExecution(
    dependencies: RunExecutionDependencies,
    fence: () => void,
): Promise<RunPreparationResult> {
    const { executionMode, lease, persistence, run } =
        dependencies;
    try {
        if (executionMode === 'monitor') {
            return { kind: 'READY' };
        }
        const snapshot = await persistence.getPipelineSnapshot(run.pipelineId, run.versionId);
        if (snapshot == null) {
            throw new Error('The pipeline source version for this run is unavailable.');
        }
        const parsed = hydratePersistedPipelineSnapshot(snapshot);
        if (run.sourceHash != null && parsed.sourceHash !== run.sourceHash) {
            throw new Error(
                'Pipeline source changed while this run was queued. Deploy and submit a new run.',
            );
        }
        const executionSnapshot = await createVerifiedPipelineExecutionSnapshot(
            parsed,
            run.sourceHash,
            run.runId,
        );
        return { kind: 'READY', parsed: executionSnapshot };
    } catch (error) {
        const failed = await persistence.failRunBeforeExecution(
            run.runId,
            lease,
            error instanceof Error ? error.message : String(error),
        );
        if (failed.kind === 'FENCED' || failed.kind === 'ALREADY_TERMINAL') {
            fence();
        }
        return {
            kind: 'FAILED',
            run: failed.run ?? await persistence.getRun(run.runId) ?? run,
        };
    }
}

async function finalizeRunExecution(
    dependencies: RunExecutionDependencies,
    result: LocalCliCommandResult,
    fence: () => void,
): Promise<PipelineRun> {
    const { lease, persistence, run } = dependencies;
    if (result.detached) {
        await persistence.releaseLease(run.runId, lease);
        return await persistence.getRun(run.runId) ?? run;
    }
    const outcomeUnknown = result.cliState === CliExecutionState.UNKNOWN;
    const terminalStatus = pipelineRunStatusForCliExecution({
        canceled: result.canceled,
        exitCode: result.exitCode,
        state: result.cliState,
        timedOut: result.timedOut,
    });
    const completedResult = await persistence.completeRun(run.runId, lease, {
        command: result.command,
        endedAt: new Date().toISOString(),
        exitCode: result.exitCode,
        nodeStatuses: outcomeUnknown
            ? undefined
            : parseRunNodeStatuses(
                [result.stdout, result.stderr].filter(Boolean).join('\n'),
                terminalStatus,
            ),
        status: terminalStatus,
        cliState: result.cliState,
        stderr: outcomeUnknown
            ? [result.stderr, 'The local Spark CLI state is unavailable. SCP cannot verify the Spark outcome and did not resubmit the run.']
                .filter(Boolean)
                .join('\n')
            : result.stderr,
        stdout: result.stdout,
        recoveryReason: outcomeUnknown
            ? result.reason ?? 'LOCAL_CLI_OUTCOME_UNKNOWN'
            : undefined,
        terminalReason: outcomeUnknown
            ? result.reason ?? 'LOCAL_CLI_OUTCOME_UNKNOWN'
            : undefined,
    });
    if (completedResult.kind === 'FENCED' || completedResult.kind === 'ALREADY_TERMINAL') {
        fence();
    }
    const completed = completedResult.run ?? await persistence.getRun(run.runId) ?? run;
    if (completedResult.kind === 'APPLIED') {
        incrementMetric(`control_plane_runs_${completed.status.toLowerCase()}_total`);
    }
    observeDuration(
        'control_plane_run_duration_ms',
        Date.parse(completed.endedAt ?? new Date().toISOString()) - Date.parse(completed.startedAt),
    );
    if (completed.status === RunStatus.TIMED_OUT) {
        logStructured('run_timed_out', {
            correlationId: completed.correlationId,
            requestSource: completed.requestSource,
            runId: completed.runId,
        });
    }
    logStructured('run_completed', {
        correlationId: completed.correlationId,
        exitCode: completed.exitCode,
        requestSource: completed.requestSource,
        runId: completed.runId,
        status: completed.status,
    });
    return completed;
}

function reportExecutionError(message: string, error: unknown): void {
    const detail = publicErrorMessage(error);
    console.error(`${message}: ${detail}`);
}
