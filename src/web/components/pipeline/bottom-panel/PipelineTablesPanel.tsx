/**
 * @fileoverview Resizable lower panel for declared tables, node samples, and
 * run performance placeholders.
 */

import { useEffect, useMemo, useState } from 'react';
import type { PipelineDetail, PipelineNode, PipelineRun } from '../../../../shared/pipelineRegistryTypes.ts';
import { pipelineTableNodes } from '../../../utils/pipelineAssets.ts';
import { BottomPanelResizer } from './BottomPanelResizer';
import { PipelineTablesView } from './PipelineTablesView';
import { PipelinePerformanceView } from './PipelinePerformanceView';
import { PipelineSampleDataView } from './PipelineSampleDataView';

/** Default height for the pipeline bottom panel in pixels. */
export const DEFAULT_PIPELINE_BOTTOM_PANEL_HEIGHT = 330;
type BottomPanelTab = 'performance' | 'sample-data' | 'tables';

/**
 * Provides the lower pipeline panel for declared outputs and run timing.
 *
 * The panel owns tab selection and delegates each view to its feature component.
 * The sample view fetches only while mounted. The shell reports
 * only the bounded height change to its parent. Spark metrics remain visible as
 * unavailable placeholders until the application can attribute them to a run.
 * Pointer and keyboard resize paths clamp the shared height to
 * the supported range so the panel cannot consume the entire workspace.
 */
export function PipelineTablesPanel({
    detail,
    nowMs = Date.now(),
    onOpenSource,
    onPanelHeightChange,
    onShowInCatalog,
    onSelectSampleDataNode,
    panelHeight,
    run,
    sampleDataNodeId,
}: Readonly<{
    detail: PipelineDetail;
    nowMs?: number;
    onOpenSource: (node: PipelineNode) => void;
    onPanelHeightChange: (height: number) => void;
    onShowInCatalog: (node: PipelineNode) => void;
    onSelectSampleDataNode: (nodeId: string | undefined) => void;
    panelHeight: number;
    run?: PipelineRun;
    sampleDataNodeId?: string;
}>) {
    const [activeTab, setActiveTab] = useState<BottomPanelTab>('tables');
    const nodes = useMemo(
        () => pipelineTableNodes(detail.nodes),
        [detail.nodes],
    );
    const sampleDataNode = useMemo(
        () => nodes.find((node) => node.id === sampleDataNodeId),
        [nodes, sampleDataNodeId],
    );
    useEffect(() => {
        if (sampleDataNode != null) {
            setActiveTab('sample-data');
        } else {
            setActiveTab((current) => current === 'sample-data' ? 'tables' : current);
        }
    }, [sampleDataNode]);

    function selectPrimaryTab(tab: 'performance' | 'tables'): void {
        setActiveTab(tab);
        onSelectSampleDataNode(undefined);
    }

    return (
        <section className="pipeline-bottom-panel">
            <BottomPanelResizer
                onHeightChange={onPanelHeightChange}
                panelHeight={panelHeight}
            />
            <div className="bottom-panel-header">
                <nav aria-label="Pipeline output views" className="bottom-panel-tabs" role="tablist">
                    <button
                        aria-selected={activeTab === 'tables'}
                        className={activeTab === 'tables' ? 'active' : undefined}
                        onClick={() => selectPrimaryTab('tables')}
                        role="tab"
                        type="button"
                    >
                        Tables <span>{nodes.length}</span>
                    </button>
                    <button
                        aria-selected={activeTab === 'performance'}
                        className={activeTab === 'performance' ? 'active' : undefined}
                        onClick={() => selectPrimaryTab('performance')}
                        role="tab"
                        type="button"
                    >
                        Performance <span>{nodes.length}</span>
                    </button>
                    {sampleDataNode != null && (
                        <button
                            aria-selected={activeTab === 'sample-data'}
                            className={activeTab === 'sample-data' ? 'active' : undefined}
                            onClick={() => setActiveTab('sample-data')}
                            role="tab"
                            type="button"
                        >
                            Sample Data
                        </button>
                    )}
                </nav>
            </div>

            <PipelineTablesView
                active={activeTab === 'tables'}
                nodes={nodes}
                nowMs={nowMs}
                onOpenSource={onOpenSource}
                onSelectSampleDataNode={onSelectSampleDataNode}
                onShowInCatalog={onShowInCatalog}
                run={run}
                spec={detail.spec}
            />
            {activeTab === 'performance' && (
                <PipelinePerformanceView
                    nodes={nodes}
                    nowMs={nowMs}
                    onSelectSampleDataNode={onSelectSampleDataNode}
                    run={run}
                />
            )}
            {activeTab === 'sample-data' && sampleDataNode != null && (
                <PipelineSampleDataView pipelineId={detail.id} node={sampleDataNode} />
            )}
        </section>
    );
}
