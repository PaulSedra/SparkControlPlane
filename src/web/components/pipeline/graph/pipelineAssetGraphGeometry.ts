/**
 * @fileoverview Node coordinates and SVG connector paths for pipeline assets.
 */

import type { GraphNode } from '../../../types/pipelineAssetLayoutTypes.ts';
import {
    ASSET_COLUMN_GAP,
    ASSET_COLUMN_WIDTH,
    ASSET_EDGE_ARROW_SIZE,
    ASSET_EDGE_NODE_GAP,
    ASSET_EXTERNAL_SOURCE_LANE_WIDTH,
    ASSET_NODE_GAP,
    ASSET_NODE_HEIGHT,
    ASSET_VIEWPORT_PADDING_X,
    ASSET_VIEWPORT_PADDING_Y,
} from './pipelineAssetGraphConstants.ts';

/** Canvas coordinates for one node or external-source card. */
export interface GraphPosition {
    x: number;
    y: number;
}

/** Returns canvas coordinates, shifting upstream columns left for collisions. */
export function nodePositions(
    levels: GraphNode[][],
    leftPaddingX = ASSET_VIEWPORT_PADDING_X,
    externalSourceCollisionLevels: number[] = [],
): Map<string, GraphPosition> {
    const positions = new Map<string, GraphPosition>();
    const maxRows = Math.max(0, ...levels.map((level) => level.length));
    const collisionLevels = [...new Set(externalSourceCollisionLevels)]
        .sort((left, right) => left - right);
    let collisionIndex = 0;

    for (let levelIndex = 0; levelIndex < levels.length; levelIndex += 1) {
        const verticalOffset =
            (maxRows - levels[levelIndex].length) *
            (ASSET_NODE_HEIGHT + ASSET_NODE_GAP) /
            2;
        while (
            collisionIndex < collisionLevels.length &&
            collisionLevels[collisionIndex] <= levelIndex
        ) {
            collisionIndex += 1;
        }
        const levelsToShiftLeft = collisionLevels.length - collisionIndex;

        for (let rowIndex = 0; rowIndex < levels[levelIndex].length; rowIndex += 1) {
            positions.set(levels[levelIndex][rowIndex].id, {
                x: leftPaddingX + levelIndex * (ASSET_COLUMN_WIDTH + ASSET_COLUMN_GAP) -
                    levelsToShiftLeft * ASSET_EXTERNAL_SOURCE_LANE_WIDTH,
                y: ASSET_VIEWPORT_PADDING_Y + verticalOffset +
                    rowIndex * (ASSET_NODE_HEIGHT + ASSET_NODE_GAP),
            });
        }
    }

    return positions;
}

/** Builds the curved SVG path connecting an asset source to its target. */
export function assetEdgePath(
    source: GraphPosition,
    target: GraphPosition,
    sourceWidth = ASSET_COLUMN_WIDTH,
    sourceHeight = ASSET_NODE_HEIGHT,
): string {
    const startX = source.x + sourceWidth + ASSET_EDGE_NODE_GAP;
    const startY = source.y + sourceHeight / 2;
    const endX = target.x - ASSET_EDGE_NODE_GAP - ASSET_EDGE_ARROW_SIZE;
    const endY = target.y + ASSET_NODE_HEIGHT / 2;
    const bend = Math.max(32, (endX - startX) / 2);

    return [
        `M ${startX} ${startY}`,
        `C ${startX + bend} ${startY}`,
        `${endX - bend} ${endY}`,
        `${endX} ${endY}`,
    ].join(' ');
}

/** Builds the SVG arrowhead path for an asset edge target. */
export function assetEdgeArrowPath(target: GraphPosition): string {
    const tipX = target.x - ASSET_EDGE_NODE_GAP;
    const baseX = tipX - ASSET_EDGE_ARROW_SIZE;
    const centerY = target.y + ASSET_NODE_HEIGHT / 2;
    const halfSize = ASSET_EDGE_ARROW_SIZE / 2;

    return [
        `M ${baseX} ${centerY - halfSize}`,
        `L ${tipX} ${centerY}`,
        `L ${baseX} ${centerY + halfSize}`,
        'Z',
    ].join(' ');
}
