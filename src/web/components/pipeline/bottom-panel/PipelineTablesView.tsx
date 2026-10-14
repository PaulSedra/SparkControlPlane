/**
 * @fileoverview Pipeline Tables view with local search, type, and status filters.
 * Retains filters across tab switches while inactive rows and menus unmount.
 */

import { ChevronDown, Search } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { PipelineDetail, PipelineNode, PipelineRun } from '../../../../shared/pipelineRegistryTypes.ts';
import { AppIcon } from '../../ui/AppIcon';
import { statusPresentationForPipelineNodeStatus, type StatusPresentationState } from '../../../../shared/status/presentation.ts';
import { PanelTable } from './PanelTable';
import { PipelineTableRow } from './PipelineTableRow';

type TableTypeFilter = 'all' | 'table' | 'view';
type TableStatusFilter = 'all' | StatusPresentationState;

/** Owns table filters across tab switches; inactive rows and menus unmount. */
export function PipelineTablesView({
    active,
    nodes,
    nowMs,
    onOpenSource,
    onSelectSampleDataNode,
    onShowInCatalog,
    run,
    spec,
}: Readonly<{
    active: boolean;
    nodes: PipelineNode[];
    nowMs: number;
    onOpenSource: (node: PipelineNode) => void;
    onSelectSampleDataNode: (nodeId: string | undefined) => void;
    onShowInCatalog: (node: PipelineNode) => void;
    run?: PipelineRun;
    spec: PipelineDetail['spec'];
}>) {
    const [tableSearchQuery, setTableSearchQuery] = useState('');
    const [statusFilter, setStatusFilter] = useState<TableStatusFilter>('all');
    const [typeFilter, setTypeFilter] = useState<TableTypeFilter>('all');
    const filteredNodes = useMemo(() => {
        const normalizedSearchQuery = tableSearchQuery.trim().toLowerCase();
        return nodes.filter((node) => {
            const statusRecord = run?.nodeStatuses?.[node.qualifiedName];
            const status = statusPresentationForPipelineNodeStatus(
                statusRecord?.status,
                run?.status,
                statusRecord?.completedAt,
            );
            const type = node.nodeType === 'MATERIALIZED_VIEW' || node.nodeType === 'TEMPORARY_VIEW'
                ? 'view'
                : 'table';

            return (typeFilter === 'all' || typeFilter === type) &&
                (statusFilter === 'all' || statusFilter === status) &&
                (normalizedSearchQuery === '' ||
                    node.name.toLowerCase().includes(normalizedSearchQuery));
        });
    }, [nodes, tableSearchQuery, run, statusFilter, typeFilter]);
    if (!active) {
        return null;
    }

    return (
    <>
        <div className="bottom-panel-toolbar">
            <label className="bottom-panel-search">
                <AppIcon icon={Search} size="status" />
                <input
                    aria-label="Filter by table"
                    onChange={(event) => setTableSearchQuery(event.target.value)}
                    placeholder="Filter by table"
                    value={tableSearchQuery}
                />
            </label>
            <label className="bottom-panel-select">
                <span>Type</span>
                <select
                    aria-label="Filter tables by type"
                    onChange={(event) => setTypeFilter(event.target.value as TableTypeFilter)}
                    value={typeFilter}
                >
                    <option value="all">All</option>
                    <option value="table">Table</option>
                    <option value="view">View</option>
                </select>
                <AppIcon icon={ChevronDown} size="status" />
            </label>
            <label className="bottom-panel-select">
                <span>Status</span>
                <select
                    aria-label="Filter tables by status"
                    onChange={(event) => setStatusFilter(event.target.value as TableStatusFilter)}
                    value={statusFilter}
                >
                    <option value="all">All</option>
                    <option value="succeeded">Completed</option>
                    <option value="canceled">Canceled</option>
                    <option value="running">Running</option>
                    <option value="failed">Failed</option>
                    <option value="unknown">Unknown</option>
                </select>
                <AppIcon icon={ChevronDown} size="status" />
            </label>
        </div>
        <PanelTable
            className="pipeline-output-table"
            columns={[
                { ariaLabel: 'Status', key: 'status', label: '' },
                { key: 'name', label: <>Asset Name <span className="sort-indicator">↕</span></> },
                { key: 'duration', label: 'Duration' },
                { key: 'records', label: 'Output records' },
                { key: 'expectations', label: 'Expectations' },
                {
                    key: 'incrementalization',
                    label: <>Incrementalization <span className="info-dot">i</span></>,
                },
                { ariaLabel: 'Actions', key: 'actions', label: '' },
            ]}
            emptyMessage={filteredNodes.length === 0
                ? 'No tables match the current filters.'
                : undefined}
        >
            {filteredNodes.map((node) => (
                <PipelineTableRow
                    key={node.id}
                    node={node}
                    nowMs={nowMs}
                    onOpenSource={onOpenSource}
                    onSelectSampleDataNode={onSelectSampleDataNode}
                    onShowInCatalog={onShowInCatalog}
                    run={run}
                    spec={spec}
                />
            ))}
        </PanelTable>
    </>
    );
}
