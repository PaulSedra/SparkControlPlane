/**
 * @fileoverview Extracts normalized Iceberg metadata from catalog properties.
 */

/**
 * Finds the Iceberg format version in normalized direct properties first, then
 * in a serialized table-properties value with punctuation/case variations.
 * Missing or blank metadata returns `undefined` rather than guessing a version.
 */
export function icebergFormatVersion(
    properties: Record<string, string>,
): string | undefined {
    const directValue = propertyValue(
        properties,
        'format-version',
        'iceberg-format-version',
    );
    if (directValue != null) {
        return directValue;
    }

    const tableProperties = propertyValue(properties, 'table-properties');
    if (tableProperties == null) {
        return undefined;
    }

    const match = tableProperties.match(
        /(?:^|,|\[)\s*format[-_]version\s*=\s*([^,\]]+)/i,
    );
    return match?.[1]?.trim() || undefined;
}

function propertyValue(
    properties: Record<string, string>,
    ...keys: string[]
): string | undefined {
    const normalizedKeys = keys.map(normalizeKey);
    for (const [key, value] of Object.entries(properties)) {
        if (normalizedKeys.includes(normalizeKey(key)) && value.trim() !== '') {
            return value.trim();
        }
    }
    return undefined;
}

function normalizeKey(value: string): string {
    return value.replaceAll(/[^a-z0-9]/gi, '').toLowerCase();
}
