/**
 * @fileoverview Readiness checks for the standalone server with PostgreSQL.
 */

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import test from 'node:test';
import { Pool } from 'pg';
import { fetchJson } from '../../support/httpTestSupport.ts';
import { createPipelineFixture } from '../../support/pipelineFixture.ts';
import {
    isLivePostgresTestEnabled,
    postgresPoolConfig,
} from '../../support/postgresTestSupport.ts';
import { captureEnvironment } from '../../support/testEnvironment.ts';
import { loadPostgresConfig } from '../../../src/server/config/postgresConfig.ts';
import { createPipelineRegistryService } from '../../../src/server/pipeline/pipelineRegistryService.ts';
import { createStandaloneControlPlane } from '../../../src/server/runtime/standaloneServer.ts';

test('standalone HTTP readiness reports PostgreSQL for a PostgreSQL-backed service', {
    skip: !isLivePostgresTestEnabled(),
}, async () => {
    const restore = captureEnvironment('PIPELINES_DIR');
    const pipelineName = 'postgres-http-readiness-' + crypto.randomUUID();
    const fixture = await createPipelineFixture({
        files: [{
            content: 'CREATE MATERIALIZED VIEW readiness AS SELECT 1 AS value;\n',
            relativePath: 'sql/readiness.sql',
        }],
        name: pipelineName,
        pipelinePath: 'readiness',
        prefix: 'spark-control-plane-http-pg-',
        specFilename: 'readiness.pipeline.yaml',
        storage: 'file:///tmp/spark-control-plane-http-readiness',
    });
    const config = loadPostgresConfig();
    let pipelineId: string | undefined;
    const cleanupPool = new Pool(postgresPoolConfig(config));
    const service = createPipelineRegistryService({
        postgresConfig: config,
        sparkConnectUrl: 'sc://unused-for-readiness:15002',
    });
    const controlPlane = createStandaloneControlPlane({
        config: {
            aistorWebhookToken: 'test-aistor-token',
            drainMilliseconds: 100,
            host: '127.0.0.1',
            port: 0,
            postgres: config,
            sparkConnectUrl: 'sc://unused-for-readiness:15002',
            staticDirectory: path.resolve('dist'),
        },
        service,
    });

    try {
        process.env.PIPELINES_DIR = path.join(fixture.root, 'pipelines');
        await service.initialize();
        await controlPlane.start();
        const address = controlPlane.server.address() as AddressInfo;
        const baseUrl = `http://127.0.0.1:${address.port}`;

        const readyBeforeRefresh = await fetchJson<{
            checks: { persistence: string; pipelineDiscovery: string };
            status: string;
        }>(`${baseUrl}/ready`, 200);
        assert.equal(readyBeforeRefresh.status, 'ready');
        assert.equal(readyBeforeRefresh.checks.persistence, 'postgresql');
        assert.equal(readyBeforeRefresh.checks.pipelineDiscovery, 'ready:0');

        const beforeRefresh = await fetchJson<{ pipelines: Array<{ name: string }> }>(
            `${baseUrl}/api/v1/pipelines`,
            200,
        );
        assert.deepEqual(beforeRefresh.pipelines, []);

        const refreshResponse = await fetch(`${baseUrl}/api/v1/pipelines/refresh-from-source`, {
            method: 'POST',
        });
        assert.equal(refreshResponse.status, 200);
        const refreshResult = await refreshResponse.json() as {
            pipelines: Array<{ name: string }>;
            total: number;
        };
        assert.equal(refreshResult.total, 1);
        assert.equal(refreshResult.pipelines[0]?.name, pipelineName);

        const readyAfterRefresh = await fetchJson<{
            checks: { persistence: string; pipelineDiscovery: string };
            status: string;
        }>(`${baseUrl}/ready`, 200);
        assert.equal(readyAfterRefresh.status, 'ready');
        assert.equal(readyAfterRefresh.checks.persistence, 'postgresql');
        assert.equal(readyAfterRefresh.checks.pipelineDiscovery, 'ready:1');

        const list = await fetchJson<{
            pipelines: Array<{ id: string; name: string }>;
        }>(`${baseUrl}/api/v1/pipelines`, 200);
        const pipeline = list.pipelines.find((item) => item.name === pipelineName);
        assert.ok(pipeline);
        pipelineId = pipeline.id;
    } finally {
        await controlPlane.close().catch(() => undefined);
        await service.shutdown(100).catch(() => undefined);
        if (pipelineId != null) {
            await cleanupPool.query('DELETE FROM audit_events WHERE pipeline_id = $1', [pipelineId]);
            await cleanupPool.query('DELETE FROM pipelines WHERE id = $1', [pipelineId]);
        }
        await cleanupPool.end();
        await fixture.cleanup();
        restore();
    }
});
