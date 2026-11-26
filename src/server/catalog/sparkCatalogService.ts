/** @fileoverview Runs bounded catalog queries through Spark Standalone. */

import type {
    SparkCatalog,
    SparkSampleData,
    SparkSchema,
    SparkTable,
    SparkTableDetail,
} from '../../shared/catalogTypes.ts';
import type { SparkQueryService, SparkQueryRequest } from '../types/sparkQueryServiceTypes.ts';
import type { CatalogService } from '../types/catalogServiceTypes.ts';

const DEFAULT_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const MAX_CONFIGURED_OUTPUT_BYTES = 64 * 1024 * 1024;

/**
 * Creates a catalog adapter that submits bounded read-only Spark applications.
 * Queries fail if no query service is supplied.
 */
export function createSparkCatalogService(
    queryService?: SparkQueryService,
): CatalogService {
    const maximumResponseBytes = configuredMaximumResponseBytes();

    return {
        getTable: async (catalog, schema, table) => requireTableDetail(
            await runQuery(queryService, {
                catalog,
                command: 'detail',
                maximumResponseBytes,
                schema,
                table,
            }),
        ),
        getTableData: async (catalog, schema, table, limit) => requireSampleData(
            await runQuery(queryService, {
                catalog,
                command: 'sample',
                limit,
                maximumResponseBytes,
                schema,
                table,
            }),
        ),
        listCatalogs: async () => requireList<SparkCatalog>(
            await runQuery(queryService, { command: 'catalogs', maximumResponseBytes }),
            'catalogs',
        ),
        listSchemas: async (catalog) => requireList<SparkSchema>(
            await runQuery(queryService, { catalog, command: 'schemas', maximumResponseBytes }),
            'schemas',
        ),
        listTables: async (catalog, schema) => requireList<SparkTable>(
            await runQuery(queryService, { catalog, command: 'tables', maximumResponseBytes, schema }),
            'tables',
        ),
    };
}

async function runQuery(
    queryService: SparkQueryService | undefined,
    request: SparkQueryRequest,
): Promise<unknown> {
    if (queryService == null) {
        throw new Error('Spark Standalone is not configured for catalog queries.');
    }
    return queryService.query(request);
}

function configuredMaximumResponseBytes(): number {
    const rawValue = process.env.SPARK_CATALOG_MAX_RESPONSE_BYTES?.trim();
    if (!rawValue) {
        return DEFAULT_MAX_OUTPUT_BYTES;
    }
    const configuredValue = Number(rawValue);
    if (!/^\d+$/.test(rawValue) || !Number.isSafeInteger(configuredValue) ||
        configuredValue < 1 || configuredValue > MAX_CONFIGURED_OUTPUT_BYTES) {
        throw new Error(
            'SPARK_CATALOG_MAX_RESPONSE_BYTES must be an integer from 1 to ' +
                String(MAX_CONFIGURED_OUTPUT_BYTES) + '.',
        );
    }
    return configuredValue;
}

function requireList<T>(value: unknown, key: string): T[] {
    if (!isRecord(value) || !Array.isArray(value[key])) {
        throw new Error('Spark returned an invalid catalog response.');
    }
    return value[key] as T[];
}

function requireTableDetail(value: unknown): SparkTableDetail {
    if (!isRecord(value) || !Array.isArray(value.columns) || !isRecord(value.properties)) {
        throw new Error('Spark returned an invalid table detail response.');
    }
    return value as unknown as SparkTableDetail;
}

function requireSampleData(value: unknown): SparkSampleData {
    if (!isRecord(value) || !Array.isArray(value.columns) || !Array.isArray(value.rows)) {
        throw new Error('Spark returned an invalid table sample response.');
    }
    return value as unknown as SparkSampleData;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value != null && !Array.isArray(value);
}
