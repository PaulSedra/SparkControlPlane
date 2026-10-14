/**
 * @fileoverview Integration coverage for queued run admission and execution.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pollUntil } from '../support/httpTestSupport.ts';
import { createInMemoryPersistence } from '../support/inMemoryPersistence.ts';
import { createPipelineFixture } from '../support/pipelineFixture.ts';
import { captureEnvironment } from '../support/testEnvironment.ts';
import { createPipelineRegistryService } from '../../src/server/pipeline/pipelineRegistryService.ts';
import type { LocalCliRunExecutor } from '../../src/server/pipeline/execution/runExecution.ts';
import type {
    LocalCliCommandResult,
    LocalCliRunSnapshot,
} from '../../src/server/pipeline/spark/sparkCliProcess.ts';
import type { ControlPlanePersistence } from '../../src/server/types/pipelinePersistenceTypes.ts';
import type { RunSubmission } from '../../src/server/types/pipelineServiceTypes.ts';

type RunRequest = Pick<RunSubmission, 'correlationId' | 'idempotencyKey' | 'requestSource'> & {
    mode?: RunSubmission['mode'];
};

test('coordinator runs the recovery sweeper continuously and stops it on shutdown', async () => {
    const restore = captureEnvironment('PIPELINE_RUN_LEASE_SECONDS', 'PIPELINE_RUN_RECOVERY_INTERVAL_SECONDS');
    process.env.PIPELINE_RUN_LEASE_SECONDS = '1';
    process.env.PIPELINE_RUN_RECOVERY_INTERVAL_SECONDS = '1';
    const persistence = createInMemoryPersistence();
    let recoveryCalls = 0;
    const reconcileExpiredLeases = persistence.reconcileExpiredLeases.bind(persistence);
    persistence.reconcileExpiredLeases = async (batchSize?: number) => {
        recoveryCalls += 1;
        await reconcileExpiredLeases(batchSize);
    };
    const service = createRunControlService(persistence);
    try {
        await service.initialize();
        await new Promise((resolve) => setTimeout(resolve, 1_100));
        assert.ok(recoveryCalls >= 2);
        await service.shutdown(0);
        const callsAtShutdown = recoveryCalls;
        await new Promise((resolve) => setTimeout(resolve, 1_100));
        assert.equal(recoveryCalls, callsAtShutdown);
    } finally {
        await service.shutdown(0);
        restore();
    }
});

test('active local CLI cancellation and timeout reach terminal states without retry', async () => {
    const originalCwd = process.cwd();
    const restore = captureEnvironment(
        'PIPELINES_DIR',
        'SPARK_CLI_STATE_DIRECTORY',
    );
    const fixture = await createPipelineFixture({
        files: [{
            content: 'CREATE MATERIALIZED VIEW example AS SELECT 1 AS value;\n',
            relativePath: 'sql/example.sql',
        }],
        name: 'Run Control Test',
        pipelinePath: 'acceptance',
        prefix: 'spark-control-plane-run-control-',
        specExtras: ['timeout_seconds: 1'],
        specFilename: 'run-control.pipeline.yaml',
    });
    process.chdir(fixture.root);
    process.env.PIPELINES_DIR = path.join(fixture.root, 'pipelines');
    process.env.SPARK_CLI_STATE_DIRECTORY = path.join(fixture.root, 'run-state');

    let invocation = 0;
    const executor: LocalCliRunExecutor = async (
        run,
        _parsed,
        _executionMode,
        _sparkConnectUrl,
        shouldCancel,
        onSnapshot,
        onLocalProcess,
    ) => {
        invocation += 1;
        const command = ['spark-pipelines', 'run'];
        const snapshot = localSnapshotForRun(run, 'RUNNING', 32);
        let detached = false;
        const controller = {
            detach: () => {
                detached = true;
            },
            requestStop: () => undefined,
        };
        onLocalProcess(controller, command);
        await onSnapshot(snapshot, { stderr: '', stdout: 'local CLI is running' });

        if (invocation === 1) {
            while (!(await shouldCancel())) {
                if (detached) {
                    return detachedLocalCliResult(command);
                }
                await delay(20);
            }
            return {
                canceled: true,
                command,
                detached: false,
                exitCode: 130,
                cliState: 'CANCELED',
                stderr: '',
                stdout: 'local CLI cancellation acknowledged',
                timedOut: false,
            };
        }

        await delay(50);
        return {
            canceled: false,
            command,
            detached,
            exitCode: 130,
            cliState: 'TIMED_OUT',
            stderr: 'Run exceeded its configured timeout.',
            stdout: 'local CLI timed out',
            timedOut: true,
        };
    };
    const service = createRunControlService(createInMemoryPersistence(), executor);
    try {
        await service.initialize();
        await service.refreshPipelinesFromSource();
        const pipelines = await service.listPipelines();
        assert.equal(pipelines.length, 1);
        const pipelineId = pipelines[0]?.id;
        assert.ok(pipelineId);
        assert.equal((await service.getPipeline(pipelineId)).spec.timeoutSeconds, 1);
        await service.deployPipeline(pipelineId, {
            correlationId: 'run-control-deploy',
            requestSource: 'run-control-test',
        });
        const submitted = await submitRun(service, pipelineId, {
            correlationId: 'run-control-submit',
            idempotencyKey: 'run-control-active-cancel',
            requestSource: 'run-control-test',
        });
        await waitForRunPredicate(
            service,
            submitted.run.runId,
            (run) => run.status === 'RUNNING' && run.cliExecutionId != null,
        );
        await service.cancelRun(
            submitted.run.runId,
            'run-control-test',
            'active CLI cancellation',
            { correlationId: 'run-control-cancel', requestSource: 'run-control-test' },
        );
        const canceled = await waitForStatus(service, submitted.run.runId, ['CANCELED']);
        assert.equal(canceled.cliState, 'CANCELED');
        const cancelEvents = await service.listRunEventsPage(submitted.run.runId, 100, 0);
        assert.equal(cancelEvents.items.filter((event) => event.eventType === 'RUN_CLAIMED').length, 1);
        assert.ok(cancelEvents.items.some((event) => event.eventType === 'CANCELLATION_REQUESTED'));
        assert.ok(cancelEvents.items.some((event) => event.eventType === 'CANCELED'));
        assert.ok(cancelEvents.items.every((event) => event.correlationId != null));

        const timedSubmission = await submitRun(service, pipelineId, {
            correlationId: 'run-control-timeout',
            idempotencyKey: 'run-control-timeout',
            requestSource: 'run-control-test',
        });
        assert.equal(timedSubmission.run.timeoutSeconds, 1);
        const timedOut = await waitForStatus(service, timedSubmission.run.runId, ['TIMED_OUT']);
        assert.equal(timedOut.cliState, 'TIMED_OUT');
        assert.equal(invocation, 2);
        const timeoutEvents = await service.listRunEventsPage(timedSubmission.run.runId, 100, 0);
        assert.equal(timeoutEvents.items.filter((event) => event.eventType === 'RUN_CLAIMED').length, 1);
        assert.ok(timeoutEvents.items.some((event) => event.eventType === 'TIMED_OUT'));
    } finally {
        await service.shutdown(2_000);
        process.chdir(originalCwd);
        restore();
        await fixture.cleanup();
    }
});

test('runs launch concurrently and shutdown waits for active CLI execution', async () => {
    const originalCwd = process.cwd();
    const restore = captureEnvironment(
        'PIPELINES_DIR',
        'PIPELINE_RUN_CONCURRENCY',
        'SPARK_CLI_STATE_DIRECTORY',
    );
    const temporaryRoot = await fs.mkdtemp(
        path.join(os.tmpdir(), 'spark-control-plane-load-pressure-'),
    );
    const pipelineCount = 3;
    await Promise.all(Array.from({ length: pipelineCount }, (_, index) =>
        createPipelineFixture({
            files: [{
                content: 'CREATE MATERIALIZED VIEW pressure_example_' + (index + 1) + ' AS SELECT 1 AS value;\n',
                relativePath: 'sql/example.sql',
            }],
            name: 'Run Control Pressure Test ' + (index + 1),
            pipelinePath: 'pressure-' + (index + 1),
            prefix: 'spark-control-plane-load-pressure-',
            root: temporaryRoot,
            specFilename: 'run-control-pressure-' + (index + 1) + '.pipeline.yaml',
            storage: path.join(temporaryRoot, 'checkpoints-' + (index + 1)).replace(/\\/g, '/'),
        })));

    process.chdir(temporaryRoot);
    process.env.PIPELINES_DIR = path.join(temporaryRoot, 'pipelines');
    process.env.PIPELINE_RUN_CONCURRENCY = '2';
    process.env.SPARK_CLI_STATE_DIRECTORY = path.join(temporaryRoot, 'run-state');
    let activeExecutions = 0;
    let peakExecutions = 0;
    let submissionCount = 0;
    const executor: LocalCliRunExecutor = async (
        run,
        _parsed,
        executionMode,
        _sparkConnectUrl,
        _shouldCancel,
        onSnapshot,
        onLocalProcess,
    ) => {
        assert.equal(executionMode, 'submit');
        submissionCount += 1;
        activeExecutions += 1;
        peakExecutions = Math.max(peakExecutions, activeExecutions);
        const command = ['spark-pipelines', 'run'];
        const snapshot = localSnapshotForRun(run, 'RUNNING', 32);
        let detached = false;
        let resolveDetached!: (result: LocalCliCommandResult) => void;
        const detachedResult = new Promise<LocalCliCommandResult>((resolve) => {
            resolveDetached = resolve;
        });
        onLocalProcess({
            detach: () => {
                detached = true;
                resolveDetached(detachedLocalCliResult(command));
            },
            requestStop: () => undefined,
        }, command);
        await onSnapshot(snapshot, { stderr: '', stdout: 'local CLI is running' });

        const completedResult = new Promise<LocalCliCommandResult>((resolve) => {
            setTimeout(() => {
                activeExecutions -= 1;
                if (detached) {
                    return;
                }
                const finalOutput = 'local CLI completed';
                void onSnapshot(
                    localSnapshotForRun(run, 'COMPLETED', snapshot.stdoutOffset + finalOutput.length),
                    { stderr: '', stdout: finalOutput },
                ).then(() => resolve({
                    canceled: false,
                    command,
                    detached: false,
                    exitCode: 0,
                    cliState: 'COMPLETED',
                    stderr: '',
                    stdout: finalOutput,
                    timedOut: false,
                }));
            }, 300);
        });
        return await Promise.race([completedResult, detachedResult]);
    };
    const service = createRunControlService(createInMemoryPersistence(), executor);
    try {
        await service.initialize();
        await service.refreshPipelinesFromSource();
        const pipelines = await service.listPipelines();
        assert.equal(pipelines.length, pipelineCount);
        await Promise.all(pipelines.map((pipeline, index) => service.deployPipeline(pipeline.id, {
            correlationId: 'load-pressure-deploy-' + index,
            requestSource: 'load-pressure-test',
        })));
        const submittedRuns = await Promise.all(pipelines.map((pipeline, index) =>
            submitRun(service, pipeline.id, {
                correlationId: 'load-pressure-' + index,
                idempotencyKey: 'load-pressure-' + index,
                requestSource: 'load-pressure-test',
            })));
        assert.ok(submittedRuns.every((submission) => submission.run.timeoutSeconds == null));
        const runs = await Promise.all(submittedRuns.map((submission) =>
            waitForStatus(service, submission.run.runId, ['SUCCEEDED']),
        ));
        assert.equal(runs.length, pipelineCount);
        assert.equal(peakExecutions, 2);
        assert.equal(submissionCount, pipelineCount);

        const shutdownSubmission = await submitRun(service, pipelines[0]!.id, {
            correlationId: 'load-pressure-shutdown',
            idempotencyKey: 'load-pressure-shutdown',
            requestSource: 'load-pressure-test',
        });
        await waitForRunPredicate(
            service,
            shutdownSubmission.run.runId,
            (run) => run.status === 'RUNNING' && run.cliExecutionId != null,
        );
        await service.shutdown(2_000);
        const completedRun = await service.getRun(shutdownSubmission.run.runId);
        assert.equal(completedRun.status, 'SUCCEEDED');
        assert.equal(completedRun.cliState, 'COMPLETED');
        assert.ok(completedRun.cliExecutionId);
        assert.ok(completedRun.endedAt);
        assert.equal(completedRun.exitCode, 0);
        assert.equal(activeExecutions, 0);
        assert.equal(submissionCount, pipelineCount + 1);
        assert.equal(service.isAcceptingWork(), false);

        for (const run of runs) {
            const eventsPage = await service.listRunEventsPage(run.runId, 100, 0);
            assert.equal(eventsPage.items.filter((event) => event.eventType === 'RUN_CLAIMED').length, 1);
        }
        const shutdownEvents = await service.listRunEventsPage(completedRun.runId, 100, 0);
        assert.equal(shutdownEvents.items.filter((event) => event.eventType === 'RUN_CLAIMED').length, 1);
        assert.equal(shutdownEvents.items.some((event) => event.eventType === 'CANCELED'), false);
    } finally {
        await service.shutdown(2_000);
        process.chdir(originalCwd);
        restore();
        await fs.rm(temporaryRoot, { force: true, recursive: true });
    }
});
test('worker and persistence failures stop heartbeats and recover the saved CLI execution', async () => {
    const originalCwd = process.cwd();
    const restore = captureEnvironment(
        'PIPELINES_DIR',
        'PIPELINE_RUN_LEASE_SECONDS',
        'PIPELINE_RUN_RECOVERY_INTERVAL_SECONDS',
        'SPARK_CLI_STATE_DIRECTORY',
    );
    const fixture = await createPipelineFixture({
        files: [{
            content: 'CREATE MATERIALIZED VIEW recovery_example AS SELECT 1 AS value;\n',
            relativePath: 'sql/example.sql',
        }],
        name: 'Run Control Worker Failure Test',
        pipelinePath: 'worker-failure',
        prefix: 'spark-control-plane-worker-failure-',
        specFilename: 'worker-failure.pipeline.yaml',
    });
    process.chdir(fixture.root);
    process.env.PIPELINES_DIR = path.join(fixture.root, 'pipelines');
    process.env.PIPELINE_RUN_LEASE_SECONDS = '3';
    process.env.PIPELINE_RUN_RECOVERY_INTERVAL_SECONDS = '1';
    process.env.SPARK_CLI_STATE_DIRECTORY = path.join(fixture.root, 'run-state');

    const persistence = createInMemoryPersistence();
    const renewLease = persistence.renewLease.bind(persistence);
    const updateLocalCliExecution = persistence.updateLocalCliExecution.bind(persistence);
    let renewCalls = 0;
    let persistenceFailureObserved = false;
    persistence.renewLease = async (...args) => {
        renewCalls += 1;
        return renewLease(...args);
    };
    persistence.updateLocalCliExecution = async (...args) => {
        const result = await updateLocalCliExecution(...args);
        if (args[2].state === 'RUNNING' && !persistenceFailureObserved) {
            persistenceFailureObserved = true;
            throw new Error('simulated output persistence failure after commit');
        }
        return result;
    };
    const calls: string[] = [];
    let detachCalls = 0;
    const executor: LocalCliRunExecutor = async (
        run,
        parsed,
        executionMode,
        _sparkConnectUrl,
        _shouldCancel,
        onSnapshot,
        onLocalProcess,
    ) => {
        calls.push(executionMode);
        const command = ['spark-pipelines', 'run'];
        const executionId = run.cliExecutionId ?? `local-cli-${run.runId}`;
        const runDirectory = run.cliRunDirectory ?? path.join(
            process.env.SPARK_CLI_STATE_DIRECTORY!,
            'runs',
            run.runId,
        );
        onLocalProcess({
            detach: () => { detachCalls += 1; },
            requestStop: () => undefined,
        }, command);

        if (executionMode === 'submit') {
            assert.ok(parsed);
            const stdout = '2026-09-27 10:00:00: Flow recovery_view is RUNNING.\n';
            await assert.rejects(onSnapshot({
                command,
                executionId,
                processId: 4242,
                runDirectory,
                startedAt: new Date().toISOString(),
                state: 'RUNNING',
                stderrOffset: 0,
                stdoutOffset: Buffer.byteLength(stdout),
            }, { stderr: '', stdout }), /simulated output persistence failure/);
            throw new Error('simulated worker crash after CLI identity persistence');
        }

        assert.equal(run.cliExecutionId, executionId);
        const stdout = [
            '2026-09-27 10:00:00: Flow recovery_view is RUNNING.',
            '2026-09-27 10:00:01: Flow recovery_view has COMPLETED.',
            '',
        ].join('\n');
        const stderr = 'recovered stderr tail\n';
        const finalSnapshot: LocalCliRunSnapshot = {
            command,
            executionId,
            processId: 4242,
            runDirectory,
            startedAt: run.cliStartedAt ?? new Date().toISOString(),
            state: 'COMPLETED',
            stderrOffset: Buffer.byteLength(stderr),
            stdoutOffset: Buffer.byteLength(stdout),
        };
        await onSnapshot(finalSnapshot, { stderr, stdout });
        return {
            canceled: false,
            command,
            detached: false,
            exitCode: 0,
            cliState: 'COMPLETED',
            stderr,
            stdout,
            timedOut: false,
        };
    };
    const service = createRunControlService(persistence, executor);
    try {
        await service.initialize();
        await service.refreshPipelinesFromSource();
        const pipelineId = (await service.listPipelines())[0]?.id;
        assert.ok(pipelineId);
        await service.deployPipeline(pipelineId, {
            correlationId: 'worker-failure-deploy',
            requestSource: 'worker-failure-test',
        });
        const submitted = await submitRun(service, pipelineId, {
            correlationId: 'worker-failure-submit',
            idempotencyKey: 'worker-failure-submit',
            requestSource: 'worker-failure-test',
        });
        const recovered = await waitForStatus(service, submitted.run.runId, ['SUCCEEDED']);
        assert.deepEqual(calls, ['submit', 'monitor']);
        assert.equal(persistenceFailureObserved, true);
        assert.equal(renewCalls, 0);
        assert.equal(detachCalls, 1);
        assert.match(recovered.stderr, /recovered stderr tail/);
        assert.match(recovered.stdout, /Flow recovery_view has COMPLETED/);
        assert.equal(recovered.nodeStatuses?.recovery_view?.status, 'COMPLETED');
        const events = await service.listRunEventsPage(submitted.run.runId, 100, 0);
        assert.equal(
            events.items.filter((event) => event.eventType === 'LOCAL_CLI_RECOVERY_CLAIMED').length,
            1,
        );
    } finally {
        await service.shutdown(2_000);
        process.chdir(originalCwd);
        restore();
        await fixture.cleanup();
    }
});

test('replacement server monitors the same local CLI execution without resubmitting', async () => {
    const originalCwd = process.cwd();
    const restore = captureEnvironment(
        'PIPELINES_DIR',
        'PIPELINE_RUN_LEASE_SECONDS',
        'SPARK_CLI_STATE_DIRECTORY',
    );
    const fixture = await createPipelineFixture({
        files: [{
            content: 'CREATE MATERIALIZED VIEW cli_recovery_example AS SELECT 1 AS value;\n',
            relativePath: 'sql/example.sql',
        }],
        name: 'Run Control Local CLI Recovery Test',
        pipelinePath: 'local-cli-recovery',
        prefix: 'spark-control-plane-local-cli-recovery-',
        specFilename: 'local-cli-recovery.pipeline.yaml',
    });
    const temporaryRoot = fixture.root;
    process.chdir(temporaryRoot);
    process.env.PIPELINES_DIR = path.join(temporaryRoot, 'pipelines');
    process.env.PIPELINE_RUN_LEASE_SECONDS = '1';
    process.env.SPARK_CLI_STATE_DIRECTORY = path.join(temporaryRoot, 'run-state');

    const persistence = createInMemoryPersistence();
    const supervisor = createLocalCliTestExecutor('COMPLETED');
    const firstService = createRunControlService(persistence, supervisor.executor);
    let secondService: ReturnType<typeof createPipelineRegistryService> | undefined;
    try {
        await firstService.initialize();
        await firstService.refreshPipelinesFromSource();
        const pipelineId = (await firstService.listPipelines())[0]?.id;
        assert.ok(pipelineId);
        await firstService.deployPipeline(pipelineId, {
            correlationId: 'local-cli-recovery-deploy',
            requestSource: 'local-cli-recovery-test',
        });
        const submitted = await submitRun(firstService, pipelineId, {
            correlationId: 'local-cli-recovery-submit',
            idempotencyKey: 'local-cli-recovery-submit',
            requestSource: 'local-cli-recovery-test',
        });
        const running = await waitForRunPredicate(
            firstService,
            submitted.run.runId,
            (run) => run.status === 'RUNNING' && run.cliExecutionId != null,
        );
        const cliExecutionId = running.cliExecutionId;
        const cliRunDirectory = running.cliRunDirectory;
        assert.ok(cliExecutionId);
        assert.ok(cliRunDirectory);
        assert.equal(running.cliState, 'RUNNING');

        await firstService.shutdown(2_000);
        const detached = await firstService.getRun(submitted.run.runId);
        assert.equal(detached.status, 'RUNNING');
        assert.equal(detached.cliExecutionId, cliExecutionId);
        assert.equal(detached.cliState, 'RUNNING');
        assert.equal(detached.endedAt, undefined);

        secondService = createRunControlService(persistence, supervisor.executor);
        await secondService.initialize();
        const completed = await waitForStatus(secondService, submitted.run.runId, ['SUCCEEDED']);
        assert.equal(completed.cliState, 'COMPLETED');
        assert.equal(completed.cliExecutionId, cliExecutionId);
        assert.equal(completed.cliRunDirectory, cliRunDirectory);
        assert.deepEqual(supervisor.calls, { monitor: 1, submit: 1 });
        const events = await secondService.listRunEventsPage(submitted.run.runId, 100, 0);
        assert.equal(
            events.items.filter((event) => event.eventType === 'LOCAL_CLI_RECOVERY_CLAIMED').length,
            1,
        );
        assert.equal(events.items.filter((event) => event.eventType === 'CANCELED').length, 0);
    } finally {
        await secondService?.shutdown(2_000);
        await firstService.shutdown(2_000);
        process.chdir(originalCwd);
        restore();
        await fixture.cleanup();
    }
});

test('replacement server records UNKNOWN when the local CLI supervisor is gone', async () => {
    const originalCwd = process.cwd();
    const restore = captureEnvironment(
        'PIPELINES_DIR',
        'PIPELINE_RUN_LEASE_SECONDS',
        'SPARK_CLI_STATE_DIRECTORY',
    );
    const fixture = await createPipelineFixture({
        files: [{
            content: 'CREATE MATERIALIZED VIEW lost_cli_example AS SELECT 1 AS value;\n',
            relativePath: 'sql/example.sql',
        }],
        name: 'Run Control Lost CLI Test',
        pipelinePath: 'lost-cli',
        prefix: 'spark-control-plane-lost-cli-',
        specFilename: 'lost-cli.pipeline.yaml',
    });
    const temporaryRoot = fixture.root;
    process.chdir(temporaryRoot);
    process.env.PIPELINES_DIR = path.join(temporaryRoot, 'pipelines');
    process.env.PIPELINE_RUN_LEASE_SECONDS = '1';
    process.env.SPARK_CLI_STATE_DIRECTORY = path.join(temporaryRoot, 'run-state');

    const persistence = createInMemoryPersistence();
    const supervisor = createLocalCliTestExecutor('UNKNOWN');
    const firstService = createRunControlService(persistence, supervisor.executor);
    let secondService: ReturnType<typeof createPipelineRegistryService> | undefined;
    try {
        await firstService.initialize();
        await firstService.refreshPipelinesFromSource();
        const pipelineId = (await firstService.listPipelines())[0]?.id;
        assert.ok(pipelineId);
        await firstService.deployPipeline(pipelineId, {
            correlationId: 'lost-cli-deploy',
            requestSource: 'lost-cli-test',
        });
        const submitted = await submitRun(firstService, pipelineId, {
            correlationId: 'lost-cli-submit',
            idempotencyKey: 'lost-cli-submit',
            requestSource: 'lost-cli-test',
        });
        const running = await waitForRunPredicate(
            firstService,
            submitted.run.runId,
            (run) => run.status === 'RUNNING' && run.cliExecutionId != null,
        );
        assert.ok(running.cliExecutionId);
        await firstService.shutdown(2_000);

        secondService = createRunControlService(persistence, supervisor.executor);
        await secondService.initialize();
        const unknown = await waitForStatus(secondService, submitted.run.runId, ['UNKNOWN']);
        assert.equal(unknown.cliState, 'UNKNOWN');
        assert.equal(unknown.exitCode, undefined);
        assert.equal(unknown.recoveryReason, 'LOCAL_CLI_STATE_UNAVAILABLE');
        assert.match(unknown.stderr, /could not recover the local CLI state/i);
        assert.deepEqual(supervisor.calls, { monitor: 1, submit: 1 });
        const events = await secondService.listRunEventsPage(submitted.run.runId, 100, 0);
        assert.equal(events.items.filter((event) => event.eventType === 'UNKNOWN').length, 1);
        assert.equal(events.items.filter((event) => event.eventType === 'ABANDONED').length, 0);
        assert.equal(events.items.filter((event) => event.eventType === 'CANCELED').length, 0);
    } finally {
        await secondService?.shutdown(2_000);
        await firstService.shutdown(2_000);
        process.chdir(originalCwd);
        restore();
        await fixture.cleanup();
    }
});

function createLocalCliTestExecutor(outcome: 'COMPLETED' | 'UNKNOWN'): {
    calls: { monitor: number; submit: number };
    executor: LocalCliRunExecutor;
} {
    const calls = { monitor: 0, submit: 0 };
    const executor: LocalCliRunExecutor = async (
        run,
        parsed,
        executionMode,
        sparkConnectUrl,
        _shouldCancel,
        onSnapshot,
        onLocalProcess,
    ) => {
        assert.equal(sparkConnectUrl, 'sc://test-spark-connect:15002');
        const command = ['spark-pipelines', 'run'];
        const identity: LocalCliRunSnapshot = {
            command,
            executionId: run.cliExecutionId ?? `local-cli-${run.runId}`,
            processId: 4242,
            runDirectory: run.cliRunDirectory ?? `/app/run-state/runs/${run.runId}`,
            startedAt: run.cliStartedAt ?? new Date().toISOString(),
            state: 'RUNNING',
            stderrOffset: run.cliStderrOffset ?? 0,
            stdoutOffset: run.cliStdoutOffset ?? 0,
        };
        let resolveDetached!: (result: LocalCliCommandResult) => void;
        const detachedResult = new Promise<LocalCliCommandResult>((resolve) => {
            resolveDetached = resolve;
        });
        const controller = {
            detach: () => resolveDetached({
                canceled: false,
                command,
                detached: true,
                exitCode: 0,
                cliState: 'RUNNING',
                stderr: '',
                stdout: 'local CLI is running',
                timedOut: false,
            }),
            requestStop: () => undefined,
        };
        onLocalProcess(controller, command);

        if (executionMode === 'submit') {
            assert.ok(parsed, 'A new local CLI execution requires parsed pipeline metadata.');
            calls.submit += 1;
            await onSnapshot(identity, { stderr: '', stdout: 'local CLI is running' });
            return detachedResult;
        }

        calls.monitor += 1;
        assert.equal(run.cliExecutionId, identity.executionId);
        assert.equal(run.cliRunDirectory, identity.runDirectory);
        const finalState = outcome;
        const finalStdout = finalState === 'COMPLETED'
            ? 'local CLI completed after the server restarted'
            : 'local CLI state unavailable after container restart';
        await onSnapshot(
            { ...identity, state: finalState, stdoutOffset: identity.stdoutOffset + finalStdout.length },
            { stderr: '', stdout: finalStdout },
        );
        return {
            canceled: false,
            command,
            detached: false,
            exitCode: finalState === 'COMPLETED' ? 0 : undefined,
            cliState: finalState,
            reason: finalState === 'UNKNOWN' ? 'LOCAL_CLI_STATE_UNAVAILABLE' : undefined,
            stderr: finalState === 'UNKNOWN' ? 'Could not recover the local CLI state.' : '',
            stdout: finalStdout,
            timedOut: false,
        };
    };
    return { calls, executor };
}

function createRunControlService(
    persistence: ControlPlanePersistence,
    runExecutor?: LocalCliRunExecutor,
) {
    return createPipelineRegistryService({
        persistence,
        sparkConnectUrl: 'sc://test-spark-connect:15002',
        runExecutor,
    });
}

function localSnapshotForRun(
    run: Parameters<LocalCliRunExecutor>[0],
    state: LocalCliRunSnapshot['state'],
    stdoutOffset: number,
): LocalCliRunSnapshot {
    return {
        command: ['spark-pipelines', 'run'],
        executionId: run.cliExecutionId ?? 'local-cli-' + run.runId,
        processId: 4242,
        runDirectory: run.cliRunDirectory ?? '/app/run-state/runs/' + run.runId,
        startedAt: run.cliStartedAt ?? new Date().toISOString(),
        state,
        stderrOffset: run.cliStderrOffset ?? 0,
        stdoutOffset,
    };
}

function detachedLocalCliResult(command: string[]): LocalCliCommandResult {
    return {
        canceled: false,
        command,
        detached: true,
        exitCode: 0,
        cliState: 'RUNNING',
        stderr: '',
        stdout: 'local CLI is running',
        timedOut: false,
    };
}

function delay(milliseconds: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function submitRun(
    service: ReturnType<typeof createPipelineRegistryService>,
    pipelineId: string,
    request: RunRequest,
) {
    return service.submitRun({
        ...request,
        mode: request.mode ?? 'incremental',
        pipelineId,
    });
}

async function waitForStatus(
    service: ReturnType<typeof createPipelineRegistryService>,
    runId: string,
    statuses: string[],
) {
    return pollUntil(
        () => service.getRun(runId),
        (run) => statuses.includes(run.status),
        10_000,
        50,
        `Run ${runId} did not reach ${statuses.join(', ')}.`,
    );
}

async function waitForRunPredicate(
    service: ReturnType<typeof createPipelineRegistryService>,
    runId: string,
    predicate: (run: Awaited<ReturnType<typeof service.getRun>>) => boolean,
) {
    return pollUntil(
        () => service.getRun(runId),
        predicate,
        10_000,
        50,
        `Run ${runId} did not match the expected state.`,
    );
}
