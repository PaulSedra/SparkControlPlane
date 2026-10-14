/**
 * @fileoverview Unit coverage for catalog metadata presentation.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { createTestDataLoader } from '../../../support/testData.ts';
import { icebergFormatVersion } from '../../../../src/web/components/catalog/catalogMetadata.ts';
import { catalogPropertyLabel } from '../../../../src/web/components/catalog/catalogPresentation.ts';

interface CatalogMetadataFixture {
    catalogMetadata: Array<{
        expected: string | null;
        metadata: Record<string, string>;
        name: string;
    }>;
}

const cases = createTestDataLoader('web/unit')
    .loadYaml<CatalogMetadataFixture>('fixtures/presentation.yaml')
    .catalogMetadata;

for (const scenario of cases) {
    test('Iceberg format version ' + scenario.name, () => {
        assert.equal(
            icebergFormatVersion(scenario.metadata),
            scenario.expected ?? undefined,
        );
    });
}

const propertyLabels: Array<[string, string]> = [
    ['created-at', 'Created at'],
    ['current-snapshot-id', 'Current snapshot ID'],
    ['format', 'Format'],
    ['format-version', 'Format version'],
    ['write.format.default', 'Default write format'],
    ['write.parquet.compression-codec', 'Parquet compression codec'],
    ['Statistics', 'Statistics'],
    ['table-uuid', 'Table UUID'],
    ['next-row-id', 'Next row ID'],
    ['last-column-id', 'Last column ID'],
    ['default-spec-id', 'Default spec ID'],
    ['last-updated-ms', 'Last updated (ms)'],
    ['parent-namespace', 'Parent namespace'],
    ['current-schema-id', 'Current schema ID'],
    ['last-partition-id', 'Last partition ID'],
    ['metadata-location', 'Metadata location'],
    ['last-sequence-number', 'Last sequence number'],
    ['default-sort-order-id', 'Default sort order ID'],
];

for (const [propertyName, expectedLabel] of propertyLabels) {
    test(`catalog property label for ${propertyName}`, () => {
        assert.equal(catalogPropertyLabel(propertyName), expectedLabel);
    });
}
