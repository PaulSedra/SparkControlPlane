/**
 * @fileoverview Regression coverage for SQL and Python pipeline asset lineage.
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import type { PipelineSpec } from '../../../../src/shared/pipelineRegistryTypes.ts';
import type { PythonPipelineManifest } from '../../../../src/server/pipeline/discovery/pipelineDiscovery.ts';
import { parsePipelineLineage } from '../../../../src/server/pipeline/discovery/pipelineLineageParser.ts';

const projectRoot = path.join('pipelines', 'lineage');
const spec = {
    catalog: 'example',
    database: 'bronze',
    libraries: [],
    name: 'Lineage Test',
    specPath: path.join(projectRoot, 'resources', 'lineage.pipeline.yaml'),
    storage: 'file:///tmp/lineage-test',
} as PipelineSpec;

test('extracts SQL FROM and JOIN dependencies for datasets and SQL flows', () => {
    const sourceFile = path.join(projectRoot, 'src', 'lineage.sql');
    const sql = [
        'CREATE MATERIALIZED VIEW example.silver.orders_enriched AS',
        'SELECT * FROM example.bronze.orders AS orders',
        'JOIN example.silver.customers AS customers ON orders.customer_id = customers.id;',
        'CREATE FLOW refresh_orders AS INSERT INTO example.silver.order_snapshot',
        'SELECT * FROM example.silver.orders_enriched',
        'JOIN example.bronze.order_tags AS tags ON orders_enriched.id = tags.order_id;',
    ].join('\n');
    const graph = parsePipelineLineage(projectRoot, spec, [{ content: sql, sourceFile }]);
    const nodeIds = new Set(graph.nodes.map((node) => node.id));
    const viewId = 'dataset:example.silver.orders_enriched';
    const flowId = 'flow:example.bronze.refresh_orders';

    assert.deepEqual(
        graph.edges
            .filter((edge) => edge.targetNodeId === viewId)
            .map((edge) => edge.sourceNodeId)
            .sort(),
        ['dataset:example.bronze.orders', 'dataset:example.silver.customers'],
    );
    assert.deepEqual(
        graph.edges
            .filter((edge) => edge.targetNodeId === flowId)
            .map((edge) => edge.sourceNodeId),
        ['dataset:example.silver.orders_enriched', 'dataset:example.bronze.order_tags'],
    );
    assert.ok(graph.edges.some((edge) =>
        edge.sourceNodeId === flowId &&
        edge.targetNodeId === 'dataset:example.silver.order_snapshot',
    ));
    assert.ok(graph.edges.every((edge) =>
        nodeIds.has(edge.sourceNodeId) && nodeIds.has(edge.targetNodeId),
    ));
});

test('omits recursive CTE names from SQL lineage while retaining source tables', () => {
    const sourceFile = path.join(projectRoot, 'src', 'lineage.sql');
    const sql = [
        'CREATE MATERIALIZED VIEW example.silver.orders_enriched AS',
        'WITH RECURSIVE recent_orders (order_id) AS (',
        'SELECT order_id FROM example.bronze.orders',
        '), active_customers AS (',
        'SELECT customer_id FROM example.silver.customers',
        ')',
        'SELECT * FROM recent_orders',
        'JOIN active_customers ON recent_orders.order_id = active_customers.customer_id;',
    ].join('\n');
    const graph = parsePipelineLineage(projectRoot, spec, [{ content: sql, sourceFile }]);

    assert.deepEqual(
        graph.edges
            .filter((edge) => edge.targetNodeId === 'dataset:example.silver.orders_enriched')
            .map((edge) => edge.sourceNodeId)
            .sort(),
        ['dataset:example.bronze.orders', 'dataset:example.silver.customers'],
    );
});

test('adds valid external dataset nodes for Python flow input references', () => {
    const manifest: PythonPipelineManifest = {
        flows: [{
            inputs: ['example.bronze.raw_events', 'example.silver.dim_server'],
            name: 'load_events',
            sourceFile: path.join(projectRoot, 'src', 'python_pipeline.py'),
            sourceLine: 14,
            target: 'event_snapshot',
        }],
        outputs: [{
            name: 'event_snapshot',
            sourceFile: path.join(projectRoot, 'src', 'python_pipeline.py'),
            sourceLine: 4,
            type: 'STREAMING_TABLE',
        }],
    };
    const graph = parsePipelineLineage(projectRoot, spec, [], manifest);
    const nodeIds = new Set(graph.nodes.map((node) => node.id));
    const flowId = 'flow:example.bronze.load_events';

    assert.deepEqual(
        graph.edges
            .filter((edge) => edge.targetNodeId === flowId)
            .map((edge) => edge.sourceNodeId)
            .sort(),
        ['dataset:example.bronze.raw_events', 'dataset:example.silver.dim_server'],
    );
    assert.ok(graph.nodes.some((node) =>
        node.id === 'dataset:example.bronze.raw_events' && node.nodeType === 'EXTERNAL_DATASET',
    ));
    assert.ok(graph.edges.every((edge) =>
        nodeIds.has(edge.sourceNodeId) && nodeIds.has(edge.targetNodeId),
    ));
});
