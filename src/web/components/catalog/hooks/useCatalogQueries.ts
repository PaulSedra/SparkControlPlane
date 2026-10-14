/**
 * @fileoverview Catalog query composition and remote-state actions.
 *
 * The root catalog list is supplied by the controller; this hook lazily observes
 * schema/table branches and selected-table detail/sample entries using the
 * selection hook's URL, expansion, and tab intent.
 */

import { useCallback, useMemo } from 'react';
import { useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import type { SparkCatalog, SparkSchema } from '../../../../shared/catalogTypes.ts';
import type { CatalogTableReference } from '../../../utils/catalogNavigation.ts';
import { namespaceKey } from '../catalogPresentation.ts';
import type { CatalogLoadState } from '../../../types/catalogTypes';
import { queryKeys } from '../../../query/queryKeys.ts';
import {
    catalogSampleDataQueryOptions,
    catalogSchemasQueryOptions,
    catalogTableDetailQueryOptions,
    catalogTablesQueryOptions,
    catalogsQueryOptions,
    shouldLoadCatalogSampleData,
    shouldLoadCatalogSchemas,
    shouldLoadCatalogTables,
} from './catalogQueries.ts';
import type { CatalogSelectionController } from './useCatalogSelection.ts';

interface CatalogRootQuery {
    data: SparkCatalog[] | undefined;
    error: unknown;
    fetchStatus: string;
    status: string;
}

type CatalogSelectionInputs = Pick<
    CatalogSelectionController,
    | 'activeTab'
    | 'expandedCatalogs'
    | 'expandedSchemas'
    | 'requestedTable'
    | 'selectedTable'
>;

/** Public query data and refresh/retry actions returned by the hook. */
export type CatalogQueries = ReturnType<typeof useCatalogQueries>;

/**
 * Observes only the catalog resources required by current user intent and maps
 * query lifecycle states to the existing catalog view-model contract.
 */
export function useCatalogQueries(
    catalogsQuery: CatalogRootQuery,
    catalogs: SparkCatalog[],
    selection: CatalogSelectionInputs,
    searchQuery: string,
) {
    const queryClient = useQueryClient();
    const normalizedQuery = searchQuery.trim().toLowerCase();
    const schemaQueries = useQueries({
        queries: catalogs.map((catalog) => ({
            ...catalogSchemasQueryOptions(catalog.name),
            enabled: shouldLoadCatalogSchemas(
                catalog.name,
                selection.expandedCatalogs,
                normalizedQuery !== '',
                selection.requestedTable,
            ),
        })),
    });
    const schemasByCatalog = useMemo(
        () => mapQueryData(catalogs, schemaQueries, (catalog) => catalog.name),
        [catalogs, schemaQueries],
    );
    const schemaStates = useMemo(
        () => mapQueryStates(catalogs, schemaQueries, (catalog) => catalog.name,
            'Unable to load Polaris schemas.'),
        [catalogs, schemaQueries],
    );

    const tableReferences = useMemo(
        () => catalogTableReferences(schemasByCatalog, selection.requestedTable),
        [schemasByCatalog, selection.requestedTable],
    );
    const tableQueries = useQueries({
        queries: tableReferences.map(({ catalog, schema }) => ({
            ...catalogTablesQueryOptions(catalog, schema),
            enabled: shouldLoadCatalogTables(
                catalog,
                schema,
                selection.expandedSchemas,
                normalizedQuery !== '',
                selection.requestedTable,
            ),
        })),
    });
    const tablesBySchema = useMemo(
        () => mapQueryData(tableReferences, tableQueries, ({ catalog, schema }) =>
            namespaceKey(catalog, schema)),
        [tableQueries, tableReferences],
    );
    const tableStates = useMemo(
        () => mapQueryStates(tableReferences, tableQueries, ({ catalog, schema }) =>
            namespaceKey(catalog, schema), 'Unable to load Polaris tables and views.'),
        [tableQueries, tableReferences],
    );

    const selectedDetailQuery = useQuery({
        ...catalogTableDetailQueryOptions(
            selection.selectedTable?.catalog ?? '',
            selection.selectedTable?.schema ?? '',
            selection.selectedTable?.name ?? '',
        ),
        enabled: selection.selectedTable != null,
    });
    const selectedSampleQuery = useQuery({
        ...catalogSampleDataQueryOptions(
            selection.selectedTable?.catalog ?? '',
            selection.selectedTable?.schema ?? '',
            selection.selectedTable?.name ?? '',
        ),
        enabled: shouldLoadCatalogSampleData(
            selection.activeTab,
            selection.selectedTable,
        ),
    });

    const selectedTableDetail = selectedDetailQuery.data;
    const selectedTableDetailState = selection.selectedTable == null
        ? undefined
        : catalogLoadState(selectedDetailQuery, 'Unable to load catalog asset metadata.');
    const selectedSampleData = selectedSampleQuery.data;
    const selectedSampleDataState = selection.selectedTable == null ||
        selection.activeTab !== 'sample-data'
        ? undefined
        : catalogLoadState(
            selectedSampleQuery,
            'Unable to load Spark sample data for the catalog asset.',
        );
    const selectedTableSummary = selection.selectedTable == null
        ? undefined
        : tablesBySchema[namespaceKey(
            selection.selectedTable.catalog,
            selection.selectedTable.schema,
        )]?.find((table) => table.name === selection.selectedTable?.name);

    const loadState = catalogLoadState(catalogsQuery, 'Unable to load Polaris catalogs.');
    const loadCatalogs = useCallback(async (force = false): Promise<void> => {
        if (force) {
            await queryClient.invalidateQueries({ queryKey: queryKeys.catalogs.all });
            return;
        }
        await queryClient.query({ ...catalogsQueryOptions(), staleTime: 'static' });
    }, [queryClient]);

    function refreshCatalog(): void {
        void Promise.all([
            queryClient.resetQueries({ queryKey: queryKeys.catalogs.all }),
            queryClient.resetQueries({ queryKey: ['catalog'] }),
        ]);
    }

    function retryDetail(): void {
        if (selection.selectedTable != null) {
            void selectedDetailQuery.refetch();
        }
    }

    function retrySample(): void {
        if (selection.selectedTable != null && selection.activeTab === 'sample-data') {
            void selectedSampleQuery.refetch();
        }
    }

    return {
        catalogs,
        loadCatalogs,
        loadState,
        refreshCatalog,
        retryDetail,
        retrySample,
        schemaStates,
        schemasByCatalog,
        selectedSampleData,
        selectedSampleDataState,
        selectedTableDetail,
        selectedTableDetailState,
        selectedTableSummary,
        tableStates,
        tablesBySchema,
    };
}

function catalogLoadState(
    catalogQueryResult: {
        data: unknown;
        error: unknown;
        fetchStatus: string;
        status: string;
    },
    fallbackMessage: string,
): CatalogLoadState {
    if (catalogQueryResult.status === 'error') {
        return {
            kind: 'error',
            message: catalogQueryResult.error instanceof Error
                ? catalogQueryResult.error.message
                : fallbackMessage,
        };
    }
    if (catalogQueryResult.data !== undefined) {
        return { kind: 'ready' };
    }
    return catalogQueryResult.fetchStatus === 'idle' ? { kind: 'idle' } : { kind: 'loading' };
}

function mapQueryData<TItem, TData>(
    items: readonly TItem[],
    results: readonly { data: TData | undefined }[],
    keyFor: (item: TItem) => string,
): Record<string, TData> {
    const data: Record<string, TData> = {};
    items.forEach((item, index) => {
        const result = results[index];
        if (result?.data !== undefined) {
            data[keyFor(item)] = result.data;
        }
    });
    return data;
}

function mapQueryStates<TItem>(
    items: readonly TItem[],
    results: readonly {
        data: unknown;
        error: unknown;
        fetchStatus: string;
        status: string;
    }[],
    keyFor: (item: TItem) => string,
    fallbackMessage: string,
): Record<string, CatalogLoadState> {
    const states: Record<string, CatalogLoadState> = {};
    items.forEach((item, index) => {
        const result = results[index];
        if (result != null) {
            states[keyFor(item)] = catalogLoadState(result, fallbackMessage);
        }
    });
    return states;
}

function catalogTableReferences(
    schemasByCatalog: Record<string, SparkSchema[]>,
    requestedTable?: CatalogTableReference,
): Array<{ catalog: string; schema: string }> {
    const references = new Map<string, { catalog: string; schema: string }>();
    Object.values(schemasByCatalog).flat().forEach((schema) => {
        const reference = { catalog: schema.catalog, schema: schema.name };
        references.set(namespaceKey(reference.catalog, reference.schema), reference);
    });
    if (requestedTable != null && schemasByCatalog[requestedTable.catalog] != null) {
        const reference = { catalog: requestedTable.catalog, schema: requestedTable.schema };
        references.set(namespaceKey(reference.catalog, reference.schema), reference);
    }
    return [...references.values()];
}
