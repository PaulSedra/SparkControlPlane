/**
 * @fileoverview Catalog query identity, lazy enablement, cancellation, and
 * retry behavior.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { QueryObserver } from '@tanstack/react-query';
import { createAppQueryClient } from '../../../../src/web/query/queryClient.ts';
import {
    catalogSampleDataQueryOptions,
    catalogSchemasQueryOptions,
    catalogTableDetailQueryOptions,
    catalogTablesQueryOptions,
    shouldLoadCatalogSchemas,
    shouldLoadCatalogSampleData,
    shouldLoadCatalogTables,
} from '../../../../src/web/components/catalog/hooks/catalogQueries.ts';
import { queryKeys } from '../../../../src/web/query/queryKeys.ts';
import { withMockFetch } from '../../../support/webFixtures.ts';

test('catalog lazy-load policy covers expansion, search, deep links, and sample tab', () => {
    const expandedCatalogs = new Set(['main']);
    const expandedSchemas = new Set(['main\u0000sales']);
    const deepLink = { catalog: 'archive', schema: 'raw', table: 'events' };
    const selectedTable = { catalog: 'main', schema: 'sales', name: 'orders' };

    assert.equal(shouldLoadCatalogSchemas('main', expandedCatalogs, false), true);
    assert.equal(shouldLoadCatalogSchemas('archive', expandedCatalogs, false), false);
    assert.equal(shouldLoadCatalogSchemas('archive', expandedCatalogs, false, deepLink), true);
    assert.equal(shouldLoadCatalogSchemas('archive', expandedCatalogs, true), true);
    assert.equal(
        shouldLoadCatalogTables('main', 'sales', expandedSchemas, false),
        true,
    );
    assert.equal(
        shouldLoadCatalogTables('main', 'example', new Set(), false),
        false,
    );
    assert.equal(
        shouldLoadCatalogTables('archive', 'raw', expandedSchemas, false, deepLink),
        true,
    );
    assert.equal(
        shouldLoadCatalogTables('archive', 'raw', expandedSchemas, true),
        true,
    );
    assert.equal(
        shouldLoadCatalogTables('archive', 'raw', expandedSchemas, false),
        false,
    );
    assert.equal(shouldLoadCatalogSampleData('overview', selectedTable), false);
    assert.equal(shouldLoadCatalogSampleData('sample-data', undefined), false);
    assert.equal(shouldLoadCatalogSampleData('sample-data', selectedTable), true);
});

test('catalog query options use isolated resource keys and forward abort signals', async () => {
    const client = createAppQueryClient();
    const capturedSignals: Array<AbortSignal | undefined> = [];
    await withMockFetch(async (_input, init) => {
        capturedSignals.push(init?.signal ?? undefined);
        return new Response(JSON.stringify({ schemas: [{ catalog: 'main', name: 'sales' }] }), {
            headers: { 'content-type': 'application/json' },
            status: 200,
        });
    }, async () => {
        const schemas = await client.query(catalogSchemasQueryOptions('main'));
        assert.equal(schemas[0]?.name, 'sales');
    });

    assert.ok(capturedSignals[0] instanceof AbortSignal);
    assert.equal(capturedSignals[0]?.aborted, false);
    assert.deepEqual(catalogTablesQueryOptions('main', 'sales').queryKey,
        queryKeys.catalogs.tables('main', 'sales'));
    assert.deepEqual(catalogTableDetailQueryOptions('main', 'sales', 'orders').queryKey,
        queryKeys.catalogs.tableDetail('main', 'sales', 'orders'));
    assert.deepEqual(catalogSampleDataQueryOptions('main', 'sales', 'orders').queryKey,
        queryKeys.catalogs.sampleData('main', 'sales', 'orders'));
    assert.notDeepEqual(
        catalogTableDetailQueryOptions('main', 'sales', 'orders').queryKey,
        catalogSampleDataQueryOptions('main', 'sales', 'orders').queryKey,
    );
    assert.notDeepEqual(
        catalogTableDetailQueryOptions('main', 'sales', 'orders').queryKey,
        catalogTableDetailQueryOptions('main', 'sales', 'customers').queryKey,
    );
    client.clear();
});

test('catalog refresh reset clears nested catalog data without clearing the root list', async () => {
    const client = createAppQueryClient();
    const catalogList = queryKeys.catalogs.all;
    const tableList = queryKeys.catalogs.tables('main', 'sales');

    client.setQueryData(catalogList, ['main']);
    client.setQueryData(tableList, ['orders']);
    await client.resetQueries({ queryKey: ['catalog'] });

    assert.deepEqual(client.getQueryData(catalogList), ['main']);
    assert.equal(client.getQueryData(tableList), undefined);
    client.clear();
});

test('failed detail query can be explicitly fetched again under the same key', async () => {
    const client = createAppQueryClient();
    let attempts = 0;
    const responseBody = { tableName: 'orders' };

    await withMockFetch(async () => {
        attempts += 1;
        if (attempts === 1) {
            return new Response(JSON.stringify({ message: 'temporary detail error' }), {
                headers: { 'content-type': 'application/json' },
                status: 503,
            });
        }
        return new Response(JSON.stringify(responseBody), {
            headers: { 'content-type': 'application/json' },
            status: 200,
        });
    }, async () => {
        const options = catalogTableDetailQueryOptions('main', 'sales', 'orders');
        await assert.rejects(client.query({ ...options, retry: false }), /temporary detail error/);
        assert.deepEqual(await client.query({ ...options, retry: false }), responseBody);
    });

    assert.equal(attempts, 2);
    client.clear();
});

test('changing selected-table query identity aborts the stale detail request', async () => {
    const client = createAppQueryClient();
    let previousSignal: AbortSignal | undefined;

    await withMockFetch(async (input, init) => {
        const url = String(input);
        if (url.endsWith('/tables/orders')) {
            previousSignal = init?.signal ?? undefined;
            return new Promise<Response>((_resolve, reject) => {
                const abortSignal = init?.signal;
                abortSignal?.addEventListener('abort', () => {
                    reject(new DOMException('Request aborted', 'AbortError'));
                }, { once: true });
            });
        }
        return new Response(JSON.stringify({ tableName: 'customers' }), {
            headers: { 'content-type': 'application/json' },
            status: 200,
        });
    }, async () => {
        const observer = new QueryObserver(client, {
            ...catalogTableDetailQueryOptions('main', 'sales', 'orders'),
            enabled: true,
        });
        const unsubscribe = observer.subscribe(() => undefined);
        await new Promise((resolve) => setTimeout(resolve, 0));
        assert.ok(previousSignal instanceof AbortSignal);

        observer.setOptions({
            ...catalogTableDetailQueryOptions('main', 'sales', 'customers'),
            enabled: true,
        });
        assert.equal(previousSignal.aborted, true);
        const result = await observer.refetch();
        assert.equal(result.data?.tableName, 'customers');
        unsubscribe();
    });

    client.clear();
});

test('failed sample query can be explicitly fetched again under the same key', async () => {
    const client = createAppQueryClient();
    let attempts = 0;
    const responseBody = { columns: ['id'], rows: [[7]] };

    await withMockFetch(async () => {
        attempts += 1;
        if (attempts === 1) {
            return new Response(JSON.stringify({ message: 'temporary Spark error' }), {
                headers: { 'content-type': 'application/json' },
                status: 503,
            });
        }
        return new Response(JSON.stringify(responseBody), {
            headers: { 'content-type': 'application/json' },
            status: 200,
        });
    }, async () => {
        const options = catalogSampleDataQueryOptions('main', 'sales', 'orders');
        await assert.rejects(client.query({ ...options, retry: false }), /temporary Spark error/);
        assert.deepEqual(await client.query({ ...options, retry: false }), responseBody);
    });

    assert.equal(attempts, 2);
    client.clear();
});
