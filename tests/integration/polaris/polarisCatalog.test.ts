/**
 * @fileoverview Live Polaris catalog coverage against the managed Docker stack.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import {
    getManagedTestContext,
    requireManagedTestContext,
} from '../../support/managedTestContext.mjs';

const acceptanceEnabled = getManagedTestContext()?.controlPlaneBaseUrl != null;

test('managed Polaris catalog exposes metadata and bounded Spark samples', {
    skip: !acceptanceEnabled,
}, async () => {
    const context = requireManagedTestContext('Polaris integration tests');
    const baseUrl = context.controlPlaneBaseUrl.replace(/\/$/, '');
    const catalogName = context.catalogName;
    const namespace = context.namespace;
    const tableName = context.tableName;

    const catalogs = await fetchJson<{ catalogs: Array<{ name: string }> }>(
        `${baseUrl}/api/v1/catalogs`,
    );
    assert.ok(catalogs.catalogs.some((item) => item.name === catalogName));

    const schemas = await fetchJson<{ schemas: Array<{ name: string }> }>(
        `${baseUrl}/api/v1/catalogs/${encodeURIComponent(catalogName)}/schemas`,
    );
    assert.ok(schemas.schemas.some((item) => item.name === namespace));

    const tables = await fetchJson<{ tables: Array<{ name: string; tableType: string }> }>(
        `${baseUrl}/api/v1/catalogs/${encodeURIComponent(catalogName)}/schemas/` +
            `${encodeURIComponent(namespace)}/tables`,
    );
    const table = tables.tables.find((item) => item.name === tableName);
    assert.ok(table, `Seed table was not discovered: ${catalogName}.${namespace}.${tableName}`);
    assert.equal(table.tableType, 'TABLE');

    const detail = await fetchJson<{
        columns: Array<{ name: string }>;
        provider?: string;
        properties: Record<string, string>;
    }>(
        `${baseUrl}/api/v1/catalogs/${encodeURIComponent(catalogName)}/schemas/` +
            `${encodeURIComponent(namespace)}/tables/${encodeURIComponent(tableName)}`,
    );
    assert.equal(detail.provider, 'iceberg');
    assert.ok(detail.columns.some((column) => column.name === 'id'));

    const sample = await fetchJson<{ columns: Array<{ name: string }>; rows: unknown[][] }>(
        `${baseUrl}/api/v1/catalogs/${encodeURIComponent(catalogName)}/schemas/` +
            `${encodeURIComponent(namespace)}/tables/${encodeURIComponent(tableName)}/data?limit=10`,
    );
    assert.ok(sample.columns.some((column) => column.name === 'label'));
    assert.ok(sample.rows.length >= 3);
    assert.deepEqual(sample.rows[0], [1, 'one']);
});

async function fetchJson<T>(url: string): Promise<T> {
    const response = await fetch(url);
    const payload = await response.json() as T & { message?: string };
    assert.equal(response.status, 200, payload.message ?? `Unexpected HTTP ${response.status}.`);
    return payload;
}
