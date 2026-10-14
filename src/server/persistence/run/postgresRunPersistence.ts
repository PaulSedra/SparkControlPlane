/**
 * @fileoverview Public PostgreSQL run-persistence factory and domain wiring.
 */

import type { Pool } from 'pg';
import type { RunPersistence } from '../../types/pipelinePersistenceTypes.ts';
import {
    appendLiveRun,
    cancelRun,
    completeRun,
    failRunBeforeExecution,
    isCancellationRequested,
    updateLocalCliExecution,
} from './postgresRunLifecycle.ts';
import {
    claimNextRecoverableRun,
    reconcileExpiredLeases,
    releaseLease,
    renewLease,
} from './postgresRunLeases.ts';
import {
    getLatestRun,
    getRun,
    listRunEvents,
    listRunEventsAfter,
    listRuns,
    listRunsPage,
    operationalSnapshot,
} from './postgresRunQueries.ts';
import {
    getRunByIdempotencyKey,
    claimNextQueuedRun,
    submitRun,
} from './postgresRunQueue.ts';
import {
    listReadyRunSuccessDependencies,
    markRunSuccessDependencySubmitted,
    recordRunSuccessDependencyFailure,
} from './postgresRunSuccessDependencies.ts';

/**
 * Creates the PostgreSQL run adapter while leaving pool ownership with its
 * aggregate persistence factory. Queue, lease, lifecycle, and query modules
 * share the configured secret so every stored or returned run value is
 * sanitized at its boundary.
 */
export function createPostgresRunPersistence(pool: Pool, secret: string): RunPersistence {
    return {
        appendLiveRun: (runId, lease, status, stdout, nodeStatuses) =>
            appendLiveRun(pool, runId, lease, status, stdout, nodeStatuses, secret),
        claimNextQueuedRun: (ownerId, leaseMilliseconds) =>
            claimNextQueuedRun(pool, ownerId, leaseMilliseconds, secret),
        claimNextRecoverableRun: (ownerId, leaseMilliseconds) =>
            claimNextRecoverableRun(pool, ownerId, leaseMilliseconds, secret),
        completeRun: (runId, lease, completion) =>
            completeRun(pool, runId, lease, completion, secret),
        cancelRun: (runId, requestedBy, reason, context) =>
            cancelRun(pool, runId, requestedBy, reason, context, secret),
        failRunBeforeExecution: (runId, lease, message) =>
            failRunBeforeExecution(pool, runId, lease, message, secret),
        getLatestRun: (pipelineId) => getLatestRun(pool, pipelineId, [secret]),
        getRunByIdempotencyKey: (idempotencyKey) =>
            getRunByIdempotencyKey(pool, idempotencyKey, secret),
        getRun: (runId) => getRun(pool, runId, [secret]),
        isCancellationRequested: (runId) => isCancellationRequested(pool, runId),
        listRuns: (pipelineId) => listRuns(pool, pipelineId, [secret]),
        listRunsPage: (pipelineId, limit, offset) =>
            listRunsPage(pool, pipelineId, limit, offset, [secret]),
        listRunEvents: (runId) => listRunEvents(pool, runId, [secret]),
        listReadyRunSuccessDependencies: (limit) =>
            listReadyRunSuccessDependencies(pool, limit),
        listRunEventsAfter: (eventId, limit) =>
            listRunEventsAfter(pool, eventId, limit, [secret]),
        markRunSuccessDependencySubmitted: (sourceRunId, targetRunId) =>
            markRunSuccessDependencySubmitted(pool, sourceRunId, targetRunId),
        operationalSnapshot: () => operationalSnapshot(pool),
        reconcileExpiredLeases: (batchSize) =>
            reconcileExpiredLeases(pool, secret, batchSize),
        releaseLease: (runId, lease) => releaseLease(pool, runId, lease),
        recordRunSuccessDependencyFailure: (sourceRunId, message, nextAttemptAt) =>
            recordRunSuccessDependencyFailure(pool, sourceRunId, message, nextAttemptAt, secret),
        updateLocalCliExecution: (runId, lease, update) =>
            updateLocalCliExecution(pool, runId, lease, update, secret),
        renewLease: (runId, lease, leaseMilliseconds) =>
            renewLease(pool, runId, lease, leaseMilliseconds),
        submitRun: (submission) => submitRun(pool, submission, secret),
    };
}
