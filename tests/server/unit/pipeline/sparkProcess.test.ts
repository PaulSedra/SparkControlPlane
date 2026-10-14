/**
 * @fileoverview Regression coverage for mapping selected graph nodes to Spark datasets.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import type {
    PipelineDetail,
    PipelineEdge,
    PipelineNode,
} from '../../../../src/shared/pipelineRegistryTypes.ts';
import { sparkRefreshDatasetNames } from '../../../../src/server/pipeline/spark/sparkProcess.ts';

const sourceEventsTable: PipelineNode = {
    id: 'dataset:sample_catalog.bronze.source_events',
    name: 'source_events',
    nodeType: 'STREAMING_TABLE',
    qualifiedName: 'sample_catalog.bronze.source_events',
};

const selectedFlow: PipelineNode = {
    id: 'flow:sample_catalog.silver.append_event_metrics',
    name: 'append_event_metrics',
    nodeType: 'FLOW',
    qualifiedName: 'sample_catalog.silver.append_event_metrics',
};

const secondSelectedFlow: PipelineNode = {
    id: 'flow:sample_catalog.silver.append_event_details',
    name: 'append_event_details',
    nodeType: 'FLOW',
    qualifiedName: 'sample_catalog.silver.append_event_details',
};

const selectedView: PipelineNode = {
    id: 'dataset:sample_catalog.silver.dim_entity',
    name: 'dim_entity',
    nodeType: 'MATERIALIZED_VIEW',
    qualifiedName: 'sample_catalog.silver.dim_entity',
};

const flowToTable: PipelineEdge = {
    confidence: 'LOW',
    evidence: 'test fixture',
    id: 'flow-to-table',
    sourceExpression: 'sample_catalog.silver.append_event_metrics',
    sourceNodeId: selectedFlow.id,
    targetNodeId: sourceEventsTable.id,
};

const secondFlowToTable: PipelineEdge = {
    ...flowToTable,
    id: 'second-flow-to-table',
    sourceExpression: secondSelectedFlow.qualifiedName,
    sourceNodeId: secondSelectedFlow.id,
};

const pipelineGraph: Pick<PipelineDetail, 'edges' | 'nodes'> = {
    edges: [flowToTable, secondFlowToTable],
    nodes: [sourceEventsTable, selectedFlow, secondSelectedFlow, selectedView],
};

test('resolves a selected flow to its qualified output dataset', () => {
    assert.deepEqual(
        sparkRefreshDatasetNames([selectedFlow.qualifiedName], pipelineGraph),
        [sourceEventsTable.qualifiedName],
    );
});

test('keeps dataset names qualified and deduplicates flows with a shared output', () => {
    assert.deepEqual(
        sparkRefreshDatasetNames(
            [
                selectedFlow.qualifiedName,
                secondSelectedFlow.qualifiedName,
                sourceEventsTable.qualifiedName,
                selectedView.qualifiedName,
            ],
            pipelineGraph,
        ),
        [sourceEventsTable.qualifiedName, selectedView.qualifiedName],
    );
});

test('rejects a selected flow without an output dataset edge', () => {
    assert.throws(
        () => sparkRefreshDatasetNames(
            ['sample_catalog.silver.unconnected_flow'],
            {
                edges: [],
                nodes: [
                    {
                        ...selectedFlow,
                        id: 'flow:sample_catalog.silver.unconnected_flow',
                        name: 'unconnected_flow',
                        qualifiedName: 'sample_catalog.silver.unconnected_flow',
                    },
                ],
            },
        ),
        /does not resolve to a refreshable dataset/,
    );
});
