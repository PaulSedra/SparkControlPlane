/**
 * @fileoverview Merges Polaris table metadata with Spark Connect detail while
 * keeping provider-specific aggregate properties out of the UI contract.
 */

import type { SparkTableDetail } from '../../shared/catalogTypes.ts';

/**
 * Combines authoritative Polaris identity with optional Spark table detail.
 *
 * Polaris wins for identity and provider metadata, while non-empty Spark
 * columns and missing descriptive fields fill gaps in the catalog record.
 * Property keys are matched case/punctuation-insensitively so the two
 * providers do not expose duplicate variants, and Polaris' aggregate
 * `tableProperties` wrapper is removed before merging.
 */
export function mergeSparkTableDetail(
    polarisDetail: SparkTableDetail,
    sparkDetail: SparkTableDetail,
): SparkTableDetail {
    return {
        ...polarisDetail,
        columns: sparkDetail.columns.length > 0
            ? sparkDetail.columns
            : polarisDetail.columns,
        comment: polarisDetail.comment ?? sparkDetail.comment,
        location: polarisDetail.location ?? sparkDetail.location,
        partitionColumns: sparkDetail.partitionColumns?.length
            ? sparkDetail.partitionColumns
            : polarisDetail.partitionColumns,
        properties: mergeSparkProperties(sparkDetail.properties, polarisDetail.properties),
        provider: polarisDetail.provider ?? sparkDetail.provider,
        viewDefinition: polarisDetail.viewDefinition ?? sparkDetail.viewDefinition,
    };
}

/**
 * Removes the aggregate `tableProperties` entry from Polaris metadata before
 * properties are exposed as individual table properties.
 */
export function withoutAggregateTableProperties(
    properties: Record<string, string>,
): Record<string, string> {
    return Object.fromEntries(
        Object.entries(properties).filter(([key]) =>
            normalizePropertyKey(key) !== 'tableproperties',
        ),
    );
}

function mergeSparkProperties(
    sparkProperties: Record<string, string>,
    polarisProperties: Record<string, string>,
): Record<string, string> {
    const merged = withoutAggregateTableProperties(sparkProperties);
    const keysByNormalizedName = new Map<string, string>();
    for (const key of Object.keys(merged)) {
        keysByNormalizedName.set(normalizePropertyKey(key), key);
    }

    for (const [key, value] of Object.entries(withoutAggregateTableProperties(polarisProperties))) {
        const normalizedKey = normalizePropertyKey(key);
        const existingKey = keysByNormalizedName.get(normalizedKey);
        if (existingKey == null) {
            keysByNormalizedName.set(normalizedKey, key);
            merged[key] = value;
        } else {
            merged[existingKey] = value;
        }
    }
    return merged;
}

function normalizePropertyKey(value: string): string {
    return value.replaceAll(/[^a-z0-9]/gi, '').toLowerCase();
}
