/**
 * @fileoverview Declarative and observed pipeline asset graph with minimap,
 * node selection, and source navigation.
 */

import {
    Code2,
    FolderTree,
    Route,
    Table2,
    Workflow,
} from 'lucide-react';
import {
    useRef,
    useState,
    type CSSProperties,
    type KeyboardEvent as ReactKeyboardEvent,
    type MouseEvent as ReactMouseEvent,
    type PointerEvent as ReactPointerEvent,
} from 'react';
import { EmptyState } from '../../ui/EmptyState';
import { AppIcon } from '../../ui/AppIcon';
import { DataAssetIcon } from '../../ui/DataAssetIcon';
import { GraphCanvas } from '../../graph-canvas/GraphCanvas';
import { StatusIcon } from '../../ui/StatusIcon';
import {
    PIPELINE_ASSET_STATUS_LABELS,
    STATUS_PRESENTATION_STATES,
    PipelineAssetState,
    type StatusPresentationState,
} from '../../../../shared/status/presentation.ts';
import type { PipelineRun } from '../../../../shared/pipelineRegistryTypes.ts';
import { formatNumber } from '../../../lib/format';
import { pipelineAssetCount } from '../../../utils/pipelineAssets.ts';
import {
    ASSET_GRAPH_STYLE,
    ASSET_COLUMN_GAP,
    ASSET_COLUMN_WIDTH,
    ASSET_EXTERNAL_SOURCE_HEIGHT,
    ASSET_EXTERNAL_SOURCE_WIDTH,
    ASSET_NODE_HEIGHT,
} from './pipelineAssetGraphConstants.ts';
import {
    assetEdgeArrowPath,
    assetEdgePath,
    nodePositions,
} from './pipelineAssetGraphGeometry.ts';
import { positionExternalSources } from './pipelineAssetGraphExternalSources.ts';
import { buildAssetLayout } from './pipelineAssetLayout.ts';
import {
    getAssetNodeHover,
    isAssetEdgeHighlighted,
    orderAssetEdgesForPaint,
    type AssetNodeHover,
    type AssetNodeHoverDirection,
} from './pipelineAssetGraphEdges.ts';
import type {
    PipelineAssetKind,
    PipelineAssetNode,
    PipelineAssetOperation,
} from '../../../types/pipelineAssetTypes.ts';
import type {
    GraphEdge,
    GraphLayout,
    GraphNode,
} from '../../../types/pipelineAssetLayoutTypes.ts';
import type { GraphPosition } from './pipelineAssetGraphGeometry.ts';
import { pipelineNodeDurationMs } from '../../../utils/pipelineRunTiming.ts';
import { PipelineRunErrorPanel } from './PipelineRunErrorPanel';

/**
 * Builds and renders the pipeline asset graph used for lineage and node state.
 *
 * Declared pipeline assets are the graph. Layout remains deterministic for
 * stable selection and minimap behavior. Hovering the left or right half of a
 * regular node highlights its incoming or outgoing connectors respectively;
 * hovering an external source highlights its outgoing connectors. Node clicks
 * request a bounded sample and optionally report refresh selection; source
 * actions navigate to the declaration. The selected run's diagnostic panel
 * stays anchored to the graph.
 */
export function PipelineAssetGraph({
    onOpenSource,
    onOpenSampleData,
    onSelectNode,
    operations,
    selectedNodeIds,
    selectedNodeId,
    run,
    nowMs = Date.now(),
}: Readonly<{
    onOpenSource?: (node: PipelineAssetNode) => void;
    onOpenSampleData?: (node: PipelineAssetNode) => void;
    onSelectNode?: (node: PipelineAssetNode) => void;
    operations: PipelineAssetOperation[];
    run?: PipelineRun;
    selectedNodeIds?: string[];
    selectedNodeId?: string;
    nowMs?: number;
}>) {
    const [hoveredNode, setHoveredNode] = useState<AssetNodeHover>();
    const layout = buildAssetLayout(operations);

    if (operations.length === 0) {
        return (
            <EmptyState
                icon={<AppIcon icon={Route} size="empty" />}
                title="No declared assets"
                detail="Run pipeline discovery to load the declared assets."
            />
        );
    }

    const positions = nodePositions(
        layout.levels,
        layout.leftPaddingX,
        layout.externalSourceCollisionLevels,
    );
    const minimapNodes = layout.levels.flat().map((node) => {
        const position = positions.get(node.id);
        return position == null ? null : {
            height: ASSET_NODE_HEIGHT,
            id: node.id,
            status: node.status,
            width: ASSET_COLUMN_WIDTH,
            x: position.x,
            y: position.y,
        };
    }).filter((node): node is NonNullable<typeof node> => node != null);
    const externalSourcePositions = externalSourceOverlayStyles(layout, positions);
    const graphStyle = {
        ...ASSET_GRAPH_STYLE,
        '--asset-viewport-padding-x': `${layout.leftPaddingX}px`,
    } as CSSProperties;

    return (
        <GraphCanvas
            ariaLabel="Pipeline asset graph"
            className="asset-viewport"
            footer={(
                <div className="asset-graph-footer">
                    <span className="asset-count">
                        {formatNumber(pipelineAssetCount(operations))} declared assets
                    </span>
                    <PipelineRunErrorPanel run={run} />
                </div>
            )}
            minimap={{
                contentSize: { height: layout.height, width: layout.width },
                nodes: minimapNodes,
            }}
            style={graphStyle}
        >
            <AssetEdges
                externalSources={externalSourcePositions}
                hoveredNode={hoveredNode}
                layout={layout}
            />
            {externalSourcePositions.map(({ node, style }) => (
                <AssetNode
                    key={`${node.id}:${style.left}:${style.top}`}
                    node={node}
                    nowMs={nowMs}
                    onHoverChange={setHoveredNode}
                    onOpenSource={onOpenSource}
                    onOpenSampleData={onOpenSampleData}
                    onSelectNode={onSelectNode}
                    selected={false}
                    style={style}
                />
            ))}
            {layout.levels.map((level, levelIndex) => {
                const columnPosition = positions.get(level[0].id);
                const defaultLeft = layout.leftPaddingX +
                    levelIndex * (ASSET_COLUMN_WIDTH + ASSET_COLUMN_GAP);
                const left = (columnPosition?.x ?? defaultLeft) - defaultLeft;
                return (
                    <div
                        className="dag-column asset-column"
                        key={levelIndex}
                        style={{ left }}
                    >
                        {level.map((node) => (
                            <AssetNode
                                key={node.id}
                                node={node}
                                onHoverChange={setHoveredNode}
                                onOpenSource={onOpenSource}
                                onOpenSampleData={onOpenSampleData}
                                onSelectNode={onSelectNode}
                                selected={node.id === selectedNodeId || selectedNodeIds?.includes(node.id) === true}
                                nowMs={nowMs}
                            />
                        ))}
                    </div>
                );
            })}
        </GraphCanvas>
    );
}

type ExternalSourcePlacement = {
    node: GraphNode;
    position: GraphPosition;
    style: CSSProperties;
    targetIds: string[];
};

type AssetEdgeRender = GraphEdge & {
    edgeId: string;
    source: GraphPosition;
    sourceHeight?: number;
    sourceWidth?: number;
    target: GraphPosition;
};

function AssetEdges({
    externalSources,
    hoveredNode,
    layout,
}: Readonly<{
    externalSources: ExternalSourcePlacement[];
    hoveredNode?: AssetNodeHover;
    layout: GraphLayout;
}>) {
    const positions = nodePositions(
        layout.levels,
        layout.leftPaddingX,
        layout.externalSourceCollisionLevels,
    );
    const edges: AssetEdgeRender[] = [
        ...layout.edges.flatMap((edge): AssetEdgeRender[] => {
            const source = positions.get(edge.sourceId);
            const target = positions.get(edge.targetId);
            if (source == null || target == null) {
                return [];
            }

            return [{
                ...edge,
                edgeId: edge.sourceId + '->' + edge.targetId,
                source,
                target,
            }];
        }),
        ...externalSources.flatMap((source) =>
            source.targetIds.flatMap((targetId): AssetEdgeRender[] => {
                const target = positions.get(targetId);
                if (target == null) {
                    return [];
                }

                return [{
                    edgeId: source.node.id + '->' + targetId,
                    sourceId: source.node.id,
                    source: source.position,
                    sourceHeight: ASSET_EXTERNAL_SOURCE_HEIGHT,
                    sourceWidth: ASSET_EXTERNAL_SOURCE_WIDTH,
                    target,
                    targetId,
                }];
            }),
        ),
    ];
    const orderedEdges = orderAssetEdgesForPaint(edges, hoveredNode);

    return (
        <svg
            aria-hidden="true"
            className="asset-edges"
            height={layout.height}
            width={layout.width}
            viewBox={`0 0 ${layout.width} ${layout.height}`}
        >
            {orderedEdges.map((edge) => (
                <g
                    className={
                        'asset-edge-group' +
                        (isAssetEdgeHighlighted(edge, hoveredNode)
                            ? ' is-highlighted'
                            : '')
                    }
                    key={edge.edgeId}
                >
                    <path
                        className="asset-edge"
                        d={assetEdgePath(
                            edge.source,
                            edge.target,
                            edge.sourceWidth,
                            edge.sourceHeight,
                        )}
                    />
                    <path
                        className="asset-edge-arrow"
                        d={assetEdgeArrowPath(edge.target)}
                    />
                </g>
            ))}
        </svg>
    );
}

function AssetNode({
    node,
    onHoverChange,
    onOpenSource,
    onOpenSampleData,
    onSelectNode,
    nowMs,
    selected,
    style,
}: Readonly<{
    node: GraphNode;
    onHoverChange: (hoveredNode: AssetNodeHover | undefined) => void;
    onOpenSource?: (node: PipelineAssetNode) => void;
    onOpenSampleData?: (node: PipelineAssetNode) => void;
    onSelectNode?: (node: PipelineAssetNode) => void;
    nowMs: number;
    selected: boolean;
    style?: CSSProperties;
}>) {
    const lastHoverDirection = useRef<AssetNodeHoverDirection | undefined>(undefined);
    const presentation = assetNodePresentation(
        node,
        nowMs,
        selected,
        onOpenSource,
        onOpenSampleData,
        onSelectNode,
    );
    const NodeWrapper = presentation.informationalSource ? 'article' : 'div';

    function activateNode(): void {
        onOpenSampleData?.(node);
        onSelectNode?.(node);
    }

    function updateHoverDirection(event: ReactPointerEvent<HTMLElement>): void {
        const hover = getAssetNodeHover(
            node.id,
            event.clientX,
            event.currentTarget.getBoundingClientRect(),
            presentation.informationalSource,
        );
        if (lastHoverDirection.current === hover.direction) {
            return;
        }

        lastHoverDirection.current = hover.direction;
        onHoverChange(hover);
    }

    function clearHoverDirection(): void {
        lastHoverDirection.current = undefined;
        onHoverChange(undefined);
    }

    return (
        <NodeWrapper
            aria-label={presentation.accessibleLabel}
            aria-pressed={presentation.selectable ? selected : undefined}
            className={presentation.className}
            onClick={assetNodeClickHandler(presentation.informationalSource, activateNode)}
            onKeyDown={assetNodeKeyDownHandler(presentation.informationalSource, activateNode)}
            onPointerEnter={updateHoverDirection}
            onPointerMove={updateHoverDirection}
            onPointerLeave={clearHoverDirection}
            onPointerDown={assetNodePointerHandler(presentation.informationalSource)}
            onPointerUp={assetNodePointerHandler(presentation.informationalSource)}
            role={presentation.informationalSource ? undefined : 'button'}
            style={style}
            tabIndex={presentation.informationalSource ? -1 : 0}
        >
            <AssetNodeStatusBar
                informationalSource={presentation.informationalSource}
                node={node}
            />
            <AssetNodeSourceAction
                canOpenSource={presentation.canOpenSource}
                node={node}
                onOpenSource={onOpenSource}
            />
            <AssetNodeMetadata
                duration={presentation.duration}
                informationalSource={presentation.informationalSource}
                newToSpark={presentation.newToSpark}
                node={node}
            />
            <AssetNodeTitle node={node} status={presentation.status} />
            <AssetNodeFooter informationalSource={presentation.informationalSource} />
        </NodeWrapper>
    );
}

function assetNodePresentation(
    node: GraphNode,
    nowMs: number,
    selected: boolean,
    onOpenSource?: (node: PipelineAssetNode) => void,
    onOpenSampleData?: (node: PipelineAssetNode) => void,
    onSelectNode?: (node: PipelineAssetNode) => void,
) {
    const informationalSource = node.kind === 'external-source';
    const newToSpark = !informationalSource && node.sparkTableExists === false;
    const accessibleNodeLabel = newToSpark ? `${node.label}, new to Spark` : node.label;
    const selectable = !informationalSource && onSelectNode != null;
    const interactive = !informationalSource && (selectable || onOpenSampleData != null);
    return {
        accessibleLabel: assetNodeAccessibleLabel(
            node,
            informationalSource,
            selectable,
            selected,
            accessibleNodeLabel,
            onOpenSampleData != null,
        ),
        canOpenSource: canOpenNodeSource(node, informationalSource, onOpenSource),
        className: assetNodeClassName(node, informationalSource, interactive, selected),
        duration: pipelineNodeDurationMs(node, nowMs),
        informationalSource,
        newToSpark,
        selectable,
        status: assetNodeStatus(node, informationalSource),
    };
}

function assetNodeAccessibleLabel(
    node: GraphNode,
    informationalSource: boolean,
    selectable: boolean,
    selected: boolean,
    accessibleNodeLabel: string,
    canOpenSampleData: boolean,
): string {
    if (informationalSource) {
        return [node.label, node.typeLabel ?? 'External Source'].join(', ');
    }
    if (selectable) {
        return `${selected ? 'Deselect' : 'Select'} ${accessibleNodeLabel} for refresh and open sample data`;
    }
    if (canOpenSampleData) {
        return `Show sample data for ${accessibleNodeLabel}`;
    }
    return accessibleNodeLabel;
}

function canOpenNodeSource(
    node: GraphNode,
    informationalSource: boolean,
    onOpenSource?: (node: PipelineAssetNode) => void,
): boolean {
    return !informationalSource && onOpenSource != null && (
        node.sourceFile?.trim() !== '' || node.sqlText?.trim() !== ''
    );
}

function assetNodeClassName(
    node: GraphNode,
    informationalSource: boolean,
    interactive: boolean,
    selected: boolean,
): string {
    return `dag-node asset-node ${node.status ?? (informationalSource ? '' : PipelineAssetState.UNKNOWN)} ${informationalSource ? 'external-source' : ''} ${interactive ? 'selectable' : ''} ${selected ? 'selected' : ''}`;
}

function assetNodeStatus(
    node: GraphNode,
    informationalSource: boolean,
): StatusPresentationState | undefined {
    return !informationalSource && node.status != null &&
        STATUS_PRESENTATION_STATES.includes(node.status as StatusPresentationState)
        ? node.status as StatusPresentationState
        : undefined;
}

function assetNodeClickHandler(
    informationalSource: boolean,
    activateNode: () => void,
): ((event: ReactMouseEvent<HTMLElement>) => void) | undefined {
    if (informationalSource) {
        return undefined;
    }
    return (event) => {
        event.stopPropagation();
        activateNode();
    };
}

function assetNodeKeyDownHandler(
    informationalSource: boolean,
    activateNode: () => void,
): ((event: ReactKeyboardEvent<HTMLElement>) => void) | undefined {
    if (informationalSource) {
        return undefined;
    }
    return (event) => {
        if (event.target !== event.currentTarget ||
            (event.key !== 'Enter' && event.key !== ' ')) {
            return;
        }
        event.preventDefault();
        activateNode();
    };
}

function assetNodePointerHandler(
    informationalSource: boolean,
): ((event: ReactPointerEvent<HTMLElement>) => void) | undefined {
    return informationalSource ? undefined : (event) => event.stopPropagation();
}

function AssetNodeStatusBar({
    informationalSource,
    node,
}: Readonly<{
    informationalSource: boolean;
    node: GraphNode;
}>) {
    if (informationalSource) {
        return null;
    }
    return (
        <span
            aria-hidden="true"
            className={`asset-node-status-bar ${node.status ?? 'unknown'}`}
        />
    );
}

function AssetNodeSourceAction({
    canOpenSource,
    node,
    onOpenSource,
}: Readonly<{
    canOpenSource: boolean;
    node: GraphNode;
    onOpenSource?: (node: PipelineAssetNode) => void;
}>) {
    if (!canOpenSource) {
        return null;
    }
    return (
        <div className="asset-node-actions">
            <button
                aria-label={`View source code for ${node.label}`}
                className="asset-node-source-button"
                onClick={(event) => {
                    event.stopPropagation();
                    onOpenSource?.(node);
                }}
                onKeyDown={(event) => event.stopPropagation()}
                onPointerDown={(event) => event.stopPropagation()}
                onPointerUp={(event) => event.stopPropagation()}
                title="View source code in Workspace"
                type="button"
            >
                <AppIcon icon={Code2} size="status" />
            </button>
        </div>
    );
}

function AssetNodeMetadata({
    duration,
    informationalSource,
    newToSpark,
    node,
}: Readonly<{
    duration?: number;
    informationalSource: boolean;
    newToSpark: boolean;
    node: GraphNode;
}>) {
    return (
        <div className={`node-meta${newToSpark ? ' node-meta-new' : ''}`}>
            {newToSpark && (
                <span aria-hidden="true" className="new-to-spark-label" title="New to Spark">
                    NEW
                </span>
            )}
            <span className="node-type-label">{node.typeLabel}</span>
            {!informationalSource && <small>{formatNodeSeconds(duration)}</small>}
        </div>
    );
}

function AssetNodeTitle({
    node,
    status,
}: Readonly<{
    node: GraphNode;
    status?: StatusPresentationState;
}>) {
    return (
        <div className="node-title">
            <span className="node-type-icon">
                {node.kind === 'table' || node.kind === 'view' ? (
                    <DataAssetIcon kind={node.kind} size="control" />
                ) : (
                    <AppIcon icon={iconForKind(node.kind)} size="control" />
                )}
            </span>
            <strong title={node.label}>{node.label}</strong>
            {status != null && (
                <StatusIcon
                    className="node-check"
                    label={PIPELINE_ASSET_STATUS_LABELS[status]}
                    status={status}
                />
            )}
        </div>
    );
}

function AssetNodeFooter({ informationalSource }: Readonly<{ informationalSource: boolean }>) {
    if (informationalSource) {
        return null;
    }
    return (
        <div className="node-footer">
            <span>Output records: -</span>
        </div>
    );
}

function formatNodeSeconds(duration?: number): string {
    if (duration == null || !Number.isFinite(duration) || duration < 0) {
        return '-';
    }

    const seconds = duration / 1000;
    return seconds < 10 ? `${seconds.toFixed(1)}s` : `${Math.round(seconds)}s`;
}

function externalSourceOverlayStyles(
    layout: GraphLayout,
    positions: ReadonlyMap<string, { x: number; y: number }>,
): ExternalSourcePlacement[] {
    return positionExternalSources(layout.externalSources, positions).map(({ position, source }) => ({
        node: source.node,
        position,
        style: {
            left: position.x,
            pointerEvents: 'auto',
            position: 'absolute',
            top: position.y,
            width: ASSET_EXTERNAL_SOURCE_WIDTH,
            zIndex: 1,
        },
        targetIds: source.targetIds,
    }));
}

function iconForKind(kind: Exclude<PipelineAssetKind, 'table' | 'view'>) {
    if (kind === 'path') {
        return FolderTree;
    }

    if (kind === 'command') {
        return Workflow;
    }

    return Table2;
}
