/**
 * @fileoverview Unit coverage for queue wakeups, recovery independence, and shutdown.
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { CliExecutionState } from '../../../../src/shared/status/execution.ts';
import { discoverAndPersistPipelines } from '../../../../src/server/pipeline/discovery/pipelineRegistryDiscovery.ts';
import type { PipelineParseCache } from '../../../../src/server/pipeline/discovery/pipelineDiscovery.ts';
import { versionId } from '../../../../src/server/pipeline/discovery/pipelineVersion.ts';
import { createRunCoordinator } from '../../../../src/server/pipeline/execution/runCoordinator.ts';
import type { LocalCliRunExecutor } from '../../../../src/server/pipeline/execution/runExecution.ts';
import { submitRun } from '../../../../src/server/pipeline/execution/runSubmission.ts';
import type { LocalCliCommandResult } from '../../../../src/server/pipeline/spark/sparkCliProcess.ts';
import type { PipelineRunPolicy } from '../../../../src/server/types/pipelineRunPolicyTypes.ts';
import { createInMemoryPersistence } from '../../../support/inMemoryPersistence.ts';
import { createPipelineFixture } from '../../../support/pipelineFixture.ts';
import { captureEnvironment } from '../../../support/testEnvironment.ts';

test('a submission waking an active empty queue pump is still claimed', async () => {
    const harness = await createCoordinatorHarness('queue-wakeup');
    let releaseFirstQueueClaim!: () => void;
    let signalFirstQueueClaim!: () => void;
    const firstQueueClaimStarted = new Promise<void>((resolve) => {
        signalFirstQueueClaim = resolve;
    });
    const firstQueueClaimReleased = new Promise<void>((resolve) => {
        releaseFirstQueueClaim = resolve;
    });
    const originalClaimNextQueuedRun = harness.persistence.claimNextQueuedRun.bind(
        harness.persistence,
    );
    let holdFirstEmptyClaim = true;

    harness.persistence.claimNextQueuedRun = async (ownerId, leaseMilliseconds) => {
        const claim = await originalClaimNextQueuedRun(ownerId, leaseMilliseconds);
        if (holdFirstEmptyClaim && claim == null) {
            holdFirstEmptyClaim = false;
            signalFirstQueueClaim();
            await firstQueueClaimReleased;
        }
        return claim;
    };

    try {
        harness.coordinator.start();
        await firstQueueClaimStarted;

        const submitted = await submitRun(
            { pipelineId: harness.pipelineId },
            harness.persistence,
        );
        harness.coordinator.wake();
        releaseFirstQueueClaim();

        const completed = await waitForRunStatus(
            harness.persistence,
            submitted.run.runId,
            'SUCCEEDED',
        );
        assert.equal(completed.status, 'SUCCEEDED');
    } finally {
        releaseFirstQueueClaim();
        await harness.cleanup();
    }
});

test('startup drains queued work when lease reconciliation fails', async () => {
    const harness = await createCoordinatorHarness('startup-recovery-failure');
    try {
        const submitted = await submitRun(
            { pipelineId: harness.pipelineId },
            harness.persistence,
        );
        harness.persistence.reconcileExpiredLeases = async () => {
            throw new Error('recovery unavailable');
        };

        harness.coordinator.start();

        const completed = await waitForRunStatus(
            harness.persistence,
            submitted.run.runId,
            'SUCCEEDED',
        );
        assert.equal(completed.status, 'SUCCEEDED');
    } finally {
        await harness.cleanup();
    }
});

test('shutdown waits for active run execution before detaching its monitor', async () => {
    let finishExecution!: (result: LocalCliCommandResult) => void;
    let signalExecutionStarted!: () => void;
    let detachCount = 0;
    const executionStarted = new Promise<void>((resolve) => {
        signalExecutionStarted = resolve;
    });
    const blockedExecutor: LocalCliRunExecutor = async (
        _run,
        _parsed,
        _executionMode,
        _sparkConnectUrl,
        _shouldCancel,
        _onSnapshot,
        onLocalProcess,
    ) => {
        onLocalProcess({
            detach: () => {
                detachCount += 1;
            },
            requestStop: () => undefined,
        }, ['spark-pipelines', 'run']);
        signalExecutionStarted();
        return await new Promise<LocalCliCommandResult>((resolve) => {
            finishExecution = resolve;
        });
    };
    const harness = await createCoordinatorHarness('shutdown-drain', blockedExecutor);
    try {
        const submitted = await submitRun(
            { pipelineId: harness.pipelineId },
            harness.persistence,
        );
        harness.coordinator.start();
        await executionStarted;

        const shutdown = harness.coordinator.shutdown(2_000);
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.equal(harness.coordinator.isAcceptingWork(), false);
        assert.equal(detachCount, 0);

        finishExecution(successfulExecutionResult());
        await shutdown;

        const completed = await harness.persistence.getRun(submitted.run.runId);
        assert.equal(completed?.status, 'SUCCEEDED');
        assert.equal(detachCount, 0);
    } finally {
        finishExecution?.(successfulExecutionResult());
        await harness.cleanup();
    }
});

test('shutdown fences, detaches, and releases a run after its drain deadline', async () => {
    let finishExecution!: (result: LocalCliCommandResult) => void;
    let signalExecutionStarted!: () => void;
    let detachCount = 0;
    let leaseReleaseCount = 0;
    const executionStarted = new Promise<void>((resolve) => {
        signalExecutionStarted = resolve;
    });
    const blockedExecutor: LocalCliRunExecutor = async (
        _run,
        _parsed,
        _executionMode,
        _sparkConnectUrl,
        _shouldCancel,
        _onSnapshot,
        onLocalProcess,
    ) => {
        onLocalProcess({
            detach: () => {
                detachCount += 1;
            },
            requestStop: () => undefined,
        }, ['spark-pipelines', 'run']);
        signalExecutionStarted();
        return await new Promise<LocalCliCommandResult>((resolve) => {
            finishExecution = resolve;
        });
    };
    const harness = await createCoordinatorHarness('shutdown-deadline', blockedExecutor);
    const originalReleaseLease = harness.persistence.releaseLease.bind(harness.persistence);
    harness.persistence.releaseLease = async (...args) => {
        leaseReleaseCount += 1;
        return originalReleaseLease(...args);
    };
    try {
        await submitRun(
            { pipelineId: harness.pipelineId },
            harness.persistence,
        );
        harness.coordinator.start();
        await executionStarted;

        await harness.coordinator.shutdown(10);

        assert.equal(detachCount, 1);
        assert.equal(leaseReleaseCount, 1);
    } finally {
        finishExecution?.(successfulExecutionResult());
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        await harness.cleanup();
    }
});

interface RunCoordinatorHarness {
    cleanup: () => Promise<void>;
    coordinator: ReturnType<typeof createRunCoordinator>;
    pipelineId: string;
    pipelineParseCache: PipelineParseCache;
    pipelineRunPolicies: Map<string, PipelineRunPolicy>;
    persistence: ReturnType<typeof createInMemoryPersistence>;
}

async function createCoordinatorHarness(
    name: string,
    runExecutor: LocalCliRunExecutor = async () => successfulExecutionResult(),
): Promise<RunCoordinatorHarness> {
    const restoreEnvironment = captureEnvironment(
        'PIPELINES_DIR',
        'PIPELINE_RUN_LEASE_SECONDS',
        'PIPELINE_RUN_RECOVERY_INTERVAL_SECONDS',
        'SPARK_CLI_STATE_DIRECTORY',
    );
    const fixture = await createPipelineFixture({
        libraryInclude: null,
        name: `${name}_pipeline`,
        prefix: `spark-control-plane-${name}-`,
        specFilename: `${name}_pipeline.pipeline.yaml`,
    });
    const persistence = createInMemoryPersistence();
    const pipelineRunPolicies = new Map<string, PipelineRunPolicy>();
    const pipelineParseCache: PipelineParseCache = new Map();
    process.env.PIPELINES_DIR = path.join(fixture.root, 'pipelines');
    process.env.PIPELINE_RUN_LEASE_SECONDS = '30';
    process.env.PIPELINE_RUN_RECOVERY_INTERVAL_SECONDS = '3600';
    process.env.SPARK_CLI_STATE_DIRECTORY = path.join(fixture.root, 'cli-state');

    try {
        await persistence.initialize();
        const pipelines = await discoverAndPersistPipelines(
            persistence,
            pipelineRunPolicies,
            pipelineParseCache,
        );
        const pipeline = pipelines[0];
        assert.ok(pipeline);
        await persistence.saveDeployment({
            deployedAt: new Date().toISOString(),
            pipelineId: pipeline.detail.id,
            sourceHash: pipeline.sourceHash,
            status: 'DEPLOYED',
            validationMessages: [],
            versionId: versionId(pipeline.sourceHash),
        });
        const coordinator = createRunCoordinator(
            undefined,
            persistence,
            runExecutor,
        );
        return {
            cleanup: async () => {
                await coordinator.shutdown(0);
                await persistence.shutdown();
                restoreEnvironment();
                await fixture.cleanup();
            },
            coordinator,
            pipelineId: pipeline.detail.id,
            pipelineParseCache,
            pipelineRunPolicies,
            persistence,
        };
    } catch (error) {
        await persistence.shutdown();
        restoreEnvironment();
        await fixture.cleanup();
        throw error;
    }
}

function successfulExecutionResult(): LocalCliCommandResult {
    return {
        canceled: false,
        command: ['spark-pipelines', 'run'],
        detached: false,
        exitCode: 0,
        cliState: CliExecutionState.COMPLETED,
        stderr: '',
        stdout: '',
        timedOut: false,
    };
}

async function waitForRunStatus(
    persistence: ReturnType<typeof createInMemoryPersistence>,
    runId: string,
    expectedStatus: string,
) {
    const deadline = Date.now() + 2_000;
    let run = await persistence.getRun(runId);
    while (run?.status !== expectedStatus && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        run = await persistence.getRun(runId);
    }
    assert.equal(run?.status, expectedStatus);
    assert.ok(run);
    return run;
}
