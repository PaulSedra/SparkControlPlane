/**
 * @fileoverview Orchestrates pipeline asset graph construction and layout.
 */

import type { PipelineAssetOperation } from '../../../types/pipelineAssetTypes.ts';
import type { GraphLayout } from '../../../types/pipelineAssetLayoutTypes.ts';
import {
    buildExternalSources,
    findExternalSourceCollisionLevels,
    positionExternalSources,
} from './pipelineAssetGraphExternalSources.ts';
import {
    ASSET_COLUMN_GAP,
    ASSET_COLUMN_WIDTH,
    ASSET_EXTERNAL_SOURCE_HEIGHT,
    ASSET_EXTERNAL_SOURCE_LANE_WIDTH,
    ASSET_NODE_GAP,
    ASSET_NODE_HEIGHT,
    ASSET_VIEWPORT_PADDING_X,
    ASSET_VIEWPORT_PADDING_Y,
} from './pipelineAssetGraphConstants.ts';
import { buildPipelineAssetGraph } from './pipelineAssetGraphBuilder.ts';
import { nodePositions } from './pipelineAssetGraphGeometry.ts';
import { buildPipelineAssetTopology } from './pipelineAssetGraphTopology.ts';

/**
 * Builds deterministic graph levels and geometry from pipeline operations.
 * Operations must describe a DAG; a dependency cycle raises an error.
 */
export function buildAssetLayout(
    operations: PipelineAssetOperation[],
): GraphLayout {
    const graph = buildPipelineAssetGraph(operations);
    const topology = buildPipelineAssetTopology(graph.nodes, graph.edges);
    const externalSources = buildExternalSources(graph.externalSourceTargets, topology.levels);
    const baseLeftPaddingX = ASSET_VIEWPORT_PADDING_X + (externalSources.length === 0
        ? 0
        : ASSET_EXTERNAL_SOURCE_LANE_WIDTH);
    const basePositions = nodePositions(topology.levels, baseLeftPaddingX);
    const externalSourceCollisionLevels = findExternalSourceCollisionLevels(
        topology.levels,
        externalSources,
        basePositions,
    );
    const hasFirstLevelExternalSource = externalSources.some((source) =>
        source.targetLevel === 0);
    const firstColumnMinX = hasFirstLevelExternalSource
        ? baseLeftPaddingX
        : ASSET_VIEWPORT_PADDING_X;
    const leftPaddingX = Math.max(
        baseLeftPaddingX,
        firstColumnMinX +
            externalSourceCollisionLevels.length * ASSET_EXTERNAL_SOURCE_LANE_WIDTH,
    );
    const positions = nodePositions(
        topology.levels,
        leftPaddingX,
        externalSourceCollisionLevels,
    );
    const positionedSources = positionExternalSources(externalSources, positions);
    const maxRows = Math.max(1, ...topology.levels.map((level) => level.length));
    const baseHeight =
        ASSET_VIEWPORT_PADDING_Y * 2 +
        maxRows * ASSET_NODE_HEIGHT +
        Math.max(0, maxRows - 1) * ASSET_NODE_GAP;
    const maximumContentBottom = positionedSources.reduce(
        (maximum, { position }) => Math.max(
            maximum,
            position.y + ASSET_EXTERNAL_SOURCE_HEIGHT,
        ),
        [...positions.values()].reduce(
            (maximum, position) => Math.max(maximum, position.y + ASSET_NODE_HEIGHT),
            ASSET_VIEWPORT_PADDING_Y,
        ),
    );

    return {
        edges: topology.edges,
        externalSources,
        externalSourceCollisionLevels,
        height: Math.max(baseHeight, maximumContentBottom + ASSET_VIEWPORT_PADDING_Y),
        leftPaddingX,
        levels: topology.levels,
        width:
            leftPaddingX + ASSET_VIEWPORT_PADDING_X +
            topology.levels.length * ASSET_COLUMN_WIDTH +
            Math.max(0, topology.levels.length - 1) * ASSET_COLUMN_GAP,
    };
}
