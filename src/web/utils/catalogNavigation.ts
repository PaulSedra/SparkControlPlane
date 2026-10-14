/**
 * @fileoverview URL contracts and builders for catalog table navigation.
 */

/** Detail tab addressable from a catalog URL. */
export type CatalogTableTab = 'details' | 'overview' | 'sample-data';

/** Catalog identity and selected detail tab encoded in a URL. */
export interface CatalogTableReference {
    catalog: string;
    schema: string;
    table: string;
    tab?: CatalogTableTab;
}

/** Resolves a catalog deep link without waiting for its data queries to load. */
export function catalogTableFromSearch(search: string): CatalogTableReference | undefined {
    const params = new URLSearchParams(search);
    const catalog = params.get('catalog')?.trim();
    const schema = params.get('schema')?.trim();
    const table = params.get('table')?.trim();
    if (catalog == null || schema == null || table == null ||
        catalog === '' || schema === '' || table === '') {
        return undefined;
    }

    const tab = parseCatalogTableTab(params.get('tab'));
    return tab == null
        ? { catalog, schema, table }
        : { catalog, schema, table, tab };
}

/**
 * Builds the canonical catalog deep link for a table and detail tab.
 *
 * `URLSearchParams` encodes catalog/schema/table values consistently, and an
 * omitted tab resolves to `overview` so copied links always have a stable
 * selection state.
 */
export function catalogTablePath(reference: CatalogTableReference): string {
    const params = new URLSearchParams({
        catalog: reference.catalog,
        schema: reference.schema,
        table: reference.table,
        tab: reference.tab ?? 'overview',
    });
    return `/catalog?${params.toString()}`;
}

function parseCatalogTableTab(value: string | null): CatalogTableTab | undefined {
    const normalizedValue = value?.trim();
    switch (normalizedValue) {
        case 'details':
        case 'overview':
        case 'sample-data':
            return normalizedValue;
        default:
            return undefined;
    }
}
