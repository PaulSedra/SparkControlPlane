/**
 * @fileoverview Browser client for catalog listing, detail, and bounded data
 * endpoints.
 */

import type {
    SparkCatalog,
    SparkSampleData,
    SparkSchema,
    SparkTable,
    SparkTableDetail,
} from '../../shared/catalogTypes.ts';

/**
 * Loads the catalog roots without using a browser cache.
 *
 * The signal is propagated so route changes can cancel stale discovery, and a
 * malformed/missing `catalogs` array is treated as an empty result rather
 * than leaking an invalid shape into the tree. Non-2xx responses become
 * user-readable errors from the API body when one is available.
 */
export async function getSparkCatalogs(
    signal?: AbortSignal,
): Promise<SparkCatalog[]> {
    const response = await fetch('/api/v1/catalogs', { cache: 'no-store', signal });
    if (!response.ok) {
        throw new Error(await errorMessage(response, 'Unable to load Polaris catalogs.'));
    }
    const body = await response.json() as { catalogs?: SparkCatalog[] };
    return Array.isArray(body.catalogs) ? body.catalogs : [];
}

/**
 * Loads one catalog's schemas on demand. The catalog name is encoded as a
 * path segment, and aborts are intentionally caller-controlled for lazy tree
 * expansion and route changes.
 */
export async function getSparkSchemas(
    catalog: string,
    signal?: AbortSignal,
): Promise<SparkSchema[]> {
    const response = await fetch(
        `/api/v1/catalogs/${encodeURIComponent(catalog)}/schemas`,
        { cache: 'no-store', signal },
    );
    if (!response.ok) {
        throw new Error(await errorMessage(response, 'Unable to load Polaris schemas.'));
    }
    const body = await response.json() as { schemas?: SparkSchema[] };
    return Array.isArray(body.schemas) ? body.schemas : [];
}

/**
 * Loads tables/views for one schema on demand, preserving the server's bounded
 * response contract and returning an empty list for a missing array payload.
 */
export async function getSparkTables(
    catalog: string,
    schema: string,
    signal?: AbortSignal,
): Promise<SparkTable[]> {
    const response = await fetch(
        `/api/v1/catalogs/${encodeURIComponent(catalog)}` +
            `/schemas/${encodeURIComponent(schema)}/tables`,
        { cache: 'no-store', signal },
    );
    if (!response.ok) {
        throw new Error(await errorMessage(response, 'Unable to load Polaris tables and views.'));
    }
    const body = await response.json() as { tables?: SparkTable[] };
    return Array.isArray(body.tables) ? body.tables : [];
}

/**
 * Loads the selected asset's metadata. This request is abortable because the
 * user can change selection before detail returns; callers can then keep the
 * previous detail visible until the new response wins.
 */
export async function getSparkTableDetail(
    catalog: string,
    schema: string,
    table: string,
    signal?: AbortSignal,
): Promise<SparkTableDetail> {
    const response = await fetch(
        `/api/v1/catalogs/${encodeURIComponent(catalog)}` +
            `/schemas/${encodeURIComponent(schema)}` +
            `/tables/${encodeURIComponent(table)}`,
        { cache: 'no-store', signal },
    );
    if (!response.ok) {
        throw new Error(await errorMessage(response, 'Unable to load catalog asset metadata.'));
    }
    return response.json() as Promise<SparkTableDetail>;
}

/**
 * Loads the server-bounded sample for the selected asset. Sampling is a
 * separate request from metadata, so a Spark query failure can be retried or
 * reported without invalidating catalog identity and schema detail.
 */
export async function getSparkTableData(
    catalog: string,
    schema: string,
    table: string,
    signal?: AbortSignal,
): Promise<SparkSampleData> {
    const response = await fetch(
        `/api/v1/catalogs/${encodeURIComponent(catalog)}` +
            `/schemas/${encodeURIComponent(schema)}` +
            `/tables/${encodeURIComponent(table)}/data`,
        { cache: 'no-store', signal },
    );
    if (!response.ok) {
        throw new Error(await errorMessage(response, 'Unable to load Spark sample data.'));
    }
    return response.json() as Promise<SparkSampleData>;
}

async function errorMessage(response: Response, fallback: string): Promise<string> {
    try {
        const body = await response.json() as { message?: string };
        return body.message ?? fallback;
    } catch {
        return fallback;
    }
}
