/**
 * @fileoverview Tables-view row with node status, timing, and navigation actions.
 * Owns the action-menu lifecycle, including outside-pointer and Escape dismissal.
 */

import { Code2, MoreVertical, Table2 } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import type { PipelineDetail, PipelineNode, PipelineRun } from '../../../../shared/pipelineRegistryTypes.ts';
import { statusPresentationForPipelineNodeStatus } from '../../../../shared/status/presentation.ts';
import { StatusIcon } from '../../ui/StatusIcon';
import { formatPipelineDuration } from '../pipelineTiming.ts';
import { pipelineNodeDurationMs } from '../../../utils/pipelineRunTiming.ts';
import { AppIcon } from '../../ui/AppIcon';
import { pipelineCatalogTarget } from '../../../utils/pipelineCatalog.ts';
import { AssetNameCell } from './AssetNameCell';

/** Owns table actions and closes its menu on outside pointer or Escape. */
export function PipelineTableRow({
    node,
    nowMs,
    onOpenSource,
    onSelectSampleDataNode,
    onShowInCatalog,
    run,
    spec,
}: Readonly<{
    node: PipelineNode;
    nowMs: number;
    onOpenSource: (node: PipelineNode) => void;
    onSelectSampleDataNode: (nodeId: string | undefined) => void;
    onShowInCatalog: (node: PipelineNode) => void;
    run?: PipelineRun;
    spec: PipelineDetail['spec'];
}>) {
    const statusRecord = run?.nodeStatuses?.[node.qualifiedName];
    const status = statusPresentationForPipelineNodeStatus(
        statusRecord?.status,
        run?.status,
        statusRecord?.completedAt,
    );
    const duration = pipelineNodeDurationMs(statusRecord, nowMs);
    const catalogTarget = pipelineCatalogTarget(node, spec);
    const canOpenSource = node.sourceFile?.trim() !== '' || node.sqlText?.trim() !== '';
    const menuId = useId();
    const menuRef = useRef<HTMLDivElement>(null);
    const [menuOpen, setMenuOpen] = useState(false);

    useEffect(() => {
        if (!menuOpen) {
            return undefined;
        }

        const closeOnOutsidePointer = (event: PointerEvent) => {
            if (menuRef.current?.contains(event.target as Node)) {
                return;
            }

            setMenuOpen(false);
        };
        const closeOnEscape = (event: KeyboardEvent) => {
            if (event.key === 'Escape') {
                setMenuOpen(false);
            }
        };
        document.addEventListener('pointerdown', closeOnOutsidePointer);
        document.addEventListener('keydown', closeOnEscape);
        return () => {
            document.removeEventListener('pointerdown', closeOnOutsidePointer);
            document.removeEventListener('keydown', closeOnEscape);
        };
    }, [menuOpen]);

    return (
        <tr>
            <td><StatusIcon status={status} /></td>
            <AssetNameCell
                node={node}
                onSelectSampleDataNode={onSelectSampleDataNode}
            />
            <td>{formatPipelineDuration(duration)}</td>
            <td>-</td>
            <td>-</td>
            <td>{node.nodeType === 'MATERIALIZED_VIEW' ? 'Incremental' : 'N/A'}</td>
            <td>
                <div className="pipeline-output-actions">
                    <button
                        aria-label={`Show ${node.name} in catalog`}
                        disabled={catalogTarget == null}
                        onClick={() => {
                            if (catalogTarget != null) {
                                onShowInCatalog(node);
                            }
                        }}
                        title="Show in Catalog"
                        type="button"
                    >
                        <AppIcon icon={Table2} size="status" />
                    </button>
                    <button
                        aria-label={`View source code for ${node.name}`}
                        disabled={!canOpenSource}
                        onClick={() => onOpenSource(node)}
                        title="View source code in Workspace"
                        type="button"
                    >
                        <AppIcon icon={Code2} size="status" />
                    </button>
                    <div className="pipeline-output-menu-wrapper" ref={menuRef}>
                        <button
                            aria-controls={menuId}
                            aria-expanded={menuOpen}
                            aria-haspopup="menu"
                            aria-label={`More actions for ${node.name}`}
                            onClick={() => setMenuOpen((current) => !current)}
                            title={`More actions for ${node.name}`}
                            type="button"
                        >
                            <AppIcon icon={MoreVertical} size="status" />
                        </button>
                        {menuOpen && (
                            <div className="pipeline-output-action-menu" id={menuId} role="menu">
                                <button onClick={() => setMenuOpen(false)} role="menuitem" type="button">
                                    View table performance
                                </button>
                                <button onClick={() => setMenuOpen(false)} role="menuitem" type="button">
                                    View flows
                                </button>
                            </div>
                        )}
                    </div>
                </div>
            </td>
        </tr>
    );
}

