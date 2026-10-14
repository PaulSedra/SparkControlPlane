/**
 * @fileoverview Local selectable-node state for pipeline table operations.
 */

import { useMemo, useState } from 'react';
import type { PipelineDetail } from '../../../../shared/pipelineRegistryTypes.ts';

/**
 * Owns table-selection mode and selected node IDs for one mounted detail page;
 * leaving that mode clears the selection, while graph selection is inert outside it.
 */
export function usePipelineNodeSelection(pipelineDetail: PipelineDetail | undefined) {
    const [selectedNodeIdSet, setSelectedNodeIdSet] = useState<Set<string>>(() => new Set());
    const [isTableSelectionMode, setIsTableSelectionMode] = useState(false);
    const selectedNodeIds = useMemo(() => [...selectedNodeIdSet], [selectedNodeIdSet]);
    const selectedNodeNames = useMemo(() => {
        if (pipelineDetail == null) {
            return [];
        }

        return pipelineDetail.nodes
            .filter((node) => node.nodeType !== 'EXTERNAL_DATASET' && selectedNodeIdSet.has(node.id))
            .map((node) => node.qualifiedName);
    }, [pipelineDetail, selectedNodeIdSet]);

    function togglePipelineNodeSelectionMode(): void {
        if (isTableSelectionMode) {
            setSelectedNodeIdSet(new Set());
            setIsTableSelectionMode(false);
            return;
        }

        setIsTableSelectionMode(true);
    }

    function togglePipelineNodeSelection(node: { id: string }): void {
        if (!isTableSelectionMode) {
            return;
        }

        setSelectedNodeIdSet((current) => {
            const next = new Set(current);
            if (next.has(node.id)) {
                next.delete(node.id);
            } else {
                next.add(node.id);
            }
            return next;
        });
    }

    function clearPipelineNodeSelection(): void {
        setSelectedNodeIdSet(new Set());
        setIsTableSelectionMode(false);
    }

    return {
        clearPipelineNodeSelection,
        isTableSelectionMode,
        selectedNodeIds,
        selectedNodeNames,
        togglePipelineNodeSelection,
        togglePipelineNodeSelectionMode,
    };
}
