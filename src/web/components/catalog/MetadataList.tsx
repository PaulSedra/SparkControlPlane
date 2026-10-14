/**
 * @fileoverview Compact definition-list presentation for catalog metadata.
 */

/**
 * Renders bounded label/value metadata without interpreting the values.
 * Empty input is explicit because a missing metadata response is different
 * from a row whose value happens to be an empty string.
 */
export function MetadataList({
    entries,
}: Readonly<{
    entries: Array<{ label: string; value: string }>;
}>) {
    if (entries.length === 0) {
        return <div className="catalog-table-empty">No metadata returned.</div>;
    }

    return (
        <dl className="catalog-metadata-list">
            {entries.map((entry) => (
                <div className="catalog-metadata-row" key={entry.label}>
                    <dt>{entry.label}</dt>
                    <dd title={entry.value}>{entry.value}</dd>
                </div>
            ))}
        </dl>
    );
}
