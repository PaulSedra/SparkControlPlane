/**
 * @fileoverview Unit coverage for Polaris catalog configuration and table details.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import type { Pool } from 'pg';
import type { PostgresConfig } from '../../../../src/server/types/postgresConfigTypes.ts';
import type { SparkTableDetail } from '../../../../src/shared/catalogTypes.ts';
import { loadPolarisPostgresConfig } from '../../../../src/server/catalog/polarisCatalogConfig.ts';
import { createPolarisCatalogService } from '../../../../src/server/catalog/polarisCatalogService.ts';
import { mergeSparkTableDetail } from '../../../../src/server/catalog/polarisTableDetail.ts';
import { createTestDataLoader } from '../../../support/testData.ts';

interface PolarisFixture {
    configCases: Array<{
        environment: Record<string, string>;
        expected: Partial<PostgresConfig> | null;
        name: string;
    }>;
    tableMerge: {
        expected: {
            columns: SparkTableDetail['columns'];
            location: string;
            properties: Record<string, string | null>;
        };
        polarisDetail: SparkTableDetail;
        sparkDetail: SparkTableDetail;
    };
}

const fixture = createTestDataLoader('server/unit')
    .loadYaml<PolarisFixture>('fixtures/polaris.yaml');

for (const scenario of fixture.configCases) {
    test('Polaris configuration ' + scenario.name, () => {
        const config = loadPolarisPostgresConfig(scenario.environment);
        if (scenario.expected == null) {
            assert.equal(config, undefined);
            return;
        }

        assert.deepEqual(config, normalizeConfig(scenario.expected));
    });
}

test('Polaris detail enrichment retains parsed Spark DESCRIBE TABLE EXTENDED properties', () => {
    const merged = mergeSparkTableDetail(
        fixture.tableMerge.polarisDetail,
        fixture.tableMerge.sparkDetail,
    );

    assert.deepEqual(merged.columns, fixture.tableMerge.expected.columns);
    assert.equal(merged.location, fixture.tableMerge.expected.location);
    for (const [key, value] of Object.entries(fixture.tableMerge.expected.properties)) {
        assert.equal(merged.properties[key], value ?? undefined);
    }
});

test('Polaris detail falls back only for explicitly unsupported Spark operations', async () => {
    const unsupported = new Error('unsupported');
    unsupported.name = 'SparkCatalogUnsupportedOperationError';
    const service = createPolarisCatalogService({
        pool: createFakePolarisPool(),
        polarisSchema: 'polaris_schema',
        sparkConnectUrl: 'sc://spark',
        sparkService: {
            getTable: async () => {
                throw unsupported;
            },
            getTableData: async () => ({ columns: [], rows: [] }),
        },
    });

    const detail = await service.getTable('catalog', 'example.silver', 'orders');

    assert.equal(detail.tableType, 'TABLE');
    assert.deepEqual(detail.columns, []);

    const connectionError = new Error('Spark Connect failed');
    const failingService = createPolarisCatalogService({
        pool: createFakePolarisPool(),
        polarisSchema: 'polaris_schema',
        sparkConnectUrl: 'sc://spark',
        sparkService: {
            getTable: async () => {
                throw connectionError;
            },
            getTableData: async () => ({ columns: [], rows: [] }),
        },
    });

    await assert.rejects(
        failingService.getTable('catalog', 'example.silver', 'orders'),
        (error) => error === connectionError,
    );
});

function normalizeConfig(expected: Partial<PostgresConfig>): PostgresConfig {
    return Object.fromEntries(
        Object.entries(expected).map(([key, value]) => [key, value ?? undefined]),
    ) as unknown as PostgresConfig;
}

function createFakePolarisPool(): Pool {
    let queryCount = 0;
    const table = {
        catalog_id: 'catalog-id',
        id: 'table-id',
        internal_properties: {},
        location_without_scheme: null,
        name: 'orders',
        parent_id: 'namespace-id',
        properties: {},
        sub_type_code: 2,
        type_code: 7,
    };
    return {
        async query() {
            queryCount += 1;
            return { rows: queryCount === 1 ? [{ id: 'catalog-id' }] : [table] };
        },
    } as unknown as Pool;
}
