/**
 * @fileoverview Web catalog selection, loading, and controller-state
 * contracts.
 */

import type {
    SparkCatalog,
    SparkSampleData,
    SparkSchema,
    SparkTable,
    SparkTableDetail,
} from '../../shared/catalogTypes.ts';
import type { CatalogTableTab } from '../utils/catalogNavigation.ts';

/** Navigation labels and keys used by the catalog detail panel. */
export const CATALOG_TABS: ReadonlyArray<{ key: CatalogTableTab; label: string }> = [
    { key: 'overview', label: 'Overview' },
    { key: 'sample-data', label: 'Sample data' },
    { key: 'details', label: 'Details' },
];

/** Loading state for catalog requests and selected-table panels. */
export type CatalogLoadState =
    | { kind: 'idle' | 'loading' | 'ready' }
    | { kind: 'error'; message: string };

/** Stable catalog/schema/table identity for the selected table. */
export interface SelectedTable {
    catalog: string;
    name: string;
    schema: string;
}

/** Complete state exposed by the catalog controller hook. */
export type CatalogControllerData = {
    catalogs: SparkCatalog[];
    expandedCatalogs: Set<string>;
    expandedSchemas: Set<string>;
    loadState: CatalogLoadState;
    query: string;
    columnQuery: string;
    sampleQuery: string;
    schemasByCatalog: Record<string, SparkSchema[]>;
    schemaStates: Record<string, CatalogLoadState>;
    selectedCatalog?: string;
    selectedTable?: SelectedTable;
    selectedDetail?: SparkTableDetail;
    selectedDetailState?: CatalogLoadState;
    selectedSample?: SparkSampleData;
    selectedSampleState?: CatalogLoadState;
    selectedSummary?: SparkTable;
    tablesBySchema: Record<string, SparkTable[]>;
    tableStates: Record<string, CatalogLoadState>;
    activeTab: CatalogTableTab;
};
