/**
 * @fileoverview Unit coverage for durable pipeline-success handoffs.
 */

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import { createInMemoryPersistence } from '../../../support/inMemoryPersistence.ts';
import type {
    ControlPlanePersistence,
    DiscoveredPipeline,
    PersistedPipeline,
    PersistedRunSubmission,
} from '../../../../src/server/types/pipelinePersistenceTypes.ts';
import type { PipelineRunPolicy } from '../../../../src/server/types/pipelineRunPolicyTypes.ts';
import type { RunSubmission } from '../../../../src/server/types/pipelineServiceTypes.ts';
import { createRunSuccessDependencyDispatcher } from '../../../../src/server/pipeline/execution/runSuccessDependencyDispatcher.ts';

const policy: PipelineRunPolicy = { allowOverlap: false, timeoutSeconds: 60 };

test('success dispatch retries after restart and persists one child with the target policy', async () => {
    let currentTime = Date.parse('2026-09-30T12:00:00.000Z');
    const persistence = createInMemoryPersistence({ now: () => currentTime });
    await persistence.initialize();
    const source = await preparePipeline(persistence, 'Example Silver', policy);
    const target = await preparePipeline(persistence, 'Example Gold', {
        allowOverlap: true,
        timeoutSeconds: 120,
    });
    const parent = await submitParent(persistence, source, target);
    const parentClaim = await persistence.claimNextQueuedRun('test-worker', 10_000);
    assert.ok(parentClaim);
    assert.equal(parentClaim.run.runId, parent.runId);
    await persistence.completeRun(parent.runId, parentClaim.lease, completion('SUCCEEDED'));

    let submitAttempts = 0;
    const firstDispatcher = createRunSuccessDependencyDispatcher({
        now: () => currentTime,
        onError: () => undefined,
        persistence,
        submitRun: async () => {
            submitAttempts += 1;
            throw new Error('temporary target deployment failure');
        },
    });
    await firstDispatcher.dispatchAvailable();
    assert.equal(submitAttempts, 1);
    assert.deepEqual(await persistence.listRuns(target.id), []);
    assert.deepEqual(await persistence.listReadyRunSuccessDependencies(), []);

    // The READY row and its retry time are the only state a restarted server needs.
    currentTime += 5_000;
    const restartedDispatcher = createRunSuccessDependencyDispatcher({
        now: () => currentTime,
        onError: () => undefined,
        persistence,
        submitRun: (submission) => persistTargetRun(persistence, target, submission),
    });
    await Promise.all([
        restartedDispatcher.dispatchAvailable(),
        restartedDispatcher.dispatchAvailable(),
    ]);

    const childRuns = await persistence.listRuns(target.id);
    assert.equal(childRuns.length, 1);
    assert.equal(childRuns[0]?.mode, 'incremental');
    assert.equal(childRuns[0]?.allowOverlap, true);
    assert.equal(childRuns[0]?.requestSource, 'pipeline-success-dependency');
    assert.equal(
        childRuns[0]?.idempotencyKey,
        `pipeline-success:${parent.runId}:${target.id}`,
    );
    assert.deepEqual(await persistence.listReadyRunSuccessDependencies(), []);
    await restartedDispatcher.dispatchAvailable();
    assert.equal((await persistence.listRuns(target.id)).length, 1);
});

test('a child persisted before a lost dispatcher response is recovered by idempotency key', async () => {
    const persistence = createInMemoryPersistence();
    await persistence.initialize();
    const source = await preparePipeline(persistence, 'Example Silver', policy);
    const target = await preparePipeline(persistence, 'Example Gold', policy);
    const parent = await submitParent(persistence, source, target);
    const parentClaim = await persistence.claimNextQueuedRun('test-worker', 10_000);
    assert.ok(parentClaim);
    await persistence.completeRun(parent.runId, parentClaim.lease, completion('SUCCEEDED'));

    let submitAttempts = 0;
    const dispatcher = createRunSuccessDependencyDispatcher({
        onError: () => undefined,
        persistence,
        submitRun: async (submission) => {
            submitAttempts += 1;
            const result = await persistTargetRun(persistence, target, submission);
            if (submitAttempts === 1) {
                throw new Error('response lost after child persistence');
            }
            return result;
        },
    });

    await dispatcher.dispatchAvailable();
    await dispatcher.dispatchAvailable();

    assert.equal(submitAttempts, 1);
    assert.equal((await persistence.listRuns(target.id)).length, 1);
    assert.deepEqual(await persistence.listReadyRunSuccessDependencies(), []);
});

test('failed, canceled, unknown, and dry-run parent outcomes never dispatch a child', async () => {
    for (const status of ['FAILED', 'CANCELED', 'TIMED_OUT', 'UNKNOWN'] as const) {
        const persistence = createInMemoryPersistence();
        await persistence.initialize();
        const source = await preparePipeline(persistence, `Example Silver ${status}`, policy);
        const target = await preparePipeline(persistence, `Example Gold ${status}`, policy);
        const parent = await submitParent(persistence, source, target);
        const claim = await persistence.claimNextQueuedRun('test-worker', 10_000);
        assert.ok(claim);
        await persistence.completeRun(parent.runId, claim.lease, completion(status));
        assert.deepEqual(await persistence.listReadyRunSuccessDependencies(), []);
    }

    const canceledPersistence = createInMemoryPersistence();
    await canceledPersistence.initialize();
    const canceledSource = await preparePipeline(canceledPersistence, 'Example Silver canceled queue', policy);
    const canceledTarget = await preparePipeline(canceledPersistence, 'Example Gold canceled queue', policy);
    const queuedParent = await submitParent(canceledPersistence, canceledSource, canceledTarget);
    await canceledPersistence.cancelRun(queuedParent.runId, 'test', 'cancel before execution');
    assert.deepEqual(await canceledPersistence.listReadyRunSuccessDependencies(), []);

    const dryRunPersistence = createInMemoryPersistence();
    await dryRunPersistence.initialize();
    const dryRunSource = await preparePipeline(dryRunPersistence, 'Example Silver dry run', policy);
    const dryRunTarget = await preparePipeline(dryRunPersistence, 'Example Gold dry run', policy);
    const dryRunParent = await submitParent(dryRunPersistence, dryRunSource, dryRunTarget, 'dry-run');
    const dryRunClaim = await dryRunPersistence.claimNextQueuedRun('test-worker', 10_000);
    assert.ok(dryRunClaim);
    await dryRunPersistence.completeRun(dryRunParent.runId, dryRunClaim.lease, completion('SUCCEEDED'));
    assert.deepEqual(await dryRunPersistence.listReadyRunSuccessDependencies(), []);
});

async function preparePipeline(
    persistence: ControlPlanePersistence,
    name: string,
    pipelinePolicy: PipelineRunPolicy,
): Promise<PersistedPipeline> {
    const discovered = discoveredPipeline(name, pipelinePolicy);
    const pipeline = await persistence.ensurePipeline(discovered);
    await persistence.saveDeployment({
        deployedAt: new Date().toISOString(),
        pipelineId: pipeline.id,
        sourceHash: discovered.sourceHash,
        status: 'DEPLOYED',
        validationMessages: [],
        versionId: discovered.versionId,
    });
    return pipeline;
}

async function submitParent(
    persistence: ControlPlanePersistence,
    source: PersistedPipeline,
    target: PersistedPipeline,
    mode: PersistedRunSubmission['mode'] = 'incremental',
) {
    return persistence.submitRun({
        mode,
        pipelineId: source.id,
        policy: source.policy,
        sourceHash: source.currentSourceHash,
        sparkAppName: source.name,
        successorPipelineId: target.id,
        versionId: source.currentVersionId,
    }).then((result) => result.run);
}

async function persistTargetRun(
    persistence: ControlPlanePersistence,
    target: PersistedPipeline,
    submission: RunSubmission,
) {
    return persistence.submitRun({
        callerMetadata: submission.callerMetadata,
        correlationId: submission.correlationId,
        idempotencyKey: submission.idempotencyKey,
        mode: submission.mode ?? 'incremental',
        pipelineId: target.id,
        policy: target.policy,
        requestSource: submission.requestSource,
        sourceHash: target.currentSourceHash,
        sparkAppName: target.name,
        versionId: target.currentVersionId,
    });
}

function discoveredPipeline(
    name: string,
    pipelinePolicy: PipelineRunPolicy,
): DiscoveredPipeline {
    const id = crypto.randomUUID();
    return {
        edges: [],
        name,
        nodes: [],
        policy: pipelinePolicy,
        sourceFiles: [],
        sourceHash: `hash-${id}`,
        spec: {
            libraries: [],
            name,
            specPath: `C:\\test\\${id}\\resources\\${id}.pipeline.yaml`,
            storage: 's3a://warehouse/',
        },
        specPath: `C:\\test\\${id}\\resources\\${id}.pipeline.yaml`,
        validationMessages: [],
        versionId: `v-${id}`,
    };
}

function completion(status: 'CANCELED' | 'FAILED' | 'SUCCEEDED' | 'TIMED_OUT' | 'UNKNOWN') {
    return {
        command: ['spark-pipelines', 'run'],
        endedAt: new Date().toISOString(),
        exitCode: status === 'SUCCEEDED' ? 0 : 1,
        status,
        stderr: '',
        stdout: '',
    } as const;
}
