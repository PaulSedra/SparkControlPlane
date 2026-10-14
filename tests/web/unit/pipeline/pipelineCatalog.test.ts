/**
 * @fileoverview Unit coverage for pipeline catalog presentation helpers.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import type { PipelineNode } from '../../../../src/shared/pipelineRegistryTypes.ts';
import type { PipelineSpec } from '../../../../src/shared/pipelineRegistryTypes.ts';
import {
    pipelineCatalogNamespaceKey,
    pipelineCatalogTarget,
    pipelineOutputTableTargets,
    pipelineTablePresenceByNodeId,
} from '../../../../src/web/utils/pipelineCatalog.ts';
import { pipelineNodeTypeLabel } from '../../../../src/web/components/pipeline/pipelineCatalogPresentation.ts';
import {
    pipelineNode,
    pipelineSpecFixture,
} from '../../../support/webFixtures.ts';
import { createTestDataLoader } from '../../../support/testData.ts';

interface PipelineCatalogFixture {
    pipelineCatalogTargets: Array<{
        expected: { catalog: string; schema: string; table: string } | null;
        name: string;
        nodeName: string;
        spec: Partial<PipelineSpec>;
    }>;
    pipelineNodeTypeLabels: Array<{
        expected: string;
        nodeType: PipelineNode['nodeType'];
    }>;
}

const fixture = createTestDataLoader('web/unit')
    .loadYaml<PipelineCatalogFixture>('fixtures/presentation.yaml');

for (const scenario of fixture.pipelineCatalogTargets) {
    test('pipeline catalog target ' + scenario.name, () => {
        assert.deepEqual(
            pipelineCatalogTarget(
                pipelineNode(scenario.nodeName),
                { ...pipelineSpecFixture, ...scenario.spec },
            ),
            scenario.expected ?? undefined,
        );
    });
}

for (const scenario of fixture.pipelineNodeTypeLabels) {
    test('pipeline node type label is ' + scenario.expected, () => {
        assert.equal(pipelineNodeTypeLabel(scenario.nodeType), scenario.expected);
    });
}

test('persistent pipeline outputs are compared with catalog names by namespace', () => {
    const pipeline = {
        nodes: [
            {
                ...pipelineNode('orders'),
                id: 'orders-output',
                nodeType: 'STREAMING_TABLE' as const,
                qualifiedName: 'sales.orders',
            },
            {
                ...pipelineNode('daily-summary'),
                id: 'summary-output',
                nodeType: 'MATERIALIZED_VIEW' as const,
                qualifiedName: 'sales.daily_summary',
            },
            {
                ...pipelineNode('scratch'),
                id: 'temporary-view',
                nodeType: 'TEMPORARY_VIEW' as const,
                qualifiedName: 'sales.scratch',
            },
        ],
        spec: { ...pipelineSpecFixture, catalog: 'main', schema: 'sales' },
    };
    const targets = pipelineOutputTableTargets(pipeline);
    assert.deepEqual(targets, [
        { catalog: 'main', schema: 'sales', table: 'orders', nodeId: 'orders-output' },
        {
            catalog: 'main', schema: 'sales', table: 'daily_summary',
            nodeId: 'summary-output',
        },
    ]);

    const presence = pipelineTablePresenceByNodeId(targets, new Map([
        [pipelineCatalogNamespaceKey('main', 'sales'), [{ name: 'orders' }]],
    ]));
    assert.deepEqual([...presence], [
        ['orders-output', true],
        ['summary-output', false],
    ]);
    assert.equal(pipelineTablePresenceByNodeId(targets, new Map()).size, 0);
});
