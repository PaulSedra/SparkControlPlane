/**
 * @fileoverview Catalog page composition for query-backed remote data,
 * URL-authoritative selection, and local display filters.
 */

import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { SparkCatalog } from '../../../../shared/catalogTypes.ts';
import { catalogsQueryOptions } from './catalogQueries.ts';
import { useCatalogQueries } from './useCatalogQueries.ts';
import { useCatalogSelection } from './useCatalogSelection.ts';

const EMPTY_CATALOGS: SparkCatalog[] = [];

/** Public state and actions returned by the catalog controller hook. */
export type CatalogController = ReturnType<typeof useCatalogController>;

/**
 * Composes catalog remote queries with route selection and transient display
 * filters. URL table/tab values remain the selection authority, while tree
 * expansion and text filters stay local to this page instance.
 */
export function useCatalogController(search: string) {
    const catalogsQuery = useQuery(catalogsQueryOptions());
    const catalogs = catalogsQuery.data ?? EMPTY_CATALOGS;
    const selection = useCatalogSelection(search, catalogs, catalogsQuery.isSuccess);
    const [catalogSearchQuery, setCatalogSearchQuery] = useState('');
    const [columnQuery, setColumnQuery] = useState('');
    const [sampleQuery, setSampleQuery] = useState('');
    const catalogQueries = useCatalogQueries(
        catalogsQuery,
        catalogs,
        selection,
        catalogSearchQuery,
    );

    useEffect(() => {
        setSampleQuery('');
        setColumnQuery('');
    }, [
        selection.selectedTable?.catalog,
        selection.selectedTable?.name,
        selection.selectedTable?.schema,
    ]);

    return {
        activeTab: selection.activeTab,
        ...catalogQueries,
        columnQuery,
        catalogSearchQuery,
        expandedCatalogs: selection.expandedCatalogs,
        expandedSchemas: selection.expandedSchemas,
        sampleQuery,
        selectedCatalog: selection.selectedCatalog,
        selectedTable: selection.selectedTable,
        selectCatalog: selection.selectCatalog,
        selectSchema: selection.selectSchema,
        selectTable: selection.selectTable,
        selectTab: selection.selectTab,
        setColumnQuery,
        setCatalogSearchQuery,
        setSampleQuery,
        toggleCatalog: selection.toggleCatalog,
        toggleSchema: selection.toggleSchema,
    };
}
