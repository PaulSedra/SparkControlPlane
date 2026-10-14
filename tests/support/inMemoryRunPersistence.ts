/**
 * @fileoverview In-memory run persistence used by unit and contract tests.
 */

import crypto from 'node:crypto';
import { ControlPlaneApiError } from '../../src/server/errors/controlPlaneApiError.ts';
import { normalizeTerminalNodeStatuses } from '../../src/server/persistence/run/postgresRunMappers.ts';
import type {
    PipelineRun,
} from '../../src/shared/pipelineRegistryTypes.ts';
import type {
    AuditContext,
    LocalCliExecutionUpdate,
    PersistenceMutationResult,
    PipelineDeployment,
    PipelineRunEvent,
    RunLease,
    RunPersistence,
    RunSuccessDependency,
} from '../../src/server/types/pipelinePersistenceTypes.ts';
import type { RunSubmissionResult } from '../../src/server/types/pipelineServiceTypes.ts';
import { sanitizeCommand, sanitizeText } from '../../src/server/utils/sanitization.ts';
import { logStructured } from '../../src/server/utils/structuredLogging.ts';

/** Configuration for deterministic in-memory run persistence. */
export interface InMemoryRunPersistenceOptions {
    getDeploymentForRun: (pipelineId: string, versionId: string) => PipelineDeployment | undefined;
    now?: () => number;
}

/**
 * Creates isolated run state for tests without PostgreSQL. Run submission
 * validates deployment through the injected pipeline-store lookup; callers can
 * inject `now` to make lease expiry and lifecycle timestamps deterministic.
 */
export function createInMemoryRunPersistence(
    options: InMemoryRunPersistenceOptions,
): RunPersistence {
    const now = options.now ?? (() => Date.now());
    const getDeploymentForRun = options.getDeploymentForRun;
    const runs: PipelineRun[] = [];
    const idempotency = new Map<string, { fingerprint: string; runId: string }>();
    const successDependencies = new Map<string, {
        dependency: RunSuccessDependency;
        status: 'WAITING' | 'READY' | 'SUBMITTED' | 'SKIPPED';
        targetRunId?: string;
    }>();
    const leases = new Map<string, { lease: RunLease; expiresAt: number }>();
    const cancellations = new Map<string, { reason: string; effectiveAt?: string }>();
    const events = new Map<string, PipelineRunEvent[]>();
    let nextEventId = 1;
    const persistence: RunPersistence = {
        async appendLiveRun(runId, lease, status, stdout, nodeStatuses) {
            const run = findRun(runId);
            if (run == null) {
                return mutation('MISSING');
            }
            if (isTerminal(run)) {
                return mutation('ALREADY_TERMINAL', run);
            }
            if (!ownsLease(runId, lease)) {
                return mutation('FENCED');
            }
            Object.assign(run, { nodeStatuses, status, stdout: sanitizeText(stdout) });
            appendEvent(runId, 'OUTPUT', status, {
                nodeCount: Object.keys(nodeStatuses).length,
                stdoutLength: sanitizeText(stdout).length,
            }, {
                correlationId: run.correlationId,
                requestSource: run.requestSource,
            });
            return mutation('APPLIED', run);
        },
        async claimNextQueuedRun(ownerId, leaseMilliseconds) {
            const run = runs.find((item) =>
                item.status === 'QUEUED' && !cancellations.has(item.runId) &&
                !runs.some((active) => active.pipelineId === item.pipelineId &&
                    (active.status === 'SUBMITTING' || active.status === 'RUNNING'))
            );
            if (run == null) {
                return undefined;
            }
            const lease = { leaseToken: crypto.randomUUID(), ownerId };
            leases.set(run.runId, {
                expiresAt: now() + Math.max(1_000, leaseMilliseconds),
                lease,
            });
            run.status = 'SUBMITTING';
            appendEvent(run.runId, 'RUN_CLAIMED', 'SUBMITTING', {
                leaseExpiresAt: new Date(leases.get(run.runId)!.expiresAt).toISOString(),
                ownerId,
            }, {
                correlationId: run.correlationId,
                requestSource: run.requestSource,
            });
            return { lease, run: cloneRun(run) };
        },
        async claimNextRecoverableRun(ownerId, leaseMilliseconds) {
            const currentTime = now();
            const run = runs.find((item) => {
                if ((item.status !== 'SUBMITTING' && item.status !== 'RUNNING') ||
                    item.cliExecutionId == null) {
                    return false;
                }
                const existing = leases.get(item.runId);
                return existing == null || existing.expiresAt <= currentTime;
            });
            if (run == null) {
                return undefined;
            }
            const lease = { leaseToken: crypto.randomUUID(), ownerId };
            leases.set(run.runId, {
                expiresAt: currentTime + Math.max(1_000, leaseMilliseconds),
                lease,
            });
            appendEvent(run.runId, 'LOCAL_CLI_RECOVERY_CLAIMED', run.status, {
                leaseExpiresAt: new Date(leases.get(run.runId)!.expiresAt).toISOString(),
                ownerId,
                cliExecutionId: run.cliExecutionId,
                cliProcessId: run.cliProcessId,
            }, {
                correlationId: run.correlationId,
                requestSource: run.requestSource,
            });
            return { lease, run: cloneRun(run) };
        },
        async completeRun(runId, lease, completion) {
            const run = findRun(runId);
            if (run == null) {
                return mutation('MISSING');
            }
            if (isTerminal(run)) {
                return mutation('ALREADY_TERMINAL', run);
            }
            if (!ownsLease(runId, lease)) {
                return mutation('FENCED');
            }
            const cancellation = cancellations.get(runId);
            const activeCancellation = cancellation != null && cancellation.effectiveAt == null &&
                completion.status !== 'UNKNOWN';
            const safeCompletion = {
                ...completion,
                command: sanitizeCommand(completion.command),
                stderr: sanitizeText(completion.stderr),
                stdout: sanitizeText(completion.stdout),
            };
            const nodeStatuses = {
                ...(run.nodeStatuses ?? {}),
                ...(safeCompletion.nodeStatuses ?? {}),
            };
            Object.assign(run, activeCancellation
                ? {
                    ...safeCompletion,
                    endedAt: safeCompletion.endedAt,
                    exitCode: 130,
                    status: 'CANCELED',
                    stderr: sanitizeText([safeCompletion.stderr, cancellation.reason].filter(Boolean).join('\n')),
                    terminalEventAt: safeCompletion.endedAt,
                    terminalReason: completion.terminalReason ?? cancellation.reason,
                }
                : {
                    ...safeCompletion,
                    terminalEventAt: safeCompletion.endedAt,
                });
            run.nodeStatuses = Object.keys(nodeStatuses).length === 0
                ? undefined
                : normalizeTerminalNodeStatuses(run.status, nodeStatuses, safeCompletion.endedAt);
            if (activeCancellation) {
                cancellation.effectiveAt = completion.endedAt;
            }
            appendEvent(runId, run.status, run.status, { exitCode: completion.exitCode }, {
                correlationId: run.correlationId,
                requestSource: run.requestSource,
            });
            leases.delete(runId);
            updateSuccessDependency(runId, run.status === 'SUCCEEDED' && run.mode !== 'dry-run');
            return mutation('APPLIED', run);
        },
        async cancelRun(runId, _requestedBy, reason, context?: AuditContext) {
            const run = requireRun(runId);
            if (['SUCCEEDED', 'FAILED', 'CANCELED', 'TIMED_OUT', 'UNKNOWN'].includes(run.status)) {
                return cloneRun(run);
            }
            const cancellation = cancellations.get(runId) ?? {
                reason: sanitizeText(reason?.trim() || 'Cancellation requested by the caller.'),
            };
            cancellations.set(runId, cancellation);
            if (run.status === 'QUEUED') {
                Object.assign(run, {
                    endedAt: new Date().toISOString(),
                    exitCode: 130,
                    status: 'CANCELED',
                    stderr: cancellation.reason,
                    terminalEventAt: new Date().toISOString(),
                    terminalReason: cancellation.reason,
                });
                cancellation.effectiveAt = run.endedAt;
                updateSuccessDependency(runId, false);
                appendEvent(runId, 'CANCELED', 'CANCELED', { reason: cancellation.reason }, context);
            } else {
                appendEvent(runId, 'CANCELLATION_REQUESTED', run.status, { reason: cancellation.reason }, context);
            }
            return cloneRun(run);
        },
        async failRunBeforeExecution(runId, lease, message) {
            const run = findRun(runId);
            if (run == null) {
                return mutation('MISSING');
            }
            if (isTerminal(run)) {
                return mutation('ALREADY_TERMINAL', run);
            }
            if (!ownsLease(runId, lease)) {
                return mutation('FENCED');
            }
            Object.assign(run, {
                endedAt: new Date().toISOString(),
                exitCode: 1,
                status: 'FAILED',
                stderr: sanitizeText(message),
                terminalEventAt: new Date().toISOString(),
                terminalReason: 'PREPARATION',
            });
            appendEvent(runId, 'FAILED', 'FAILED', { reason: 'PREPARATION' }, {
                correlationId: run.correlationId,
                requestSource: run.requestSource,
            });
            leases.delete(runId);
            updateSuccessDependency(runId, false);
            return mutation('APPLIED', run);
        },
        async getLatestRun(pipelineId) {
            return [...runs].reverse().find((run) => run.pipelineId === pipelineId);
        },
        async getRun(runId) {
            const run = runs.find((item) => item.runId === runId);
            return run == null ? undefined : cloneRun(run);
        },
        async getRunByIdempotencyKey(idempotencyKey) {
            const existing = idempotency.get(idempotencyKey);
            const run = existing == null ? undefined : findRun(existing.runId);
            return run == null ? undefined : cloneRun(run);
        },
        async listReadyRunSuccessDependencies(limit = 20) {
            return [...successDependencies.values()]
                .filter((item) => item.status === 'READY' &&
                    Date.parse(item.dependency.nextAttemptAt) <= now())
                .sort((left, right) =>
                    left.dependency.nextAttemptAt.localeCompare(right.dependency.nextAttemptAt) ||
                    left.dependency.sourceRunId.localeCompare(right.dependency.sourceRunId))
                .slice(0, boundedLimit(limit))
                .map((item) => ({ ...item.dependency }));
        },
        async markRunSuccessDependencySubmitted(sourceRunId, targetRunId) {
            const dependency = successDependencies.get(sourceRunId);
            if (dependency == null) {
                throw new Error(`Unknown pipeline success dependency for run ${sourceRunId}.`);
            }
            if (dependency.status === 'SUBMITTED' && dependency.targetRunId === targetRunId) {
                return;
            }
            if (dependency.status !== 'READY') {
                throw new Error(`Pipeline success dependency for run ${sourceRunId} is ${dependency.status}.`);
            }
            const targetRun = requireRun(targetRunId);
            if (targetRun.pipelineId !== dependency.dependency.targetPipelineId) {
                throw new Error(`Pipeline success dependency for run ${sourceRunId} targeted the wrong pipeline.`);
            }
            dependency.status = 'SUBMITTED';
            dependency.targetRunId = targetRunId;
        },
        async recordRunSuccessDependencyFailure(sourceRunId, _message, nextAttemptAt) {
            const dependency = successDependencies.get(sourceRunId);
            if (dependency == null || dependency.status !== 'READY') {
                return;
            }
            dependency.dependency.attemptCount += 1;
            dependency.dependency.nextAttemptAt = nextAttemptAt;
        },
        async isCancellationRequested(runId) {
            const run = runs.find((item) => item.runId === runId);
            return run?.status === 'SUBMITTING' || run?.status === 'RUNNING'
                ? cancellations.get(runId)?.effectiveAt == null && cancellations.has(runId)
                : false;
        },
        async listRuns(pipelineId) {
            return runs
                .filter((run) => run.pipelineId === pipelineId)
                .reverse()
                .map(cloneRun);
        },
        async listRunEvents(runId) {
            return (events.get(runId) ?? []).map((event) => ({
                ...event,
                payload: { ...event.payload },
            }));
        },
        async listRunEventsAfter(eventId, limit = 100) {
            return Array.from(events.values())
                .flat()
                .filter((event) => event.eventId > eventId)
                .sort((left, right) => left.eventId - right.eventId)
                .slice(0, boundedLimit(limit))
                .map((event) => ({ ...event, payload: { ...event.payload } }));
        },
        async operationalSnapshot() {
            const queued = runs.filter((run) => run.status === 'QUEUED');
            const active = runs.filter((run) => run.status === 'SUBMITTING' || run.status === 'RUNNING');
            const currentTime = now();
            return {
                activeRuns: active.length,
                oldestQueuedAt: queued[0]?.startedAt,
                queuedRuns: queued.length,
                stuckRuns: active.filter((run) => run.timeoutSeconds != null &&
                    currentTime - Date.parse(run.startedAt) > run.timeoutSeconds * 1000).length,
            };
        },
        async reconcileExpiredLeases(batchSize = 100) {
            reconcileExpiredLeaseBatch(batchSize);
        },
        async releaseLease(runId, lease) {
            const run = findRun(runId);
            if (run == null) {
                return mutation('MISSING');
            }
            const existing = leases.get(runId);
            if (existing != null && existing.expiresAt > now() &&
                existing.lease.ownerId === lease.ownerId &&
                existing.lease.leaseToken === lease.leaseToken) {
                leases.delete(runId);
                return mutation('APPLIED', run);
            }
            return isTerminal(run) ? mutation('ALREADY_TERMINAL', run) : mutation('FENCED');
        },
        async updateLocalCliExecution(runId, lease, update: LocalCliExecutionUpdate) {
            const run = findRun(runId);
            if (run == null) {
                return mutation('MISSING');
            }
            if (isTerminal(run)) {
                return mutation('ALREADY_TERMINAL', run);
            }
            if (!ownsLease(runId, lease)) {
                return mutation('FENCED');
            }
            if (run.cliExecutionId != null && run.cliExecutionId !== update.executionId) {
                throw new Error('Local CLI execution identity cannot change after a run is submitted.');
            }
            const previousState = run.cliState;
            const outputChanged = run.stdout !== update.stdout || run.stderr !== update.stderr;
            Object.assign(run, {
                cliExecutionId: update.executionId,
                cliState: update.state,
                cliProcessId: update.processId ?? run.cliProcessId,
                cliRunDirectory: update.runDirectory,
                cliStartedAt: update.startedAt ?? run.cliStartedAt,
                cliStdoutOffset: Math.max(run.cliStdoutOffset ?? 0, update.stdoutOffset),
                cliStderrOffset: Math.max(run.cliStderrOffset ?? 0, update.stderrOffset),
                command: sanitizeCommand(update.command),
                status: run.status === 'RUNNING' ? 'RUNNING' : update.runStatus,
                stderr: update.stderr,
                stdout: update.stdout,
            });
            if (update.state === 'UNKNOWN') {
                run.recoveryReason ??= update.reason ?? 'LOCAL_CLI_STATE_UNKNOWN';
                run.terminalReason ??= update.reason ?? 'LOCAL_CLI_STATE_UNKNOWN';
            }
            Object.assign(run.nodeStatuses ??= {}, update.nodeStatuses);
            if (previousState !== update.state) {
                appendEvent(runId, 'LOCAL_CLI_STATE', update.state, {
                    executionId: update.executionId,
                    processId: update.processId,
                    reason: update.reason,
                    state: update.state,
                }, {
                    correlationId: run.correlationId,
                    requestSource: run.requestSource,
                });
            }
            if (outputChanged) {
                appendEvent(runId, 'OUTPUT', update.runStatus, {
                    nodeCount: Object.keys(update.nodeStatuses).length,
                    stderrLength: update.stderr.length,
                    stdoutLength: update.stdout.length,
                }, {
                    correlationId: run.correlationId,
                    requestSource: run.requestSource,
                });
            }
            return mutation('APPLIED', run);
        },
        async renewLease(runId, lease, leaseMilliseconds) {
            const run = findRun(runId);
            if (run == null) {
                return mutation('MISSING');
            }
            if (isTerminal(run)) {
                return mutation('ALREADY_TERMINAL', run);
            }
            const existing = leases.get(runId);
            if (existing == null || existing.lease.ownerId !== lease.ownerId ||
                existing.lease.leaseToken !== lease.leaseToken || existing.expiresAt <= now()) {
                return mutation('FENCED');
            }
            existing.expiresAt = now() + Math.max(1_000, leaseMilliseconds);
            return mutation('APPLIED', run);
        },
        async submitRun(submission): Promise<RunSubmissionResult> {
            const fingerprint = JSON.stringify({
                callerMetadata: submission.callerMetadata ?? {},
                mode: submission.mode,
                pipelineId: submission.pipelineId,
                repairedNodeNames: submission.repairedNodeNames ?? [],
                targetNodeNames: submission.targetNodeNames ?? [],
                requestSource: submission.requestSource,
                sourceHash: submission.sourceHash,
                successorPipelineId: submission.successorPipelineId ?? null,
                versionId: submission.versionId,
            });
            if (submission.successorPipelineId === submission.pipelineId) {
                throw new ControlPlaneApiError(400, 'A pipeline cannot be its own on_success successor.');
            }
            if (submission.idempotencyKey != null) {
                const existing = idempotency.get(submission.idempotencyKey);
                if (existing != null) {
                    if (existing.fingerprint !== fingerprint) {
                        throw new ControlPlaneApiError(
                            409,
                            'The idempotency key was already used for a different pipeline run request.',
                        );
                    }
                    return { replayed: true, run: cloneRun(requireRun(existing.runId)) };
                }
            }
            const deployment = getDeploymentForRun(submission.pipelineId, submission.versionId);
            if (deployment == null) {
                throw new ControlPlaneApiError(409, 'Deploy this pipeline before running it.');
            }
            if (deployment.sourceHash !== submission.sourceHash) {
                throw new ControlPlaneApiError(
                    409,
                    'Pipeline source has changed since deployment. Deploy the current version before running it.',
                );
            }
            const runId = crypto.randomUUID();
            const run: PipelineRun = {
                allowOverlap: submission.policy?.allowOverlap ?? false,
                callerMetadata: submission.callerMetadata,
                correlationId: submission.correlationId,
                idempotencyKey: submission.idempotencyKey,
                mode: submission.mode,
                pipelineId: submission.pipelineId,
                repairedNodeNames: submission.repairedNodeNames,
                targetNodeNames: submission.targetNodeNames,
                requestSource: submission.requestSource,
                runId,
                sourceHash: submission.sourceHash,
                sparkAppName: submission.sparkAppName,
                startedAt: new Date().toISOString(),
                status: 'QUEUED',
                versionId: submission.versionId,
                ...(submission.policy?.timeoutSeconds == null
                    ? {}
                    : { timeoutSeconds: submission.policy.timeoutSeconds }),
            };
            run.nodeStatuses = submission.initialNodeStatuses;
            runs.push(run);
            if (submission.successorPipelineId != null) {
                const createdAt = new Date(now()).toISOString();
                successDependencies.set(runId, {
                    dependency: {
                        attemptCount: 0,
                        nextAttemptAt: createdAt,
                        sourcePipelineId: submission.pipelineId,
                        sourceRunId: runId,
                        targetPipelineId: submission.successorPipelineId,
                    },
                    status: 'WAITING',
                });
            }
            appendEvent(run.runId, 'QUEUED', 'QUEUED', {
                mode: run.mode,
                sourceHash: run.sourceHash,
            }, {
                correlationId: run.correlationId,
                requestSource: run.requestSource,
            });
            if (submission.idempotencyKey != null) {
                idempotency.set(submission.idempotencyKey, {
                    fingerprint,
                    runId: run.runId,
                });
            }
            return { replayed: false, run: cloneRun(run) };
        },
    };

    return persistence;

    function reconcileExpiredLeaseBatch(batchSize: number): void {
        const currentTime = now();
        const maximumRecoveryCount = Math.max(1, Math.floor(batchSize));
        let recovered = 0;
        for (const [runId, lease] of leases) {
            if (recovered >= maximumRecoveryCount) {
                break;
            }
            if (lease.expiresAt <= currentTime && recoverExpiredLease(runId)) {
                recovered += 1;
            }
        }
    }

    function recoverExpiredLease(runId: string): boolean {
        const run = findRun(runId);
        if (run == null || isTerminal(run)) {
            leases.delete(runId);
            return false;
        }
        if (run.cliExecutionId != null) {
            return false;
        }

        const hasLegacyExecutionIdentity = run.sparkOperationId != null ||
            run.sparkSessionId != null;
        const recoveryReason = hasLegacyExecutionIdentity
            ? 'LOCAL_CLI_IDENTITY_UNAVAILABLE'
            : 'LEASE_EXPIRED';
        const status: PipelineRun['status'] = hasLegacyExecutionIdentity
            ? 'UNKNOWN'
            : 'FAILED';
        const endedAt = new Date().toISOString();
        Object.assign(run, {
            endedAt,
            exitCode: hasLegacyExecutionIdentity ? undefined : 1,
            leaseLost: true,
            recoveryReason,
            status,
            stderr: sanitizeText(hasLegacyExecutionIdentity
                ? 'The previous execution identity cannot be monitored by the local CLI runtime; the outcome is unknown.'
                : 'The worker lease expired before a local CLI execution was recorded; run classified as abandoned.'),
            terminalEventAt: endedAt,
            terminalReason: recoveryReason,
        });
        if (run.nodeStatuses != null) {
            run.nodeStatuses = normalizeTerminalNodeStatuses(status, run.nodeStatuses, endedAt);
        }
        appendEvent(runId, hasLegacyExecutionIdentity ? 'UNKNOWN' : 'ABANDONED', status, {
            reason: recoveryReason,
        }, {
            correlationId: run.correlationId,
            requestSource: run.requestSource,
        });
        updateSuccessDependency(runId, false);
        logStructured('run_recovered', {
            correlationId: run.correlationId,
            reason: recoveryReason,
            requestSource: run.requestSource,
            runId,
        });
        leases.delete(runId);
        return true;
    }

    function requireRun(runId: string): PipelineRun {
        const run = findRun(runId);
        if (run == null) {
            throw new ControlPlaneApiError(404, `Unknown pipeline run: ${runId}`);
        }
        return run;
    }

    function findRun(runId: string): PipelineRun | undefined {
        return runs.find((item) => item.runId === runId);
    }

    function ownsLease(runId: string, lease: RunLease): boolean {
        const existing = leases.get(runId);
        return existing != null && existing.expiresAt > now() &&
            existing.lease.ownerId === lease.ownerId &&
            existing.lease.leaseToken === lease.leaseToken;
    }

    function updateSuccessDependency(runId: string, succeeded: boolean): void {
        const dependency = successDependencies.get(runId);
        if (dependency == null || dependency.status !== 'WAITING') {
            return;
        }
        dependency.status = succeeded ? 'READY' : 'SKIPPED';
        dependency.dependency.nextAttemptAt = new Date(now()).toISOString();
    }

    function appendEvent(
        runId: string,
        eventType: string,
        status: string,
        payload: Record<string, unknown>,
        context?: AuditContext,
    ): void {
        const event: PipelineRunEvent = {
            correlationId: context?.correlationId,
            eventId: nextEventId++,
            eventType,
            occurredAt: new Date().toISOString(),
            payload,
            runId,
            status,
        };
        events.set(runId, [...(events.get(runId) ?? []), event]);
    }
}

function isTerminal(run: PipelineRun): boolean {
    return ['SUCCEEDED', 'FAILED', 'CANCELED', 'TIMED_OUT', 'UNKNOWN'].includes(run.status);
}

function mutation(
    kind: PersistenceMutationResult['kind'],
    run?: PipelineRun,
): PersistenceMutationResult {
    return { kind, run: run == null ? undefined : cloneRun(run) };
}

function cloneRun(run: PipelineRun): PipelineRun {
    return JSON.parse(JSON.stringify(run)) as PipelineRun;
}

function boundedLimit(value: number): number {
    return Math.min(1000, Math.max(1, Math.floor(value)));
}
