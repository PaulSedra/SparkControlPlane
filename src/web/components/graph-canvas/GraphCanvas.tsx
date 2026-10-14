/**
 * @fileoverview Reusable pan, zoom, reset, and minimap viewport for graph
 * content.
 */

import { Maximize2, Minus, Plus, RotateCcw } from 'lucide-react';
import { AppIcon } from '../ui/AppIcon';
import { useGraphCanvas } from './hooks/useGraphCanvas';
import type { GraphCanvasProps } from '../../types/graphCanvasTypes';

/**
 * Provides a reusable graph viewport with pan, zoom, reset, and minimap
 * interactions.
 *
 * The child graph remains responsible for its own content and node behavior;
 * this component owns only the transformed viewport and translates pointer
 * gestures into the hook's bounded pan/scale state. The minimap is an
 * alternate navigation surface over that same state, so toolbar and minimap
 * actions stay synchronized.
 */
export function GraphCanvas({
    ariaLabel,
    children,
    className,
    footer,
    minimap,
    style,
}: Readonly<GraphCanvasProps>) {
    const {
        canvasRef,
        handleMinimapPointerDown,
        handleMinimapPointerMove,
        handleMinimapPointerUp,
        handlePointerDown,
        handlePointerMove,
        handlePointerUp,
        handleWheel,
        minimapMap,
        minimapRef,
        pan,
        resetView,
        scale,
        viewportRect,
        zoomBy,
    } = useGraphCanvas(minimap);

    return (
        <div className="dag-shell">
            <div className="dag-tools">
                <button aria-label="Fit graph" onClick={resetView} title="Fit graph" type="button">
                    <AppIcon icon={Maximize2} size="status" />
                </button>
                <button aria-label="Zoom in" onClick={() => zoomBy(0.1)} title="Zoom in" type="button">
                    <AppIcon icon={Plus} size="status" />
                </button>
                <button aria-label="Zoom out" onClick={() => zoomBy(-0.1)} title="Zoom out" type="button">
                    <AppIcon icon={Minus} size="status" />
                </button>
                <button aria-label="Reset graph" onClick={resetView} title="Reset graph" type="button">
                    <AppIcon icon={RotateCcw} size="status" />
                </button>
            </div>
            <div
                aria-label={ariaLabel}
                className="dag-canvas"
                ref={canvasRef}
                onPointerDown={handlePointerDown}
                onPointerLeave={handlePointerUp}
                onPointerMove={handlePointerMove}
                onPointerUp={handlePointerUp}
                onWheel={handleWheel}
            >
                <div
                    className={className == null ? 'dag-viewport' : `dag-viewport ${className}`}
                    style={{
                        ...style,
                        transform: `translate(${pan.x}px, ${pan.y}px) scale(${scale})`,
                    }}
                >
                    {children}
                </div>
            </div>
            {footer}
            {minimap != null && minimapMap != null && viewportRect != null && (
                <div
                    aria-label="Graph minimap. Click or drag to move the graph."
                    className="graph-minimap"
                    ref={minimapRef}
                    onPointerDown={handleMinimapPointerDown}
                    onPointerMove={handleMinimapPointerMove}
                    onPointerUp={handleMinimapPointerUp}
                >
                    {minimap.nodes.map((node) => (
                        <i
                            aria-hidden="true"
                            className={`graph-minimap-node ${node.status ?? 'defined'}`}
                            key={node.id}
                            style={{
                                height: Math.max(2, node.height * minimapMap.scale),
                                left: minimapMap.offsetX + node.x * minimapMap.scale,
                                top: minimapMap.offsetY + node.y * minimapMap.scale,
                                width: Math.max(3, node.width * minimapMap.scale),
                            }}
                        />
                    ))}
                    <span
                        aria-hidden="true"
                        className="graph-minimap-viewport"
                        style={{
                            height: viewportRect.height,
                            left: viewportRect.left,
                            top: viewportRect.top,
                            width: viewportRect.width,
                        }}
                    />
                </div>
            )}
        </div>
    );
}
