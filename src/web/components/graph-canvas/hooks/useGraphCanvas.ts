/**
 * @fileoverview React interaction state for graph pan, zoom, resize, and
 * minimap pointer gestures.
 */

import { useEffect, useRef, useState } from 'react';
import type { PointerEvent, WheelEvent } from 'react';
import {
    getGraphCanvasCenteredPan,
    getGraphCanvasMinimapMap,
    getGraphCanvasViewportRect,
    getGraphCanvasZoomedPan,
} from '../graphCanvasGeometry';
import { clamp } from '../../../utils/numbers.ts';
import type {
    GraphCanvasMinimap,
    GraphCanvasPan,
    GraphCanvasSize,
} from '../../../types/graphCanvasTypes';

/**
 * Provides the graph viewport state and gesture handlers.
 *
 * Canvas and minimap dimensions are measured through `ResizeObserver` when
 * available; initial centering waits for both measurements and each content
 * size is centered only once so later resizes do not unexpectedly reset a
 * user's pan. Button and Ctrl/Cmd-wheel zoom keep the graph point at the
 * viewport center fixed, and minimap clicks/dragging recenter the same view.
 */
export function useGraphCanvas(minimap?: GraphCanvasMinimap) {
    const [scale, setScale] = useState(1);
    const scaleRef = useRef(1);
    const [pan, setPan] = useState<GraphCanvasPan>({ x: 0, y: 0 });
    const [canvasSize, setCanvasSize] = useState<GraphCanvasSize>({ height: 0, width: 0 });
    const [minimapSize, setMinimapSize] = useState<GraphCanvasSize>({ height: 74, width: 90 });
    const canvasRef = useRef<HTMLDivElement>(null);
    const minimapRef = useRef<HTMLDivElement>(null);
    const dragState = useRef<{ pointerId: number; x: number; y: number } | null>(null);
    const minimapDragState = useRef<{ pointerId: number } | null>(null);
    // Remember the content size that received automatic centering so a later
    // container resize preserves the user's pan instead of snapping it back.
    const centeredContentKey = useRef<string | null>(null);
    const hasMinimap = minimap != null;

    useEffect(() => {
        const canvas = canvasRef.current;
        if (canvas == null) {
            return undefined;
        }

        const updateSize = () => {
            setCanvasSize({ height: canvas.clientHeight, width: canvas.clientWidth });
        };

        updateSize();
        if (typeof ResizeObserver === 'undefined') {
            window.addEventListener('resize', updateSize);
            return () => window.removeEventListener('resize', updateSize);
        }

        const observer = new ResizeObserver(updateSize);
        observer.observe(canvas);
        return () => observer.disconnect();
    }, []);

    const canvasHeight = canvasSize.height;
    const canvasWidth = canvasSize.width;
    const contentHeight = minimap?.contentSize.height;
    const contentWidth = minimap?.contentSize.width;

    useEffect(() => {
        if (
            contentWidth == null ||
            contentHeight == null ||
            canvasWidth <= 0 ||
            canvasHeight <= 0
        ) {
            return;
        }

        // ResizeObserver can report before layout has real dimensions; wait
        // for both measurements, then center only when the graph itself has
        // changed rather than on every viewport resize.
        const contentKey = `${contentWidth}:${contentHeight}`;
        if (centeredContentKey.current === contentKey) {
            return;
        }

        centeredContentKey.current = contentKey;
        scaleRef.current = 1;
        setScale(1);
        setPan(getGraphCanvasCenteredPan(
            { height: canvasHeight, width: canvasWidth },
            { height: contentHeight, width: contentWidth },
        ));
    }, [canvasHeight, canvasWidth, contentHeight, contentWidth]);

    useEffect(() => {
        if (!hasMinimap) {
            return undefined;
        }

        const element = minimapRef.current;
        if (element == null) {
            return undefined;
        }

        const updateSize = () => {
            setMinimapSize({ height: element.clientHeight, width: element.clientWidth });
        };

        updateSize();
        if (typeof ResizeObserver === 'undefined') {
            window.addEventListener('resize', updateSize);
            return () => window.removeEventListener('resize', updateSize);
        }

        const observer = new ResizeObserver(updateSize);
        observer.observe(element);
        return () => observer.disconnect();
    }, [hasMinimap]);

    function zoomTo(nextScale: number) {
        const currentScale = scaleRef.current;
        const boundedScale = clamp(nextScale, 0.55, 1.7);
        if (boundedScale === currentScale) {
            return;
        }

        scaleRef.current = boundedScale;
        setScale(boundedScale);
        setPan((currentPan) => getGraphCanvasZoomedPan(
            currentPan,
            { height: canvasHeight, width: canvasWidth },
            currentScale,
            boundedScale,
        ));
    }

    function zoomBy(delta: number) {
        zoomTo(scaleRef.current + delta);
    }

    function resetView() {
        scaleRef.current = 1;
        setScale(1);
        setPan(minimap == null
            ? { x: 0, y: 0 }
            : getGraphCanvasCenteredPan(canvasSize, minimap.contentSize));
    }

    function panToMinimapPoint(clientX: number, clientY: number) {
        const currentScale = scaleRef.current;
        if (minimap == null || currentScale <= 0) {
            return;
        }

        const element = minimapRef.current;
        if (element == null) {
            return;
        }

        const rect = element.getBoundingClientRect();
        const map = getGraphCanvasMinimapMap(minimapSize, minimap.contentSize);
        const contentX = clamp(
            (clientX - rect.left - map.offsetX) / map.scale,
            0,
            minimap.contentSize.width,
        );
        const contentY = clamp(
            (clientY - rect.top - map.offsetY) / map.scale,
            0,
            minimap.contentSize.height,
        );

        setPan({
            x: canvasSize.width / 2 - contentX * currentScale,
            y: canvasSize.height / 2 - contentY * currentScale,
        });
    }

    function handleWheel(event: WheelEvent<HTMLDivElement>) {
        event.preventDefault();

        if (event.ctrlKey || event.metaKey) {
            zoomTo(scaleRef.current - event.deltaY * 0.0012);
            return;
        }

        setPan((current) => ({
            x: current.x - event.deltaX,
            y: current.y - event.deltaY,
        }));
    }

    function handlePointerDown(event: PointerEvent<HTMLDivElement>) {
        if (event.button !== 0) {
            return;
        }

        event.currentTarget.setPointerCapture(event.pointerId);
        dragState.current = {
            pointerId: event.pointerId,
            x: event.clientX,
            y: event.clientY,
        };
    }

    function handlePointerMove(event: PointerEvent<HTMLDivElement>) {
        const currentDrag = dragState.current;
        if (currentDrag == null || currentDrag.pointerId !== event.pointerId) {
            return;
        }

        const deltaX = event.clientX - currentDrag.x;
        const deltaY = event.clientY - currentDrag.y;
        dragState.current = {
            pointerId: event.pointerId,
            x: event.clientX,
            y: event.clientY,
        };
        setPan((current) => ({ x: current.x + deltaX, y: current.y + deltaY }));
    }

    function handlePointerUp(event: PointerEvent<HTMLDivElement>) {
        if (dragState.current?.pointerId === event.pointerId) {
            dragState.current = null;
        }
    }

    function handleMinimapPointerDown(event: PointerEvent<HTMLDivElement>) {
        event.preventDefault();
        event.stopPropagation();
        event.currentTarget.setPointerCapture(event.pointerId);
        minimapDragState.current = { pointerId: event.pointerId };
        panToMinimapPoint(event.clientX, event.clientY);
    }

    function handleMinimapPointerMove(event: PointerEvent<HTMLDivElement>) {
        if (minimapDragState.current?.pointerId !== event.pointerId) {
            return;
        }

        event.preventDefault();
        panToMinimapPoint(event.clientX, event.clientY);
    }

    function handleMinimapPointerUp(event: PointerEvent<HTMLDivElement>) {
        if (minimapDragState.current?.pointerId === event.pointerId) {
            minimapDragState.current = null;
        }
    }

    const minimapMap = minimap == null
        ? undefined
        : getGraphCanvasMinimapMap(minimapSize, minimap.contentSize);
    const viewportRect = minimap == null || minimapMap == null
        ? undefined
        : getGraphCanvasViewportRect(
            pan,
            scale,
            canvasSize,
            minimap.contentSize,
            minimapMap,
        );

    return {
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
    };
}
