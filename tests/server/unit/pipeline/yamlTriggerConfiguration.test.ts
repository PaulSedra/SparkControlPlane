/**
 * @fileoverview Unit coverage for YAML trigger configuration parsing.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { parsePipelineYamlTriggers } from '../../../../src/server/pipeline/discovery/yamlTriggerConfiguration.ts';
import { createInMemoryPersistence } from '../../../support/inMemoryPersistence.ts';
import { createPipelineFixture } from '../../../support/pipelineFixture.ts';
import { captureEnvironment } from '../../../support/testEnvironment.ts';
import { createTestDataLoader } from '../../../support/testData.ts';
import { triggerDefinition } from '../../../support/triggerFixtures.ts';
import { createPipelineRegistryService } from '../../../../src/server/pipeline/pipelineRegistryService.ts';

const testData = createTestDataLoader('server/unit');
interface YamlTriggerConfigurationFixture {
    parseCases: Array<{
        expected: Array<{
            configuration: Record<string, unknown>;
            enabled?: boolean;
            type?: string;
        }>;
        fixture: string;
        name: string;
        specPath: string;
    }>;
    rejectCases: Array<{
        errorIncludes: string;
        fixture: string;
        name: string;
        specPath: string;
    }>;
}

const fixture = testData.loadYaml<YamlTriggerConfigurationFixture>(
    'fixtures/yaml-trigger-configuration.yaml',
);

for (const scenario of fixture.parseCases) {
    test(scenario.name, () => {
        const definitions = parsePipelineYamlTriggers(
            testData.loadText(scenario.fixture),
            scenario.specPath,
        );

        assert.equal(definitions.length, scenario.expected.length);
        for (const [index, expected] of scenario.expected.entries()) {
            assert.equal(definitions[index]?.type, expected.type);
            if (expected.enabled != null) {
                assert.equal(definitions[index]?.enabled, expected.enabled);
            }
            assert.deepEqual(
                definitions[index]?.configuration,
                normalizeConfiguration(expected.configuration),
            );
        }
    });
}

for (const scenario of fixture.rejectCases) {
    test(scenario.name, () => {
        assert.throws(
            () => parsePipelineYamlTriggers(
                testData.loadText(scenario.fixture),
                scenario.specPath,
            ),
            new RegExp(scenario.errorIncludes),
        );
    });
}

function normalizeConfiguration(
    configuration: Record<string, unknown>,
): Record<string, unknown> {
    return Object.fromEntries(
        Object.entries(configuration).map(([key, value]) => [
            key,
            value === null ? undefined : value,
        ]),
    );
}

test('reconciles direct pipeline YAML trigger edits and disables removed definitions', async () => {
    const restore = captureEnvironment('PIPELINES_DIR');
    const fixture = await createPipelineFixture({
        files: [{
            content: 'CREATE MATERIALIZED VIEW orders AS SELECT 1 AS value;\n',
            relativePath: 'sql/orders.sql',
        }],
        name: 'YAML Orders Pipeline',
        pipelinePath: 'orders',
        prefix: 'spark-control-plane-yaml-trigger-service-',
        specFilename: 'orders.pipeline.yaml',
        storage: 's3://checkpoints/yaml-orders',
    });
    const specPath = fixture.specPath;

    const writeSpec = (prefix: string, waitSeconds: number) => fs.writeFile(specPath, [
        'name: YAML Orders Pipeline',
        'storage: s3://checkpoints/yaml-orders',
        'libraries:',
        '  - glob:',
        '      include: ../sql/**',
        'triggers:',
        '  - name: incoming-orders',
        '    trigger:',
        '      file_arrival:',
        `        url: s3://lake/${prefix}`,
        `        wait_after_last_change_seconds: ${waitSeconds}`,
        '',
    ].join('\n'), 'utf8');

    await writeSpec('incoming/', 1);
    process.env.PIPELINES_DIR = path.join(fixture.root, 'pipelines');
    const basePersistence = createInMemoryPersistence();
    let yamlReconcileCount = 0;
    const persistence = {
        ...basePersistence,
        reconcileYamlTriggers: (...args: Parameters<typeof basePersistence.reconcileYamlTriggers>) => {
            yamlReconcileCount += 1;
            return basePersistence.reconcileYamlTriggers(...args);
        },
    };
    const service = createPipelineRegistryService({
        persistence,
    });
    try {
        await service.initialize();
        await service.refreshPipelinesFromSource();
        const initial = await service.listTriggers();
        assert.equal(initial.length, 1);
        const yamlTrigger = initial[0];
        assert.ok(yamlTrigger);
        assert.equal(yamlTrigger.active, true);
        assert.equal(yamlTrigger.managedByYaml, true);
        assert.equal(yamlTrigger.configuration.debounceMilliseconds, 1_000);

        const pipelineId = (await service.listPipelines())[0]?.id;
        assert.ok(pipelineId);
        const initialPipeline = await service.getPipeline(pipelineId);
        const initialSourceHash = initialPipeline.sourceHash;
        const apiTrigger = await service.createTrigger(triggerDefinition({
            configuration: {
                eventType: 'order.created',
                source: 'warehouse',
            },
            name: 'api-orders',
            pipelineId,
        }));
        yamlReconcileCount = 0;
        await service.updateTrigger(apiTrigger.id, {
            callerMetadata: { owner: 'updated-test' },
        });
        assert.equal(yamlReconcileCount, 0);

        await writeSpec('incoming/priority/', 2);
        const unchanged = await service.listTriggers();
        const unchangedYaml = unchanged.find((trigger) => trigger.id === yamlTrigger.id);
        assert.equal(unchangedYaml?.configuration.debounceMilliseconds, 1_000);
        assert.equal((await service.getPipeline(pipelineId)).sourceHash, initialSourceHash);

        await service.refreshPipelinesFromSource();
        const updated = await service.listTriggers();
        const updatedYaml = updated.find((trigger) => trigger.id === yamlTrigger.id);
        assert.ok(updatedYaml);
        assert.equal(updatedYaml.configuration.debounceMilliseconds, 2_000);
        assert.equal(updatedYaml.configuration.prefix, 'incoming/priority/');
        assert.equal(updatedYaml.active, true);
        assert.equal(updatedYaml.managedByYaml, true);
        assert.equal(updated.find((trigger) => trigger.id === apiTrigger.id)?.enabled, true);
        assert.equal((await service.getPipeline(pipelineId)).sourceHash, initialSourceHash);

        await fs.writeFile(specPath, [
            'name: YAML Orders Pipeline',
            'storage: s3://checkpoints/yaml-orders',
            'libraries:',
            '  - glob:',
            '      include: ../sql/**',
            '',
        ].join('\n'), 'utf8');
        const beforeRemovalRefresh = await service.listTriggers();
        assert.equal(beforeRemovalRefresh.find((trigger) => trigger.id === yamlTrigger.id)?.active, true);
        await service.refreshPipelinesFromSource();
        const removed = await service.listTriggers();
        const removedYaml = removed.find((trigger) => trigger.id === yamlTrigger.id);
        assert.ok(removedYaml);
        assert.equal(removedYaml.active, false);
        assert.equal(removedYaml.enabled, false);
        assert.equal(removedYaml.managedByYaml, true);
        assert.ok(removed.find((trigger) => trigger.id === apiTrigger.id));
        assert.equal((await service.getPipeline(pipelineId)).sourceHash, initialSourceHash);

        await writeSpec('incoming/restored/', 3);
        await service.refreshPipelinesFromSource();
        const restored = await service.listTriggers();
        const restoredYaml = restored.find((trigger) => trigger.id === yamlTrigger.id);
        assert.ok(restoredYaml);
        assert.equal(restoredYaml.active, true);
        assert.equal(restoredYaml.enabled, true);
        assert.equal(restoredYaml.managedByYaml, true);
    } finally {
        await service.shutdown(100);
        restore();
        await fixture.cleanup();
    }
});
