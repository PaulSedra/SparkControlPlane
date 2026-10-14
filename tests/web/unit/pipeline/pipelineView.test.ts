/**
 * @fileoverview Regression coverage for PipelineView graph projection through its child props.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInThisContext } from 'node:vm';
import * as react from 'react';
import type { ComponentType } from 'react';
import * as jsxRuntime from 'react/jsx-runtime';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';
import type {
    PipelineDetail,
    PipelineEdge,
    PipelineNode,
    PipelineRun,
    PipelineRunNodeStatusRecord,
} from '../../../../src/shared/pipelineRegistryTypes.ts';
import { PipelineRunNodeStatus } from '../../../../src/shared/status/node.ts';
import { RunStatus } from '../../../../src/shared/status/run.ts';
import type { PipelineAssetOperation } from '../../../../src/web/types/pipelineAssetTypes.ts';
import { declaredPipelineOperations } from '../../../../src/web/utils/pipelineAssets.ts';
import { pipelineDetail } from '../../../support/webFixtures.ts';

const flowNode: PipelineNode = {
    id: 'flow-id',
    name: 'refresh-orders',
    nodeType: 'FLOW',
    qualifiedName: 'sales.refresh_orders',
};

const tableNode: PipelineNode = {
    id: 'table-id',
    name: 'orders',
    nodeType: 'STREAMING_TABLE',
    qualifiedName: 'sales.orders',
};

const flowToTable: PipelineEdge = {
    confidence: 'LOW',
    evidence: 'test fixture',
    id: 'flow-to-table',
    sourceExpression: 'sales.refresh_orders',
    sourceNodeId: flowNode.id,
    targetNodeId: tableNode.id,
};

test('internal flows collapse into deduplicated table connections without losing target state', () => {
    const source = { ...tableNode, id: 'source', name: 'source', qualifiedName: 'sales.source' };
    const second = { ...source, id: 'second', qualifiedName: 'sales.second' };
    const run = runWithNodeStatuses({
        flow: nodeStatus(flowNode.qualifiedName, PipelineRunNodeStatus.COMPLETED),
    }, RunStatus.SUCCEEDED);
    const pipeline = pipelineDetail([source, second, flowNode, tableNode], {
        edges: [
            flowToTable,
            { ...flowToTable, id: 'source-flow', sourceNodeId: source.id, targetNodeId: flowNode.id },
            { ...flowToTable, id: 'second-flow', sourceNodeId: second.id, targetNodeId: flowNode.id },
            { ...flowToTable, id: 'source-table', sourceNodeId: source.id },
        ],
    });
    const declared = declaredPipelineOperations(pipeline, run);
    const graph = renderedGraphOperations(pipeline, run);
    assert.equal(graph.some((operation) => operation.output.id === flowNode.id), false);
    const target = graph.find((operation) => operation.output.id === tableNode.id);
    assert.deepEqual(target?.inputs.map((input) => input.id), [source.id, second.id]);
    assert.equal(target?.status, 'succeeded');
    assert.equal(declared.some((operation) => operation.output.id === flowNode.id), true);
});

test('external and unresolved flows remain visible while mixed internal reads connect directly', () => {
    const internal = { ...tableNode, id: 'internal', qualifiedName: 'sales.internal' };
    const external: PipelineNode = {
        ...internal, id: 'external', nodeType: 'EXTERNAL_DATASET', qualifiedName: 'other.table',
    };
    for (const sourceNodeId of [external.id, 'unresolved']) {
        const pipeline = pipelineDetail([internal, external, flowNode, tableNode], {
            edges: [
                flowToTable,
                { ...flowToTable, id: 'external-flow', sourceNodeId, targetNodeId: flowNode.id },
                { ...flowToTable, id: 'internal-flow', sourceNodeId: internal.id, targetNodeId: flowNode.id },
            ],
        });
        const graph = renderedGraphOperations(pipeline);
        const flow = graph.find((operation) => operation.output.id === flowNode.id);
        assert.deepEqual(flow?.inputs.map((input) => input.id),
            sourceNodeId === external.id ? [external.id] : []);
        if (sourceNodeId === external.id) {
            assert.equal(flow?.inputs[0]?.kind, 'external-source');
            assert.equal(flow?.inputs[0]?.status, undefined);
        }
        assert.deepEqual(graph.find((operation) => operation.output.id === tableNode.id)?.inputs
            .map((input) => input.id), [internal.id, flowNode.id]);
    }
    const pipeline = pipelineDetail([flowNode, tableNode], { edges: [flowToTable] });
    assert.equal(renderedGraphOperations(pipeline)
        .some((operation) => operation.output.id === flowNode.id), true);
});

test('confirmed Spark table absence is forwarded to output graph nodes', () => {
    const pipeline = pipelineDetail([tableNode]);
    const graph = renderedGraphOperations(
        pipeline,
        undefined,
        new Map([[tableNode.id, false]]),
    );

    assert.equal(graph.find((operation) => operation.output.id === tableNode.id)
        ?.output.sparkTableExists, false);
    assert.equal(renderedGraphOperations(pipeline)
        .find((operation) => operation.output.id === tableNode.id)
        ?.output.sparkTableExists, undefined);
});

function renderedGraphOperations(
    pipeline: PipelineDetail,
    run?: PipelineRun,
    sparkTablePresenceByNodeId?: ReadonlyMap<string, boolean>,
): PipelineAssetOperation[] {
    let operations: PipelineAssetOperation[] | undefined;
    const source = readFileSync(new URL(
        '../../../../src/web/components/pipeline/PipelineView.tsx', import.meta.url,
    ), 'utf8');
    const compiled = ts.transpileModule(source, {
        compilerOptions: {
            jsx: ts.JsxEmit.ReactJSX,
            module: ts.ModuleKind.CommonJS,
            target: ts.ScriptTarget.ES2022,
        },
    });
    // Render the real parent with a graph probe so projection stays private.
    const dependencies: Record<string, unknown> = {
        'lucide-react': { List: () => null, Network: () => null },
        react,
        'react/jsx-runtime': jsxRuntime,
        '../ui/AppIcon': { AppIcon: () => null },
        './graph/PipelineAssetGraph': {
            PipelineAssetGraph: (props: { operations: PipelineAssetOperation[] }) => {
                operations = props.operations;
                return null;
            },
        },
        './runs/PipelineRunsView': { PipelineRunsView: () => null },
        '../../utils/pipelineAssets.ts': { declaredPipelineOperations },
    };
    const componentExports: {
        PipelineView?: ComponentType<{
            declaredPipeline: PipelineDetail;
            run?: PipelineRun;
            sparkTablePresenceByNodeId?: ReadonlyMap<string, boolean>;
        }>;
    } = {};
    const loadComponent = runInThisContext(
        `(function(require, exports) {${compiled.outputText}\n})`,
    );
    loadComponent((id: string) => {
        assert.ok(id in dependencies, `Unexpected component dependency: ${id}`);
        return dependencies[id];
    }, componentExports);
    assert.ok(componentExports.PipelineView);
    renderToStaticMarkup(react.createElement(componentExports.PipelineView, {
        declaredPipeline: pipeline,
        run,
        sparkTablePresenceByNodeId,
    }));
    assert.ok(operations);
    return operations;
}

function nodeStatus(
    qualifiedName: string,
    status: PipelineRunNodeStatusRecord['status'],
    lastUpdatedAt = '2026-09-27T11:59:00.000Z',
): PipelineRunNodeStatusRecord {
    return { lastUpdatedAt, qualifiedName, status };
}

function runWithNodeStatuses(
    nodeStatuses: NonNullable<PipelineRun['nodeStatuses']>,
    status: PipelineRun['status'],
): PipelineRun {
    return {
        mode: 'incremental',
        nodeStatuses,
        pipelineId: 'pipeline-1',
        runId: 'run-1',
        sparkAppName: 'application-1',
        startedAt: '2026-09-27T11:58:00.000Z',
        status,
    };
}
