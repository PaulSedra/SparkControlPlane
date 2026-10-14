/**
 * @fileoverview DAG reduction, level assignment, and deterministic row ordering.
 */

import type { GraphEdge, GraphNode } from '../../../types/pipelineAssetLayoutTypes.ts';

interface GraphAdjacency {
    incomingByTarget: Map<string, GraphEdge[]>;
    outgoingBySource: Map<string, GraphEdge[]>;
}

type EdgeNodeKey = 'sourceId' | 'targetId';

/** Reduces lineage edges and assigns stable, ordered levels to graph nodes. */
export function buildPipelineAssetTopology(
    nodes: Map<string, GraphNode>,
    edges: GraphEdge[],
): { edges: GraphEdge[]; levels: GraphNode[][] } {
    const uniqueEdges = Array.from(
        new Map(edges.map((edge) => [`${edge.sourceId}->${edge.targetId}`, edge])).values(),
    );
    const graphAdjacency = buildAdjacency(uniqueEdges);
    assertAcyclic(nodes, graphAdjacency);

    const reducedEdges = transitiveReduction(uniqueEdges, graphAdjacency);
    const reducedAdjacency = buildAdjacency(reducedEdges);
    const levelById = levelsForEdges(nodes, reducedAdjacency);
    const levels: GraphNode[][] = [];
    for (const node of nodes.values()) {
        const level = levelById.get(node.id) ?? 0;
        levels[level] ??= [];
        levels[level].push(node);
    }

    return {
        edges: reducedEdges,
        levels: orderLevels(levels.filter(Boolean), reducedAdjacency),
    };
}

function buildAdjacency(edges: GraphEdge[]): GraphAdjacency {
    const incomingByTarget = new Map<string, GraphEdge[]>();
    const outgoingBySource = new Map<string, GraphEdge[]>();
    for (const edge of edges) {
        incomingByTarget.set(edge.targetId, [
            ...(incomingByTarget.get(edge.targetId) ?? []),
            edge,
        ]);
        outgoingBySource.set(edge.sourceId, [
            ...(outgoingBySource.get(edge.sourceId) ?? []),
            edge,
        ]);
    }

    return { incomingByTarget, outgoingBySource };
}

function assertAcyclic(nodes: Map<string, GraphNode>, adjacency: GraphAdjacency): void {
    const indegree = new Map([...nodes.keys()].map((nodeId) => [nodeId, 0]));
    for (const [targetId, incomingEdges] of adjacency.incomingByTarget) {
        indegree.set(targetId, incomingEdges.length);
    }

    const queue = [...nodes.keys()].filter((nodeId) => indegree.get(nodeId) === 0);
    let head = 0;
    let processedNodeCount = 0;
    while (head < queue.length) {
        const sourceId = queue[head++];
        processedNodeCount += 1;
        for (const edge of adjacency.outgoingBySource.get(sourceId) ?? []) {
            const targetIndegree = (indegree.get(edge.targetId) ?? 0) - 1;
            indegree.set(edge.targetId, targetIndegree);
            if (targetIndegree === 0) {
                queue.push(edge.targetId);
            }
        }
    }

    if (processedNodeCount !== nodes.size) {
        throw new Error('Pipeline asset graph contains a dependency cycle');
    }
}

function transitiveReduction(
    edges: GraphEdge[],
    adjacency: GraphAdjacency,
): GraphEdge[] {
    return edges.filter((edge) => !hasAlternativePath(edge, adjacency.outgoingBySource));
}

function hasAlternativePath(
    excludedEdge: GraphEdge,
    outgoingBySource: Map<string, GraphEdge[]>,
): boolean {
    const pendingNodeIds = [excludedEdge.sourceId];
    const visitedNodeIds = new Set<string>(pendingNodeIds);
    let head = 0;

    while (head < pendingNodeIds.length) {
        const sourceId = pendingNodeIds[head++];
        if (sourceId == null) {
            continue;
        }

        for (const edge of outgoingBySource.get(sourceId) ?? []) {
            if (edge === excludedEdge || visitedNodeIds.has(edge.targetId)) {
                continue;
            }

            if (edge.targetId === excludedEdge.targetId) {
                return true;
            }

            visitedNodeIds.add(edge.targetId);
            pendingNodeIds.push(edge.targetId);
        }
    }

    return false;
}

function orderLevels(levels: GraphNode[][], adjacency: GraphAdjacency): GraphNode[][] {
    const orderedLevels = levels.map((level) =>
        [...level].sort((left, right) => left.label.localeCompare(right.label)),
    );

    for (let pass = 0; pass < 4; pass += 1) {
        let rowsByNodeId = rowIndexes(orderedLevels);
        for (let levelIndex = 1; levelIndex < orderedLevels.length; levelIndex += 1) {
            orderLevel(
                orderedLevels[levelIndex],
                adjacency.incomingByTarget,
                rowsByNodeId,
                'sourceId',
            );
            rowsByNodeId = rowIndexes(orderedLevels);
        }

        for (let levelIndex = orderedLevels.length - 2; levelIndex >= 0; levelIndex -= 1) {
            orderLevel(
                orderedLevels[levelIndex],
                adjacency.outgoingBySource,
                rowsByNodeId,
                'targetId',
            );
            rowsByNodeId = rowIndexes(orderedLevels);
        }
    }

    return orderedLevels;
}

function orderLevel(
    level: GraphNode[],
    edgesByNodeId: Map<string, GraphEdge[]>,
    rowsByNodeId: Map<string, number>,
    neighborIdKey: EdgeNodeKey,
): void {
    level.sort((left, right) => {
        const leftRow = averageNeighborRow(left.id, edgesByNodeId, rowsByNodeId, neighborIdKey);
        const rightRow = averageNeighborRow(right.id, edgesByNodeId, rowsByNodeId, neighborIdKey);
        return leftRow - rightRow || left.label.localeCompare(right.label);
    });
}

function averageNeighborRow(
    nodeId: string,
    edgesByNodeId: Map<string, GraphEdge[]>,
    rowsByNodeId: Map<string, number>,
    neighborIdKey: EdgeNodeKey,
): number {
    const rows = (edgesByNodeId.get(nodeId) ?? [])
        .map((edge) => rowsByNodeId.get(edge[neighborIdKey]))
        .filter((row): row is number => row != null);
    if (rows.length === 0) {
        return rowsByNodeId.get(nodeId) ?? 0;
    }

    return rows.reduce((total, row) => total + row, 0) / rows.length;
}

function rowIndexes(levels: GraphNode[][]): Map<string, number> {
    const rowsByNodeId = new Map<string, number>();
    for (const level of levels) {
        for (let rowIndex = 0; rowIndex < level.length; rowIndex += 1) {
            rowsByNodeId.set(level[rowIndex].id, rowIndex);
        }
    }

    return rowsByNodeId;
}

function levelsForEdges(
    nodes: Map<string, GraphNode>,
    adjacency: GraphAdjacency,
): Map<string, number> {
    const indegree = new Map([...nodes.keys()].map((nodeId) => [nodeId, 0]));
    const levelById = new Map([...nodes.keys()].map((nodeId) => [nodeId, 0]));
    for (const [targetId, incomingEdges] of adjacency.incomingByTarget) {
        indegree.set(targetId, incomingEdges.length);
    }

    const queue = [...nodes.keys()].filter((nodeId) => indegree.get(nodeId) === 0);
    let head = 0;
    while (head < queue.length) {
        const sourceId = queue[head++];
        if (sourceId == null) {
            continue;
        }

        for (const edge of adjacency.outgoingBySource.get(sourceId) ?? []) {
            levelById.set(
                edge.targetId,
                Math.max(levelById.get(edge.targetId) ?? 0, (levelById.get(sourceId) ?? 0) + 1),
            );
            const targetIndegree = (indegree.get(edge.targetId) ?? 0) - 1;
            indegree.set(edge.targetId, targetIndegree);
            if (targetIndegree === 0) {
                queue.push(edge.targetId);
            }
        }
    }

    compactLevelsTowardTargets(levelById, adjacency.outgoingBySource);
    return levelById;
}

function compactLevelsTowardTargets(
    levelById: Map<string, number>,
    outgoingBySource: Map<string, GraphEdge[]>,
): void {
    const nodeIdsByDescendingLevel = [...levelById.keys()].sort(
        (left, right) => (levelById.get(right) ?? 0) - (levelById.get(left) ?? 0),
    );

    for (const nodeId of nodeIdsByDescendingLevel) {
        const targetLevels = (outgoingBySource.get(nodeId) ?? [])
            .map((edge) => levelById.get(edge.targetId))
            .filter((level): level is number => level != null);
        if (targetLevels.length === 0) {
            continue;
        }

        const latestValidLevel = Math.min(...targetLevels) - 1;
        levelById.set(nodeId, Math.max(levelById.get(nodeId) ?? 0, latestValidLevel));
    }
}
