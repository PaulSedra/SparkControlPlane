/**
 * @fileoverview HTTP contract coverage for catalog endpoints.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import test from 'node:test';
import { createServer } from 'vite';
import {
    assertMethodNotAllowed,
    fetchJson,
} from '../../../support/httpTestSupport.ts';
import { createInMemoryPersistence } from '../../../support/inMemoryPersistence.ts';
import {
    withEnvironment,
    withTemporaryDirectory,
    withWorkingDirectory,
} from '../../../support/testEnvironment.ts';
import { createTestDataLoader } from '../../../support/testData.ts';
import { pipelineRegistryApiPlugin } from '../../../../src/server/api/pipelineRegistryVitePlugin.ts';
import type { CatalogService } from '../../../../src/server/types/catalogServiceTypes.ts';
import type {
    SparkSampleData,
    SparkTable,
    SparkTableDetail,
} from '../../../../src/shared/catalogTypes.ts';

interface CatalogFixture {
    catalogService: {
        catalogs: Array<{ name: string }>;
        schemas: Array<{ name: string }>;
        table: Omit<SparkTableDetail, 'catalog' | 'name' | 'schema'>;
        tableData: SparkSampleData;
        tables: Array<Omit<SparkTable, 'catalog' | 'schema'>>;
    };
    expected: {
        catalogs: unknown;
        detail: SparkTableDetail;
        sample: SparkSampleData;
        schemas: unknown;
        tables: unknown;
    };
}

const fixture = createTestDataLoader('server/contract')
    .loadData<CatalogFixture>('catalog.json');

test('catalog routes expose catalog, schema, table, and sample contracts', async () => {
    const catalogService: CatalogService = {
        getTable: async (catalog, schema, table) => ({
            catalog,
            ...fixture.catalogService.table,
            name: table,
            schema,
        }),
        getTableData: async () => fixture.catalogService.tableData,
        listCatalogs: async () => fixture.catalogService.catalogs,
        listSchemas: async (catalog) => fixture.catalogService.schemas.map((schema) => ({
            ...schema,
            catalog,
        })),
        listTables: async (catalog, schema) => fixture.catalogService.tables.map((table) => ({
            ...table,
            catalog,
            schema,
        })),
    };

    await withTemporaryDirectory('spark-control-plane-catalog-test-', async (temporaryRoot) => {
        await fs.mkdir(path.join(temporaryRoot, 'pipelines'), { recursive: true });
        await withEnvironment({
            PIPELINES_DIR: path.join(temporaryRoot, 'pipelines'),
        }, () => withWorkingDirectory(temporaryRoot, async () => {
            const server = await createServer({
                configFile: false,
                logLevel: 'silent',
                plugins: [pipelineRegistryApiPlugin({
                    catalogService,
                    persistence: createInMemoryPersistence(),
                })],
                server: { host: '127.0.0.1', port: 0 },
            });

            try {
                await server.listen();
                const address = server.httpServer?.address() as AddressInfo;
                const baseUrl = `http://127.0.0.1:${address.port}`;

                assert.deepEqual(
                    await fetchJson(`${baseUrl}/api/v1/catalogs`, 200),
                    fixture.expected.catalogs,
                );

                assert.deepEqual(await fetchJson(
                    `${baseUrl}/api/v1/catalogs/spark_catalog/schemas`,
                    200,
                ), fixture.expected.schemas);

                assert.deepEqual(await fetchJson(
                    `${baseUrl}/api/v1/catalogs/spark_catalog/schemas/analytics/tables`,
                    200,
                ), fixture.expected.tables);

                const detail = await fetchJson<{ name: string; tableType: string }>(
                    `${baseUrl}/api/v1/catalogs/spark_catalog/schemas/analytics/tables/orders`,
                    200,
                );
                assert.deepEqual(detail, fixture.expected.detail);

                assert.deepEqual(await fetchJson(
                    `${baseUrl}/api/v1/catalogs/spark_catalog/schemas/analytics/tables/orders/data?limit=12`,
                    200,
                ), fixture.expected.sample);

                await assertMethodNotAllowed(`${baseUrl}/api/v1/catalogs`, 'POST', 'GET');
            } finally {
                await server.close();
            }
        }));
    });
});
