/**
 * @fileoverview Verifies shared query lifecycle defaults and cache isolation.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { createAppQueryClient } from '../../../../src/web/query/queryClient.ts';
import { queryKeys } from '../../../../src/web/query/queryKeys.ts';

test('query client applies bounded read defaults and disables unsafe mutation retries', () => {
    const client = createAppQueryClient();
    const defaults = client.getDefaultOptions();

    assert.equal(defaults.queries?.staleTime, 30_000);
    assert.equal(defaults.queries?.gcTime, 300_000);
    assert.equal(defaults.queries?.retry, 1);
    assert.equal(defaults.queries?.refetchOnWindowFocus, false);
    assert.equal(defaults.mutations?.retry, false);
    client.clear();
});

test('query client factory creates independent caches', () => {
    const firstClient = createAppQueryClient();
    const secondClient = createAppQueryClient();
    const key = queryKeys.catalogs.all;

    firstClient.setQueryData(key, ['catalog-a']);

    assert.deepEqual(firstClient.getQueryData(key), ['catalog-a']);
    assert.equal(secondClient.getQueryData(key), undefined);
    firstClient.clear();
    secondClient.clear();
});

test('feature query keys isolate catalog resources and preserve invalidation prefixes', () => {
    assert.deepEqual(queryKeys.catalogs.all, ['catalogs']);
    assert.deepEqual(queryKeys.catalogs.schemas('main'), ['catalog', 'main', 'schemas']);
    assert.deepEqual(
        queryKeys.catalogs.tables('main', 'sales'),
        ['catalog', 'main', 'sales', 'tables'],
    );
    assert.deepEqual(
        queryKeys.catalogs.tableDetail('main', 'sales', 'orders'),
        ['catalog', 'main', 'sales', 'orders', 'detail'],
    );
    assert.deepEqual(
        queryKeys.catalogs.sampleData('main', 'sales', 'orders'),
        ['catalog', 'main', 'sales', 'orders', 'sample'],
    );
    assert.notDeepEqual(
        queryKeys.catalogs.tableDetail('main', 'sales', 'orders'),
        queryKeys.catalogs.sampleData('main', 'sales', 'orders'),
    );
});
