/**
 * @fileoverview Shared asset-name cell for the Tables and Performance views.
 * Delegates sample-data selection to the bottom-panel owner.
 */

import type { PipelineNode } from '../../../../shared/pipelineRegistryTypes.ts';
import { DataAssetIcon } from '../../ui/DataAssetIcon';


/** Shows the asset name and delegates sample selection to the panel owner. */
export function AssetNameCell({
    node,
    onSelectSampleDataNode,
}: Readonly<{
    node: PipelineNode;
    onSelectSampleDataNode: (nodeId: string | undefined) => void;
}>) {
    return (
        <td>
            <button
                aria-label={`Show sample data for ${node.name}`}
                className="pipeline-output-name"
                onClick={() => onSelectSampleDataNode(node.id)}
                type="button"
            >
                <DataAssetIcon
                    kind={node.nodeType === 'MATERIALIZED_VIEW' ? 'view' : 'table'}
                />
                <strong>{node.name}</strong>
            </button>
        </td>
    );
}

