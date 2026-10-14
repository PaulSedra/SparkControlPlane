/**
 * @fileoverview Persistence contracts for discovered pipelines, runs, and audits.
 */

import type {
    PipelineEdge,
    PipelineNode,
    PipelineRun,
    PipelineRunNodeStatusRecord,
    PipelineSpec,
    RunMode,
} from '../../shared/pipelineRegistryTypes.ts';
import type {
    CliExecutionState,
} from '../../shared/status/execution.ts';
import type {
    DeploymentStatus,
} from '../../shared/status/deployment.ts';
import type {
    TerminalRunStatus,
    WorkerActiveRunStatus,
} from '../../shared/status/run.ts';
import type { PipelineRunPolicy } from './pipelineRunPolicyTypes.ts';
import type { TriggerDefinitionInput, TriggerPersistence } from './triggerTypes.ts';

/** Version and validation state recorded when a pipeline is deployed. */
export interface PipelineDeployment {
    deployedAt: string;
    pipelineId: string;
    sourceHash: string;
    status: DeploymentStatus;
    validationMessages: string[];
    versionId: string;
}

/** Pipeline graph and source data produced by discovery before persistence. */
export interface DiscoveredPipeline {
    policy?: PipelineRunPolicy;
    edges: PipelineEdge[];
    name: string;
    nodes: PipelineNode[];
    sourceFiles: string[];
    sourceContents?: Array<{ content: string; sourceFile: string }>;
    sourceHash: string;
    spec: PipelineSpec;
    specContent?: string;
    specPath: string;
    validationMessages: string[];
    versionId: string;
    yamlTriggerDefinitions?: Array<Omit<TriggerDefinitionInput, 'pipelineId'>>;
}

/** Immutable parsed source state used until the operator refreshes the source folder. */
export interface PersistedPipelineSnapshot extends DiscoveredPipeline {
    createdAt: string;
    pipelineId: string;
}

/** Stable pipeline identity and the currently deployed source pointer. */
export interface PersistedPipeline {
    active: boolean;
    policy?: PipelineRunPolicy;
    createdAt: string;
    currentSourceHash: string;
    currentVersionId: string;
    id: string;
    name: string;
    normalizedName: string;
    specPath: string;
    updatedAt: string;
}

/** Run submission fields after discovery has supplied source and version data. */
export interface PersistedRunSubmission {
    callerMetadata?: Record<string, string>;
    correlationId?: string;
    idempotencyKey?: string;
    initialNodeStatuses?: Record<string, PipelineRunNodeStatusRecord>;
    mode: RunMode;
    pipelineId: string;
    repairedNodeNames?: string[];
    targetNodeNames?: string[];
    sourceHash: string;
    policy?: PipelineRunPolicy;
    requestSource?: string;
    sparkAppName: string;
    successorPipelineId?: string;
    versionId: string;
}

/** Durable handoff from a successful parent run to its one configured successor. */
export interface RunSuccessDependency {
    attemptCount: number;
    nextAttemptAt: string;
    sourcePipelineId: string;
    sourceRunId: string;
    targetPipelineId: string;
}

/** Terminal worker result applied to a leased persisted run. */
export interface RunCompletion {
    command: string[];
    endedAt: string;
    exitCode?: number;
    cliState?: CliExecutionState;
    nodeStatuses?: Record<string, PipelineRunNodeStatusRecord>;
    recoveryReason?: string;
    stderr: string;
    stdout: string;
    status: TerminalRunStatus;
    terminalReason?: string;
    leaseLost?: boolean;
}

/** State and output reported by the local stock CLI supervisor. */
export interface LocalCliExecutionUpdate {
    command: string[];
    executionId: string;
    nodeStatuses: Record<string, import('../../shared/pipelineRegistryTypes.ts').PipelineRunNodeStatusRecord>;
    processId?: number;
    reason?: string;
    runDirectory: string;
    runStatus: WorkerActiveRunStatus;
    startedAt?: string;
    state: CliExecutionState;
    stderrOffset: number;
    stderr: string;
    stdoutOffset: number;
    stdout: string;
}

/** Lease identity used to fence concurrent run workers. */
export interface RunLease {
    leaseToken: string;
    ownerId: string;
}

/** Outcome of a fenced persistence mutation. */
export type PersistenceMutationKind =
    | 'ALREADY_TERMINAL'
    | 'APPLIED'
    | 'FENCED'
    | 'MISSING';

/** Persisted run returned after a mutation, when one remains addressable. */
export interface PersistenceMutationResult {
    kind: PersistenceMutationKind;
    run?: PipelineRun;
}

/** Offset page of persisted runs, used by history endpoints without loading all rows. */
export interface PersistedRunPage {
    items: PipelineRun[];
    offset: number;
    total: number;
}

/** Persistence contract for pipeline identities, source versions, and deployments. */
export interface PipelinePersistence {
    deactivatePipelinesNotIn(pipelineIds: string[]): Promise<string[]>;
    ensurePipeline(discovered: DiscoveredPipeline): Promise<PersistedPipeline>;
    getLatestDeployment(pipelineId: string): Promise<PipelineDeployment | undefined>;
    getPipelineSnapshot(
        pipelineId: string,
        versionId?: string,
    ): Promise<PersistedPipelineSnapshot | undefined>;
    getPersistedPipeline(pipelineId: string): Promise<PersistedPipeline | undefined>;
    listCurrentPipelineSnapshots(): Promise<PersistedPipelineSnapshot[]>;
    saveDeployment(deployment: PipelineDeployment, context?: AuditContext): Promise<void>;
}

/** Persistence contract for run submission, execution, leases, and history. */
export interface RunPersistence {
    appendLiveRun(
        runId: string,
        lease: RunLease,
        status: WorkerActiveRunStatus,
        stdout: string,
        nodeStatuses: Record<string, PipelineRunNodeStatusRecord>,
    ): Promise<PersistenceMutationResult>;
    claimNextQueuedRun(ownerId: string, leaseMilliseconds: number): Promise<{
        lease: RunLease;
        run: PipelineRun;
    } | undefined>;
    claimNextRecoverableRun(ownerId: string, leaseMilliseconds: number): Promise<{
        lease: RunLease;
        run: PipelineRun;
    } | undefined>;
    completeRun(
        runId: string,
        lease: RunLease,
        completion: RunCompletion,
    ): Promise<PersistenceMutationResult>;
    getRunByIdempotencyKey(idempotencyKey: string): Promise<PipelineRun | undefined>;
    listReadyRunSuccessDependencies(limit?: number): Promise<RunSuccessDependency[]>;
    markRunSuccessDependencySubmitted(sourceRunId: string, targetRunId: string): Promise<void>;
    recordRunSuccessDependencyFailure(
        sourceRunId: string,
        message: string,
        nextAttemptAt: string,
    ): Promise<void>;
    cancelRun(
        runId: string,
        requestedBy?: string,
        reason?: string,
        context?: AuditContext,
    ): Promise<PipelineRun>;
    failRunBeforeExecution(
        runId: string,
        lease: RunLease,
        message: string,
    ): Promise<PersistenceMutationResult>;
    getLatestRun(pipelineId: string): Promise<PipelineRun | undefined>;
    getRun(runId: string): Promise<PipelineRun | undefined>;
    isCancellationRequested(runId: string): Promise<boolean>;
    listRuns(pipelineId: string): Promise<PipelineRun[]>;
    /** Optional paged run-history query for adapters that can push pagination into storage. */
    listRunsPage?(
        pipelineId: string,
        limit: number,
        offset: number,
    ): Promise<PersistedRunPage>;
    listRunEvents(runId: string): Promise<PipelineRunEvent[]>;
    listRunEventsAfter(eventId: number, limit?: number): Promise<PipelineRunEvent[]>;
    operationalSnapshot(): Promise<OperationalSnapshot>;
    reconcileExpiredLeases(batchSize?: number): Promise<void>;
    releaseLease(runId: string, lease: RunLease): Promise<PersistenceMutationResult>;
    updateLocalCliExecution(
        runId: string,
        lease: RunLease,
        update: LocalCliExecutionUpdate,
    ): Promise<PersistenceMutationResult>;
    renewLease(
        runId: string,
        lease: RunLease,
        leaseMilliseconds: number,
    ): Promise<PersistenceMutationResult>;
    submitRun(submission: PersistedRunSubmission): Promise<
        import('./pipelineServiceTypes.ts').RunSubmissionResult
    >;
}

/** Persistence contract for append-only audit records. */
export interface AuditPersistence {
    listAuditEventsAfter(eventId: number, limit?: number): Promise<PipelineAuditEvent[]>;
    recordAuditEvent(input: PipelineAuditEventInput): Promise<PipelineAuditEvent>;
}

/** Aggregate persistence contract used by the control-plane service. */
export interface ControlPlanePersistence
    extends PipelinePersistence, RunPersistence, AuditPersistence, TriggerPersistence {
    kind: 'memory' | 'postgresql';
    initialize(): Promise<void>;
    isReady(): boolean;
    shutdown(): Promise<void>;
}

/** Persistence operations required to export run and audit history. */
export type HistoryPersistence =
    Pick<RunPersistence, 'getRun' | 'listRunEventsAfter'> &
    Pick<AuditPersistence, 'listAuditEventsAfter'>;

/** Request metadata carried into audit records. */
export interface AuditContext {
    correlationId?: string;
    requestSource?: string;
}

/** Append-only event emitted while a pipeline run progresses. */
export interface PipelineRunEvent {
    correlationId?: string;
    eventId: number;
    eventType: string;
    occurredAt: string;
    payload: Record<string, unknown>;
    runId: string;
    status?: string;
}

/** Input used to append an audit record for a control-plane action. */
export interface PipelineAuditEventInput {
    actor?: string;
    correlationId?: string;
    payload: Record<string, unknown>;
    pipelineId?: string;
    requestSource?: string;
    runId?: string;
    eventType: string;
}

/** Persisted audit record with its database identity and timestamp. */
export interface PipelineAuditEvent extends PipelineAuditEventInput {
    eventId: number;
    occurredAt: string;
}

/** Aggregate queue and worker counts used by operational diagnostics. */
export interface OperationalSnapshot {
    activeRuns: number;
    oldestQueuedAt?: string;
    queuedRuns: number;
    stuckRuns: number;
}
