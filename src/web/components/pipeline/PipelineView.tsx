/**
 * @fileoverview Pipeline graph/run tab switcher for declared assets and history.
 */

import { List, Network } from 'lucide-react';
import { useMemo, useState } from 'react';
import type {
    PipelineDetail,
    PipelineRun,
} from '../../../shared/pipelineRegistryTypes.ts';
import { AppIcon } from '../ui/AppIcon';
import { PipelineAssetGraph } from './graph/PipelineAssetGraph';
import { PipelineRunsView } from './runs/PipelineRunsView';
import { declaredPipelineOperations } from '../../utils/pipelineAssets.ts';
import type {
    PipelineAssetNode,
    PipelineAssetOperation,
} from '../../types/pipelineAssetTypes.ts';

/**
 * Switches between the declared asset graph and run history.
 *
 * The registry is the graph authority. The selected view is local UI state,
 * while run/node selection, sample-data requests, and source navigation are
 * delegated to the page controller.
 */
export function PipelineView({
    declaredPipeline,
    run,
    runs = [],
    onSelectRun,
    onOpenSource,
    onOpenSampleData,
    onSelectNode,
    selectedNodeIds,
    selectedRunId,
    sparkTablePresenceByNodeId,
    nowMs,
}: Readonly<{
    onSelectRun?: (runId: string) => void;
    onOpenSource?: (node: PipelineAssetNode) => void;
    onOpenSampleData?: (node: PipelineAssetNode) => void;
    onSelectNode?: (node: PipelineAssetNode) => void;
    declaredPipeline?: PipelineDetail;
    run?: PipelineRun;
    runs?: PipelineRun[];
    selectedNodeIds?: string[];
    selectedRunId?: string;
    sparkTablePresenceByNodeId?: ReadonlyMap<string, boolean>;
    nowMs?: number;
}>) {
    const [view, setView] = useState<'pipeline' | 'runs'>('pipeline');
    const assetOperations: PipelineAssetOperation[] = useMemo(() => {
        const operations = declaredPipeline == null
            ? []
            : pipelineGraphOperations(
                declaredPipelineOperations(declaredPipeline, run), declaredPipeline,
            );
        return operations.map((operation) => ({
            ...operation,
            inputs: operation.inputs.map((input) =>
                assetWithSparkTablePresence(input, sparkTablePresenceByNodeId)),
            output: assetWithSparkTablePresence(
                operation.output,
                sparkTablePresenceByNodeId,
            ),
        }));
    }, [declaredPipeline, run, sparkTablePresenceByNodeId]);

    return (
        <div className="pipeline-graph-frame">
            <div className="graph-view-tabs">
                <div aria-label="Pipeline view" className="pipeline-view-tabs" role="tablist">
                    <button
                        aria-selected={view === 'pipeline'}
                        aria-label="Graph"
                        className={view === 'pipeline' ? 'active' : undefined}
                        onClick={() => setView('pipeline')}
                        title="Graph"
                        role="tab"
                        type="button"
                    >
                        <AppIcon icon={Network} size="status" />
                    </button>
                    <button
                        aria-selected={view === 'runs'}
                        aria-label="Runs"
                        className={view === 'runs' ? 'active' : undefined}
                        onClick={() => setView('runs')}
                        title="Runs"
                        role="tab"
                        type="button"
                    >
                        <AppIcon icon={List} size="status" />
                    </button>
                </div>
            </div>
            {view === 'pipeline' ? (
                <PipelineAssetGraph
                    onOpenSource={onOpenSource}
                    onOpenSampleData={onOpenSampleData}
                    onSelectNode={onSelectNode}
                    operations={assetOperations}
                    run={run}
                    selectedNodeIds={selectedNodeIds}
                    nowMs={nowMs}
                />
            ) : (
                <PipelineRunsView
                    onSelectRun={onSelectRun ?? (() => undefined)}
                    runs={runs}
                    selectedRunId={selectedRunId}
                />
            )}
        </div>
    );
}

function assetWithSparkTablePresence(
    asset: PipelineAssetNode,
    presenceByNodeId: ReadonlyMap<string, boolean> | undefined,
): PipelineAssetNode {
    const exists = presenceByNodeId?.get(asset.id);
    return exists == null ? asset : { ...asset, sparkTableExists: exists };
}

/**
 * Connects pipeline table inputs directly to flow targets for graph display.
 * Flows without known internal inputs remain visible as external-source flows.
 * The original operations retain flow execution state for other consumers.
 */
function pipelineGraphOperations(
    operations: readonly PipelineAssetOperation[],
    pipeline: PipelineDetail,
): PipelineAssetOperation[] {
    const operationsById = new Map(operations.map((operation) =>
        [operation.output.id, operation]));
    const nodesById = new Map(pipeline.nodes.map((node) => [node.id, node]));
    const internalInputs = new Map<string, PipelineAssetNode[]>();
    const externalInputsByFlow = new Map<string, PipelineAssetNode[]>();
    const visibleFlows = new Set<string>();
    for (const node of pipeline.nodes) {
        if (node.nodeType !== 'FLOW') {
            continue;
        }
        const edges = pipeline.edges.filter((edge) => edge.targetNodeId === node.id);
        const flowInputs = operationsById.get(node.id)?.inputs ?? [];
        const inputs = flowInputs.filter((input) => {
            const inputType = nodesById.get(input.id)?.nodeType;
            return inputType !== 'FLOW' && inputType !== 'EXTERNAL_DATASET';
        });
        const externalInputs = flowInputs.filter((input) =>
            nodesById.get(input.id)?.nodeType === 'EXTERNAL_DATASET');
        internalInputs.set(node.id, inputs);
        externalInputsByFlow.set(node.id, externalInputs);
        if (edges.length === 0 || edges.some((edge) => {
            const source = nodesById.get(edge.sourceNodeId);
            return source == null || source.nodeType === 'EXTERNAL_DATASET' ||
                source.nodeType === 'FLOW';
        })) {
            visibleFlows.add(node.id);
        }
    }

    return operations
        .filter((operation) => !internalInputs.has(operation.output.id) ||
            visibleFlows.has(operation.output.id))
        .map((operation) => {
            const inputs = internalInputs.has(operation.output.id)
                ? [
                    ...operation.inputs.filter((input) =>
                        nodesById.get(input.id)?.nodeType === 'FLOW'),
                    ...(externalInputsByFlow.get(operation.output.id) ?? []),
                ] :
                operation.inputs.flatMap((input) => {
                    const tables = internalInputs.get(input.id);
                    return tables == null ? [input] :
                        [...tables, ...(visibleFlows.has(input.id) ? [input] : [])];
                });
            return {
                ...operation,
                inputs: [...new Map(inputs.map((input) => [input.id, input])).values()],
            };
        });
}

