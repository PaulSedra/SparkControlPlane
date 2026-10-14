/**
 * @fileoverview Query identities, request options, and lazy-load policy for
 * catalog resources.
 *
 * Queries consume TanStack's abort signal and keep catalogs, schemas, tables,
 * metadata, and sample rows independently addressable. Branch queries remain
 * disabled until expansion, search, explicit schema selection, or a valid
 * deep-link requires them; sample rows are enabled only on their tab.
 */

import { queryOptions } from '@tanstack/react-query';
import {
    getSparkCatalogs,
    getSparkSchemas,
    getSparkTableData,
    getSparkTableDetail,
    getSparkTables,
} from '../../../api/catalogClient.ts';
import type { CatalogTableReference, CatalogTableTab } from '../../../utils/catalogNavigation.ts';
import type { SelectedTable } from '../../../types/catalogTypes';
import { queryKeys } from '../../../query/queryKeys.ts';

/** Creates an abortable query for the catalog roots. */
export function catalogsQueryOptions() {
    return queryOptions({
        queryKey: queryKeys.catalogs.all,
        queryFn: ({ signal }) => getSparkCatalogs(signal),
    });
}

/** Creates an abortable query for schemas in one catalog. */
export function catalogSchemasQueryOptions(catalogId: string) {
    return queryOptions({
        queryKey: queryKeys.catalogs.schemas(catalogId),
        queryFn: ({ signal }) => getSparkSchemas(catalogId, signal),
    });
}

/** Creates an abortable query for tables/views in one catalog schema. */
export function catalogTablesQueryOptions(catalogId: string, schemaId: string) {
    return queryOptions({
        queryKey: queryKeys.catalogs.tables(catalogId, schemaId),
        queryFn: ({ signal }) => getSparkTables(catalogId, schemaId, signal),
    });
}

/** Creates an abortable metadata query for one selected catalog asset. */
export function catalogTableDetailQueryOptions(
    catalogId: string,
    schemaId: string,
    tableName: string,
) {
    return queryOptions({
        queryKey: queryKeys.catalogs.tableDetail(catalogId, schemaId, tableName),
        queryFn: ({ signal }) => getSparkTableDetail(catalogId, schemaId, tableName, signal),
    });
}

/** Creates an abortable, independently retryable sample query for one asset. */
export function catalogSampleDataQueryOptions(
    catalogId: string,
    schemaId: string,
    tableName: string,
) {
    return queryOptions({
        queryKey: queryKeys.catalogs.sampleData(catalogId, schemaId, tableName),
        queryFn: ({ signal }) => getSparkTableData(catalogId, schemaId, tableName, signal),
    });
}

/** Decides whether one catalog's schema query is needed by current UI intent. */
export function shouldLoadCatalogSchemas(
    catalogId: string,
    expandedCatalogs: ReadonlySet<string>,
    hasSearch: boolean,
    requestedTable?: CatalogTableReference,
): boolean {
    return hasSearch || expandedCatalogs.has(catalogId) || requestedTable?.catalog === catalogId;
}

/** Decides whether one schema's table query is needed by current UI intent. */
export function shouldLoadCatalogTables(
    catalogId: string,
    schemaId: string,
    expandedSchemas: ReadonlySet<string>,
    hasSearch: boolean,
    requestedTable?: CatalogTableReference,
): boolean {
    const namespace = `${catalogId}\u0000${schemaId}`;
    return hasSearch || expandedSchemas.has(namespace) ||
        (requestedTable?.catalog === catalogId && requestedTable.schema === schemaId);
}

/** Keeps sample requests dormant until an asset and sample-data tab are selected. */
export function shouldLoadCatalogSampleData(
    activeTab: CatalogTableTab,
    selectedTable?: SelectedTable,
): boolean {
    return activeTab === 'sample-data' && selectedTable != null;
}
