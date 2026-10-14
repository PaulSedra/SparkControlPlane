/**
 * @fileoverview Contract checks for the published OpenAPI document.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import { createTestDataLoader } from '../../../support/testData.ts';

interface OpenApiFixture {
    aistorSecurity: unknown;
    expectedRoutes: Record<string, string[]>;
    pathCount: number;
    proxy: {
        canonical: boolean;
        enabledBy: string;
        pathPrefix: string;
        purpose: string;
    };
}

const fixture = createTestDataLoader('server/contract')
    .loadData<OpenApiFixture>('openapi.json');

test('published OpenAPI document is valid JSON and covers backend routes', async () => {
    const document = JSON.parse(
        await fs.readFile(new URL('../../../../docs/openapi.json', import.meta.url), 'utf8'),
    ) as {
        components?: {
            schemas?: {
                PipelineSpec?: {
                    properties?: {
                        onSuccess?: { $ref?: string };
                    };
                };
                PipelineSuccessDependency?: {
                    properties?: {
                        pipeline?: { minLength?: number };
                    };
                };
                PipelineRun?: {
                    properties?: {
                        cliExecutionId?: unknown;
                        cliProcessId?: unknown;
                        cliRunDirectory?: unknown;
                        cliState?: unknown;
                        status?: { enum?: string[] };
                    };
                };
            };
        };
        openapi?: string;
        paths?: Record<string, Record<string, unknown>>;
        'x-spark-control-plane-proxy'?: {
            canonical?: boolean;
            enabledBy?: string;
            pathPrefix?: string;
            purpose?: string;
        };
    };
    assert.match(document.openapi ?? '', /^3\.1\./);
    for (const [route, methods] of Object.entries(fixture.expectedRoutes)) {
        assert.ok(document.paths?.[route], `Missing OpenAPI route: ${route}`);
        for (const method of methods) {
            assert.ok(
                document.paths?.[route]?.[method],
                `Missing OpenAPI operation: ${method.toUpperCase()} ${route}`,
            );
        }
    }
    assert.equal(document.paths && Object.keys(document.paths).length, fixture.pathCount);
    const pipelineRun = document.components?.schemas?.PipelineRun?.properties;
    assert.ok(pipelineRun?.status?.enum?.includes('UNKNOWN'));
    assert.ok(pipelineRun?.cliExecutionId);
    assert.ok(pipelineRun?.cliState);
    assert.ok(pipelineRun?.cliProcessId);
    assert.ok(pipelineRun?.cliRunDirectory);
    assert.equal(
        document.components?.schemas?.PipelineSpec?.properties?.onSuccess?.$ref,
        '#/components/schemas/PipelineSuccessDependency',
    );
    assert.equal(
        document.components?.schemas?.PipelineSuccessDependency?.properties?.pipeline?.minLength,
        1,
    );
    const aistorOperation = document.paths?.['/api/v1/triggers/aistor/events']?.post as {
        security?: unknown;
    } | undefined;
    assert.deepEqual(aistorOperation?.security, fixture.aistorSecurity);
    assert.equal(JSON.stringify(document).includes('deprecated'), false);
    assert.deepEqual(document['x-spark-control-plane-proxy'], fixture.proxy);
});
