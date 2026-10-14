/**
 * @fileoverview URL-authoritative catalog selection and local tree interaction.
 *
 * Table and tab identity comes from the route. Expansion and catalog-tree
 * search remain local, while click commands update history and explicitly
 * populate the corresponding branch query even when a click collapses it.
 */

import { useEffect, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { SparkCatalog } from '../../../../shared/catalogTypes.ts';
import { navigateTo } from '../../../routes/useCurrentRoute';
import {
    catalogTableFromSearch,
    catalogTablePath,
} from '../../../utils/catalogNavigation.ts';
import type {
    CatalogTableReference,
    CatalogTableTab,
} from '../../../utils/catalogNavigation.ts';
import type { SelectedTable } from '../../../types/catalogTypes';
import { namespaceKey } from '../catalogPresentation.ts';
import {
    catalogSchemasQueryOptions,
    catalogTablesQueryOptions,
} from './catalogQueries.ts';

/** Public selection state and route/tree commands returned by the hook. */
export type CatalogSelectionController = ReturnType<typeof useCatalogSelection>;

/**
 * Resolves table/tab identity from the current URL and coordinates the
 * surrounding tree interaction state. Deep links expand their known catalog
 * and schema as soon as the catalog list confirms that catalog exists.
 */
export function useCatalogSelection(
    search: string,
    catalogs: SparkCatalog[],
    isCatalogListLoaded: boolean,
) {
    const queryClient = useQueryClient();
    const requestedTable = useMemo(
        () => catalogTableFromSearch(search),
        [search],
    );
    const activeTab = requestedTable?.tab ?? 'overview';
    const selectedTable: SelectedTable | undefined = requestedTable == null
        ? undefined
        : {
            catalog: requestedTable.catalog,
            name: requestedTable.table,
            schema: requestedTable.schema,
        };
    const [expandedCatalogs, setExpandedCatalogs] = useState<Set<string>>(() => new Set());
    const [expandedSchemas, setExpandedSchemas] = useState<Set<string>>(() => new Set());
    const [selectedCatalog, setSelectedCatalog] = useState<string>();

    useEffect(() => {
        if (!isCatalogListLoaded) {
            return;
        }
        setSelectedCatalog((current) =>
            current != null && catalogs.some((catalog) => catalog.name === current)
                ? current
                : catalogs[0]?.name,
        );
    }, [catalogs, isCatalogListLoaded]);

    useEffect(() => {
        if (requestedTable == null ||
            !catalogs.some((catalog) => catalog.name === requestedTable.catalog)) {
            return;
        }

        setSelectedCatalog(requestedTable.catalog);
        setExpandedCatalogs((current) => new Set(current).add(requestedTable.catalog));
        setExpandedSchemas((current) => new Set(current).add(
            namespaceKey(requestedTable.catalog, requestedTable.schema),
        ));
    }, [catalogs, requestedTable]);

    function selectCatalog(catalog: string): void {
        setSelectedCatalog(catalog);
        navigateTo('/catalog');
    }

    function toggleCatalog(catalog: string): void {
        setExpandedCatalogs((current) => toggleSet(current, catalog));
        void queryClient.query(catalogSchemasQueryOptions(catalog)).catch(() => undefined);
    }

    function selectSchema(catalog: string, schema: string): void {
        setSelectedCatalog(catalog);
        navigateTo('/catalog');
        void queryClient.query(catalogTablesQueryOptions(catalog, schema))
            .catch(() => undefined);
    }

    function toggleSchema(catalog: string, schema: string): void {
        setExpandedSchemas((current) => toggleSet(
            current,
            namespaceKey(catalog, schema),
        ));
        void queryClient.query(catalogTablesQueryOptions(catalog, schema))
            .catch(() => undefined);
    }

    function selectTable(catalog: string, schema: string, table: string): void {
        setSelectedCatalog(catalog);
        setExpandedCatalogs((current) => new Set(current).add(catalog));
        setExpandedSchemas((current) => new Set(current).add(namespaceKey(catalog, schema)));
        navigateTo(catalogTablePath({ catalog, schema, table, tab: 'overview' }));
    }

    function selectTab(tab: CatalogTableTab): void {
        if (selectedTable == null) {
            return;
        }
        navigateTo(catalogTablePath({
            catalog: selectedTable.catalog,
            schema: selectedTable.schema,
            table: selectedTable.name,
            tab,
        }));
    }

    return {
        activeTab,
        expandedCatalogs,
        expandedSchemas,
        requestedTable: requestedTable as CatalogTableReference | undefined,
        selectedCatalog,
        selectedTable,
        selectCatalog,
        selectSchema,
        selectTable,
        selectTab,
        toggleCatalog,
        toggleSchema,
    };
}

function toggleSet(current: Set<string>, value: string): Set<string> {
    const next = new Set(current);
    if (next.has(value)) {
        next.delete(value);
    } else {
        next.add(value);
    }
    return next;
}
