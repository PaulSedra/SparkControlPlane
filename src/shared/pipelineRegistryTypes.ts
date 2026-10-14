/**
 * @fileoverview Shared contracts for discovered pipelines, graph lineage, and
 * persisted run state exchanged by the server and web application.
 */

import type {
    CliExecutionState,
    SparkExecutionState,
} from './status/execution.ts';
import type { DeploymentStatus } from './status/deployment.ts';
import type { PipelineRunNodeStatus } from './status/node.ts';
import type { RunStatus } from './status/run.ts';

/** Identifies the Spark or external node kind displayed in a pipeline graph. */
export type NodeType =
    | 'MATERIALIZED_VIEW'
    | 'STREAMING_TABLE'
    | 'TEMPORARY_VIEW'
    | 'SINK'
    | 'FLOW'
    | 'EXTERNAL_DATASET';

/** Distinguishes external table references from external URI inputs. */
export type ExternalDatasetKind = 'SOURCE' | 'TABLE';

/** Confidence assigned to an inferred graph edge. */
export type EdgeConfidence = 'LOW' | 'UNKNOWN';

/** Selects the execution or refresh behavior requested for a pipeline run. */
export type RunMode =
    | 'incremental'
    | 'full-refresh-all'
    | 'repair-failed'
    | 'dry-run'
    | 'refresh-selected'
    | 'full-refresh-selected';

/** Pipeline settings discovered from a `resources/<name>.pipeline.yaml` spec. */
export interface PipelineSpec {
    catalog?: string;
    database?: string;
    libraries: string[];
    name: string;
    onSuccess?: { pipeline: string };
    schema?: string;
    specPath: string;
    storage: string;
    timeoutSeconds?: number;
}

/** Lightweight pipeline record used by catalog and list responses. */
export interface PipelineSummary {
    currentVersionId?: string;
    id: string;
    lastRun?: PipelineRun;
    name: string;
    nodeCount: number;
    recentRuns: PipelineRun[];
    sourceHash: string;
    specPath: string;
    status: DeploymentStatus;
    updatedAt?: string;
}

/** Full pipeline response containing source, graph, validation, and run data. */
export interface PipelineDetail extends PipelineSummary {
    edges: PipelineEdge[];
    sourceFiles: string[];
    spec: PipelineSpec;
    validationMessages: string[];
    nodes: PipelineNode[];
    runs: PipelineRun[];
}

/** Persisted and runtime state for one submitted pipeline run. */
export interface PipelineRun {
    allowOverlap?: boolean;
    callerMetadata?: Record<string, string>;
    command?: string[];
    correlationId?: string;
    endedAt?: string;
    exitCode?: number;
    idempotencyKey?: string;
    leaseLost?: boolean;
    mode: RunMode;
    pipelineId: string;
    repairedNodeNames?: string[];
    targetNodeNames?: string[];
    recoveryReason?: string;
    cliExecutionId?: string;
    cliState?: CliExecutionState;
    cliProcessId?: number;
    cliRunDirectory?: string;
    cliStartedAt?: string;
    cliStdoutOffset?: number;
    cliStderrOffset?: number;
    requestSource?: string;
    runId: string;
    sourceHash?: string;
    sparkAppName: string;
    sparkExecutionState?: SparkExecutionState;
    sparkLastResponseId?: string;
    sparkOperationId?: string;
    sparkSessionId?: string;
    sparkStageProgress?: SparkStageProgressRecord;
    startedAt: string;
    nodeStatuses?: Record<string, PipelineRunNodeStatusRecord>;
    status: RunStatus;
    stderr?: string;
    stdout?: string;
    terminalEventAt?: string;
    terminalReason?: string;
    versionId?: string;
    timeoutSeconds?: number;
}

/** Aggregated Spark stage progress reported while a run is monitored. */
export interface SparkStageProgressRecord {
    activeStages?: number;
    completedStages: number;
    numInflightTasks?: number;
    observedAt: string;
    totalStages: number;
}

/** Persisted lifecycle state for one node within a pipeline run. */
export interface PipelineRunNodeStatusRecord {
    completedAt?: string;
    durationMs?: number;
    lastUpdatedAt: string;
    qualifiedName: string;
    startedAt?: string;
    status: PipelineRunNodeStatus;
}

/**
 * Normalizes a pipeline node name emitted in Spark lifecycle messages.
 *
 * Spark may wrap a qualified flow name in matching single or double quotes in
 * one event message and omit them in another event for the same logical node.
 * Removing only those outer delimiters keeps retries under one persisted node
 * identity without changing names that contain internal quoting.
 */
export function normalizePipelineNodeName(value: string): string {
    if (value.length < 2) {
        return value;
    }

    const first = value[0];
    const last = value.at(-1);
    if ((first === "'" && last === "'") || (first === '"' && last === '"')) {
        return value.slice(1, -1);
    }

    return value;
}

/** Bounded data returned when a pipeline node is previewed. */
export interface PipelineNodeData {
    columns: Array<{ name: string; type: string }>;
    rows: unknown[][];
}

/** Source language used to render a discovered pipeline file. */
export type PipelineSourceLanguage = 'python' | 'sql' | 'text';

/** Source file content and metadata associated with a discovered pipeline. */
export interface PipelineSourceFile {
    content: string;
    language: PipelineSourceLanguage;
    path: string;
}

/** A discovered pipeline node and its optional source location. */
export interface PipelineNode {
    externalKind?: ExternalDatasetKind;
    id: string;
    name: string;
    nodeType: NodeType;
    qualifiedName: string;
    sourceFile?: string;
    sourceLine?: number;
    sqlText?: string;
}

/** A directed lineage edge between two discovered pipeline nodes. */
export interface PipelineEdge {
    confidence: EdgeConfidence;
    evidence: string;
    id: string;
    sourceExpression: string;
    sourceNodeId: string;
    targetNodeId: string;
}
