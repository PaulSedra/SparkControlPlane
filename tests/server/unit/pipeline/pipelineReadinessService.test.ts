/**
 * @fileoverview Tests cached readiness state and operational queue metrics.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { createPipelineReadinessService } from '../../../../src/server/pipeline/pipelineReadinessService.ts';
import { createInMemoryPersistence } from '../../../support/inMemoryPersistence.ts';
import { prometheusMetrics } from '../../../../src/server/observability/observability.ts';

test('readiness tracks discovery and measures queue age with the injected clock', async () => {
    const now = Date.parse('2026-10-02T12:01:41.000Z');
    const basePersistence = createInMemoryPersistence();
    const persistence = {
        ...basePersistence,
        async operationalSnapshot() {
            return {
                activeRuns: 2,
                oldestQueuedAt: '2026-10-02T12:00:01.000Z',
                queuedRuns: 3,
                stuckRuns: 1,
            };
        },
    };
    const readiness = createPipelineReadinessService({
        isAcceptingWork: () => true,
        now: () => now,
        persistence,
    });

    assert.equal(readiness.snapshot().discoveryReady, false);
    readiness.markDiscoveryReady(4);
    assert.equal(readiness.snapshot().discoveredPipelineCount, 4);
    assert.equal(readiness.snapshot().discoveryReady, true);

    const snapshot = await readiness.readOperationalSnapshot();
    assert.deepEqual(snapshot, {
        activeRuns: 2,
        oldestQueuedAt: '2026-10-02T12:00:01.000Z',
        queuedRuns: 3,
        stuckRuns: 1,
    });
    assert.equal(readiness.snapshot().operationalSnapshotReady, true);
    assert.match(prometheusMetrics(), /control_plane_oldest_queued_age_seconds 100/);

    await readiness.start();
    assert.equal(readiness.snapshot().initialized, true);
    readiness.stop();
    assert.equal(readiness.snapshot().initialized, false);

    readiness.markDiscoveryFailed();
    assert.equal(readiness.snapshot().discoveryReady, false);
    assert.equal(readiness.snapshot().discoveredPipelineCount, 4);
});
