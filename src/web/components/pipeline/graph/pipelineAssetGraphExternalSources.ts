/**
 * @fileoverview Groups and positions external sources and detects card overlap.
 */

import type {
    GraphExternalSource,
    GraphNode,
} from '../../../types/pipelineAssetLayoutTypes.ts';
import {
    ASSET_COLUMN_WIDTH,
    ASSET_EXTERNAL_SOURCE_HEIGHT,
    ASSET_EXTERNAL_SOURCE_LABEL_HEIGHT,
    ASSET_EXTERNAL_SOURCE_LABEL_TOP,
    ASSET_EXTERNAL_SOURCE_LANE_WIDTH,
    ASSET_EXTERNAL_SOURCE_STACK_GAP,
    ASSET_EXTERNAL_SOURCE_WIDTH,
    ASSET_NODE_HEIGHT,
    ASSET_VIEWPORT_PADDING_Y,
} from './pipelineAssetGraphConstants.ts';
import type { GraphPosition } from './pipelineAssetGraphGeometry.ts';

/** Groups each external source with the graph-level nodes that consume it. */
export function buildExternalSources(
    externalSourceTargets: Map<string, { node: GraphNode; targetIds: Set<string> }>,
    levels: GraphNode[][],
): GraphExternalSource[] {
    const levelIndexByNodeId = new Map(
        levels.flatMap((level, levelIndex) =>
            level.map((node) => [node.id, levelIndex] as const)),
    );
    const externalSources = [...externalSourceTargets.values()].flatMap((source) => {
        const targetIdsByLevel = new Map<number, string[]>();
        for (const targetId of source.targetIds) {
            const targetLevel = levelIndexByNodeId.get(targetId) ?? 0;
            targetIdsByLevel.set(targetLevel, [
                ...(targetIdsByLevel.get(targetLevel) ?? []),
                targetId,
            ]);
        }

        return [...targetIdsByLevel.entries()].map(([targetLevel, targetIds]) => ({
            node: source.node,
            targetIds: targetIds.sort((left, right) => left.localeCompare(right)),
            targetLevel,
        }));
    });

    return externalSources.sort((left, right) =>
        left.targetLevel - right.targetLevel ||
        left.node.label.localeCompare(right.node.label) ||
        left.node.id.localeCompare(right.node.id));
}

/** Returns target levels where an external card or its label overlaps a node. */
export function findExternalSourceCollisionLevels(
    levels: GraphNode[][],
    externalSources: GraphExternalSource[],
    positions: ReadonlyMap<string, GraphPosition>,
): number[] {
    const collisionLevels = new Set<number>();
    for (const { position: sourcePosition, source } of positionExternalSources(
        externalSources,
        positions,
    )) {
        if (source.targetLevel === 0) {
            continue;
        }

        const labelTop = sourcePosition.y + ASSET_EXTERNAL_SOURCE_LABEL_TOP;
        const labelBottom = labelTop + ASSET_EXTERNAL_SOURCE_LABEL_HEIGHT;
        const sourceBottom = sourcePosition.y + ASSET_EXTERNAL_SOURCE_HEIGHT;
        const overlapsUpstreamNode = levels.slice(0, source.targetLevel).some((upstreamLevel) =>
            upstreamLevel.some((upstreamNode) => {
                const upstreamPosition = positions.get(upstreamNode.id);
                if (upstreamPosition == null) {
                    return false;
                }

                const overlapsHorizontally =
                    sourcePosition.x < upstreamPosition.x + ASSET_COLUMN_WIDTH &&
                    sourcePosition.x + ASSET_EXTERNAL_SOURCE_WIDTH > upstreamPosition.x;
                const overlapsCard =
                    sourcePosition.y < upstreamPosition.y + ASSET_NODE_HEIGHT &&
                    sourceBottom > upstreamPosition.y;
                const overlapsLabel =
                    labelTop < upstreamPosition.y + ASSET_NODE_HEIGHT &&
                    labelBottom > upstreamPosition.y;

                return overlapsHorizontally && (overlapsCard || overlapsLabel);
            }),
        );
        if (overlapsUpstreamNode) {
            collisionLevels.add(source.targetLevel);
        }
    }

    return [...collisionLevels].sort((left, right) => left - right);
}

/** Returns the positioned external-source cards used by graph overlays. */
export function positionExternalSources(
    externalSources: GraphExternalSource[],
    positions: ReadonlyMap<string, GraphPosition>,
): Array<{ position: GraphPosition; source: GraphExternalSource }> {
    const sourcesByLevel = new Map<number, GraphExternalSource[]>();
    for (const source of externalSources) {
        sourcesByLevel.set(source.targetLevel, [
            ...(sourcesByLevel.get(source.targetLevel) ?? []),
            source,
        ]);
    }

    const positionedSources: Array<{ position: GraphPosition; source: GraphExternalSource }> = [];
    for (const sources of sourcesByLevel.values()) {
        const candidates = sources.flatMap((source) => {
            const targetPositions = source.targetIds
                .map((targetId) => positions.get(targetId))
                .filter((position): position is GraphPosition => position != null);
            if (targetPositions.length === 0) {
                return [];
            }

            const averageTargetY = targetPositions.reduce((sum, position) => sum + position.y, 0) /
                targetPositions.length;
            return [{
                desiredTop: averageTargetY + (ASSET_NODE_HEIGHT - ASSET_EXTERNAL_SOURCE_HEIGHT) / 2,
                source,
                x: targetPositions[0].x - ASSET_EXTERNAL_SOURCE_LANE_WIDTH,
            }];
        }).sort((left, right) =>
            left.desiredTop - right.desiredTop ||
            left.source.node.label.localeCompare(right.source.node.label) ||
            left.source.node.id.localeCompare(right.source.node.id));

        const minimumCardStep = ASSET_EXTERNAL_SOURCE_HEIGHT +
            ASSET_EXTERNAL_SOURCE_STACK_GAP - ASSET_EXTERNAL_SOURCE_LABEL_TOP;
        const packedTops: number[] = [];
        for (let index = 0; index < candidates.length; index += 1) {
            packedTops.push(index === 0
                ? candidates[index].desiredTop
                : Math.max(
                    candidates[index].desiredTop,
                    packedTops[index - 1] + minimumCardStep,
                ));
        }
        const averageDisplacement = candidates.length === 0
            ? 0
            : packedTops.reduce((sum, top, index) =>
                sum + top - candidates[index].desiredTop, 0) / candidates.length;
        const firstPackedTop = candidates.length === 0
            ? ASSET_VIEWPORT_PADDING_Y
            : packedTops[0] - averageDisplacement;
        const topAdjustment = Math.max(0, ASSET_VIEWPORT_PADDING_Y - firstPackedTop);

        for (let index = 0; index < candidates.length; index += 1) {
            positionedSources.push({
                position: {
                    x: candidates[index].x,
                    y: packedTops[index] - averageDisplacement + topAdjustment,
                },
                source: candidates[index].source,
            });
        }
    }

    return positionedSources;
}
