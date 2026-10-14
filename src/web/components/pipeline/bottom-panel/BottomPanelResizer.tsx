/**
 * @fileoverview Pointer and keyboard resize control for the pipeline bottom panel.
 * Reports bounded height changes while the parent owns the panel height.
 */

import { useRef, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';

const MIN_PIPELINE_BOTTOM_PANEL_HEIGHT = 220;
const MAX_PIPELINE_BOTTOM_PANEL_HEIGHT = 720;

/** Reports bounded pointer and keyboard height changes without owning panel state. */
export function BottomPanelResizer({
    onHeightChange,
    panelHeight,
}: Readonly<{
    onHeightChange: (height: number) => void;
    panelHeight: number;
}>) {
    const resizeStart = useRef<{ height: number; y: number } | undefined>(undefined);

    function handlePointerDown(event: ReactPointerEvent<HTMLButtonElement>): void {
        event.preventDefault();
        resizeStart.current = {
            height: panelHeight,
            y: event.clientY,
        };
        event.currentTarget.setPointerCapture(event.pointerId);
    }

    function handlePointerMove(event: ReactPointerEvent<HTMLButtonElement>): void {
        if (resizeStart.current == null) {
            return;
        }

        onHeightChange(clampPanelHeight(
            resizeStart.current.height - (event.clientY - resizeStart.current.y),
        ));
    }

    function handlePointerUp(event: ReactPointerEvent<HTMLButtonElement>): void {
        resizeStart.current = undefined;
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId);
        }
    }

    function handleKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>): void {
        const step = event.key === 'PageUp' || event.key === 'PageDown' ? 64 : 16;
        let nextHeight: number | undefined;
        if (event.key === 'ArrowUp' || event.key === 'PageUp') {
            nextHeight = panelHeight + step;
        } else if (event.key === 'ArrowDown' || event.key === 'PageDown') {
            nextHeight = panelHeight - step;
        } else if (event.key === 'Home') {
            nextHeight = MIN_PIPELINE_BOTTOM_PANEL_HEIGHT;
        } else if (event.key === 'End') {
            nextHeight = MAX_PIPELINE_BOTTOM_PANEL_HEIGHT;
        }

        if (nextHeight == null) {
            return;
        }

        event.preventDefault();
        onHeightChange(clampPanelHeight(nextHeight));
    }

    return (
        <button
            aria-label={`Resize tables panel (current height ${panelHeight}px)`}
            className="bottom-panel-resizer"
            onKeyDown={handleKeyDown}
            onPointerCancel={handlePointerUp}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            type="button"
        />
    );
}

function clampPanelHeight(height: number): number {
    return Math.min(
        MAX_PIPELINE_BOTTOM_PANEL_HEIGHT,
        Math.max(MIN_PIPELINE_BOTTOM_PANEL_HEIGHT, height),
    );
}

