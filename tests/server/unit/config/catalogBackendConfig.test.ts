/**
 * @fileoverview Unit coverage for catalog backend environment configuration.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { loadCatalogBackend } from '../../../../src/server/config/catalogBackendConfig.ts';

test('catalog backend defaults to Polaris and normalizes configured values', () => {
    assert.equal(loadCatalogBackend({}), 'polaris');
    assert.equal(loadCatalogBackend({ CATALOG_BACKEND: '  ' }), 'polaris');
    assert.equal(loadCatalogBackend({ CATALOG_BACKEND: ' SPARK ' }), 'spark');
    assert.equal(loadCatalogBackend({ CATALOG_BACKEND: 'POLARIS' }), 'polaris');
});

test('catalog backend rejects unsupported values', () => {
    assert.throws(
        () => loadCatalogBackend({ CATALOG_BACKEND: 'hive' }),
        /CATALOG_BACKEND must be either "polaris" or "spark"/,
    );
});
