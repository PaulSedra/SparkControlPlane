/**
 * @fileoverview Pipeline detail route composition for graph, runs, controls,
 * source navigation, and catalog navigation.
 */

import { useQueries } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { CSSProperties } from 'react';
import { AlertCircle } from 'lucide-react';
import { ApplicationShell } from '../components/shell/ApplicationShell';
import { AppIcon } from '../components/ui/AppIcon';
import {
    DEFAULT_PIPELINE_BOTTOM_PANEL_HEIGHT,
    PipelineTablesPanel,
} from '../components/pipeline/bottom-panel/PipelineTablesPanel';
import { PipelineView } from '../components/pipeline/PipelineView';
import {
    PipelineHeader,
    PipelineRunToolbar,
    PipelineSelectionBar,
} from '../components/pipeline/PipelineControls';
import { PipelineDetailsRail } from '../components/pipeline/PipelineDetailsRail';
import { usePipelineController } from '../components/pipeline/hooks/usePipelineController';
import type { PipelineController } from '../components/pipeline/hooks/usePipelineController';
import { hasActiveRunTiming } from '../components/pipeline/pipelineTiming.ts';
import type { SparkTable } from '../../shared/catalogTypes.ts';
import type { PipelineNode } from '../../shared/pipelineRegistryTypes.ts';
import type { PipelineAssetNode } from '../types/pipelineAssetTypes.ts';
import { navigateTo, pipelineRunPath, useCurrentRoute } from '../routes/useCurrentRoute';
import { catalogTablePath } from '../utils/catalogNavigation.ts';
import { catalogTablesQueryOptions } from '../components/catalog/hooks/catalogQueries.ts';
import {
    pipelineCatalogNamespaceKey,
    pipelineCatalogTarget,
    pipelineOutputTableTargets,
    pipelineTablePresenceByNodeId,
} from '../utils/pipelineCatalog.ts';

/**
 * Wires the pipeline route's controllers and navigation boundaries together.
 *
 * The route owns URL selection, the pipeline controller owns durable run state,
 * and elapsed run timing follows persisted app run state. Source and catalog
 * actions become deep links rather than local modal state, allowing a
 * reload/back navigation to reconstruct the same context.
 */
export default function PipelinePage() {
    const currentRoute = useCurrentRoute();
    const routePipelineId = currentRoute.match?.params.applicationId;
    const routeRunId = currentRoute.match?.params.runId;
    const navigateToRun = useCallback((runId: string) => {
        if (routePipelineId != null) {
            navigateTo(pipelineRunPath(routePipelineId, runId));
        }
    }, [routePipelineId]);
    const controller = usePipelineController(routePipelineId, routeRunId, navigateToRun);
    const pipelineDetail = controller.pipelineDetail;
    const selectedRun = controller.selectedRun;
    const outputTableTargets = useMemo(
        () => pipelineOutputTableTargets(pipelineDetail),
        [pipelineDetail],
    );
    const catalogNamespaces = useMemo(() => {
        const namespaces = new Map<string, { catalog: string; schema: string }>();
        for (const target of outputTableTargets) {
            const key = pipelineCatalogNamespaceKey(target.catalog, target.schema);
            namespaces.set(key, { catalog: target.catalog, schema: target.schema });
        }
        return [...namespaces.values()];
    }, [outputTableTargets]);
    const catalogTableQueries = useQueries({
        queries: catalogNamespaces.map(({ catalog, schema }) => ({
            ...catalogTablesQueryOptions(catalog, schema),
            retry: false,
            staleTime: 0,
        })),
    });
    const sparkTablePresenceByNodeId = useMemo(() => {
        const tablesByNamespace = new Map<
            string,
            readonly Pick<SparkTable, 'name'>[]
        >();
        catalogTableQueries.forEach((query, index) => {
            const namespace = catalogNamespaces[index];
            if (namespace != null && query.isSuccess && !query.isFetching) {
                tablesByNamespace.set(
                    pipelineCatalogNamespaceKey(namespace.catalog, namespace.schema),
                    query.data,
                );
            }
        });
        return pipelineTablePresenceByNodeId(outputTableTargets, tablesByNamespace);
    }, [catalogNamespaces, catalogTableQueries, outputTableTargets]);
    const selectedRunId = selectedRun?.runId;
    const selectedRunHasActiveTiming = hasActiveRunTiming(selectedRun);
    const [nowMs, setNowMs] = useState(() => Date.now());
    const [bottomPanelHeight, setBottomPanelHeight] = useState(
        DEFAULT_PIPELINE_BOTTOM_PANEL_HEIGHT,
    );

    useEffect(() => {
        if (!selectedRunHasActiveTiming) {
            return undefined;
        }

        setNowMs(Date.now());
        const intervalId = window.setInterval(() => setNowMs(Date.now()), 1_000);
        return () => window.clearInterval(intervalId);
    }, [selectedRunHasActiveTiming, selectedRunId]);

    function openSourceWorkspace(node: { id: string; sourceFile?: string }): void {
        if (controller.pipelineDetail == null) {
            return;
        }

        const params = new URLSearchParams({
            nodeId: node.id,
            pipelineId: controller.pipelineDetail.id,
        });
        if (node.sourceFile != null) {
            params.set('file', node.sourceFile);
        }
        navigateTo(`/workspace?${params.toString()}`);
    }

    function openCatalog(node: PipelineNode): void {
        if (controller.pipelineDetail == null) {
            return;
        }

        const target = pipelineCatalogTarget(node, controller.pipelineDetail.spec);
        if (target == null) {
            return;
        }

        navigateTo(catalogTablePath(target));
    }

    return (
        <ApplicationShell activeItem="pipelines" className="pipeline-app-shell">
            <PipelinePageContent
                key={routePipelineId ?? ''}
                bottomPanelHeight={bottomPanelHeight}
                controller={controller}
                nowMs={nowMs}
                sparkTablePresenceByNodeId={sparkTablePresenceByNodeId}
                onOpenCatalog={openCatalog}
                onOpenSource={openSourceWorkspace}
                onPanelHeightChange={setBottomPanelHeight}
            />
        </ApplicationShell>
    );
}

/**
 * Composes the loaded pipeline view below the persistent shell.
 *
 * Loading/error state stays outside the graph, while the graph, detail rail,
 * and bottom panel share the selected run and app-owned timing clock. The panel
 * height is local layout state; all pipeline actions continue through the
 * controller supplied by the route.
 */
function PipelinePageContent({
    bottomPanelHeight = DEFAULT_PIPELINE_BOTTOM_PANEL_HEIGHT,
    controller,
    nowMs,
    sparkTablePresenceByNodeId,
    onOpenCatalog,
    onOpenSource,
    onPanelHeightChange,
}: Readonly<{
    bottomPanelHeight?: number;
    controller: PipelineController;
    nowMs: number;
    sparkTablePresenceByNodeId: ReadonlyMap<string, boolean>;
    onOpenCatalog: (node: PipelineNode) => void;
    onOpenSource: (node: { id: string; sourceFile?: string }) => void;
    onPanelHeightChange: (height: number) => void;
}>) {
    const [sampleDataNodeId, setSampleDataNodeId] = useState<string>();
    const {
        pipelineActionStates,
        activePipelineRunId,
        isPipelineRunnable,
        cancelPipelineRun,
        clearPipelineNodeSelection,
        pipelineDetail,
        deployPipeline,
        pipelineLoadState,
        startPipelineRun,
        selectedNodeIds,
        selectedNodeNames,
        selectPipelineRun,
        isTableSelectionMode,
        togglePipelineNodeSelection,
        togglePipelineNodeSelectionMode,
    } = controller;
    const selectedRun = controller.selectedRun;
    const selectedSampleDataNode = pipelineDetail?.nodes.find(
        (node) => node.id === sampleDataNodeId && node.nodeType !== 'EXTERNAL_DATASET',
    );

    function openSampleDataForAsset(assetNode: PipelineAssetNode): void {
        const node = pipelineDetail?.nodes.find((candidate) => candidate.id === assetNode.id);
        if (node != null && node.nodeType !== 'EXTERNAL_DATASET') {
            setSampleDataNodeId(node.id);
        }
    }

    return (
        <>
            {pipelineLoadState.kind === 'error' && (
                <div className="graph-notice" role="alert">
                    <AppIcon icon={AlertCircle} size="status" />
                    <span>{pipelineLoadState.message}</span>
                </div>
            )}

            <section
                className="db-workspace"
                style={{ '--pipeline-bottom-panel-height': `${bottomPanelHeight}px` } as CSSProperties}
            >
                <PipelineHeader
                    actionStates={pipelineActionStates}
                    canRunPipeline={isPipelineRunnable}
                    detail={pipelineDetail}
                    onCancel={cancelPipelineRun}
                    onDeploy={deployPipeline}
                    onRun={startPipelineRun}
                />
                <PipelineRunToolbar
                    actionStates={pipelineActionStates}
                    canRunPipeline={isPipelineRunnable}
                    detail={pipelineDetail}
                    onSelectRun={selectPipelineRun}
                    onToggleTableSelection={togglePipelineNodeSelectionMode}
                    selectedRun={selectedRun}
                    tableSelectionMode={isTableSelectionMode}
                />

                {pipelineDetail == null ? (
                    <div aria-busy="true" className="pipeline-blank-results" />
                ) : (
                    <>
                        <section className="pipeline-upper">
                            <section className="main-canvas">
                                <PipelineView
                                    declaredPipeline={pipelineDetail}
                                    onOpenSource={onOpenSource}
                                    onOpenSampleData={openSampleDataForAsset}
                                    onSelectNode={isTableSelectionMode ? togglePipelineNodeSelection : undefined}
                                    onSelectRun={selectPipelineRun}
                                    run={selectedRun}
                                    runs={pipelineDetail.runs}
                                    sparkTablePresenceByNodeId={sparkTablePresenceByNodeId}
                                    selectedNodeIds={selectedNodeIds}
                                    selectedRunId={selectedRun?.runId}
                                    nowMs={nowMs}
                                />
                                {selectedNodeNames.length > 0 && (
                                    <PipelineSelectionBar
                                        activeRunId={activePipelineRunId}
                                        runPending={pipelineActionStates.run.kind === 'running'}
                                        canRunPipeline={isPipelineRunnable}
                                        onClear={clearPipelineNodeSelection}
                                        onRun={startPipelineRun}
                                        selectedNodeNames={selectedNodeNames}
                                    />
                                )}
                            </section>
                            <PipelineDetailsRail
                                detail={pipelineDetail}
                                nowMs={nowMs}
                                run={selectedRun}
                            />
                        </section>

                        <PipelineTablesPanel
                            panelHeight={bottomPanelHeight}
                            detail={pipelineDetail}
                            onOpenSource={onOpenSource}
                            onPanelHeightChange={onPanelHeightChange}
                            onShowInCatalog={onOpenCatalog}
                            run={selectedRun}
                            sampleDataNodeId={selectedSampleDataNode?.id}
                            onSelectSampleDataNode={setSampleDataNodeId}
                        />
                    </>
                )}
            </section>
        </>
    );
}
