/**
 * @fileoverview Layout output for the pipeline asset graph and its edges.
 */

import type { PipelineAssetNode } from './pipelineAssetTypes.ts';
import type {
    PipelineRunNodeStatus,
} from '../../shared/status/node.ts';

/** Asset node enriched with run progress for graph rendering. */
export interface GraphNode extends PipelineAssetNode {
    completedAt?: string;
    duration?: number;
    runStatus?: PipelineRunNodeStatus;
    startedAt?: string;
    status?: string;
}

/** Directed edge connecting two rendered asset nodes. */
export interface GraphEdge {
    sourceId: string;
    targetId: string;
}

/** One informational external card shared by targets in a graph level. */
export interface GraphExternalSource {
    node: GraphNode;
    targetIds: string[];
    targetLevel: number;
}

/** Layered graph geometry used by the pipeline asset renderer. */
export interface GraphLayout {
    edges: GraphEdge[];
    externalSources: GraphExternalSource[];
    /** Graph levels where an external card or label overlaps an upstream node. */
    externalSourceCollisionLevels: number[];
    height: number;
    leftPaddingX: number;
    levels: GraphNode[][];
    width: number;
}
