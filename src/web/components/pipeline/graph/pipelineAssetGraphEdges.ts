/**
 * @fileoverview Hover matching and SVG paint ordering for pipeline graph edges.
 */

/** Direction of the connectors highlighted for a hovered node. */
export type AssetNodeHoverDirection = 'incoming' | 'outgoing';

/** Node identity and connector direction selected by pointer hover. */
export interface AssetNodeHover {
    direction: AssetNodeHoverDirection;
    nodeId: string;
}

type AssetEdgeEndpoints = {
    sourceId: string;
    targetId: string;
};

/**
 * Selects the connector direction for a node hover.
 *
 * Regular nodes split incoming and outgoing connectors at their midpoint.
 * External tables only have outgoing connectors, so any hover on their card
 * highlights those arrows.
 */
export function getAssetNodeHover(
    nodeId: string,
    pointerX: number,
    bounds: { left: number; width: number },
    isExternalSource: boolean,
): AssetNodeHover {
    const direction = isExternalSource || pointerX >= bounds.left + bounds.width / 2
        ? 'outgoing'
        : 'incoming';

    return { direction, nodeId };
}

/** Returns whether a graph edge is connected in the hovered direction. */
export function isAssetEdgeHighlighted(
    edge: AssetEdgeEndpoints,
    hoveredNode?: AssetNodeHover,
): boolean {
    if (hoveredNode == null) {
        return false;
    }

    return hoveredNode.direction === 'incoming'
        ? edge.targetId === hoveredNode.nodeId
        : edge.sourceId === hoveredNode.nodeId;
}

/**
 * Stable-partitions graph edges so hovered connectors paint above their peers.
 */
export function orderAssetEdgesForPaint<T extends AssetEdgeEndpoints>(
    edges: readonly T[],
    hoveredNode?: AssetNodeHover,
): T[] {
    return [
        ...edges.filter((edge) => !isAssetEdgeHighlighted(edge, hoveredNode)),
        ...edges.filter((edge) => isAssetEdgeHighlighted(edge, hoveredNode)),
    ];
}
