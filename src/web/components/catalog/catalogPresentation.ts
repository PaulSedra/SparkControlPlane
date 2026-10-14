/**
 * @fileoverview Small presentation helpers shared by catalog tree and detail
 * components.
 */

import type { SparkTable } from '../../../shared/catalogTypes.ts';

const PROPERTY_LABEL_OVERRIDES: Readonly<Record<string, string>> = {
    lastupdatedms: 'Last updated (ms)',
    writeformatdefault: 'Default write format',
    writeparquetcompressioncodec: 'Parquet compression codec',
};

/** Creates a collision-resistant in-memory key for one catalog/schema pair. */
export function namespaceKey(catalog: string, schema: string): string {
    return `${catalog}\u0000${schema}`;
}

/** Converts catalog property keys to readable sentence-case labels. */
export function catalogPropertyLabel(propertyName: string): string {
    const normalizedName = propertyName.replaceAll(/[^a-z0-9]/gi, '').toLowerCase();
    const override = PROPERTY_LABEL_OVERRIDES[normalizedName];
    if (override != null) {
        return override;
    }

    const words = propertyName
        .replaceAll(/([a-z0-9])([A-Z])/g, '$1 $2')
        .split(/[^a-z0-9]+/i)
        .filter(Boolean);
    return words.map((word, index) => {
        const normalizedWord = word.toLowerCase();
        if (normalizedWord === 'id') {
            return 'ID';
        }
        if (normalizedWord === 'uuid') {
            return 'UUID';
        }
        if (normalizedWord === 'parquet') {
            return 'Parquet';
        }
        if (normalizedWord === 'ms') {
            return 'ms';
        }
        return index === 0
            ? normalizedWord.charAt(0).toUpperCase() + normalizedWord.slice(1)
            : normalizedWord;
    }).join(' ');
}

/** Performs case-insensitive substring matching, with an empty query matching all values. */
export function matchesQuery(query: string, ...values: string[]): boolean {
    return query === '' || values.some((value) => value.toLowerCase().includes(query));
}

/** Maps API table types to the UI labels used by tree and detail views. */
export function tableTypeLabel(tableType?: SparkTable['tableType']): string {
    return tableType === 'VIEW'
        ? 'View'
        : tableType === 'TABLE'
            ? 'Table'
            : 'Table or view';
}

/**
 * Converts sample data to display text, preserving `NULL` and falling back to
 * `String` when a cyclic object cannot be JSON serialized.
 */
export function formatCell(value: unknown): string {
    if (value == null) {
        return 'NULL';
    }
    if (typeof value === 'object') {
        try {
            return JSON.stringify(value);
        } catch {
            return String(value);
        }
    }
    return String(value);
}
