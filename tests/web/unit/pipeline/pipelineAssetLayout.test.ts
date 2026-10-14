/**
 * @fileoverview Unit coverage for pipeline graph layout calculations.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import type { PipelineRun } from '../../../../src/shared/pipelineRegistryTypes.ts';
import {
    getGraphCanvasCenteredPan,
    getGraphCanvasZoomedPan,
} from '../../../../src/web/components/graph-canvas/graphCanvasGeometry.ts';
import {
    ASSET_COLUMN_GAP,
    ASSET_COLUMN_WIDTH,
    ASSET_EDGE_ARROW_SIZE,
    ASSET_EDGE_NODE_GAP,
    ASSET_EXTERNAL_SOURCE_HEIGHT,
    ASSET_EXTERNAL_SOURCE_WIDTH,
    ASSET_NODE_GAP,
    ASSET_NODE_HEIGHT,
    ASSET_VIEWPORT_PADDING_X,
    ASSET_VIEWPORT_PADDING_Y,
} from '../../../../src/web/components/pipeline/graph/pipelineAssetGraphConstants.ts';
import {
    assetEdgeArrowPath,
    assetEdgePath,
    nodePositions,
} from '../../../../src/web/components/pipeline/graph/pipelineAssetGraphGeometry.ts';
import { positionExternalSources } from '../../../../src/web/components/pipeline/graph/pipelineAssetGraphExternalSources.ts';
import { buildAssetLayout } from '../../../../src/web/components/pipeline/graph/pipelineAssetLayout.ts';
import {
    declaredPipelineOperations as declaredOperations,
    pipelineAssetCount,
    pipelineTableNodes,
} from '../../../../src/web/utils/pipelineAssets.ts';
import { buildPipelineAssetGraph } from '../../../../src/web/components/pipeline/graph/pipelineAssetGraphBuilder.ts';
import { pipelineNodeDurationMs } from '../../../../src/web/utils/pipelineRunTiming.ts';
import {
    asset as fixtureAsset,
    operation as fixtureOperation,
    pipelineDetail,
} from '../../../support/webFixtures.ts';

function edgeIds(layout: ReturnType<typeof buildAssetLayout>): string[] {
    return layout.edges
        .map((edge) => `${edge.sourceId}->${edge.targetId}`)
        .sort();
}

test('removes a redundant transitive edge while keeping essential edges', () => {
    const a = fixtureAsset('a');
    const b = fixtureAsset('b');
    const c = fixtureAsset('c');

    const layout = buildAssetLayout([
        fixtureOperation(a),
        fixtureOperation(b, [a]),
        fixtureOperation(c, [a, b]),
    ]);

    assert.deepEqual(edgeIds(layout), ['a->b', 'b->c']);
});

test('orders graph rows using the reduced lineage edges', () => {
    const a = fixtureAsset('a', 'Alpha');
    const b = fixtureAsset('b', 'Beta');
    const x = fixtureAsset('x', 'X');
    const y = fixtureAsset('y', 'Y');
    const p = fixtureAsset('p', 'P');
    const q = fixtureAsset('q', 'Q');
    const layout = buildAssetLayout([
        fixtureOperation(a),
        fixtureOperation(b),
        fixtureOperation(x, [a]),
        fixtureOperation(y, [b]),
        fixtureOperation(p, [x, y, b]),
        fixtureOperation(q, [x, y, a]),
    ]);

    assert.deepEqual(layout.levels[2].map((node) => node.id), ['p', 'q']);
});

test('rejects dependency cycles instead of assigning fallback graph levels', () => {
    const a = fixtureAsset('a');
    const b = fixtureAsset('b');

    assert.throws(
        () => buildAssetLayout([
            fixtureOperation(a, [b]),
            fixtureOperation(b, [a]),
        ]),
        /dependency cycle/,
    );
});

test('collapses duplicate edges without changing the graph', () => {
    const a = fixtureAsset('a');
    const b = fixtureAsset('b');

    const layout = buildAssetLayout([
        fixtureOperation(a),
        fixtureOperation(b, [a, a]),
    ]);

    assert.deepEqual(edgeIds(layout), ['a->b']);
});

test('keeps level ordering deterministic when operation order changes', () => {
    const a = fixtureAsset('a', 'Alpha');
    const b = fixtureAsset('b', 'Beta');
    const c = fixtureAsset('c', 'Combined');
    const d = fixtureAsset('d', 'Downstream');
    const operations = [
        fixtureOperation(a),
        fixtureOperation(b),
        fixtureOperation(c, [a, b]),
        fixtureOperation(d, [c]),
    ];

    const forward = buildAssetLayout(operations);
    const reversed = buildAssetLayout([...operations].reverse());

    assert.deepEqual(
        forward.levels.map((level) => level.map((node) => node.id)),
        reversed.levels.map((level) => level.map((node) => node.id)),
    );
    assert.deepEqual(edgeIds(forward), edgeIds(reversed));
});

test('keeps graph geometry aligned with the rendered node spacing', () => {
    const a = fixtureAsset('a');
    const b = fixtureAsset('b');
    const c = fixtureAsset('c');
    const layout = buildAssetLayout([
        fixtureOperation(a),
        fixtureOperation(b),
        fixtureOperation(c, [a, b]),
    ]);
    const positions = nodePositions(layout.levels);
    const aPosition = positions.get(a.id);
    const bPosition = positions.get(b.id);
    const cPosition = positions.get(c.id);

    assert.ok(aPosition != null);
    assert.ok(bPosition != null);
    assert.ok(cPosition != null);
    assert.equal(bPosition.y - aPosition.y, ASSET_NODE_HEIGHT + ASSET_NODE_GAP);
    assert.equal(cPosition.x - aPosition.x, ASSET_COLUMN_WIDTH + ASSET_COLUMN_GAP);
    assert.equal(ASSET_COLUMN_GAP, 86);
    assert.equal(ASSET_NODE_GAP, 60);

    const edgePath = assetEdgePath({ x: 0, y: 0 }, { x: 500, y: 100 });
    const startX = ASSET_COLUMN_WIDTH + ASSET_EDGE_NODE_GAP;
    const endX = 500 - ASSET_EDGE_NODE_GAP - ASSET_EDGE_ARROW_SIZE;
    assert.equal(edgePath, `M ${startX} 38 C 356 38 356 138 ${endX} 138`);
    assert.equal(assetEdgeArrowPath({ x: 500, y: 100 }), 'M 480 134 L 488 138 L 480 142 Z');
});

test('keeps informational external sources out of graph levels and beside their Flow', () => {
    const external = {
        ...fixtureAsset('external-events'),
        kind: 'external-source' as const,
    };
    const output = fixtureAsset('orders');
    const layout = buildAssetLayout([fixtureOperation(output, [external])]);
    const layoutWithoutExternal = buildAssetLayout([fixtureOperation(output)]);
    const positions = nodePositions(layout.levels, layout.leftPaddingX);
    const externalSource = layout.externalSources[0];

    assert.equal(layout.levels.flat().some((node) => node.id === external.id), false);
    assert.equal(positions.has(external.id), false);
    assert.equal(externalSource?.node.id, external.id);
    assert.deepEqual(externalSource?.targetIds, [output.id]);
    assert.equal(externalSource?.targetLevel, 0);
    assert.deepEqual(layout.levels, layoutWithoutExternal.levels);
    assert.equal(
        layout.width,
        layoutWithoutExternal.width + ASSET_EXTERNAL_SOURCE_WIDTH + ASSET_COLUMN_GAP,
    );
    assert.equal(layout.height, layoutWithoutExternal.height);
    assert.equal(
        layout.leftPaddingX,
        ASSET_VIEWPORT_PADDING_X + ASSET_EXTERNAL_SOURCE_WIDTH + ASSET_COLUMN_GAP,
    );
    assert.equal(ASSET_EXTERNAL_SOURCE_HEIGHT, 38);
    assert.equal(ASSET_EXTERNAL_SOURCE_WIDTH < ASSET_COLUMN_WIDTH, true);
});

test('spaces external-source cards from adjacent asset nodes like regular columns', () => {
    const upstream = fixtureAsset('upstream');
    const external = {
        ...fixtureAsset('external-events'),
        kind: 'external-source' as const,
    };
    const flow = fixtureAsset('flow');
    const layout = buildAssetLayout([
        fixtureOperation(upstream),
        fixtureOperation(flow, [upstream, external]),
    ]);
    const positions = nodePositions(
        layout.levels,
        layout.leftPaddingX,
        layout.externalSourceCollisionLevels,
    );
    const upstreamPosition = positions.get(upstream.id);
    const flowPosition = positions.get(flow.id);
    const externalPosition = positionExternalSources(layout.externalSources, positions)[0]?.position;

    assert.ok(upstreamPosition != null);
    assert.ok(flowPosition != null);
    assert.ok(externalPosition != null);
    assert.equal(
        externalPosition.x - (upstreamPosition.x + ASSET_COLUMN_WIDTH),
        ASSET_COLUMN_GAP,
    );
    assert.equal(
        flowPosition.x - (externalPosition.x + ASSET_EXTERNAL_SOURCE_WIDTH),
        ASSET_COLUMN_GAP,
    );
});

test('expands canvas height to contain packed external-source cards', () => {
    const output = fixtureAsset('orders');
    const externalSources = Array.from({ length: 8 }, (_, index) => ({
        ...fixtureAsset(`external-${index}`),
        kind: 'external-source' as const,
    }));
    const layout = buildAssetLayout([
        fixtureOperation(output, externalSources),
    ]);
    const positions = nodePositions(
        layout.levels,
        layout.leftPaddingX,
        layout.externalSourceCollisionLevels,
    );
    const cards = positionExternalSources(layout.externalSources, positions);
    const canvasBottom = layout.height - ASSET_VIEWPORT_PADDING_Y;

    assert.equal(cards.length, externalSources.length);
    assert.ok(cards.every(({ position }) => position.y >= ASSET_VIEWPORT_PADDING_Y));
    assert.ok(cards.every(({ position }) =>
        position.y + ASSET_EXTERNAL_SOURCE_HEIGHT <= canvasBottom));
    assert.ok(layout.height > ASSET_VIEWPORT_PADDING_Y * 2 + ASSET_NODE_HEIGHT);
});

test('centers graph content inside the canvas', () => {
    assert.deepEqual(
        getGraphCanvasCenteredPan(
            { height: 800, width: 1_000 },
            { height: 300, width: 400 },
        ),
        { x: 300, y: 250 },
    );
    assert.deepEqual(
        getGraphCanvasCenteredPan(
            { height: 800, width: 1_000 },
            { height: 300, width: 400 },
            1.5,
        ),
        { x: 200, y: 175 },
    );
});

test('keeps the canvas center fixed when zooming in or out from a panned graph', () => {
    const canvasSize = { height: 800, width: 1_000 };
    const pan = { x: -180, y: -95 };
    const currentScale = 1.25;
    const centerGraphX = (canvasSize.width / 2 - pan.x) / currentScale;
    const centerGraphY = (canvasSize.height / 2 - pan.y) / currentScale;

    for (const nextScale of [1.5, 0.75]) {
        const nextPan = getGraphCanvasZoomedPan(
            pan,
            canvasSize,
            currentScale,
            nextScale,
        );

        assert.ok(Math.abs(
            (canvasSize.width / 2 - nextPan.x) / nextScale - centerGraphX,
        ) < 1e-9);
        assert.ok(Math.abs(
            (canvasSize.height / 2 - nextPan.y) / nextScale - centerGraphY,
        ) < 1e-9);
    }
});

test('carries declared node timing and status into the graph layout', () => {
    const detail = pipelineDetail([{
            id: 'node-1',
            name: 'Orders',
            nodeType: 'MATERIALIZED_VIEW',
            qualifiedName: 'catalog.orders',
        }]);
    const run = {
        mode: 'incremental',
        nodeStatuses: {
            'catalog.orders': {
                completedAt: '2026-08-25T12:00:05.000Z',
                durationMs: 5_000,
                lastUpdatedAt: '2026-08-25T12:00:05.000Z',
                qualifiedName: 'catalog.orders',
                startedAt: '2026-08-25T12:00:00.000Z',
                status: 'COMPLETED',
            },
        },
        pipelineId: 'pipeline-1',
        runId: 'run-1',
        sparkAppName: 'app-1',
        startedAt: '2026-08-25T12:00:00.000Z',
        status: 'SUCCEEDED',
    } as PipelineRun;

    const operations = declaredOperations(detail, run);
    const graph = buildAssetLayout(operations);
    const graphNode = graph.levels[0]?.[0];

    assert.equal(operations[0]?.startedAt, '2026-08-25T12:00:00.000Z');
    assert.equal(operations[0]?.duration, 5_000);
    assert.equal(operations[0]?.runStatus, 'COMPLETED');
    assert.equal(graphNode?.startedAt, '2026-08-25T12:00:00.000Z');
    assert.equal(graphNode?.duration, 5_000);
    assert.equal(graphNode?.runStatus, 'COMPLETED');
    assert.equal(pipelineNodeDurationMs(graphNode), 5_000);
});

test('derives active declared-node elapsed time from graph timing', () => {
    const detail = pipelineDetail([{
        id: 'node-1',
        name: 'Orders',
        nodeType: 'MATERIALIZED_VIEW',
        qualifiedName: 'catalog.orders',
    }]);
    const run = {
        mode: 'incremental',
        nodeStatuses: {
            'catalog.orders': {
                lastUpdatedAt: '2026-08-25T12:00:02.000Z',
                qualifiedName: 'catalog.orders',
                startedAt: '2026-08-25T12:00:00.000Z',
                status: 'RUNNING',
            },
        },
        pipelineId: 'pipeline-1',
        runId: 'run-1',
        sparkAppName: 'app-1',
        startedAt: '2026-08-25T12:00:00.000Z',
        status: 'RUNNING',
    } as PipelineRun;
    const graphNode = buildAssetLayout(declaredOperations(detail, run)).levels[0]?.[0];

    assert.equal(graphNode?.runStatus, 'RUNNING');
    assert.equal(pipelineNodeDurationMs(graphNode, Date.parse('2026-08-25T12:00:10.000Z')), 10_000);
});

test('maps flow-to-streaming-table lineage to an incoming graph edge', () => {
    const flow = {
        id: 'flow:sample_catalog.bronze.append_events_1',
        name: 'append_events_1',
        nodeType: 'FLOW' as const,
        qualifiedName: 'sample_catalog.bronze.append_events_1',
    };
    const target = {
        id: 'dataset:sample_catalog.bronze.events',
        name: 'events',
        nodeType: 'STREAMING_TABLE' as const,
        qualifiedName: 'sample_catalog.bronze.events',
    };
    const detail = pipelineDetail([target, flow], {
        edges: [{
            confidence: 'LOW',
            evidence: 'SQL_TEXT_PATTERN',
            id: `${flow.id}->${target.id}`,
            sourceExpression: target.qualifiedName,
            sourceNodeId: flow.id,
            targetNodeId: target.id,
        }],
    });

    const operations = declaredOperations(detail);
    const targetOperation = operations.find((operation) => operation.output.id === target.id);
    assert.ok(targetOperation);
    assert.equal(targetOperation.output.nodeType, 'STREAMING_TABLE');
    assert.deepEqual(pipelineTableNodes(detail.nodes).map((node) => node.id), [target.id]);
    assert.equal(pipelineAssetCount(operations), 1);
    const graphNodes = buildPipelineAssetGraph(operations).nodes;
    assert.equal(graphNodes.get(target.id)?.typeLabel, 'Streaming Table');
    assert.equal(graphNodes.get(flow.id)?.typeLabel, 'Flow');
    assert.deepEqual(
        targetOperation.inputs.map((input) => [input.id, input.nodeType]),
        [[flow.id, 'FLOW']],
    );
    assert.deepEqual(edgeIds(buildAssetLayout(operations)), [`${flow.id}->${target.id}`]);
});

test('derives streaming-table state from incoming flow states', () => {
    const firstFlow = {
        id: 'flow:sample_catalog.bronze.append_events_1',
        name: 'append_events_1',
        nodeType: 'FLOW' as const,
        qualifiedName: 'sample_catalog.bronze.append_events_1',
    };
    const secondFlow = {
        id: 'flow:sample_catalog.bronze.append_events_2',
        name: 'append_events_2',
        nodeType: 'FLOW' as const,
        qualifiedName: 'sample_catalog.bronze.append_events_2',
    };
    const target = {
        id: 'dataset:sample_catalog.bronze.events',
        name: 'events',
        nodeType: 'STREAMING_TABLE' as const,
        qualifiedName: 'sample_catalog.bronze.events',
    };
    const detail = pipelineDetail([target, firstFlow, secondFlow], {
        edges: [firstFlow, secondFlow].map((flow) => ({
            confidence: 'LOW' as const,
            evidence: 'SQL_TEXT_PATTERN' as const,
            id: `${flow.id}->${target.id}`,
            sourceExpression: target.qualifiedName,
            sourceNodeId: flow.id,
            targetNodeId: target.id,
        })),
    });
    const commonRun = {
        mode: 'incremental' as const,
        pipelineId: 'pipeline-1',
        runId: 'run-1',
        sparkAppName: 'app-1',
        startedAt: '2026-08-25T12:00:00.000Z',
        status: 'SUCCEEDED' as const,
    } as PipelineRun;
    const firstFlowRun = {
        ...commonRun,
        nodeStatuses: {
            [firstFlow.qualifiedName]: {
                lastUpdatedAt: '2026-08-25T12:00:05.000Z',
                qualifiedName: firstFlow.qualifiedName,
                status: 'COMPLETED' as const,
            },
        },
    };
    const incompleteTarget = declaredOperations(detail, firstFlowRun)
        .find((operation) => operation.output.id === target.id);

    assert.equal(incompleteTarget?.status, 'defined');

    const completeTarget = declaredOperations(detail, {
        ...commonRun,
        nodeStatuses: {
            ...firstFlowRun.nodeStatuses,
            [secondFlow.qualifiedName]: {
                lastUpdatedAt: '2026-08-25T12:00:06.000Z',
                qualifiedName: secondFlow.qualifiedName,
                status: 'COMPLETED' as const,
            },
        },
    }).find((operation) => operation.output.id === target.id);

    assert.equal(completeTarget?.status, 'succeeded');

    const runningTarget = declaredOperations(detail, {
        ...commonRun,
        nodeStatuses: {
            ...firstFlowRun.nodeStatuses,
            [secondFlow.qualifiedName]: {
                lastUpdatedAt: '2026-08-25T12:00:06.000Z',
                qualifiedName: secondFlow.qualifiedName,
                status: 'RUNNING' as const,
            },
        },
    }).find((operation) => operation.output.id === target.id);
    assert.equal(runningTarget?.status, 'running');

    const failedTarget = declaredOperations(detail, {
        ...commonRun,
        nodeStatuses: {
            ...firstFlowRun.nodeStatuses,
            [secondFlow.qualifiedName]: {
                lastUpdatedAt: '2026-08-25T12:00:06.000Z',
                qualifiedName: secondFlow.qualifiedName,
                status: 'FAILED' as const,
            },
        },
    }).find((operation) => operation.output.id === target.id);
    assert.equal(failedTarget?.status, 'failed');

    const standaloneTarget = declaredOperations(
        pipelineDetail([target]),
        commonRun,
    ).find((operation) => operation.output.id === target.id);
    assert.equal(standaloneTarget?.status, 'defined');
});

test('normalizes persisted quoted retry identities before rendering flow status', () => {
    const flow = {
        id: 'flow:sample_catalog.silver.append_events_root',
        name: 'append_events_root',
        nodeType: 'FLOW' as const,
        qualifiedName: 'sample_catalog.silver.append_events_root',
    };
    const detail = pipelineDetail([flow]);
    const operation = declaredOperations(detail, {
        mode: 'incremental',
        nodeStatuses: {
            "'sample_catalog.silver.append_events_root'": {
                lastUpdatedAt: '2026-09-21T22:00:05.000Z',
                qualifiedName: "'sample_catalog.silver.append_events_root'",
                status: 'FAILED',
            },
            'sample_catalog.silver.append_events_root': {
                lastUpdatedAt: '2026-09-21T22:00:06.000Z',
                qualifiedName: 'sample_catalog.silver.append_events_root',
                status: 'RUNNING',
            },
        },
        pipelineId: 'pipeline-1',
        runId: 'run-1',
        sparkAppName: 'app-1',
        startedAt: '2026-09-21T22:00:00.000Z',
        status: 'RUNNING',
    } as PipelineRun).find((candidate) => candidate.output.id === flow.id);

    assert.equal(operation?.status, 'running');
});

test('does not infer success for unselected nodes in a selective refresh run', () => {
    const detail = pipelineDetail([
            {
                id: 'node-1',
                name: 'Selected orders',
                nodeType: 'MATERIALIZED_VIEW',
                qualifiedName: 'catalog.selected_orders',
            },
            {
                id: 'node-2',
                name: 'Unselected customers',
                nodeType: 'MATERIALIZED_VIEW',
                qualifiedName: 'catalog.unselected_customers',
            },
        ]);
    const run = {
        mode: 'refresh-selected',
        nodeStatuses: {
            'catalog.selected_orders': {
                completedAt: '2026-08-25T12:00:05.000Z',
                lastUpdatedAt: '2026-08-25T12:00:05.000Z',
                qualifiedName: 'catalog.selected_orders',
                status: 'COMPLETED',
            },
        },
        pipelineId: 'pipeline-1',
        runId: 'run-1',
        sparkAppName: 'app-1',
        startedAt: '2026-08-25T12:00:00.000Z',
        status: 'SUCCEEDED',
        targetNodeNames: ['catalog.selected_orders'],
    } as PipelineRun;

    const operations = declaredOperations(detail, run);

    assert.deepEqual(
        operations.map((operation) => [operation.output.qualifiedName, operation.status]),
        [
            ['catalog.selected_orders', 'succeeded'],
            ['catalog.unselected_customers', 'defined'],
        ],
    );
});
