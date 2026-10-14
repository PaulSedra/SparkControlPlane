/**
 * @fileoverview Pure geometry helpers for centering graph content and mapping
 * the visible viewport into minimap coordinates.
 */

import type {
    GraphCanvasPan,
    GraphCanvasSize,
} from '../../types/graphCanvasTypes';
import { clamp } from '../../utils/numbers.ts';

/** Scale and offset used to render graph content in the minimap. */
export interface GraphCanvasMinimapMap {
    offsetX: number;
    offsetY: number;
    scale: number;
}

/** Minimap rectangle corresponding to the visible graph viewport. */
export interface GraphCanvasViewportRect {
    height: number;
    left: number;
    top: number;
    width: number;
}

/**
 * Computes the pan needed to place scaled graph content at the canvas center;
 * negative values intentionally allow oversized content to extend beyond the
 * viewport so reset/initial framing remains symmetric.
 */
export function getGraphCanvasCenteredPan(
    canvasSize: GraphCanvasSize,
    contentSize: GraphCanvasSize,
    scale = 1,
): GraphCanvasPan {
    return {
        x: (canvasSize.width - contentSize.width * scale) / 2,
        y: (canvasSize.height - contentSize.height * scale) / 2,
    };
}

/**
 * Calculates pan values that keep the graph point under the canvas center
 * stationary while the scale changes around the viewport's top-left origin.
 */
export function getGraphCanvasZoomedPan(
    pan: GraphCanvasPan,
    canvasSize: GraphCanvasSize,
    currentScale: number,
    nextScale: number,
): GraphCanvasPan {
    const scaleRatio = nextScale / currentScale;
    const centerX = canvasSize.width / 2;
    const centerY = canvasSize.height / 2;

    return {
        x: centerX + (pan.x - centerX) * scaleRatio,
        y: centerY + (pan.y - centerY) * scaleRatio,
    };
}

/**
 * Computes a uniform minimap scale that fits the full content inside a seven-
 * pixel inset, centering the unused axis when aspect ratios differ.
 */
export function getGraphCanvasMinimapMap(
    minimapSize: GraphCanvasSize,
    contentSize: GraphCanvasSize,
): GraphCanvasMinimapMap {
    const inset = 7;
    const scale = Math.min(
        (minimapSize.width - inset * 2) / Math.max(1, contentSize.width),
        (minimapSize.height - inset * 2) / Math.max(1, contentSize.height),
    );

    return {
        offsetX: (minimapSize.width - contentSize.width * scale) / 2,
        offsetY: (minimapSize.height - contentSize.height * scale) / 2,
        scale,
    };
}

/**
 * Projects the canvas viewport into minimap coordinates, clamping content
 * bounds and preserving a four-pixel minimum marker for very small views.
 */
export function getGraphCanvasViewportRect(
    pan: GraphCanvasPan,
    scale: number,
    canvasSize: GraphCanvasSize,
    contentSize: GraphCanvasSize,
    map: GraphCanvasMinimapMap,
): GraphCanvasViewportRect {
    const visibleLeft = clamp(-pan.x / scale, 0, contentSize.width);
    const visibleTop = clamp(-pan.y / scale, 0, contentSize.height);
    const visibleRight = clamp(
        (canvasSize.width - pan.x) / scale,
        0,
        contentSize.width,
    );
    const visibleBottom = clamp(
        (canvasSize.height - pan.y) / scale,
        0,
        contentSize.height,
    );
    const left = Math.min(visibleLeft, visibleRight);
    const top = Math.min(visibleTop, visibleBottom);
    const right = Math.max(visibleLeft, visibleRight);
    const bottom = Math.max(visibleTop, visibleBottom);

    return {
        height: Math.max(4, (bottom - top) * map.scale),
        left: map.offsetX + left * map.scale,
        top: map.offsetY + top * map.scale,
        width: Math.max(4, (right - left) * map.scale),
    };
}
