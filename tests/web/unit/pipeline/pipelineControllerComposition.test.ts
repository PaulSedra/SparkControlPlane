import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToString } from 'react-dom/server';
import { usePipelineController } from '../../../../src/web/components/pipeline/hooks/usePipelineController.ts';

test('pipeline controller composes pending route data and idle local controls', () => {
    const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false } },
    });
    let controller: ReturnType<typeof usePipelineController> | undefined;

    function ControllerProbe() {
        controller = usePipelineController('pipeline-1', 'deep-linked-run');
        return null;
    }

    renderToString(createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(ControllerProbe),
    ));

    assert.ok(controller);
    assert.equal(controller.pipelineLoadState.kind, 'loading');
    assert.equal(controller.pipelineDetail, undefined);
    assert.equal(controller.selectedRunId, 'deep-linked-run');
    assert.deepEqual(controller.selectedNodeIds, []);
    assert.deepEqual(controller.selectedNodeNames, []);
    assert.equal(controller.isTableSelectionMode, false);
    assert.equal(controller.isPipelineRunnable, false);
    assert.deepEqual(controller.pipelineActionStates, {
        cancel: { kind: 'idle' },
        deploy: { kind: 'idle' },
        run: { kind: 'idle' },
    });

    queryClient.clear();
});
