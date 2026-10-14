/**
 * @fileoverview Unit coverage for pipeline successor resolution at submission.
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { createInMemoryPersistence } from '../../../support/inMemoryPersistence.ts';
import { createPipelineFixture } from '../../../support/pipelineFixture.ts';
import { captureEnvironment } from '../../../support/testEnvironment.ts';
import { discoverAndPersistPipelines } from '../../../../src/server/pipeline/discovery/pipelineRegistryDiscovery.ts';
import { submitRun } from '../../../../src/server/pipeline/execution/runSubmission.ts';
import type { PipelineParseCache } from '../../../../src/server/pipeline/discovery/pipelineDiscovery.ts';
import type { PipelineRunPolicy } from '../../../../src/server/types/pipelineRunPolicyTypes.ts';
import { versionId } from '../../../../src/server/pipeline/discovery/pipelineVersion.ts';

test('resolves on_success pipeline names to durable pipeline IDs at submission', async () => {
    const restoreEnvironment = captureEnvironment('PIPELINES_DIR');
    const sourceFixture = await createPipelineFixture({
        libraryInclude: null,
        name: 'source_pipeline',
        pipelinePath: 'source',
        prefix: 'spark-control-plane-success-source-',
        specExtras: [
            'on_success:',
            '  pipeline: target_pipeline',
        ],
        specFilename: 'source_pipeline.pipeline.yaml',
        storage: 's3a://warehouse/',
    });
    await createPipelineFixture({
        libraryInclude: null,
        name: 'target_pipeline',
        pipelinePath: 'target',
        prefix: 'spark-control-plane-success-target-',
        root: sourceFixture.root,
        specFilename: 'target_pipeline.pipeline.yaml',
        storage: 's3a://warehouse/',
    });
    const persistence = createInMemoryPersistence();

    try {
        process.env.PIPELINES_DIR = path.join(sourceFixture.root, 'pipelines');
        await persistence.initialize();
        const pipelines = await discoverAndPersistPipelines(persistence, new Map<string, PipelineRunPolicy>(), new Map() as PipelineParseCache);
        const source = pipelines.find((pipeline) =>
            pipeline.detail.name === 'source_pipeline'
        );
        const target = pipelines.find((pipeline) =>
            pipeline.detail.name === 'target_pipeline'
        );
        assert.ok(source);
        assert.ok(target);
        assert.deepEqual(source.detail.spec.onSuccess, { pipeline: 'target_pipeline' });

        await persistence.saveDeployment({
            deployedAt: new Date().toISOString(),
            pipelineId: source.detail.id,
            sourceHash: source.sourceHash,
            status: 'DEPLOYED',
            validationMessages: [],
            versionId: versionId(source.sourceHash),
        });
        const parent = await submitRun(
            { pipelineId: source.detail.id },
            persistence,
        );
        const claim = await persistence.claimNextQueuedRun('success-submission-test', 5_000);
        assert.ok(claim);
        assert.equal(claim.run.runId, parent.run.runId);
        await persistence.completeRun(parent.run.runId, claim.lease, {
            command: ['spark-pipelines', 'run'],
            endedAt: new Date().toISOString(),
            exitCode: 0,
            stderr: '',
            stdout: '',
            status: 'SUCCEEDED',
        });

        const dependency = await persistence.listReadyRunSuccessDependencies();
        assert.equal(dependency.length, 1);
        assert.equal(dependency[0]?.sourcePipelineId, source.detail.id);
        assert.equal(dependency[0]?.targetPipelineId, target.detail.id);
        assert.equal(dependency[0]?.sourceRunId, parent.run.runId);
    } finally {
        await persistence.shutdown();
        restoreEnvironment();
        await sourceFixture.cleanup();
    }
});
