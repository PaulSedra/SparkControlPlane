/**
 * @fileoverview Unit coverage for in-memory pipeline persistence behavior.
 */

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import { createInMemoryPersistence } from '../../../support/inMemoryPersistence.ts';
import type { PipelineRunPolicy } from '../../../../src/server/types/pipelineRunPolicyTypes.ts';
import type {
    DiscoveredPipeline,
    ControlPlanePersistence,
} from '../../../../src/server/types/pipelinePersistenceTypes.ts';

interface PersistenceFixture {
    persistence: ControlPlanePersistence;
    pipelineId: string;
    policy: PipelineRunPolicy;
}

for (const scenario of [
    {
        keys: ['first-key', 'second-key'],
        name: 'in-memory queue is FIFO and blocks a second run for the same pipeline',
        policy: { allowOverlap: false, timeoutSeconds: 60 },
    },
    {
        keys: ['overlap-first', 'overlap-second'],
        name: 'same-pipeline runs remain serialized when legacy overlap is requested',
        policy: { allowOverlap: true, timeoutSeconds: 60 },
    },
] as const) {
    test(scenario.name, async () => {
        const fixture = await preparedPersistence(scenario.policy);
        const first = await submit(fixture, scenario.keys[0]);
        const second = await submit(fixture, scenario.keys[1]);

        const firstClaim = await fixture.persistence.claimNextQueuedRun('worker', 10_000);
        assert.ok(firstClaim);
        assert.equal(firstClaim.run.runId, first.runId);
        assert.equal(await fixture.persistence.claimNextQueuedRun('worker', 10_000), undefined);

        await fixture.persistence.completeRun(first.runId, firstClaim.lease, completion('SUCCEEDED'));
        const secondClaim = await fixture.persistence.claimNextQueuedRun('worker', 10_000);
        assert.ok(secondClaim);
        assert.equal(secondClaim.run.runId, second.runId);
    });
}

test('independent pipelines can claim concurrently under default policy', async () => {
    const firstFixture = await preparedPersistence({ allowOverlap: false, timeoutSeconds: 60 });
    const secondDiscovered = discoveredPipeline(
        crypto.randomUUID(),
        firstFixture.policy,
        'Second Test Pipeline',
    );
    const secondIdentity = await firstFixture.persistence.ensurePipeline(secondDiscovered);
    await firstFixture.persistence.saveDeployment({
        deployedAt: new Date().toISOString(),
        pipelineId: secondIdentity.id,
        sourceHash: secondDiscovered.sourceHash,
        status: 'DEPLOYED',
        validationMessages: [],
        versionId: secondDiscovered.versionId,
    });
    const secondFixture: PersistenceFixture = {
        ...firstFixture,
        pipelineId: secondIdentity.id,
    };
    const first = await submit(firstFixture, 'independent-first');
    const second = await submit(secondFixture, 'independent-second');
    const claims = [
        await firstFixture.persistence.claimNextQueuedRun('worker', 10_000),
        await firstFixture.persistence.claimNextQueuedRun('worker', 10_000),
    ];
    assert.ok(claims[0]);
    assert.ok(claims[1]);
    assert.deepEqual(
        claims.map((claim) => claim.run.runId).sort(),
        [first.runId, second.runId].sort(),
    );
});

test('queue accepts a burst without automatic retries or duplicate claims', async () => {
    const fixture = await preparedPersistence({ allowOverlap: false, timeoutSeconds: 60 });
    const submitted = await Promise.all(
        Array.from({ length: 32 }, (_, index) => submit(fixture, `burst-${index}`)),
    );
    const claimed: string[] = [];
    for (const expected of submitted) {
        const claim = await fixture.persistence.claimNextQueuedRun('worker', 10_000);
        assert.ok(claim);
        claimed.push(claim.run.runId);
        assert.equal(claim.run.runId, expected.runId);
        await fixture.persistence.completeRun(claim.run.runId, claim.lease, completion('SUCCEEDED'));
    }
    assert.equal(new Set(claimed).size, 32);
    assert.equal(await fixture.persistence.claimNextQueuedRun('worker', 10_000), undefined);
    for (const runId of claimed) {
        const events = await fixture.persistence.listRunEvents(runId);
        assert.equal(events.filter((event) => event.eventType === 'RUN_CLAIMED').length, 1);
    }
});

test('queued and active cancellation remain terminal and observable', async () => {
    const fixture = await preparedPersistence({ allowOverlap: false, timeoutSeconds: 60 });
    const queued = await submit(fixture, 'queued-cancel');
    const canceledQueued = await fixture.persistence.cancelRun(
        queued.runId,
        'unit-test',
        'queued cancellation',
        { correlationId: 'corr-queued', requestSource: 'unit-test' },
    );
    assert.equal(canceledQueued.status, 'CANCELED');
    assert.equal(await fixture.persistence.claimNextQueuedRun('worker', 10_000), undefined);

    const active = await submit(fixture, 'active-cancel');
    const claim = await fixture.persistence.claimNextQueuedRun('worker', 10_000);
    assert.ok(claim);
    assert.equal(claim.run.runId, active.runId);
    const requested = await fixture.persistence.cancelRun(
        active.runId,
        'unit-test',
        'active cancellation',
        { correlationId: 'corr-active', requestSource: 'unit-test' },
    );
    assert.equal(requested.status, 'SUBMITTING');
    assert.equal(await fixture.persistence.isCancellationRequested(active.runId), true);

    const completed = await fixture.persistence.completeRun(active.runId, claim.lease, completion('SUCCEEDED'));
    assert.equal(completed.run?.status, 'CANCELED');
    assert.equal(await fixture.persistence.isCancellationRequested(active.runId), false);
    assert.equal((await fixture.persistence.listRunEvents(active.runId)).at(-1)?.eventType, 'CANCELED');
});

test('expired leases fence stale writes and recover the same local CLI execution', async () => {
    let currentTime = Date.now();
    const fixture = await preparedPersistence(
        { allowOverlap: false, timeoutSeconds: 60 },
        () => currentTime,
    );
    const submitted = await submit(fixture, 'expired-lease');
    const claim = await fixture.persistence.claimNextQueuedRun('old-worker', 1_000);
    assert.ok(claim);
    const executionId = `local-cli-${submitted.runId}`;
    const localExecution = {
        command: ['spark-pipelines', 'run'],
        executionId,
        nodeStatuses: {},
        processId: 4242,
        runDirectory: `/app/run-state/runs/${submitted.runId}`,
        runStatus: 'RUNNING' as const,
        startedAt: new Date(currentTime).toISOString(),
        state: 'RUNNING' as const,
        stderrOffset: 0,
        stderr: '',
        stdoutOffset: 24,
        stdout: 'local CLI still running',
    };
    assert.equal(
        (await fixture.persistence.updateLocalCliExecution(submitted.runId, claim.lease, localExecution)).kind,
        'APPLIED',
    );

    currentTime += 1_001;
    assert.equal(
        (await fixture.persistence.renewLease(submitted.runId, claim.lease, 1_000)).kind,
        'FENCED',
    );
    assert.equal(
        (await fixture.persistence.appendLiveRun(
            submitted.runId,
            claim.lease,
            'RUNNING',
            'stale output',
            {},
        )).kind,
        'FENCED',
    );
    assert.equal(
        (await fixture.persistence.completeRun(
            submitted.runId,
            claim.lease,
            completion('SUCCEEDED'),
        )).kind,
        'FENCED',
    );
    assert.equal(
        (await fixture.persistence.failRunBeforeExecution(
            submitted.runId,
            claim.lease,
            'stale preparation failure',
        )).kind,
        'FENCED',
    );
    assert.equal(
        (await fixture.persistence.releaseLease(submitted.runId, claim.lease)).kind,
        'FENCED',
    );

    await fixture.persistence.reconcileExpiredLeases();
    const stillActive = await fixture.persistence.getRun(submitted.runId);
    assert.equal(stillActive?.status, 'RUNNING');
    assert.equal(stillActive?.cliExecutionId, executionId);
    assert.equal(stillActive?.cliState, 'RUNNING');

    const recovered = await fixture.persistence.claimNextRecoverableRun('new-worker', 1_000);
    assert.equal(recovered?.run.runId, submitted.runId);
    assert.equal(recovered?.run.status, 'RUNNING');
    assert.equal(recovered?.run.cliExecutionId, executionId);
    assert.equal(recovered?.run.cliProcessId, 4242);
    await fixture.persistence.reconcileExpiredLeases();
    const events = await fixture.persistence.listRunEvents(submitted.runId);
    assert.equal(events.filter((event) => event.eventType === 'ABANDONED').length, 0);
    assert.equal(events.filter((event) => event.eventType === 'LOCAL_CLI_RECOVERY_CLAIMED').length, 1);

    assert.equal(
        (await fixture.persistence.updateLocalCliExecution(
            submitted.runId,
            claim.lease,
            { ...localExecution, stdoutOffset: 25, stdout: 'stale output' },
        )).kind,
        'FENCED',
    );
    const completed = await fixture.persistence.completeRun(
        submitted.runId,
        recovered!.lease,
        completion('SUCCEEDED'),
    );
    assert.equal(completed.kind, 'APPLIED');
    assert.equal(completed.run?.status, 'SUCCEEDED');

    const queuedAfterRecovery = await submit(fixture, 'after-recovery');
    const newClaim = await fixture.persistence.claimNextQueuedRun('new-worker', 1_000);
    assert.equal(newClaim?.run.runId, queuedAfterRecovery.runId);
});

test('terminal completion is first-writer-wins and idempotent', async () => {
    const fixture = await preparedPersistence({ allowOverlap: false, timeoutSeconds: 60 });
    const submitted = await submit(fixture, 'terminal-once');
    const claim = await fixture.persistence.claimNextQueuedRun('worker', 10_000);
    assert.ok(claim);
    const first = await fixture.persistence.completeRun(
        submitted.runId,
        claim.lease,
        completion('SUCCEEDED'),
    );
    const second = await fixture.persistence.completeRun(
        submitted.runId,
        claim.lease,
        completion('FAILED'),
    );
    assert.equal(first.kind, 'APPLIED');
    assert.equal(second.kind, 'ALREADY_TERMINAL');
    assert.equal((await fixture.persistence.getRun(submitted.runId))?.status, 'SUCCEEDED');
    const events = await fixture.persistence.listRunEvents(submitted.runId);
    assert.equal(events.filter((event) => event.eventType === 'SUCCEEDED').length, 1);
});

test('unknown local CLI outcomes remain terminal and observable exactly once', async () => {
    const fixture = await preparedPersistence({ allowOverlap: false, timeoutSeconds: 60 });
    const submitted = await submit(fixture, 'operation-lost');
    const claim = await fixture.persistence.claimNextQueuedRun('worker', 10_000);
    assert.ok(claim);

    const completionResult = await fixture.persistence.completeRun(
        submitted.runId,
        claim.lease,
        {
            command: ['spark-pipelines', 'run'],
            endedAt: new Date().toISOString(),
            cliState: 'UNKNOWN',
            recoveryReason: 'LOCAL_CLI_STATE_UNAVAILABLE',
            stderr: 'Could not recover the local CLI state.',
            stdout: 'last observed local CLI output',
            status: 'UNKNOWN',
            terminalReason: 'LOCAL_CLI_STATE_UNAVAILABLE',
        },
    );
    assert.equal(completionResult.run?.status, 'UNKNOWN');
    assert.equal(completionResult.run?.cliState, 'UNKNOWN');
    assert.equal(completionResult.run?.exitCode, undefined);
    assert.equal(completionResult.run?.recoveryReason, 'LOCAL_CLI_STATE_UNAVAILABLE');

    const repeated = await fixture.persistence.completeRun(
        submitted.runId,
        claim.lease,
        completion('SUCCEEDED'),
    );
    assert.equal(repeated.kind, 'ALREADY_TERMINAL');
    const events = await fixture.persistence.listRunEvents(submitted.runId);
    assert.equal(events.filter((event) => event.eventType === 'UNKNOWN').length, 1);
    assert.equal(events.filter((event) => event.eventType === 'ABANDONED').length, 0);
});

async function preparedPersistence(
    policy: PipelineRunPolicy,
    now?: () => number,
): Promise<PersistenceFixture> {
    const persistence = createInMemoryPersistence(now == null ? {} : { now });
    await persistence.initialize();
    const discovered = discoveredPipeline(crypto.randomUUID(), policy);
    const identity = await persistence.ensurePipeline(discovered);
    await persistence.saveDeployment({
        deployedAt: new Date().toISOString(),
        pipelineId: identity.id,
        sourceHash: discovered.sourceHash,
        status: 'DEPLOYED',
        validationMessages: [],
        versionId: discovered.versionId,
    });
    return { persistence, pipelineId: identity.id, policy };
}

async function submit(fixture: PersistenceFixture, idempotencyKey: string) {
    const result = await fixture.persistence.submitRun({
        idempotencyKey,
        mode: 'incremental',
        pipelineId: fixture.pipelineId,
        policy: fixture.policy,
        sourceHash: 'source-hash',
        sparkAppName: 'Test Pipeline',
        versionId: 'version-1',
    });
    return result.run;
}

function discoveredPipeline(
    pipelineId: string,
    policy: PipelineRunPolicy,
    name = 'Test Pipeline',
): DiscoveredPipeline {
    return {
        edges: [],
        name,
        nodes: [],
        policy,
        sourceFiles: [],
        sourceHash: 'source-hash',
        spec: {
            libraries: [],
            name,
            specPath: `C:\\test\\${pipelineId}\\resources\\${pipelineId}.pipeline.yaml`,
            storage: 'file:///tmp/test-pipeline',
        },
        specPath: `C:\\test\\${pipelineId}\\resources\\${pipelineId}.pipeline.yaml`,
        validationMessages: [],
        versionId: 'version-1',
    };
}

function completion(status: 'FAILED' | 'SUCCEEDED') {
    return {
        command: ['python', '-m', 'pyspark.pipelines.cli'],
        endedAt: new Date().toISOString(),
        exitCode: status === 'SUCCEEDED' ? 0 : 1,
        status,
        stderr: '',
        stdout: '',
    } as const;
}
