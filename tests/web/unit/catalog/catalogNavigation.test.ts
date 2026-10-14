/**
 * @fileoverview Unit coverage for catalog URL construction.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import {
    catalogTableFromSearch,
    catalogTablePath,
} from '../../../../src/web/utils/catalogNavigation.ts';

test('catalog table URL encodes each supported tab for refreshable navigation', () => {
    const supportedTabs = ['overview', 'sample-data', 'details'] as const;

    for (const tab of supportedTabs) {
        assert.equal(
            catalogTablePath({ catalog: 'example', schema: 'silver.monthly', table: 'daily prices', tab }),
            `/catalog?catalog=example&schema=silver.monthly&table=daily+prices&tab=${tab}`,
        );
    }
});

test('catalog table URL defaults an omitted tab to overview', () => {
    assert.equal(
        catalogTablePath({ catalog: 'example', schema: 'silver', table: 'events' }),
        '/catalog?catalog=example&schema=silver&table=events&tab=overview',
    );
});

test('catalog deep links resolve selection and tab before dependent data is available', () => {
    assert.deepEqual(
        catalogTableFromSearch('?catalog=example&schema=silver&table=events&tab=sample-data'),
        { catalog: 'example', schema: 'silver', table: 'events', tab: 'sample-data' },
    );
});

test('catalog deep links ignore invalid tabs and reject incomplete table identity', () => {
    assert.deepEqual(
        catalogTableFromSearch('?catalog=example&schema=silver&table=events&tab=unknown'),
        { catalog: 'example', schema: 'silver', table: 'events' },
    );
    assert.equal(catalogTableFromSearch('?catalog=example&schema=silver'), undefined);
});
