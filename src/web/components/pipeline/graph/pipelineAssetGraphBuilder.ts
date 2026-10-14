/**
 * @fileoverview Builds graph records from declared pipeline asset operations.
 */

import type { PipelineAssetOperation } from '../../../types/pipelineAssetTypes.ts';
import type { GraphEdge, GraphNode } from '../../../types/pipelineAssetLayoutTypes.ts';
import { pipelineNodeTypeLabel } from '../pipelineCatalogPresentation.ts';

/** Graph records prepared for topology and layout calculations. */
export interface PipelineAssetGraph {
    edges: GraphEdge[];
    externalSourceTargets: Map<string, {
        node: GraphNode;
        targetIds: Set<string>;
    }>;
    nodes: Map<string, GraphNode>;
}

/** Converts operation inputs and outputs into graph nodes, edges, and source targets. */
export function buildPipelineAssetGraph(
    operations: PipelineAssetOperation[],
): PipelineAssetGraph {
    const nodes = new Map<string, GraphNode>();
    const edges: GraphEdge[] = [];
    const externalSourceTargets = new Map<string, {
        node: GraphNode;
        targetIds: Set<string>;
    }>();

    for (const operation of operations) {
        for (const input of operation.inputs) {
            if (input.kind === 'external-source') {
                const source = externalSourceTargets.get(input.id) ?? {
                    node: pipelineAssetNodeWithTypeLabel(input),
                    targetIds: new Set<string>(),
                };
                source.targetIds.add(operation.output.id);
                externalSourceTargets.set(input.id, source);
                continue;
            }

            if (!nodes.has(input.id)) {
                nodes.set(input.id, pipelineAssetNodeWithTypeLabel(input));
            }
            edges.push({
                sourceId: input.id,
                targetId: operation.output.id,
            });
        }

        nodes.set(operation.output.id, {
            ...pipelineAssetNodeWithTypeLabel(operation.output),
            completedAt: operation.completedAt,
            duration: operation.duration,
            runStatus: operation.runStatus,
            startedAt: operation.startedAt,
            status: operation.status,
        });
    }

    return { edges, externalSourceTargets, nodes };
}
function pipelineAssetNodeWithTypeLabel(node: PipelineAssetOperation['output']): GraphNode {
    return {
        ...node,
        typeLabel: node.nodeType == null
            ? node.typeLabel ?? 'Pipeline asset'
            : pipelineNodeTypeLabel(node.nodeType, node.externalKind),
    };
}
