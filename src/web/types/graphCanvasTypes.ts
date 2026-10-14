/**
 * @fileoverview Shared props and geometry contracts for the graph viewport and
 * its minimap.
 */

import type { CSSProperties, ReactNode } from 'react';

/** Positioned node summary rendered by the graph minimap. */
export interface GraphCanvasMinimapNode {
    height: number;
    id: string;
    status?: string;
    width: number;
    x: number;
    y: number;
}

/** Bounded minimap model derived from the graph layout. */
export interface GraphCanvasMinimap {
    contentSize: { height: number; width: number };
    nodes: GraphCanvasMinimapNode[];
}

/** Visual and accessibility contract for the reusable graph canvas. */
export interface GraphCanvasProps {
    ariaLabel: string;
    children: ReactNode;
    className?: string;
    footer?: ReactNode;
    minimap?: GraphCanvasMinimap;
    style?: CSSProperties;
}

/** Measured graph-canvas dimensions in CSS pixels. */
export interface GraphCanvasSize {
    height: number;
    width: number;
}

/** Pan offset applied to graph content inside the canvas. */
export interface GraphCanvasPan {
    x: number;
    y: number;
}
