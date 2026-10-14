/**
 * @fileoverview Catalog adapter that combines Polaris metadata with optional
 * Spark Connect enrichment.
 */

import type { Pool, PoolConfig, QueryResultRow } from 'pg';
import { Pool as PgPool } from 'pg';
import { ControlPlaneApiError } from '../errors/controlPlaneApiError.ts';
import { createSparkCatalogService } from './sparkCatalogService.ts';
import { POLARIS_SCHEMA, loadPolarisPostgresConfig } from './polarisCatalogConfig.ts';
import {
    mergeSparkTableDetail,
    withoutAggregateTableProperties,
} from './polarisTableDetail.ts';
import type { PostgresConfig } from '../types/postgresConfigTypes.ts';
import type {
    SparkCatalog,
    SparkSchema,
    SparkTable,
    SparkTableDetail,
} from '../../shared/catalogTypes.ts';
import type { CatalogService } from '../types/catalogServiceTypes.ts';

const POLARIS_REALM = 'POLARIS';
const POLARIS_CATALOG_TYPE = 4;
const POLARIS_NAMESPACE_TYPE = 6;
const POLARIS_TABLE_LIKE_TYPE = 7;
const POLARIS_ICEBERG_TABLE_SUBTYPE = 2;
const POLARIS_ICEBERG_VIEW_SUBTYPE = 3;
const POLARIS_GENERIC_TABLE_SUBTYPE = 4;

interface PolarisEntityRow extends QueryResultRow {
    catalog_id: string;
    id: string;
    internal_properties: unknown;
    location_without_scheme: string | null;
    name: string;
    parent_id: string;
    properties: unknown;
    sub_type_code: number;
    type_code: number;
}

interface PolarisNamespaceRow extends QueryResultRow {
    id: string;
    namespace_path: string;
}

/** Construction options for the Polaris-backed catalog service. */
export interface PolarisCatalogServiceOptions {
    pool?: Pool;
    polarisSchema?: string;
    postgresConfig?: PostgresConfig;
    realm?: string;
    sparkConnectUrl?: string;
    sparkService?: Pick<CatalogService, 'getTable' | 'getTableData'>;
}

/**
 * Creates a catalog service whose namespace and table identity come from
 * Polaris PostgreSQL metadata.
 *
 * Table details use Spark Connect only as optional enrichment; if enrichment
 * is not configured or the operation is unsupported, authoritative Polaris
 * detail is returned. Permission, connection, and unexpected Spark failures
 * surface to the caller. Sample rows always use the Spark adapter, and the
 * factory closes only a pool it created itself. A caller without Polaris
 * configuration can construct the adapter, but catalog operations fail with
 * a configuration error.
 */
export function createPolarisCatalogService(
    options: PolarisCatalogServiceOptions = {},
): CatalogService {
    const postgresConfig = loadPolarisPostgresConfig(
        process.env,
        options.postgresConfig,
        options.polarisSchema,
    );
    const pool = options.pool ?? (
        postgresConfig == null ? undefined : new PgPool(poolConfig(postgresConfig))
    );
    const ownsPool = options.pool == null && pool != null;
    const realm = options.realm?.trim() || process.env.POLARIS_REALM?.trim() || POLARIS_REALM;
    const schema = quoteIdentifier(postgresConfig?.schema || options.polarisSchema || POLARIS_SCHEMA);
    const sparkConnectUrl = options.sparkConnectUrl?.trim();
    const sparkService = options.sparkService ?? createSparkCatalogService({ sparkConnectUrl });

    return {
        getTable: async (catalog, namespace, table) => {
            const detail = await getPolarisTable(
                requirePool(pool),
                schema,
                realm,
                catalog,
                namespace,
                table,
            );
            if (!sparkConnectUrl) {
                return detail;
            }
            try {
                const sparkDetail = await sparkService.getTable(catalog, namespace, table);
                return mergeSparkTableDetail(detail, sparkDetail);
            } catch (error) {
                if (isUnsupportedSparkCatalogOperation(error)) {
                    process.stderr.write(
                        '[spark-catalog] Spark detail operation is unsupported; ' +
                            'returning Polaris metadata only.\n',
                    );
                    return detail;
                }
                throw error;
            }
        },
        getTableData: (catalog, namespace, table, limit) =>
            sparkService.getTableData(catalog, namespace, table, limit),
        listCatalogs: async () => {
            const result = await requirePool(pool).query<PolarisEntityRow>(
                `
                    SELECT id::text AS id, name
                    FROM ${schema}.entities
                    WHERE realm_id = $1
                      AND type_code = ${POLARIS_CATALOG_TYPE}
                      AND drop_timestamp = 0
                      AND purge_timestamp = 0
                    ORDER BY name
                `,
                [realm],
            );
            return result.rows.map((row): SparkCatalog => ({
                id: row.id,
                name: row.name,
            }));
        },
        listSchemas: async (catalog) => {
            const poolInstance = requirePool(pool);
            const catalogId = await getCatalogId(poolInstance, schema, realm, catalog);
            const result = await poolInstance.query<PolarisNamespaceRow>(
                `${namespaceTreeSql(schema)}
                 SELECT id::text AS id, namespace_path
                 FROM namespace_tree
                 ORDER BY namespace_path`,
                [realm, catalogId],
            );
            return result.rows.map((row): SparkSchema => ({
                catalog,
                id: row.id,
                name: row.namespace_path,
            }));
        },
        listTables: async (catalog, namespace) => {
            const poolInstance = requirePool(pool);
            const catalogId = await getCatalogId(poolInstance, schema, realm, catalog);
            const result = await poolInstance.query<PolarisEntityRow>(
                `${namespaceTreeSql(schema)}
                 SELECT e.catalog_id::text AS catalog_id,
                        e.id::text AS id,
                        e.internal_properties,
                        e.location_without_scheme,
                        e.name,
                        e.parent_id::text AS parent_id,
                        e.properties,
                        e.sub_type_code,
                        e.type_code
                 FROM namespace_tree n
                 JOIN ${schema}.entities e ON e.parent_id = n.id
                 WHERE n.namespace_path = $3
                   AND e.catalog_id = $2
                   AND e.type_code = ${POLARIS_TABLE_LIKE_TYPE}
                   AND e.drop_timestamp = 0
                   AND e.purge_timestamp = 0
                 ORDER BY e.name`,
                [realm, catalogId, namespace],
            );
            return result.rows.map((row): SparkTable =>
                tableSummary(catalog, namespace, row));
        },
        async shutdown() {
            if (ownsPool) {
                await pool.end();
            }
        },
    };
}

async function getPolarisTable(
    pool: Pool,
    schema: string,
    realm: string,
    catalog: string,
    namespace: string,
    table: string,
): Promise<SparkTableDetail> {
    const catalogId = await getCatalogId(pool, schema, realm, catalog);
    const result = await pool.query<PolarisEntityRow>(
        `${namespaceTreeSql(schema)}
         SELECT e.catalog_id::text AS catalog_id,
                e.id::text AS id,
                e.internal_properties,
                e.location_without_scheme,
                e.name,
                e.parent_id::text AS parent_id,
                e.properties,
                e.sub_type_code,
                e.type_code
         FROM namespace_tree n
         JOIN ${schema}.entities e ON e.parent_id = n.id
         WHERE n.namespace_path = $3
           AND e.catalog_id = $2
           AND e.name = $4
           AND e.type_code = ${POLARIS_TABLE_LIKE_TYPE}
           AND e.drop_timestamp = 0
           AND e.purge_timestamp = 0
         LIMIT 1`,
        [realm, catalogId, namespace, table],
    );
    const row = result.rows[0];
    if (row == null) {
        throw new ControlPlaneApiError(
            404,
            `Catalog asset ${catalog}.${namespace}.${table} was not found.`,
        );
    }
    return tableDetail(catalog, namespace, row);
}

async function getCatalogId(
    pool: Pool,
    schema: string,
    realm: string,
    catalog: string,
): Promise<string> {
    const result = await pool.query<{ id: string }>(
        `
            SELECT id::text AS id
            FROM ${schema}.entities
            WHERE realm_id = $1
              AND name = $2
              AND type_code = ${POLARIS_CATALOG_TYPE}
              AND drop_timestamp = 0
              AND purge_timestamp = 0
            LIMIT 1
        `,
        [realm, catalog],
    );
    const id = result.rows[0]?.id;
    if (id == null) {
        throw new ControlPlaneApiError(404, `Polaris catalog "${catalog}" was not found.`);
    }
    return id;
}

function namespaceTreeSql(schema: string): string {
    return `
        WITH RECURSIVE namespace_tree AS (
            SELECT e.id, e.parent_id, e.catalog_id, e.name,
                   e.name::text AS namespace_path
            FROM ${schema}.entities e
            WHERE e.realm_id = $1
              AND e.catalog_id = $2
              AND e.parent_id = $2
              AND e.type_code = ${POLARIS_NAMESPACE_TYPE}
              AND e.drop_timestamp = 0
              AND e.purge_timestamp = 0
            UNION ALL
            SELECT child.id, child.parent_id, child.catalog_id, child.name,
                   namespace_tree.namespace_path || '.' || child.name
            FROM ${schema}.entities child
            JOIN namespace_tree ON child.parent_id = namespace_tree.id
            WHERE child.realm_id = $1
              AND child.catalog_id = $2
              AND child.type_code = ${POLARIS_NAMESPACE_TYPE}
              AND child.drop_timestamp = 0
              AND child.purge_timestamp = 0
        )`;
}

function tableSummary(
    catalog: string,
    namespace: string,
    row: PolarisEntityRow,
): SparkTable {
    return {
        catalog,
        id: row.id,
        isTemporary: false,
        name: row.name,
        schema: namespace,
        tableType: tableType(row.sub_type_code),
    };
}

function tableDetail(
    catalog: string,
    namespace: string,
    row: PolarisEntityRow,
): SparkTableDetail {
    const properties = mergedProperties(row);
    const comment = propertyValue(row.properties, 'comment', 'description');
    return {
        ...tableSummary(catalog, namespace, row),
        columns: [],
        comment,
        location: propertyValue(row.properties, 'location') ||
            row.location_without_scheme ||
            undefined,
        properties,
        provider: 'iceberg',
        viewDefinition: propertyValue(
            row.properties,
            'view-definition',
            'viewDefinition',
            'definition',
        ),
    };
}

function mergedProperties(row: PolarisEntityRow): Record<string, string> {
    return withoutAggregateTableProperties({
        ...safePropertyMap(row.properties),
        ...Object.fromEntries(
            Object.entries(safePropertyMap(row.internal_properties)).map(([key, value]) =>
                [key, value]),
        ),
    });
}

function safePropertyMap(value: unknown): Record<string, string> {
    const object = jsonObject(value);
    const entries: Array<[string, string]> = [];
    for (const [key, rawValue] of Object.entries(object)) {
        if (isSensitiveProperty(key)) {
            continue;
        }
        if (typeof rawValue === 'string' || typeof rawValue === 'number' ||
            typeof rawValue === 'boolean') {
            entries.push([key, String(rawValue)]);
        } else {
            entries.push([key, JSON.stringify(rawValue)]);
        }
    }
    return Object.fromEntries(entries);
}

function propertyValue(value: unknown, ...keys: string[]): string | undefined {
    const object = jsonObject(value);
    for (const key of keys) {
        const rawValue = object[key];
        if (typeof rawValue === 'string' && rawValue.trim() !== '') {
            return rawValue;
        }
    }
    return undefined;
}

function jsonObject(value: unknown): Record<string, unknown> {
    return value != null && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : {};
}

function isSensitiveProperty(key: string): boolean {
    return /(password|secret|token|credential|access[._-]?key|private[._-]?key)/i.test(key);
}

function tableType(subTypeCode: number): SparkTable['tableType'] {
    if (subTypeCode === POLARIS_ICEBERG_VIEW_SUBTYPE) {
        return 'VIEW';
    }
    if (subTypeCode === POLARIS_ICEBERG_TABLE_SUBTYPE ||
        subTypeCode === POLARIS_GENERIC_TABLE_SUBTYPE) {
        return 'TABLE';
    }
    return 'UNKNOWN';
}

function requirePool(pool: Pool | undefined): Pool {
    if (pool == null) {
        throw new ControlPlaneApiError(
            503,
            'Polaris PostgreSQL catalog access is not configured. Set POLARIS_POSTGRES_* connection values or provide the control-plane PostgreSQL connection.',
        );
    }
    return pool;
}

function isUnsupportedSparkCatalogOperation(error: unknown): boolean {
    return error instanceof Error &&
        error.name === 'SparkCatalogUnsupportedOperationError';
}

function poolConfig(config: PostgresConfig): PoolConfig {
    const ssl = config.tlsMode === 'disable'
        ? false
        : {
            ca: config.ca,
            cert: config.cert,
            key: config.key,
            rejectUnauthorized: config.tlsMode !== 'require',
        };
    return {
        database: config.database,
        host: config.host,
        max: 10,
        password: config.password,
        port: config.port,
        ssl,
        user: config.user,
    };
}

function quoteIdentifier(value: string): string {
    const trimmed = value.trim();
    if (!/^[a-z_][a-z0-9_]*$/.test(trimmed)) {
        throw new Error(
            'POLARIS_POSTGRES_SCHEMA must contain only lowercase letters, digits, and underscores.',
        );
    }
    return `"${trimmed.replaceAll('"', '""')}"`;
}
