/**
 * @fileoverview Tests pipeline registry composition and discovery concurrency.
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { createPipelineRegistryService } from '../../../../src/server/pipeline/pipelineRegistryService.ts';
import { createInMemoryPersistence } from '../../../support/inMemoryPersistence.ts';
import { createPipelineFixture } from '../../../support/pipelineFixture.ts';
import { captureEnvironment } from '../../../support/testEnvironment.ts';

test('registry reads use saved snapshots and explicit source refreshes share discovery', async () => {
    const originalCwd = process.cwd();
    const restore = captureEnvironment('PIPELINES_DIR');
    const fixture = await createPipelineFixture({
        files: [{
            content: 'CREATE MATERIALIZED VIEW example AS SELECT 1 AS value;\n',
            relativePath: 'sql/example.sql',
        }],
        libraryInclude: '../sql/**',
        name: 'Registry Service Test',
        pipelinePath: 'registry-service',
        prefix: 'spark-control-plane-registry-service-',
        specFilename: 'registry.pipeline.yaml',
    });
    const fixedNow = Date.parse('2026-10-02T12:00:00.000Z');
    const basePersistence = createInMemoryPersistence({ now: () => fixedNow });
    let ensurePipelineCount = 0;
    const persistence = {
        ...basePersistence,
        async ensurePipeline(discovered: Parameters<typeof basePersistence.ensurePipeline>[0]) {
            ensurePipelineCount += 1;
            await new Promise<void>((resolve) => setTimeout(resolve, 10));
            return basePersistence.ensurePipeline(discovered);
        },
    };
    process.chdir(fixture.root);
    process.env.PIPELINES_DIR = path.join(fixture.root, 'pipelines');
    const service = createPipelineRegistryService({
        now: () => fixedNow,
        persistence,
    });

    try {
        await service.initialize();
        await Promise.all([service.listTriggers(), service.listTriggers()]);
        assert.equal(ensurePipelineCount, 0);

        await Promise.all([
            service.refreshPipelinesFromSource(),
            service.refreshPipelinesFromSource(),
        ]);
        assert.equal(ensurePipelineCount, 1);

        const pipelineId = (await service.listPipelines())[0]?.id;
        assert.ok(pipelineId);
        const normalizedPage = await service.listPipelinesPage(Number.NaN, Number.NaN);
        assert.equal(normalizedPage.items.length, 1);
        assert.equal(normalizedPage.offset, 0);
        assert.equal(normalizedPage.total, 1);
        const normalizedRunPage = await service.listPipelineRunsPage(
            pipelineId,
            Number.NaN,
            Number.POSITIVE_INFINITY,
        );
        assert.equal(normalizedRunPage.offset, 0);
        assert.equal(normalizedRunPage.total, 0);

        const deployed = await service.deployPipeline(pipelineId);
        assert.equal(deployed.updatedAt, new Date(fixedNow).toISOString());
    } finally {
        await service.shutdown(100);
        restore();
        process.chdir(originalCwd);
        await fixture.cleanup();
    }
});
