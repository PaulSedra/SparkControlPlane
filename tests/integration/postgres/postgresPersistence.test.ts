/**
 * @fileoverview PostgreSQL persistence integration coverage.
 */

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Pool } from 'pg';
import { applyMigrations } from '../../../src/server/persistence/migrations.ts';
import { loadPostgresConfig } from '../../../src/server/config/postgresConfig.ts';
import { createPostgresPersistence } from '../../../src/server/persistence/postgresPersistence.ts';
import {
    isLivePostgresTestEnabled,
    postgresPoolConfig,
} from '../../support/postgresTestSupport.ts';
import type {
    AuditContext,
    ControlPlanePersistence,
    DiscoveredPipeline,
    PersistedRunSubmission,
    RunLease,
} from '../../../src/server/types/pipelinePersistenceTypes.ts';

type PipelineRunOverrides = Partial<Omit<
    PersistedRunSubmission,
    'pipelineId' | 'sourceHash' | 'versionId'
>>;

test('PostgreSQL configuration uses direct environment values and rejects file indirection', () => {
    const environment = {
        POSTGRES_DATABASE: 'spark_control_plane_test',
        POSTGRES_HOST: '127.0.0.1',
        POSTGRES_PASSWORD: 'opaque-env-value',
        POSTGRES_PORT: '5432',
        POSTGRES_SSLMODE: 'disable',
        POSTGRES_USER: 'spark',
    };
    const config = loadPostgresConfig(environment);
    assert.equal(config.database, environment.POSTGRES_DATABASE);
    assert.equal(config.password, environment.POSTGRES_PASSWORD);
    assert.equal(config.tlsMode, 'disable');

    assert.throws(
        () => loadPostgresConfig({
            ...environment,
            POSTGRES_DATABASE: undefined,
            POSTGRES_DB: 'legacy-database',
        }),
        /POSTGRES_DATABASE is required/,
    );
    const ignoredTlsAliasConfig = loadPostgresConfig({
        ...environment,
        POSTGRES_SSLMODE: undefined,
        POSTGRES_TLS_MODE: 'disable',
    });
    assert.equal(ignoredTlsAliasConfig.tlsMode, 'require');

    assert.throws(
        () => loadPostgresConfig({
            ...environment,
            POSTGRES_PASSWORD_FILE: 'not-read',
        }),
        /POSTGRES_PASSWORD_FILE.*not supported/,
    );
    assert.throws(
        () => loadPostgresConfig({
            ...environment,
            POSTGRES_SSLROOTCERT_FILE: 'not-read',
        }),
        /POSTGRES_SSLROOTCERT_FILE.*not supported/,
    );
});

test('PostgreSQL persistence applies idempotent migrations and preserves run history', {
    skip: !isLivePostgresTestEnabled(),
}, async () => {
    const config = loadPostgresConfig();
    let persistence = createPostgresPersistence(config);
    const cleanupPool = new Pool(postgresPoolConfig(config, config.schema, false));
    const pipelineName = `postgres-persistence-test-${crypto.randomUUID()}`;
    const idempotencyKey = `postgres-persistence-test-key-${crypto.randomUUID()}`;
    let pipelineId: string | undefined;
    const deployedPipeline = {
        name: pipelineName,
        sourceHash: 'hash-two',
        versionId: 'v-hash-two',
    };

    try {
        await persistence.initialize();
        await persistence.initialize();
        const discovered = discoveredPipeline(pipelineName, 'hash-one', 'v-hash-one');
        const firstIdentity = await persistence.ensurePipeline(discovered);
        assert.equal(firstIdentity.policy?.timeoutSeconds, undefined);
        pipelineId = firstIdentity.id;
        const secondIdentity = await persistence.ensurePipeline(
            discoveredPipeline(pipelineName, 'hash-two', 'v-hash-two'),
        );
        assert.equal(secondIdentity.id, firstIdentity.id);
        assert.equal(secondIdentity.currentVersionId, 'v-hash-two');

        await deployDiscovered(persistence, pipelineId!, deployedPipeline, {
            correlationId: 'postgres-deploy-correlation',
            requestSource: 'postgres-test',
        });

        const metadataCredential = `caller-secret-${crypto.randomUUID()}`;
        const firstSubmission = await submitPipelineRun(persistence, pipelineId!, deployedPipeline, {
            callerMetadata: { password: metadataCredential, suite: 'postgres' },
            correlationId: 'postgres-submit-correlation',
            idempotencyKey,
            requestSource: 'postgres-test',
        });
        assert.equal(firstSubmission.run.timeoutSeconds, undefined);
        const timeoutResult = await cleanupPool.query<{ timeout_seconds: number | null }>(
            'SELECT timeout_seconds FROM runs WHERE run_id = $1',
            [firstSubmission.run.runId],
        );
        assert.equal(timeoutResult.rows[0]?.timeout_seconds, null);
        const pipelineTimeoutResult = await cleanupPool.query<{ timeout_seconds: number | null }>(
            'SELECT timeout_seconds FROM pipelines WHERE id = $1',
            [pipelineId],
        );
        assert.equal(pipelineTimeoutResult.rows[0]?.timeout_seconds, null);
        assert.equal(firstSubmission.run.correlationId, 'postgres-submit-correlation');
        assert.equal(firstSubmission.run.requestSource, 'postgres-test');
        const replay = await submitPipelineRun(persistence, pipelineId!, deployedPipeline, {
            callerMetadata: { suite: 'postgres', password: metadataCredential },
            idempotencyKey,
            requestSource: 'postgres-test',
        });
        assert.equal(replay.replayed, true);
        assert.equal(replay.run.runId, firstSubmission.run.runId);
        assert.equal(replay.run.callerMetadata?.password, '[REDACTED]');
        const fingerprintResult = await cleanupPool.query<{ request_fingerprint: string }>(
            'SELECT request_fingerprint FROM idempotency_keys WHERE idempotency_key = $1',
            [idempotencyKey],
        );
        assert.match(fingerprintResult.rows[0]?.request_fingerprint ?? '', /^[a-f0-9]{64}$/);
        assert.doesNotMatch(fingerprintResult.rows[0]?.request_fingerprint ?? '', /caller-secret/);
        const persistedSubmission = await cleanupPool.query<{
            caller_metadata: Record<string, string>;
            audit_metadata: Record<string, string>;
        }>(
            `
                SELECT r.caller_metadata,
                       a.payload->'callerMetadata' AS audit_metadata
                FROM runs r
                JOIN audit_events a ON a.run_id = r.run_id AND a.event_type = 'RUN_SUBMITTED'
                WHERE r.run_id = $1
            `,
            [firstSubmission.run.runId],
        );
        assert.equal(persistedSubmission.rows[0]?.caller_metadata.password, '[REDACTED]');
        assert.equal(persistedSubmission.rows[0]?.audit_metadata.password, '[REDACTED]');
        await assert.rejects(
            () => submitPipelineRun(persistence, pipelineId!, deployedPipeline, {
                callerMetadata: { password: metadataCredential, suite: 'postgres' },
                idempotencyKey,
                policy: { allowOverlap: true, timeoutSeconds: 14400 },
                requestSource: 'postgres-test',
            }),
            (error: unknown) => error instanceof Error &&
                error.message.includes('idempotency key was already used'),
        );
        await assert.rejects(
            () => submitPipelineRun(persistence, pipelineId!, deployedPipeline, {
                callerMetadata: { password: metadataCredential, suite: 'postgres' },
                idempotencyKey,
                requestSource: 'postgres-test',
                sparkAppName: 'different-spark-application',
            }),
            (error: unknown) => error instanceof Error &&
                error.message.includes('idempotency key was already used'),
        );
        await assert.rejects(
            () => submitPipelineRun(persistence, pipelineId!, deployedPipeline, {
                callerMetadata: { suite: 'postgres' },
                idempotencyKey,
                mode: 'full-refresh-all',
                requestSource: 'postgres-test',
            }),
            (error: unknown) => error instanceof Error &&
                error.message.includes('idempotency key was already used'),
        );

        const claimed = await persistence.claimNextQueuedRun('postgres-test-worker', 5_000);
        assert.ok(claimed);
        assert.equal(claimed.run.status, 'SUBMITTING');
        assert.equal(
            (await persistence.renewLease(claimed.run.runId, claimed.lease, 5_000)).kind,
            'APPLIED',
        );
        const liveNodeStatuses = {
            'example.test': {
                lastUpdatedAt: new Date().toISOString(),
                qualifiedName: 'example.test',
                status: 'RUNNING' as const,
            },
        };
        const liveOutput = 'Flow example.test is RUNNING.\n';
        await persistence.appendLiveRun(
            claimed.run.runId,
            claimed.lease,
            'RUNNING',
            liveOutput,
            liveNodeStatuses,
        );
        const outputEventCount = (await persistence.listRunEvents(claimed.run.runId))
            .filter((event) => event.eventType === 'OUTPUT').length;
        await persistence.appendLiveRun(
            claimed.run.runId,
            claimed.lease,
            'RUNNING',
            liveOutput,
            liveNodeStatuses,
        );
        assert.equal(
            (await persistence.listRunEvents(claimed.run.runId))
                .filter((event) => event.eventType === 'OUTPUT').length,
            outputEventCount,
        );
        const completedResult = await persistence.completeRun(claimed.run.runId, claimed.lease, {
            command: ['test'],
            endedAt: new Date().toISOString(),
            exitCode: 0,
            nodeStatuses: {
                'example.test': {
                    completedAt: new Date().toISOString(),
                    lastUpdatedAt: new Date().toISOString(),
                    qualifiedName: 'example.test',
                    status: 'COMPLETED',
                },
            },
            stderr: '',
            stdout: 'Run is COMPLETED.\n',
            status: 'SUCCEEDED',
        });
        assert.equal(completedResult.run?.status, 'SUCCEEDED');
        assert.equal((await persistence.getRun(claimed.run.runId))?.nodeStatuses?.['example.test']?.status, 'COMPLETED');
        const firstEvents = await persistence.listRunEvents(claimed.run.runId);
        assert.ok(firstEvents.length >= 4);
        assert.ok(firstEvents.every((event) => event.correlationId === 'postgres-submit-correlation'));
        const auditCorrelation = await cleanupPool.query<{ correlation_id: string; request_source: string }>(
            `
                SELECT correlation_id, request_source
                FROM audit_events
                WHERE run_id = $1 AND event_type = 'RUN_SUCCEEDED'
            `,
            [claimed.run.runId],
        );
        assert.deepEqual(auditCorrelation.rows[0], {
            correlation_id: 'postgres-submit-correlation',
            request_source: 'postgres-test',
        });

        const queuedNodeTimestamp = new Date().toISOString();
        const canceledSubmission = await submitPipelineRun(persistence, pipelineId!, deployedPipeline, {
            initialNodeStatuses: {
                'example.test': {
                    lastUpdatedAt: queuedNodeTimestamp,
                    qualifiedName: 'example.test',
                    status: 'QUEUED',
                },
                'marketing.test': {
                    lastUpdatedAt: queuedNodeTimestamp,
                    qualifiedName: 'marketing.test',
                    status: 'QUEUED',
                },
            },
        });
        const canceled = await persistence.cancelRun(
            canceledSubmission.run.runId,
            'postgres-test',
            'test cancellation',
        );
        assert.equal(canceled.status, 'CANCELED');
        const canceledNodeStatuses = (await persistence.getRun(canceled.runId))?.nodeStatuses;
        assert.equal(canceledNodeStatuses?.['example.test']?.status, 'CANCELED');
        assert.equal(canceledNodeStatuses?.['marketing.test']?.status, 'CANCELED');
        assert.equal(
            await persistence.claimNextQueuedRun('postgres-test-worker', 5_000),
            undefined,
        );

        const activeCancellationSubmission = await submitPipelineRun(persistence, pipelineId!, deployedPipeline);
        const activeCancellationClaim = await persistence.claimNextQueuedRun('postgres-test-worker', 5_000);
        assert.equal(activeCancellationClaim?.run.runId, activeCancellationSubmission.run.runId);
        const requestedCancellation = await persistence.cancelRun(
            activeCancellationSubmission.run.runId,
            'postgres-test',
            'active test cancellation',
        );
        assert.equal(requestedCancellation.status, 'SUBMITTING');
        assert.equal(
            await persistence.isCancellationRequested(activeCancellationSubmission.run.runId),
            true,
        );
        const activeCanceled = await persistence.completeRun(activeCancellationSubmission.run.runId, activeCancellationClaim!.lease, {
            command: ['test'],
            endedAt: new Date().toISOString(),
            exitCode: 130,
            stderr: '',
            stdout: '',
            status: 'FAILED',
        });
        assert.equal(activeCanceled.run?.status, 'CANCELED');

        const concurrentCancellation = await submitPipelineRun(
            persistence,
            pipelineId!,
            deployedPipeline,
            {
                initialNodeStatuses: {
                    'concurrent.active': {
                        lastUpdatedAt: new Date().toISOString(),
                        qualifiedName: 'concurrent.active',
                        status: 'RUNNING',
                    },
                },
            },
        );
        const concurrentClaim = await persistence.claimNextQueuedRun('postgres-test-worker', 5_000);
        assert.equal(concurrentClaim?.run.runId, concurrentCancellation.run.runId);
        await Promise.all([
            persistence.cancelRun(
                concurrentCancellation.run.runId,
                'postgres-test',
                'concurrent cancellation',
            ),
            persistence.completeRun(concurrentCancellation.run.runId, concurrentClaim!.lease, {
                command: ['test'],
                endedAt: new Date().toISOString(),
                exitCode: 0,
                stderr: '',
                stdout: '',
                status: 'SUCCEEDED',
            }),
        ]);
        const concurrentTerminal = await persistence.getRun(concurrentCancellation.run.runId);
        assert.ok(['CANCELED', 'SUCCEEDED'].includes(concurrentTerminal?.status ?? ''));
        assert.equal(
            concurrentTerminal?.nodeStatuses?.['concurrent.active']?.status,
            concurrentTerminal?.status === 'CANCELED' ? 'CANCELED' : 'COMPLETED',
        );
        assert.equal(
            (await cleanupPool.query<{ count: string }>(
                'SELECT COUNT(*)::text AS count FROM run_leases WHERE run_id = $1',
                [concurrentCancellation.run.runId],
            )).rows[0]?.count,
            '0',
        );
        const terminalRaceEvents = (await persistence.listRunEvents(concurrentCancellation.run.runId))
            .filter((event) => ['CANCELED', 'SUCCEEDED'].includes(event.eventType));
        assert.equal(terminalRaceEvents.length, 1);

        const expiring = await submitPipelineRun(persistence, pipelineId!, deployedPipeline);
        const expiringClaim = await persistence.claimNextQueuedRun('postgres-test-worker', 1_000);
        assert.ok(expiringClaim);
        assert.equal(expiringClaim.run.runId, expiring.run.runId);
        const cliNodeTimestamp = new Date().toISOString();
        const localCliExecution = {
            command: ['spark-pipelines', '--password', config.password],
            executionId: `local-cli-${expiring.run.runId}`,
            nodeStatuses: {
                'example.test': {
                    lastUpdatedAt: cliNodeTimestamp,
                    qualifiedName: 'example.test',
                    startedAt: cliNodeTimestamp,
                    status: 'RUNNING' as const,
                },
            },
            processId: 4242,
            runDirectory: `/app/run-state/runs/${expiring.run.runId}`,
            runStatus: 'RUNNING' as const,
            reason: '{"token":"diagnostic-token"}',
            startedAt: new Date().toISOString(),
            state: 'RUNNING' as const,
            stderrOffset: 32,
            stderr: `diagnostic ${config.password}`,
            stdoutOffset: 128,
            stdout: 'local CLI still running token=output-secret',
        };
        assert.equal(
            (await persistence.updateLocalCliExecution(
                expiring.run.runId,
                expiringClaim.lease,
                localCliExecution,
            )).kind,
            'APPLIED',
        );
        const sanitizedCliRun = await persistence.getRun(expiring.run.runId);
        assert.deepEqual(sanitizedCliRun?.command, [
            'spark-pipelines',
            '--password',
            '[REDACTED]',
        ]);
        assert.equal(sanitizedCliRun?.stderr, 'diagnostic [REDACTED]');
        assert.equal(sanitizedCliRun?.stdout, 'local CLI still running token=[REDACTED]');
        assert.doesNotMatch(
            JSON.stringify(await persistence.listRunEvents(expiring.run.runId)),
            /diagnostic-token/,
        );
        const outputEventsBeforeStaleUpdate = (await persistence.listRunEvents(expiring.run.runId))
            .filter((event) => event.eventType === 'OUTPUT').length;
        assert.equal(
            (await persistence.updateLocalCliExecution(
                expiring.run.runId,
                expiringClaim.lease,
                {
                    ...localCliExecution,
                    nodeStatuses: {
                        'example.test': {
                            lastUpdatedAt: new Date(Date.parse(cliNodeTimestamp) + 60_000).toISOString(),
                            qualifiedName: 'example.test',
                            status: 'FAILED',
                        },
                    },
                    runStatus: 'SUBMITTING',
                    state: 'STARTING',
                    stderr: 'stale stderr',
                    stderrOffset: 0,
                    stdout: 'stale stdout',
                    stdoutOffset: localCliExecution.stdoutOffset - 1,
                },
            )).kind,
            'APPLIED',
        );
        const afterStaleUpdate = await persistence.getRun(expiring.run.runId);
        assert.equal(afterStaleUpdate?.stdout, 'local CLI still running token=[REDACTED]');
        assert.equal(afterStaleUpdate?.stderr, 'diagnostic [REDACTED]');
        assert.equal(afterStaleUpdate?.cliStdoutOffset, localCliExecution.stdoutOffset);
        assert.equal(afterStaleUpdate?.cliStderrOffset, localCliExecution.stderrOffset);
        assert.equal(afterStaleUpdate?.cliState, 'RUNNING');
        assert.equal(afterStaleUpdate?.nodeStatuses?.['example.test']?.status, 'RUNNING');
        assert.equal(
            (await persistence.listRunEvents(expiring.run.runId))
                .filter((event) => event.eventType === 'OUTPUT').length,
            outputEventsBeforeStaleUpdate,
        );
        assert.equal(
            (await persistence.updateLocalCliExecution(
                expiring.run.runId,
                expiringClaim.lease,
                {
                    ...localCliExecution,
                    executionId: 'different-local-execution',
                    stdout: 'identity mismatch output',
                    stdoutOffset: localCliExecution.stdoutOffset + 10,
                },
            )).kind,
            'FENCED',
        );
        await new Promise((resolve) => setTimeout(resolve, 1_200));
        assert.equal(
            (await persistence.renewLease(expiring.run.runId, expiringClaim.lease, 1_000)).kind,
            'FENCED',
        );
        assert.equal(
            (await persistence.appendLiveRun(
                expiring.run.runId,
                expiringClaim.lease,
                'RUNNING',
                'stale output',
                {},
            )).kind,
            'FENCED',
        );
        assert.equal(
            (await persistence.failRunBeforeExecution(
                expiring.run.runId,
                expiringClaim.lease,
                'stale preparation failure',
            )).kind,
            'FENCED',
        );
        assert.equal(
            (await persistence.completeRun(expiring.run.runId, expiringClaim.lease, {
                command: ['stale'],
                endedAt: new Date().toISOString(),
                exitCode: 0,
                stderr: '',
                stdout: 'stale completion',
                status: 'SUCCEEDED',
            })).kind,
            'FENCED',
        );
        assert.equal(
            (await persistence.releaseLease(expiring.run.runId, expiringClaim.lease)).kind,
            'FENCED',
        );
        await persistence.reconcileExpiredLeases();
        const recoverable = await persistence.getRun(expiring.run.runId);
        assert.equal(recoverable?.status, 'RUNNING');
        assert.equal(recoverable?.cliState, 'RUNNING');
        assert.equal(recoverable?.cliExecutionId, localCliExecution.executionId);
        assert.equal(recoverable?.cliProcessId, localCliExecution.processId);
        const recovered = await persistence.claimNextRecoverableRun('postgres-local-cli-worker', 5_000);
        assert.equal(recovered?.run.runId, expiring.run.runId);
        assert.equal(recovered?.run.status, 'RUNNING');
        assert.equal(recovered?.run.cliExecutionId, localCliExecution.executionId);
        assert.equal(
            (await persistence.updateLocalCliExecution(
                expiring.run.runId,
                expiringClaim.lease,
                { ...localCliExecution, stdoutOffset: 25, stdout: 'stale output' },
            )).kind,
            'FENCED',
        );
        const recoveredCompleted = await persistence.completeRun(expiring.run.runId, recovered!.lease, {
            command: localCliExecution.command,
            endedAt: new Date().toISOString(),
            exitCode: 0,
            cliState: 'COMPLETED',
            stderr: '',
            stdout: 'local CLI completed after the server restarted',
            status: 'SUCCEEDED',
        });
        assert.equal(recoveredCompleted.run?.status, 'SUCCEEDED');
        assert.equal(recoveredCompleted.run?.cliState, 'COMPLETED');
        assert.equal(recoveredCompleted.run?.cliExecutionId, localCliExecution.executionId);
        assert.equal(recoveredCompleted.run?.nodeStatuses?.['example.test']?.status, 'COMPLETED');

        const detachedSubmission = await submitPipelineRun(persistence, pipelineId!, deployedPipeline);
        const detachedClaim = await persistence.claimNextQueuedRun('postgres-test-worker', 5_000);
        assert.equal(detachedClaim?.run.runId, detachedSubmission.run.runId);
        const detachedExecutionId = `detached-${detachedSubmission.run.runId}`;
        assert.equal(
            (await persistence.updateLocalCliExecution(
                detachedSubmission.run.runId,
                detachedClaim!.lease,
                {
                    ...localCliExecution,
                    executionId: detachedExecutionId,
                    nodeStatuses: {},
                    reason: undefined,
                    runDirectory: `/app/run-state/runs/${detachedExecutionId}`,
                    stderr: '',
                    stderrOffset: 0,
                    stdout: '',
                    stdoutOffset: 0,
                },
            )).kind,
            'APPLIED',
        );
        assert.equal(
            (await persistence.releaseLease(detachedSubmission.run.runId, detachedClaim!.lease)).kind,
            'APPLIED',
        );
        const detachedRecovery = await persistence.claimNextRecoverableRun('postgres-detached-worker', 5_000);
        assert.equal(detachedRecovery?.run.runId, detachedSubmission.run.runId);
        assert.equal(detachedRecovery?.run.cliExecutionId, detachedExecutionId);
        assert.equal(
            (await persistence.completeRun(detachedSubmission.run.runId, detachedRecovery!.lease, {
                command: ['test'],
                endedAt: new Date().toISOString(),
                exitCode: 0,
                cliState: 'COMPLETED',
                stderr: '',
                stdout: 'finished after detach',
                status: 'SUCCEEDED',
            })).run?.status,
            'SUCCEEDED',
        );
        await persistence.reconcileExpiredLeases();
        const recoveredEvents = await persistence.listRunEvents(expiring.run.runId);
        assert.equal(
            recoveredEvents.filter((event) => event.eventType === 'ABANDONED').length,
            0,
        );
        assert.equal(
            recoveredEvents.filter((event) => event.eventType === 'LOCAL_CLI_RECOVERY_CLAIMED').length,
            1,
        );

        const legacySubmission = await submitPipelineRun(persistence, pipelineId!, deployedPipeline, {
            initialNodeStatuses: {
                'legacy.active': {
                    lastUpdatedAt: new Date().toISOString(),
                    qualifiedName: 'legacy.active',
                    status: 'RUNNING',
                },
            },
        });
        const legacyClaim = await persistence.claimNextQueuedRun('postgres-test-worker', 1_000);
        assert.equal(legacyClaim?.run.runId, legacySubmission.run.runId);
        await cleanupPool.query(
            `UPDATE runs
             SET spark_session_id = $2, spark_operation_id = $3, spark_execution_state = $4
             WHERE run_id = $1`,
            [
                legacySubmission.run.runId,
                '00000000-0000-4000-8000-000000000001',
                '00000000-0000-4000-8000-000000000002',
                'SUBMITTING',
            ],
        );
        await new Promise((resolve) => setTimeout(resolve, 1_200));
        await persistence.reconcileExpiredLeases();
        const legacyUnknown = await persistence.getRun(legacySubmission.run.runId);
        assert.equal(legacyUnknown?.status, 'UNKNOWN');
        assert.equal(legacyUnknown?.exitCode, undefined);
        assert.equal(legacyUnknown?.recoveryReason, 'LOCAL_CLI_IDENTITY_UNAVAILABLE');
        assert.equal(legacyUnknown?.terminalReason, 'LOCAL_CLI_IDENTITY_UNAVAILABLE');
        assert.equal(legacyUnknown?.nodeStatuses?.['legacy.active']?.status, 'UNKNOWN');
        assert.equal(
            (await persistence.completeRun(legacySubmission.run.runId, legacyClaim!.lease, {
                command: ['duplicate'],
                endedAt: new Date().toISOString(),
                exitCode: 0,
                stderr: '',
                stdout: '',
                status: 'SUCCEEDED',
            })).kind,
            'ALREADY_TERMINAL',
        );
        await persistence.reconcileExpiredLeases();
        const legacyUnknownEvents = await persistence.listRunEvents(legacySubmission.run.runId);
        assert.equal(legacyUnknownEvents.filter((event) => event.eventType === 'UNKNOWN').length, 1);
        assert.equal(legacyUnknownEvents.filter((event) => event.eventType === 'ABANDONED').length, 0);
        const unknownAudits = await cleanupPool.query<{ count: string }>(
            'SELECT COUNT(*)::text AS count FROM audit_events WHERE run_id = $1 AND event_type = $2',
            [legacySubmission.run.runId, 'RUN_OUTCOME_UNKNOWN'],
        );
        assert.equal(unknownAudits.rows[0]?.count, '1');

        const abandonedSubmission = await submitPipelineRun(persistence, pipelineId!, deployedPipeline, {
            initialNodeStatuses: {
                'abandoned.active': {
                    lastUpdatedAt: new Date().toISOString(),
                    qualifiedName: 'abandoned.active',
                    status: 'RUNNING',
                },
            },
        });
        const abandonedClaim = await persistence.claimNextQueuedRun('postgres-test-worker', 1_000);
        assert.equal(abandonedClaim?.run.runId, abandonedSubmission.run.runId);
        assert.equal(
            (await persistence.releaseLease(abandonedSubmission.run.runId, abandonedClaim!.lease)).kind,
            'APPLIED',
        );
        const retainedLease = await cleanupPool.query<{ count: string }>(
            'SELECT COUNT(*)::text AS count FROM run_leases WHERE run_id = $1',
            [abandonedSubmission.run.runId],
        );
        assert.equal(retainedLease.rows[0]?.count, '1');
        await cleanupPool.query('DELETE FROM run_leases WHERE run_id = $1', [abandonedSubmission.run.runId]);
        await persistence.reconcileExpiredLeases();
        const abandoned = await persistence.getRun(abandonedSubmission.run.runId);
        assert.equal(abandoned?.status, 'FAILED');
        assert.equal(abandoned?.leaseLost, true);
        assert.equal(abandoned?.recoveryReason, 'LEASE_EXPIRED');
        assert.equal(abandoned?.terminalReason, 'LEASE_EXPIRED');
        assert.equal(abandoned?.nodeStatuses?.['abandoned.active']?.status, 'FAILED');
        assert.match(abandoned?.stderr ?? '', /classified as abandoned/);
        await persistence.reconcileExpiredLeases();
        const abandonedEvents = await persistence.listRunEvents(abandonedSubmission.run.runId);
        assert.equal(abandonedEvents.filter((event) => event.eventType === 'ABANDONED').length, 1);

        const timedOutSubmission = await submitPipelineRun(persistence, pipelineId!, deployedPipeline);
        const timedOutClaim = await persistence.claimNextQueuedRun('postgres-test-worker', 5_000);
        assert.equal(timedOutClaim?.run.runId, timedOutSubmission.run.runId);
        const timedOut = await persistence.completeRun(timedOutSubmission.run.runId, timedOutClaim!.lease, {
            command: ['test'],
            endedAt: new Date().toISOString(),
            exitCode: 130,
            stderr: 'Run exceeded configured timeout.',
            stdout: '',
            status: 'TIMED_OUT',
        });
        assert.equal(timedOut.run?.status, 'TIMED_OUT');

        const allRuns = await persistence.listRuns(pipelineId!);
        assert.equal(
            allRuns.find((run) => run.runId === firstSubmission.run.runId)
                ?.nodeStatuses?.['example.test']?.status,
            'COMPLETED',
        );
        const firstRunsPage = await persistence.listRunsPage?.(pipelineId!, 2, 0);
        assert.ok(firstRunsPage);
        assert.equal(firstRunsPage.total, allRuns.length);
        assert.equal(firstRunsPage.items.length, 2);
        assert.deepEqual(
            firstRunsPage.items.map((run) => run.runId),
            allRuns.slice(0, 2).map((run) => run.runId),
        );
        const laterRunsPage = await persistence.listRunsPage?.(pipelineId!, 2, 2);
        assert.ok(laterRunsPage);
        assert.equal(laterRunsPage.total, allRuns.length);
        assert.deepEqual(
            laterRunsPage.items.map((run) => run.runId),
            allRuns.slice(2, 4).map((run) => run.runId),
        );
        const emptyRunsPage = await persistence.listRunsPage?.(pipelineId!, 2, allRuns.length + 20);
        assert.ok(emptyRunsPage);
        assert.equal(emptyRunsPage.total, allRuns.length);
        assert.equal(emptyRunsPage.items.length, 0);

        await persistence.shutdown();
        persistence = createPostgresPersistence(config);
        await persistence.initialize();
        assert.equal((await persistence.getRun(firstSubmission.run.runId))?.status, 'SUCCEEDED');
        assert.equal((await persistence.getRun(timedOutSubmission.run.runId))?.status, 'TIMED_OUT');

        const counts = await cleanupPool.query<{ events: string; nodes: string; audits: string }>(
            `
                SELECT
                    (SELECT COUNT(*)::text FROM run_events WHERE run_id IN (SELECT run_id FROM runs WHERE pipeline_id = $1)) AS events,
                    (SELECT COUNT(*)::text FROM run_node_states WHERE run_id IN (SELECT run_id FROM runs WHERE pipeline_id = $1)) AS nodes,
                    (SELECT COUNT(*)::text FROM audit_events WHERE pipeline_id = $1) AS audits
            `,
            [pipelineId],
        );
        assert.ok(Number(counts.rows[0]?.events) >= 4);
        assert.ok(Number(counts.rows[0]?.nodes) >= 1);
        assert.ok(Number(counts.rows[0]?.audits) >= 3);
    } finally {
        if (pipelineId != null) {
            await cleanupPool.query('DELETE FROM audit_events WHERE pipeline_id = $1', [pipelineId]);
            await cleanupPool.query('DELETE FROM runs WHERE pipeline_id = $1', [pipelineId]);
            await cleanupPool.query('DELETE FROM pipelines WHERE id = $1', [pipelineId]);
        }
        await persistence.shutdown();
        await cleanupPool.end();
    }
});

test('PostgreSQL trigger foundation persists definitions, deduplication, and outcomes', {
    skip: !isLivePostgresTestEnabled(),
}, async () => {
    const config = loadPostgresConfig();
    const schema = `spark_control_plane_trigger_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`;
    const persistence = createPostgresPersistence({ ...config, schema });
    const cleanupPool = new Pool(postgresPoolConfig(config, schema, false));

    try {
        await persistence.initialize();
        const discovered = discoveredPipeline(
            `postgres-trigger-${crypto.randomUUID()}`,
            'trigger-source-hash',
            'trigger-version',
        );
        const pipeline = await persistence.ensurePipeline(discovered);
        const trigger = await persistence.createTrigger({
            callerMetadata: { owner: 'test' },
            configuration: { eventType: 'file.arrived' },
            mode: 'incremental',
            name: 'trigger-foundation-test',
            pipelineId: pipeline.id,
            type: 'FILE_ARRIVAL',
        });
        assert.equal((await persistence.getTrigger(trigger.id))?.name, trigger.name);

        const event = {
            attributes: { bucket: 'lake', key: 'incoming/file.json' },
            deduplicationKey: 'lake:incoming/file.json:etag-1',
            eventId: 'trigger-event-1',
            eventType: 'file.arrived',
            occurredAt: '2026-09-08T12:00:00.000Z',
            payload: { bucket: 'lake', key: 'incoming/file.json' },
            source: 'aistor',
        } as const;
        assert.equal((await persistence.recordTriggerEvent(event)).duplicate, false);
        const duplicate = await persistence.recordTriggerEvent({
            ...event,
            eventId: 'trigger-event-2',
        });
        assert.equal(duplicate.duplicate, true);
        assert.equal(duplicate.event.duplicateCount, 1);
        assert.equal(
            (await persistence.updateTriggerEventStatus(event.eventId, 'ROUTED')).status,
            'ROUTED',
        );

        const decision = await persistence.recordRoutingDecision({
            eventId: event.eventId,
            outcome: 'MATCHED',
            reason: 'test match',
            triggerId: trigger.id,
        });
        const attempt = await persistence.recordTriggerDeliveryAttempt({
            attemptNumber: 1,
            completedAt: '2026-09-08T12:00:01.000Z',
            eventId: event.eventId,
            startedAt: '2026-09-08T12:00:00.500Z',
            status: 'ACCEPTED',
            triggerId: trigger.id,
        });
        const outcome = await persistence.updateTriggerOutcome(trigger.id, {
            detail: 'test submission',
            eventId: event.eventId,
            occurredAt: '2026-09-08T12:00:01.000Z',
            status: 'ACCEPTED',
        });
        assert.equal(outcome.lastOutcome?.status, 'ACCEPTED');
        assert.equal(
            (await persistence.listTriggerRoutingDecisions(event.eventId, trigger.id))[0]?.decisionId,
            decision.decisionId,
        );
        assert.equal(
            (await persistence.listTriggerDeliveryAttempts(trigger.id))[0]?.attemptId,
            attempt.attemptId,
        );
        assert.equal((await persistence.listTriggerEvents())[0]?.status, 'ROUTED');
        const deadLetter = await persistence.createTriggerDeadLetter({
            event,
            eventId: event.eventId,
            failureReason: 'test delivery failure',
            triggerId: trigger.id,
        });
        assert.equal((await persistence.listTriggerDeadLetters('PENDING'))[0]?.id, deadLetter.id);
        assert.deepEqual((await persistence.getTriggerDeadLetter(deadLetter.id))?.event, event);
        assert.equal(
            (await persistence.updateTriggerDeadLetter(deadLetter.id, {
                status: 'REPLAYED',
            })).status,
            'REPLAYED',
        );
    } finally {
        await persistence.shutdown();
        await cleanupPool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
        await cleanupPool.end();
    }
});

test('PostgreSQL pipeline source snapshots retain current and queued versions', {
    skip: !isLivePostgresTestEnabled(),
}, async () => {
    const config = loadPostgresConfig();
    const schema = `spark_control_plane_source_snapshot_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`;
    const persistence = createPostgresPersistence({ ...config, schema });
    const cleanupPool = new Pool(postgresPoolConfig(config, schema, false));

    try {
        await persistence.initialize();
        const first = {
            ...discoveredPipeline(
                `postgres-source-snapshot-${crypto.randomUUID()}`,
                'snapshot-hash-one',
                'snapshot-version-one',
            ),
            sourceContents: [{
                content: 'CREATE MATERIALIZED VIEW snapshot AS SELECT 1;\n',
                sourceFile: 'sql/snapshot.sql',
            }],
            specContent: 'name: snapshot-test\nstorage: file:///tmp/snapshot\n',
        };
        const pipeline = await persistence.ensurePipeline(first);
        const original = await persistence.getPipelineSnapshot(pipeline.id, first.versionId);
        assert.equal(original?.specContent, first.specContent);
        assert.deepEqual(original?.sourceContents, first.sourceContents);

        const second = {
            ...first,
            sourceContents: [{
                content: 'CREATE MATERIALIZED VIEW snapshot AS SELECT 2;\n',
                sourceFile: 'sql/snapshot.sql',
            }],
            sourceHash: 'snapshot-hash-two',
            specContent: 'name: snapshot-test\nstorage: file:///tmp/snapshot-two\n',
            versionId: 'snapshot-version-two',
        };
        await persistence.ensurePipeline(second);
        assert.equal(
            (await persistence.getPipelineSnapshot(pipeline.id))?.sourceHash,
            second.sourceHash,
        );
        assert.equal(
            (await persistence.getPipelineSnapshot(pipeline.id, first.versionId))?.specContent,
            first.specContent,
        );

        assert.deepEqual(await persistence.deactivatePipelinesNotIn([]), [pipeline.id]);
        assert.equal((await persistence.listCurrentPipelineSnapshots()).length, 0);
        assert.equal(
            (await persistence.getPipelineSnapshot(pipeline.id, first.versionId))?.sourceHash,
            first.sourceHash,
        );
    } finally {
        await persistence.shutdown();
        await cleanupPool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
        await cleanupPool.end();
    }
});

test('PostgreSQL YAML trigger pause persists until explicit source reconciliation', {
    skip: !isLivePostgresTestEnabled(),
}, async () => {
    const config = loadPostgresConfig();
    const schema = `spark_control_plane_yaml_trigger_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`;
    const persistence = createPostgresPersistence({ ...config, schema });
    const cleanupPool = new Pool(postgresPoolConfig(config, schema, false));

    try {
        await persistence.initialize();
        const pipeline = await persistence.ensurePipeline(discoveredPipeline(
            `postgres-yaml-trigger-${crypto.randomUUID()}`,
            'yaml-trigger-source-hash',
            'yaml-trigger-version',
        ));
        const yamlTrigger = {
            configuration: { cron: '*/5 * * * *', timeZone: 'UTC' },
            enabled: true,
            mode: 'incremental' as const,
            name: 'yaml-schedule-trigger',
            pipelineId: pipeline.id,
            type: 'SCHEDULE' as const,
        };
        const [created] = await persistence.reconcileYamlTriggers(pipeline.id, [yamlTrigger]);
        assert.ok(created);

        await persistence.updateTrigger(created.id, { enabled: false });
        assert.equal((await persistence.getTrigger(created.id))?.enabled, false);
        assert.equal((await persistence.listTriggers())[0]?.enabled, false);

        const [paused] = await persistence.reconcileYamlTriggers(pipeline.id, [yamlTrigger]);
        assert.equal(paused?.enabled, true);

        await persistence.updateTrigger(created.id, { enabled: true });
        const [resumed] = await persistence.reconcileYamlTriggers(pipeline.id, [
            { ...yamlTrigger, enabled: false },
        ]);
        assert.equal(resumed?.enabled, false);

        await persistence.reconcileYamlTriggers(pipeline.id, []);
        const removed = await persistence.getTrigger(created.id);
        assert.equal(removed?.active, false);
        assert.equal(removed?.enabled, false);

        const [recreated] = await persistence.reconcileYamlTriggers(pipeline.id, [
            { ...yamlTrigger, enabled: false },
        ]);
        assert.equal(recreated?.id, created.id);
        assert.equal(recreated?.active, true);
        assert.equal(recreated?.enabled, false);
    } finally {
        await persistence.shutdown();
        await cleanupPool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
        await cleanupPool.end();
    }
});

test('PostgreSQL claims serialize default runs and admit opted-in overlap', {
    skip: !isLivePostgresTestEnabled(),
}, async () => {
    const config = loadPostgresConfig();
    const schema = `spark_control_plane_claims_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`;
    const firstPersistence = createPostgresPersistence({ ...config, schema });
    const secondPersistence = createPostgresPersistence({ ...config, schema });
    const cleanupPool = new Pool(postgresPoolConfig(config, schema, false));
    const pipelineIds: string[] = [];
    const defaultPolicy = { allowOverlap: false, timeoutSeconds: 60 };
    const overlapPolicy = { allowOverlap: true, timeoutSeconds: 60 };

    try {
        await firstPersistence.initialize();
        await secondPersistence.initialize();

        const defaultPipeline = discoveredPipeline(
            `postgres-claim-default-${crypto.randomUUID()}`,
            'claim-default-hash',
            'claim-default-version',
        );
        defaultPipeline.policy = defaultPolicy;
        const defaultIdentity = await firstPersistence.ensurePipeline(defaultPipeline);
        pipelineIds.push(defaultIdentity.id);
        await deployDiscovered(firstPersistence, defaultIdentity.id, defaultPipeline);
        const defaultSubmissions = await Promise.all([
            submitPipelineRun(firstPersistence, defaultIdentity.id, defaultPipeline, { policy: defaultPolicy }),
            submitPipelineRun(firstPersistence, defaultIdentity.id, defaultPipeline, { policy: defaultPolicy }),
        ]);
        const defaultClaims = await Promise.all([
            firstPersistence.claimNextQueuedRun('claim-worker-one', 5_000),
            secondPersistence.claimNextQueuedRun('claim-worker-two', 5_000),
        ]);
        const claimedDefaultRuns = defaultClaims.filter((claim) => claim != null);
        assert.equal(claimedDefaultRuns.length, 1);

        const claimedDefault = claimedDefaultRuns[0];
        assert.ok(claimedDefault);
        const queuedDefault = defaultSubmissions.find(
            (submission) => submission.run.runId !== claimedDefault.run.runId,
        );
        assert.ok(queuedDefault);
        await completeSuccessfully(firstPersistence, claimedDefault.run.runId, claimedDefault.lease);
        const nextDefaultClaim = await firstPersistence.claimNextQueuedRun('claim-worker-one', 5_000);
        assert.equal(nextDefaultClaim?.run.runId, queuedDefault.run.runId);
        await completeSuccessfully(firstPersistence, queuedDefault.run.runId, nextDefaultClaim!.lease);

        const overlapPipeline = discoveredPipeline(
            `postgres-claim-overlap-${crypto.randomUUID()}`,
            'claim-overlap-hash',
            'claim-overlap-version',
        );
        overlapPipeline.policy = overlapPolicy;
        const overlapIdentity = await firstPersistence.ensurePipeline(overlapPipeline);
        pipelineIds.push(overlapIdentity.id);
        await deployDiscovered(firstPersistence, overlapIdentity.id, overlapPipeline);
        const overlapSubmissions = await Promise.all([
            submitPipelineRun(firstPersistence, overlapIdentity.id, overlapPipeline, { policy: overlapPolicy }),
            submitPipelineRun(firstPersistence, overlapIdentity.id, overlapPipeline, { policy: overlapPolicy }),
        ]);
        const overlapClaims = await Promise.all([
            firstPersistence.claimNextQueuedRun('claim-worker-one', 5_000),
            secondPersistence.claimNextQueuedRun('claim-worker-two', 5_000),
        ]);
        const claimedOverlapRuns = overlapClaims.filter((claim) => claim != null);
        assert.equal(claimedOverlapRuns.length, 2);
        assert.deepEqual(
            claimedOverlapRuns.map((claim) => claim!.run.runId).sort(),
            overlapSubmissions.map((submission) => submission.run.runId).sort(),
        );
        const serializedDuringOverlap = await submitPipelineRun(
            firstPersistence,
            overlapIdentity.id,
            overlapPipeline,
            { policy: defaultPolicy },
        );
        assert.equal(
            await firstPersistence.claimNextQueuedRun('claim-worker-one', 5_000),
            undefined,
        );
        for (const claim of claimedOverlapRuns) {
            await completeSuccessfully(firstPersistence, claim!.run.runId, claim!.lease);
        }
        const nextSerializedClaim = await firstPersistence.claimNextQueuedRun('claim-worker-one', 5_000);
        assert.equal(nextSerializedClaim?.run.runId, serializedDuringOverlap.run.runId);
        await completeSuccessfully(firstPersistence, serializedDuringOverlap.run.runId, nextSerializedClaim!.lease);

        const independentPipelines = await Promise.all([
            firstPersistence.ensurePipeline(discoveredPipeline(
                `postgres-claim-independent-one-${crypto.randomUUID()}`,
                'claim-independent-1-hash',
                'claim-independent-1-version',
            )),
            firstPersistence.ensurePipeline(discoveredPipeline(
                `postgres-claim-independent-two-${crypto.randomUUID()}`,
                'claim-independent-2-hash',
                'claim-independent-2-version',
            )),
        ]);
        for (const pipeline of independentPipelines) {
            pipelineIds.push(pipeline.id);
        }
        const independentDiscovered = independentPipelines.map((pipeline, index) => ({
            ...discoveredPipeline(
                pipeline.name,
                `claim-independent-${index + 1}-hash`,
                `claim-independent-${index + 1}-version`,
            ),
            policy: defaultPolicy,
        }));
        for (let index = 0; index < independentPipelines.length; index += 1) {
            await deployDiscovered(firstPersistence, independentPipelines[index].id, independentDiscovered[index]);
        }
        const independentSubmissions = await Promise.all(
            independentPipelines.map((pipeline, index) =>
                submitPipelineRun(firstPersistence, pipeline.id, independentDiscovered[index], { policy: defaultPolicy })),
        );
        const independentClaims = await Promise.all([
            firstPersistence.claimNextQueuedRun('claim-worker-one', 5_000),
            secondPersistence.claimNextQueuedRun('claim-worker-two', 5_000),
        ]);
        const claimedIndependentRuns = independentClaims.filter((claim) => claim != null);
        assert.equal(claimedIndependentRuns.length, 2);
        assert.deepEqual(
            claimedIndependentRuns.map((claim) => claim.run.runId).sort(),
            independentSubmissions.map((submission) => submission.run.runId).sort(),
        );
        for (const claim of claimedIndependentRuns) {
            await completeSuccessfully(firstPersistence, claim.run.runId, claim.lease);
        }
    } finally {
        await firstPersistence.shutdown();
        await secondPersistence.shutdown();
        for (const pipelineId of pipelineIds) {
            await cleanupPool.query('DELETE FROM audit_events WHERE pipeline_id = $1', [pipelineId]);
            await cleanupPool.query('DELETE FROM runs WHERE pipeline_id = $1', [pipelineId]);
            await cleanupPool.query('DELETE FROM pipelines WHERE id = $1', [pipelineId]);
        }
        await cleanupPool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
        await cleanupPool.end();
    }
});

test('PostgreSQL stuck-run age starts at lease acquisition', {
    skip: !isLivePostgresTestEnabled(),
}, async () => {
    const config = loadPostgresConfig();
    const schema = `spark_control_plane_stuck_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`;
    const persistence = createPostgresPersistence({ ...config, schema });
    const cleanupPool = new Pool(postgresPoolConfig(config, schema, false));
    let pipelineId: string | undefined;

    try {
        await persistence.initialize();
        const policy = { allowOverlap: false, timeoutSeconds: 1 };
        const discovered = discoveredPipeline(
            `postgres-stuck-age-${crypto.randomUUID()}`,
            'stuck-age-hash',
            'stuck-age-version',
        );
        discovered.policy = policy;
        pipelineId = (await persistence.ensurePipeline(discovered)).id;
        await deployDiscovered(persistence, pipelineId, discovered);
        const submission = await submitPipelineRun(persistence, pipelineId, discovered, { policy });
        await cleanupPool.query(
            `UPDATE runs SET started_at = NOW() - INTERVAL '2 hours' WHERE run_id = $1`,
            [submission.run.runId],
        );
        const claim = await persistence.claimNextQueuedRun('stuck-age-worker', 5_000);
        assert.ok(claim);
        const snapshot = await persistence.operationalSnapshot();
        assert.equal(snapshot.activeRuns, 1);
        assert.equal(snapshot.stuckRuns, 0);
        await persistence.completeRun(claim.run.runId, claim.lease, {
            command: ['test'],
            endedAt: new Date().toISOString(),
            exitCode: 0,
            stderr: '',
            stdout: '',
            status: 'SUCCEEDED',
        });
    } finally {
        await persistence.shutdown();
        if (pipelineId != null) {
            await cleanupPool.query('DELETE FROM audit_events WHERE pipeline_id = $1', [pipelineId]);
            await cleanupPool.query('DELETE FROM runs WHERE pipeline_id = $1', [pipelineId]);
            await cleanupPool.query('DELETE FROM pipelines WHERE id = $1', [pipelineId]);
        }
        await cleanupPool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
        await cleanupPool.end();
    }
});

test('PostgreSQL initializes a fresh empty schema and reruns migrations safely', {
    skip: !isLivePostgresTestEnabled(),
}, async () => {
    const config = loadPostgresConfig();
    const schema = `spark_control_plane_fresh_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`;
    const persistence = createPostgresPersistence({ ...config, schema });
    const cleanupPool = new Pool(postgresPoolConfig(config, schema, false));

    try {
        await persistence.initialize();
        await persistence.initialize();
        const migrationCount = await cleanupPool.query<{ count: string }>(
            'SELECT COUNT(*)::text AS count FROM schema_migrations',
        );
        assert.equal(migrationCount.rows[0]?.count, '19');
        const tableCount = await cleanupPool.query<{ count: string }>(
            `
                SELECT COUNT(*)::text AS count
                FROM information_schema.tables
                WHERE table_schema = $1
            `,
            [schema],
        );
        assert.equal(tableCount.rows[0]?.count, '18');
    } finally {
        await persistence.shutdown();
        await cleanupPool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
        await cleanupPool.end();
    }
});

test('PostgreSQL rolls back a failed migration without recording it', {
    skip: !isLivePostgresTestEnabled(),
}, async () => {
    const config = loadPostgresConfig();
    const schema = `spark_control_plane_rollback_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`;
    const migrationDirectory = await fs.mkdtemp(
        path.join(os.tmpdir(), 'spark-control-plane-migrations-'),
    );
    const pool = new Pool(postgresPoolConfig(config, schema, false));

    try {
        await fs.writeFile(
            path.join(migrationDirectory, '001_probe.sql'),
            'CREATE TABLE migration_probe (id integer PRIMARY KEY);\n',
            'utf8',
        );
        await fs.writeFile(
            path.join(migrationDirectory, '002_broken.sql'),
            'CREATE TABLE migration_broken (\n',
            'utf8',
        );
        await assert.rejects(() => applyMigrations(pool, migrationDirectory, schema));
        const state = await pool.query<{ applied: string; probe: string; broken: string }>(
            `
                SELECT
                    (SELECT COUNT(*)::text FROM schema_migrations) AS applied,
                    (SELECT COUNT(*)::text FROM information_schema.tables
                        WHERE table_schema = $1 AND table_name = 'migration_probe') AS probe,
                    (SELECT COUNT(*)::text FROM information_schema.tables
                        WHERE table_schema = $1 AND table_name = 'migration_broken') AS broken
            `,
            [schema],
        );
        assert.deepEqual(state.rows[0], { applied: '1', broken: '0', probe: '1' });
        await fs.writeFile(
            path.join(migrationDirectory, '002_broken.sql'),
            'CREATE TABLE migration_recovered (id integer PRIMARY KEY);\n',
            'utf8',
        );
        await applyMigrations(pool, migrationDirectory, schema);
        const recovered = await pool.query<{ applied: string; recovered: string }>(
            `
                SELECT
                    (SELECT COUNT(*)::text FROM schema_migrations) AS applied,
                    (SELECT COUNT(*)::text FROM information_schema.tables
                        WHERE table_schema = $1 AND table_name = 'migration_recovered') AS recovered
            `,
            [schema],
        );
        assert.deepEqual(recovered.rows[0], { applied: '2', recovered: '1' });
    } finally {
        await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
        await pool.end();
        await fs.rm(migrationDirectory, { force: true, recursive: true });
    }
});

test('PostgreSQL rejects migration checksum drift after a successful apply', {
    skip: !isLivePostgresTestEnabled(),
}, async () => {
    const config = loadPostgresConfig();
    const schema = `spark_control_plane_checksum_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`;
    const migrationDirectory = await fs.mkdtemp(
        path.join(os.tmpdir(), 'spark-control-plane-checksum-'),
    );
    const pool = new Pool(postgresPoolConfig(config, schema, false));

    try {
        await fs.writeFile(
            path.join(migrationDirectory, '001_probe.sql'),
            'CREATE TABLE migration_probe (id integer PRIMARY KEY);\n',
            'utf8',
        );
        await applyMigrations(pool, migrationDirectory, schema);
        await fs.writeFile(
            path.join(migrationDirectory, '001_probe.sql'),
            'CREATE TABLE migration_probe (id bigint PRIMARY KEY);\n',
            'utf8',
        );
        await assert.rejects(
            () => applyMigrations(pool, migrationDirectory, schema),
            /Migration checksum mismatch for version 001/,
        );
    } finally {
        await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
        await pool.end();
        await fs.rm(migrationDirectory, { force: true, recursive: true });
    }
});

async function deployDiscovered(
    persistence: ControlPlanePersistence,
    pipelineId: string,
    pipeline: Pick<DiscoveredPipeline, 'sourceHash' | 'versionId'>,
    context?: AuditContext,
): Promise<void> {
    await persistence.saveDeployment({
        deployedAt: new Date().toISOString(),
        pipelineId,
        sourceHash: pipeline.sourceHash,
        status: 'DEPLOYED',
        validationMessages: [],
        versionId: pipeline.versionId,
    }, context);
}

function submitPipelineRun(
    persistence: ControlPlanePersistence,
    pipelineId: string,
    pipeline: Pick<DiscoveredPipeline, 'name' | 'sourceHash' | 'versionId'>,
    overrides: PipelineRunOverrides = {},
) {
    return persistence.submitRun({
        mode: 'incremental',
        pipelineId,
        sourceHash: pipeline.sourceHash,
        sparkAppName: pipeline.name,
        versionId: pipeline.versionId,
        ...overrides,
    });
}

function completeSuccessfully(
    persistence: ControlPlanePersistence,
    runId: string,
    lease: RunLease,
) {
    return persistence.completeRun(runId, lease, {
        command: ['test'],
        endedAt: new Date().toISOString(),
        exitCode: 0,
        stderr: '',
        stdout: '',
        status: 'SUCCEEDED',
    });
}

function discoveredPipeline(
    name: string,
    sourceHash: string,
    versionId: string,
): DiscoveredPipeline {
    return {
        edges: [],
        name,
        nodes: [],
        sourceFiles: [],
        sourceHash,
        spec: {
            libraries: [],
            name,
            specPath: `C:\\test\\${name}\\resources\\${name}.pipeline.yaml`,
            storage: 'file:///tmp/postgres-persistence-test',
        },
        specPath: `C:\\test\\${name}\\resources\\${name}.pipeline.yaml`,
        validationMessages: [],
        versionId,
    };
}
