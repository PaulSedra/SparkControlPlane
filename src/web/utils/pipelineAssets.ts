/**
 * @fileoverview Builds declared pipeline asset operations from registry lineage.
 */

import type {
    PipelineDetail,
    PipelineNode,
    NodeType,
    PipelineRun,
    PipelineRunNodeStatusRecord,
} from '../../shared/pipelineRegistryTypes.ts';
import { normalizePipelineNodeName } from '../../shared/pipelineRegistryTypes.ts';
import {
    PIPELINE_RUN_NODE_STATUS_PRIORITY,
    PipelineRunNodeStatus,
} from '../../shared/status/node.ts';
import {
    PipelineAssetState,
    StatusPresentationState,
    pipelineAssetStateForIncomingFlows,
    statusPresentationForPipelineNodeStatus,
} from '../../shared/status/presentation.ts';
import type {
    PipelineAssetKind,
    PipelineAssetNode,
    PipelineAssetOperation,
} from '../types/pipelineAssetTypes.ts';

/**
 * Returns declared data outputs suitable for the Tables and Performance tabs.
 * External sources and flows remain useful lineage, but are not output tables.
 */
export function pipelineTableNodes(nodes: readonly PipelineNode[]): PipelineNode[] {
    return nodes.filter((node) =>
        node.nodeType !== 'EXTERNAL_DATASET' && node.nodeType !== 'FLOW');
}

/** Counts graph outputs while excluding lineage-only flow nodes. */
export function pipelineAssetCount(
    operations: readonly PipelineAssetOperation[],
): number {
    return operations.filter((operation) =>
        operation.output.kind !== 'command').length;
}

/**
 * Builds the declared asset graph and overlays the selected run's node state.
 *
 * External datasets appear as lineage inputs but are not emitted as
 * declared output operations. Timing, status, and confidence are
 * copied only when the registry/run evidence supplies them, leaving unknown
 * values unavailable rather than inventing success or metrics. Streaming-table
 * targets without their own run record derive state from incoming flows: a
 * success requires every incoming flow to have completed.
 */
export function declaredPipelineOperations(
    pipeline: PipelineDetail,
    run: PipelineRun | undefined = pipeline.lastRun,
): PipelineAssetOperation[] {
    const nodesById = new Map(pipeline.nodes.map((node) => [node.id, node]));
    const edgesByTarget = new Map<string, PipelineAssetNode[]>();
    const nodeStatuses = normalizedNodeStatuses(run?.nodeStatuses);

    for (const edge of pipeline.edges) {
        const source = nodesById.get(edge.sourceNodeId);
        if (source == null) {
            continue;
        }

        const inputs = edgesByTarget.get(edge.targetNodeId) ?? [];
        inputs.push(pipelineAssetNodeFromRegistryNode(source));
        edgesByTarget.set(edge.targetNodeId, inputs);
    }

    return pipeline.nodes
        .filter((node) => node.nodeType !== 'EXTERNAL_DATASET')
        .map((node) => {
            const statusRecord = nodeStatuses.get(node.qualifiedName);
            const inputs = edgesByTarget.get(node.id) ?? [];
            return {
                completedAt: statusRecord?.completedAt,
                confidence: confidenceForNode(pipeline, node.id),
                duration: statusRecord?.durationMs,
                id: `declared-${node.id}`,
                inputs,
                output: pipelineAssetNodeFromRegistryNode(node),
                runStatus: statusRecord?.status,
                startedAt: statusRecord?.startedAt,
                status: assetStatusForNodeRun(
                    node,
                    statusRecord,
                    inputs,
                    nodesById,
                    nodeStatuses,
                    run?.status,
                ),
            };
        });
}

function assetStatusForNodeRun(
    node: PipelineNode,
    nodeStatus: PipelineRunNodeStatusRecord | undefined,
    inputs: PipelineAssetNode[],
    nodesById: ReadonlyMap<string, PipelineNode>,
    nodeStatuses: ReadonlyMap<string, PipelineRunNodeStatusRecord>,
    runStatus?: PipelineRun['status'],
): PipelineAssetState {
    const status = statusPresentationForPipelineNodeStatus(
        nodeStatus?.status,
        runStatus,
        nodeStatus?.completedAt,
    );
    if (nodeStatus?.status === PipelineRunNodeStatus.UNKNOWN) {
        return PipelineAssetState.UNKNOWN;
    }
    if (status != null && status !== StatusPresentationState.UNKNOWN) {
        return status;
    }

    return statusForIncomingFlows(node, inputs, nodesById, nodeStatuses, runStatus) ??
        PipelineAssetState.DEFINED;
}

function statusForIncomingFlows(
    node: PipelineNode,
    inputs: PipelineAssetNode[],
    nodesById: ReadonlyMap<string, PipelineNode>,
    nodeStatuses: ReadonlyMap<string, PipelineRunNodeStatusRecord>,
    runStatus?: PipelineRun['status'],
): StatusPresentationState | undefined {
    if (node.nodeType !== 'STREAMING_TABLE') {
        return undefined;
    }

    const flowNodes = inputs
        .map((input) => nodesById.get(input.id))
        .filter((input): input is PipelineNode => input?.nodeType === 'FLOW');
    if (flowNodes.length === 0) {
        return undefined;
    }

    const flowStatuses = flowNodes.map((flow) => {
        const flowStatus = nodeStatuses.get(flow.qualifiedName);
        return flowStatus == null
            ? undefined
            : statusPresentationForPipelineNodeStatus(
                flowStatus.status,
                runStatus,
                flowStatus.completedAt,
            );
    });
    return pipelineAssetStateForIncomingFlows(flowStatuses);
}

function normalizedNodeStatuses(
    nodeStatuses: PipelineRun['nodeStatuses'],
): ReadonlyMap<string, PipelineRunNodeStatusRecord> {
    const normalized = new Map<string, PipelineRunNodeStatusRecord>();
    for (const status of Object.values(nodeStatuses ?? {})) {
        const qualifiedName = normalizePipelineNodeName(status.qualifiedName);
        const current = normalized.get(qualifiedName);
        if (current == null || shouldReplaceNodeStatus(current, status)) {
            normalized.set(qualifiedName, {
                ...status,
                qualifiedName,
            });
        }
    }

    return normalized;
}

function shouldReplaceNodeStatus(
    current: PipelineRunNodeStatusRecord,
    candidate: PipelineRunNodeStatusRecord,
): boolean {
    const currentTime = Date.parse(current.lastUpdatedAt);
    const candidateTime = Date.parse(candidate.lastUpdatedAt);
    if (candidateTime !== currentTime) {
        return candidateTime > currentTime;
    }

    return PIPELINE_RUN_NODE_STATUS_PRIORITY[candidate.status] >
        PIPELINE_RUN_NODE_STATUS_PRIORITY[current.status];
}

function confidenceForNode(
    pipeline: PipelineDetail,
    nodeIdValue: string,
): string | undefined {
    const edge = pipeline.edges.find((item) => item.targetNodeId === nodeIdValue);
    return edge == null ? undefined : `${edge.confidence} (${edge.evidence})`;
}

function pipelineAssetNodeFromRegistryNode(node: PipelineNode): PipelineAssetNode {
    return {
        externalKind: node.externalKind,
        id: node.id,
        kind: kindForNodeType(node.nodeType),
        label: node.name,
        nodeType: node.nodeType,
        qualifiedName: node.qualifiedName,
        sourceFile: node.sourceFile,
        sourceLine: node.sourceLine,
        sqlText: node.sqlText,
    };
}

function kindForNodeType(nodeType: NodeType): PipelineAssetKind {
    if (nodeType === 'EXTERNAL_DATASET') {
        return 'external-source';
    }

    if (nodeType === 'STREAMING_TABLE') {
        return 'table';
    }

    if (nodeType === 'FLOW') {
        return 'command';
    }

    return 'view';
}

