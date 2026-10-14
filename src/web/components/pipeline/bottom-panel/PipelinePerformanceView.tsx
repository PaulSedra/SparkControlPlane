/**
 * @fileoverview Pipeline Performance view with persisted run timing.
 * Keeps unavailable Spark metrics as placeholders and delegates sample selection.
 */

import { Search } from 'lucide-react';
import type { PipelineNode, PipelineRun } from '../../../../shared/pipelineRegistryTypes.ts';
import { STATUS_PRESENTATION_LABELS, statusPresentationForPipelineNodeStatus } from '../../../../shared/status/presentation.ts';
import { StatusIcon } from '../../ui/StatusIcon';
import { formatPipelineDuration } from '../pipelineTiming.ts';
import { pipelineNodeDurationMs } from '../../../utils/pipelineRunTiming.ts';
import { AppIcon } from '../../ui/AppIcon';
import { formatDate } from '../../../lib/format';
import { AssetNameCell } from './AssetNameCell';
import { PanelTable } from './PanelTable';

/** Presents persisted run timing and unavailable Spark metric placeholders. */
export function PipelinePerformanceView({
    nodes,
    nowMs,
    onSelectSampleDataNode,
    run,
}: Readonly<{
    nodes: PipelineNode[];
    nowMs: number;
    onSelectSampleDataNode: (nodeId: string | undefined) => void;
    run?: PipelineRun;
}>) {
    return (
        <>
            <div className="bottom-panel-toolbar bottom-panel-performance-toolbar">
                <label className="bottom-panel-search">
                    <AppIcon icon={Search} size="status" />
                    <input aria-label="Filter performance statements" placeholder="Filter by table" />
                </label>
                <a href="#query-history">View all in query history ↗</a>
            </div>
            <PanelTable
                className="pipeline-performance-table"
                columns={[
                    { ariaLabel: 'Status', key: 'status', label: '' },
                    { key: 'asset-name', label: 'Asset Name' },
                    { key: 'started-at', label: 'Started At ↕' },
                    { key: 'duration', label: 'Duration' },
                    { key: 'rows-read', label: 'Rows read' },
                    { key: 'bytes-read', label: 'Bytes read' },
                    { key: 'bytes-written', label: 'Bytes written' },
                    {
                        key: 'spark-stages',
                        label: 'Spark stages',
                        title: 'Spark stage progress for the selected run',
                    },
                ]}
            >
                {nodes.map((node) => {
                    const statusRecord = run?.nodeStatuses?.[node.qualifiedName];
                    const status = statusPresentationForPipelineNodeStatus(
                        statusRecord?.status,
                        run?.status,
                        statusRecord?.completedAt,
                    );
                    const duration = pipelineNodeDurationMs(statusRecord, nowMs);
                    return (
                        <tr key={node.id}>
                            <td><StatusIcon label={STATUS_PRESENTATION_LABELS[status]} status={status} /></td>
                            <AssetNameCell
                                node={node}
                                onSelectSampleDataNode={onSelectSampleDataNode}
                            />
                            <td>{formatDate(statusRecord?.startedAt ?? run?.startedAt)}</td>
                            <td>{formatPipelineDuration(duration)}</td>
                            <td aria-label="Rows read unavailable">-</td>
                            <td aria-label="Bytes read unavailable">-</td>
                            <td aria-label="Bytes written unavailable">-</td>
                            <td aria-label="Spark stages unavailable">-</td>
                        </tr>
                    );
                })}
            </PanelTable>
        </>
    );
}

