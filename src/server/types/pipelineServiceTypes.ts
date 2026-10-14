/**
 * @fileoverview Service contracts for pipeline discovery, runs, and history.
 */

import type {
    PipelineDetail,
    PipelineNodeData,
    PipelineSourceFile,
    PipelineRun,
    PipelineSummary,
    RunMode,
} from '../../shared/pipelineRegistryTypes.ts';
import type { PostgresConfig } from './postgresConfigTypes.ts';
import type {
    AuditContext,
    OperationalSnapshot,
    ControlPlanePersistence,
    PipelineRunEvent,
} from './pipelinePersistenceTypes.ts';
import type {
    HistoryExportBatch,
    HistoryExportCursor,
} from '../history/historyExport.ts';
import type { PipelineRunPolicy } from './pipelineRunPolicyTypes.ts';
import type { LocalCliRunExecutor } from '../pipeline/execution/runExecution.ts';
import type {
    CanonicalTriggerEvent,
    TriggerDefinition,
    TriggerDefinitionInput,
    TriggerDefinitionPatch,
    TriggerDeadLetter,
    TriggerDeliveryAttempt,
    TriggerEventRecord,
    TriggerIngestionResult,
    TriggerRoutingDecision,
} from './triggerTypes.ts';
import type {
    TriggerDeadLetterStatus,
} from '../../shared/status/trigger.ts';

/** Input accepted when a caller submits a pipeline run. */
export interface RunSubmission {
    callerMetadata?: Record<string, string>;
    correlationId?: string;
    idempotencyKey?: string;
    mode?: RunMode;
    nodeNames?: string[];
    pipelineId: string;
    requestSource?: string;
}
/** Result of a run submission, including whether idempotency replayed a run. */
export interface RunSubmissionResult {
    replayed: boolean;
    run: PipelineRun;
}

/** Optional expansion settings for a pipeline detail response. */
export interface PipelineDetailOptions {
    includeRuns?: boolean;
}

/** Dependencies and runtime settings used by the registry service. */
export interface PipelineRegistryServiceOptions {
    now?: () => number;
    pipelineRunPolicies?: Map<string, PipelineRunPolicy>;
    persistence?: ControlPlanePersistence;
    postgresConfig?: PostgresConfig;
    sparkConnectUrl?: string;
    runExecutor?: LocalCliRunExecutor;
    triggerSchedulerIntervalMilliseconds?: number;
}

/** Cached service state used by frequent liveness and readiness probes. */
export interface PipelineServiceReadinessSnapshot {
    acceptingWork: boolean;
    discoveredPipelineCount: number;
    discoveryReady: boolean;
    initialized: boolean;
    operationalSnapshot?: OperationalSnapshot;
    operationalSnapshotReady: boolean;
    persistenceKind: 'memory' | 'postgresql';
    persistenceReady: boolean;
}

/** Operations exposed by the server's pipeline and trigger registry. */
export interface PipelineRegistryService {
    cancelRun: (
        runId: string,
        requestedBy?: string,
        reason?: string,
        context?: AuditContext,
    ) => Promise<PipelineRun>;
    createTrigger: (input: TriggerDefinitionInput) => Promise<TriggerDefinition>;
    deployPipeline: (pipelineId: string, context?: AuditContext) => Promise<PipelineDetail>;
    getPipeline: (
        pipelineId: string,
        options?: PipelineDetailOptions,
    ) => Promise<PipelineDetail>;
    getPipelineNodeData: (
        pipelineId: string,
        nodeId: string,
    ) => Promise<PipelineNodeData>;
    getPipelineSourceFile: (
        pipelineId: string,
        sourceFile: string,
    ) => Promise<PipelineSourceFile>;
    getRun: (runId: string) => Promise<PipelineRun>;
    getRunSummary: (runId: string) => Promise<PipelineRun>;
    getTrigger: (triggerId: string) => Promise<TriggerDefinition>;
    getTriggerScheduleStatus: (triggerId: string) => Promise<TriggerScheduleStatus>;
    exportHistoryBatch: (
        cursor?: HistoryExportCursor,
        limit?: number,
    ) => Promise<HistoryExportBatch>;
    persistenceKind: () => 'memory' | 'postgresql';
    isPersistenceReady: () => boolean;
    initialize: () => Promise<void>;
    isAcceptingWork: () => boolean;
    readinessSnapshot: () => PipelineServiceReadinessSnapshot;
    listPipelines: () => Promise<PipelineSummary[]>;
    listPipelinesPage: (limit: number, offset: number) => Promise<PipelinePage>;
    refreshPipelinesFromSource: () => Promise<PipelineSummary[]>;
    listPipelineRunsPage: (
        pipelineId: string,
        limit: number,
        offset: number,
    ) => Promise<PipelinePage<PipelineRun>>;
    listRunEventsPage: (
        runId: string,
        limit: number,
        offset: number,
    ) => Promise<PipelinePage<PipelineRunEvent>>;
    listTriggerDeliveryAttempts: (
        triggerId?: string,
        limit?: number,
    ) => Promise<TriggerDeliveryAttempt[]>;
    listTriggerDeadLetters: (
        status?: TriggerDeadLetterStatus,
        limit?: number,
    ) => Promise<TriggerDeadLetter[]>;
    listTriggerEvents: (limit?: number) => Promise<TriggerEventRecord[]>;
    listTriggerRoutingDecisions: (
        eventId?: string,
        triggerId?: string,
        limit?: number,
    ) => Promise<TriggerRoutingDecision[]>;
    listTriggers: () => Promise<TriggerDefinition[]>;
    ingestAistorNotification: (payload: unknown) => Promise<TriggerIngestionResult>;
    ingestTriggerEvent: (event: CanonicalTriggerEvent) => Promise<TriggerIngestionResult>;
    replayTriggerDeadLetter: (deadLetterId: string) => Promise<TriggerIngestionResult>;
    discardTriggerDeadLetter: (deadLetterId: string) => Promise<TriggerDeadLetter>;
    operationalSnapshot: () => Promise<OperationalSnapshot>;
    shutdown: (drainMilliseconds: number) => Promise<void>;
    submitRun: (submission: RunSubmission) => Promise<RunSubmissionResult>;
    updateTrigger: (
        triggerId: string,
        patch: TriggerDefinitionPatch,
    ) => Promise<TriggerDefinition>;
}

/** Scheduled occurrence and last-outcome information for one trigger. */
export interface TriggerScheduleStatus {
    lastOccurrenceAt?: string;
    lastOutcome?: TriggerDefinition['lastOutcome'];
    nextOccurrenceAt?: string;
    triggerId: string;
}

/** Offset-based page returned by list endpoints. */
export interface PipelinePage<T = PipelineSummary> {
    items: T[];
    nextOffset?: number;
    offset: number;
    total: number;
}
