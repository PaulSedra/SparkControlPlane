/** @fileoverview Display labels for discovered pipeline node types. */

import type {
    ExternalDatasetKind,
    NodeType,
} from '../../../shared/pipelineRegistryTypes.ts';

/** Returns the canonical user-facing label for a registry pipeline node type. */
export function pipelineNodeTypeLabel(
    nodeType: NodeType,
    externalKind?: ExternalDatasetKind,
): string {
    switch (nodeType) {
        case 'EXTERNAL_DATASET':
            return externalKind === 'TABLE' ? 'External Table' : 'External Source';
        case 'FLOW':
            return 'Flow';
        case 'MATERIALIZED_VIEW':
            return 'Materialized view';
        case 'SINK':
            return 'Sink';
        case 'STREAMING_TABLE':
            return 'Streaming Table';
        case 'TEMPORARY_VIEW':
            return 'Temporary view';
    }
}
