/**
 * @fileoverview Unit coverage for graph connector hover and paint ordering.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import {
    getAssetNodeHover,
    isAssetEdgeHighlighted,
    orderAssetEdgesForPaint,
} from '../../../../src/web/components/pipeline/graph/pipelineAssetGraphEdges.ts';

test('external table hover highlights outgoing arrows from either side of the card', () => {
    const bounds = { left: 100, width: 80 };

    assert.deepEqual(
        getAssetNodeHover('regular', 110, bounds, false),
        { direction: 'incoming', nodeId: 'regular' },
    );
    assert.deepEqual(
        getAssetNodeHover('regular', 170, bounds, false),
        { direction: 'outgoing', nodeId: 'regular' },
    );
    assert.deepEqual(
        getAssetNodeHover('external', 110, bounds, true),
        { direction: 'outgoing', nodeId: 'external' },
    );
});

test('paints hovered external arrows after overlapping regular and external edges', () => {
    const edges = [
        { id: 'external-peer', sourceId: 'other-table', targetId: 'flow' },
        { id: 'regular-peer', sourceId: 'upstream', targetId: 'flow' },
        { id: 'external-hovered-first', sourceId: 'external', targetId: 'flow' },
        { id: 'external-hovered-second', sourceId: 'external', targetId: 'other-flow' },
    ];
    const externalHover = getAssetNodeHover(
        'external',
        110,
        { left: 100, width: 80 },
        true,
    );

    assert.equal(
        isAssetEdgeHighlighted(
            { sourceId: 'external', targetId: 'flow' },
            externalHover,
        ),
        true,
    );
    assert.deepEqual(
        orderAssetEdgesForPaint(edges, externalHover).map((edge) => edge.id),
        [
            'external-peer',
            'regular-peer',
            'external-hovered-first',
            'external-hovered-second',
        ],
    );

    const targetHover = { direction: 'incoming' as const, nodeId: 'flow' };
    assert.deepEqual(
        orderAssetEdgesForPaint(edges, targetHover).map((edge) => edge.id),
        [
            'external-hovered-second',
            'external-peer',
            'regular-peer',
            'external-hovered-first',
        ],
    );
});
