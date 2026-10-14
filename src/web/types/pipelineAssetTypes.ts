/**
 * @fileoverview Client-side asset and operation models for pipeline graphs.
 */

import type {
    PipelineRunNodeStatus,
} from '../../shared/status/node.ts';
import type {
    ExternalDatasetKind,
    NodeType,
} from '../../shared/pipelineRegistryTypes.ts';
import type {
    PipelineAssetState,
} from '../../shared/status/presentation.ts';

/** Rendering category for a discovered pipeline asset. */
export type PipelineAssetKind = 'command' | 'external-source' | 'path' | 'table' | 'view';

/** Displayable input or output asset in a pipeline operation. */
export interface PipelineAssetNode {
    externalKind?: ExternalDatasetKind;
    id: string;
    kind: PipelineAssetKind;
    label: string;
    nodeType?: NodeType;
    qualifiedName: string;
    /** False only after the Spark catalog confirms this output is absent. */
    sparkTableExists?: boolean;
    sourceFile?: string;
    sourceLine?: number;
    sqlText?: string;
    typeLabel?: string;
}

/** One operation with its inputs, output, lineage confidence, and run state. */
export interface PipelineAssetOperation {
    completedAt?: string;
    confidence?: string;
    duration?: number;
    id: string;
    inputs: PipelineAssetNode[];
    output: PipelineAssetNode;
    runStatus?: PipelineRunNodeStatus;
    status: PipelineAssetState;
    startedAt?: string;
}
