/**
 * @fileoverview Regression coverage for run-state projection onto pipeline assets.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import type {
    PipelineEdge,
    PipelineNode,
    PipelineRun,
    PipelineRunNodeStatusRecord,
} from '../../../../src/shared/pipelineRegistryTypes.ts';
import {
    PipelineRunNodeStatus,
} from '../../../../src/shared/status/node.ts';
import {
    RunStatus,
} from '../../../../src/shared/status/run.ts';
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

test('an explicit UNKNOWN node result stays unknown despite a successful incoming flow', () => {
    const run = runWithNodeStatuses({
        flow: nodeStatus(flowNode.qualifiedName, PipelineRunNodeStatus.COMPLETED),
        table: nodeStatus(tableNode.qualifiedName, PipelineRunNodeStatus.UNKNOWN),
    }, RunStatus.UNKNOWN);
    const operations = declaredPipelineOperations(
        pipelineDetail([flowNode, tableNode], {
            edges: [flowToTable],
            lastRun: run,
            runs: [run],
        }),
        run,
    );

    assert.equal(
        operations.find((operation) => operation.output.qualifiedName === tableNode.qualifiedName)?.status,
        'unknown',
    );
});

test('a same-time active node snapshot cannot replace a terminal node outcome', () => {
    const updatedAt = '2026-09-27T12:00:00.000Z';
    const run = runWithNodeStatuses({
        terminal: nodeStatus('sales.orders', PipelineRunNodeStatus.COMPLETED, updatedAt),
        staleActive: nodeStatus('sales.orders', PipelineRunNodeStatus.RUNNING, updatedAt),
    }, RunStatus.SUCCEEDED);
    const operations = declaredPipelineOperations(
        pipelineDetail([tableNode], { lastRun: run, runs: [run] }),
        run,
    );

    assert.equal(
        operations.find((operation) => operation.output.qualifiedName === tableNode.qualifiedName)?.status,
        'succeeded',
    );
});

test('canceled flows and their streaming-table targets display as canceled', () => {
    const run = runWithNodeStatuses({
        canceledFlow: nodeStatus(flowNode.qualifiedName, PipelineRunNodeStatus.CANCELED),
    }, RunStatus.CANCELED);
    const operations = declaredPipelineOperations(
        pipelineDetail([flowNode, tableNode], {
            edges: [flowToTable],
            lastRun: run,
            runs: [run],
        }),
        run,
    );

    assert.equal(
        operations.find((operation) => operation.output.qualifiedName === flowNode.qualifiedName)?.status,
        'canceled',
    );
    assert.equal(
        operations.find((operation) => operation.output.qualifiedName === tableNode.qualifiedName)?.status,
        'canceled',
    );
});

test('legacy unfinished failures in canceled runs display as canceled', () => {
    const confirmedFailureNode: PipelineNode = {
        id: 'confirmed-failure-id',
        name: 'confirmed-failure',
        nodeType: 'FLOW',
        qualifiedName: 'sales.confirmed_failure',
    };
    const run = runWithNodeStatuses({
        legacyFailure: nodeStatus(flowNode.qualifiedName, PipelineRunNodeStatus.FAILED),
        confirmedFailure: {
            ...nodeStatus(confirmedFailureNode.qualifiedName, PipelineRunNodeStatus.FAILED),
            completedAt: '2026-09-28T20:09:00.000Z',
        },
    }, RunStatus.CANCELED);
    const operations = declaredPipelineOperations(
        pipelineDetail([flowNode, tableNode, confirmedFailureNode], {
            edges: [flowToTable],
            lastRun: run,
            runs: [run],
        }),
        run,
    );

    assert.equal(
        operations.find((operation) => operation.output.qualifiedName === flowNode.qualifiedName)?.status,
        'canceled',
    );
    assert.equal(
        operations.find((operation) => operation.output.qualifiedName === tableNode.qualifiedName)?.status,
        'canceled',
    );
    assert.equal(
        operations.find((operation) => operation.output.qualifiedName === confirmedFailureNode.qualifiedName)?.status,
        'failed',
    );
});

test('external dataset inputs are informational source nodes without run state', () => {
    const external: PipelineNode = {
        id: 'external-id',
        name: 'bronze.events',
        nodeType: 'EXTERNAL_DATASET',
        qualifiedName: 'bronze.events',
    };
    const pipeline = pipelineDetail([external, tableNode], {
        edges: [{
            ...flowToTable,
            id: 'external-to-table',
            sourceNodeId: external.id,
            targetNodeId: tableNode.id,
        }],
    });
    const operation = declaredPipelineOperations(pipeline)
        .find((candidate) => candidate.output.id === tableNode.id);

    assert.equal(operation?.inputs[0]?.id, external.id);
    assert.equal(operation?.inputs[0]?.kind, 'external-source');
    assert.equal(operation?.inputs[0]?.nodeType, 'EXTERNAL_DATASET');
    assert.equal(operation?.inputs[0]?.status, undefined);
});

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
