/**
 * @fileoverview Shared dimensions and CSS values for pipeline asset graphs.
 */

import type { CSSProperties } from 'react';

/** Width of one rendered asset node. */
export const ASSET_COLUMN_WIDTH = 220;
/** Horizontal gap between rendered asset columns. */
export const ASSET_COLUMN_GAP = 86;
/** Height of one rendered asset node. */
export const ASSET_NODE_HEIGHT = 76;
/** Width of the compact informational node used for external sources. */
export const ASSET_EXTERNAL_SOURCE_WIDTH = 188;
/** Height of the compact external-source card beside its supporting node. */
export const ASSET_EXTERNAL_SOURCE_HEIGHT = 38;
/** Top offset of the external-source type label relative to its card. */
export const ASSET_EXTERNAL_SOURCE_LABEL_TOP = -20;
/** Line-box height of the external-source type label. */
export const ASSET_EXTERNAL_SOURCE_LABEL_HEIGHT = 12;
/** Gap between a stacked external-source card and the next source label. */
export const ASSET_EXTERNAL_SOURCE_STACK_GAP = 12;
/** Horizontal space reserved for an external-source card and its Flow gap. */
export const ASSET_EXTERNAL_SOURCE_LANE_WIDTH =
    ASSET_EXTERNAL_SOURCE_WIDTH + ASSET_COLUMN_GAP;
/** Vertical gap between nodes in one column. */
export const ASSET_NODE_GAP = 60;
/** Horizontal graph viewport padding. */
export const ASSET_VIEWPORT_PADDING_X = 48;
/** Vertical graph viewport padding. */
export const ASSET_VIEWPORT_PADDING_Y = 38;
/** Arrowhead size used by asset edge paths. */
export const ASSET_EDGE_ARROW_SIZE = 8;
/** Gap between an asset node and its incoming/outgoing edge. */
export const ASSET_EDGE_NODE_GAP = 12;

/** CSS custom properties shared by the asset graph layout and styles. */
export const ASSET_GRAPH_STYLE = {
    '--asset-column-gap': `${ASSET_COLUMN_GAP}px`,
    '--asset-column-width': `${ASSET_COLUMN_WIDTH}px`,
    '--asset-external-source-width': `${ASSET_EXTERNAL_SOURCE_WIDTH}px`,
    '--asset-external-source-height': `${ASSET_EXTERNAL_SOURCE_HEIGHT}px`,
    '--asset-external-source-label-top': `${ASSET_EXTERNAL_SOURCE_LABEL_TOP}px`,
    '--asset-external-source-label-height': `${ASSET_EXTERNAL_SOURCE_LABEL_HEIGHT}px`,
    '--asset-node-gap': `${ASSET_NODE_GAP}px`,
    '--asset-node-height': `${ASSET_NODE_HEIGHT}px`,
    '--asset-viewport-padding-x': `${ASSET_VIEWPORT_PADDING_X}px`,
    '--asset-viewport-padding-y': `${ASSET_VIEWPORT_PADDING_Y}px`,
} as CSSProperties;
