/**
 * @fileoverview Unit coverage for append-only history export batches.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { exportHistoryBatch } from '../../../../src/server/history/historyExport.ts';
import { createInMemoryPersistence } from '../../../support/inMemoryPersistence.ts';
import type { DiscoveredPipeline, PipelineDeployment } from '../../../../src/server/types/pipelinePersistenceTypes.ts';

test('history export resumes from independent source cursors without rewriting source evidence', async () => {
    const persistence = createInMemoryPersistence();
    await persistence.initialize();
    const discovered: DiscoveredPipeline = {
        edges: [],
        name: 'History Export Pipeline',
        nodes: [],
        sourceFiles: [],
        sourceHash: 'source-hash-1',
        spec: {
            libraries: [],
            name: 'History Export Pipeline',
            specPath: 'resources/history.pipeline.yaml',
            storage: 's3://history-export',
        },
        specPath: 'resources/history.pipeline.yaml',
        validationMessages: [],
        versionId: 'version-1',
    };
    const pipeline = await persistence.ensurePipeline(discovered);
    const deployment: PipelineDeployment = {
        deployedAt: '2026-09-08T12:00:00.000Z',
        pipelineId: pipeline.id,
        sourceHash: discovered.sourceHash,
        status: 'DEPLOYED',
        validationMessages: [],
        versionId: discovered.versionId,
    };
    await persistence.saveDeployment(deployment);
    const firstRun = await persistence.submitRun({
        mode: 'incremental',
        pipelineId: pipeline.id,
        sourceHash: discovered.sourceHash,
        sparkAppName: 'history-run-1',
        versionId: discovered.versionId,
    });
    const secondRun = await persistence.submitRun({
        mode: 'incremental',
        pipelineId: pipeline.id,
        sourceHash: discovered.sourceHash,
        sparkAppName: 'history-run-2',
        versionId: discovered.versionId,
    });
    await persistence.recordAuditEvent({
        eventType: 'history.test.first',
        payload: { sequence: 1 },
        pipelineId: pipeline.id,
    });
    await persistence.recordAuditEvent({
        eventType: 'history.test.second',
        payload: { sequence: 2 },
        pipelineId: pipeline.id,
    });

    const firstBatch = await exportHistoryBatch(persistence, undefined, 1);
    assert.equal(firstBatch.pipelineRunHistory.length, 1);
    assert.equal(firstBatch.auditHistory.length, 1);
    assert.equal(firstBatch.pipelineRunHistory[0]?.runId, firstRun.run.runId);
    assert.equal(firstBatch.auditHistory[0]?.eventType, 'history.test.first');

    const secondBatch = await exportHistoryBatch(persistence, firstBatch.nextCursor, 1);
    assert.equal(secondBatch.pipelineRunHistory.length, 1);
    assert.equal(secondBatch.auditHistory.length, 1);
    assert.equal(secondBatch.pipelineRunHistory[0]?.runId, secondRun.run.runId);
    assert.equal(secondBatch.auditHistory[0]?.eventType, 'history.test.second');

    const completed = await exportHistoryBatch(persistence, secondBatch.nextCursor, 1);
    assert.deepEqual(completed.pipelineRunHistory, []);
    assert.deepEqual(completed.auditHistory, []);
    assert.deepEqual(
        [firstBatch.pipelineRunHistory[0]?.runEventId, secondBatch.pipelineRunHistory[0]?.runEventId],
        ['1', '2'],
    );
    await persistence.shutdown();
});
