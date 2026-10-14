/**
 * @fileoverview Metadata sidebar for the selected catalog table or view.
 */

import { tableTypeLabel } from './catalogPresentation';
import { MetadataList } from './MetadataList';
import { icebergFormatVersion } from './catalogMetadata.ts';
import type { SparkTableDetail } from '../../../shared/catalogTypes.ts';

/**
 * Presents the selected asset's authoritative identity separately from its
 * optional storage metadata. Missing provider/location/version fields simply
 * remove those rows, so incomplete enrichment cannot make the identity appear
 * unavailable.
 */
export function CatalogAssetAbout({ detail }: Readonly<{ detail: SparkTableDetail }>) {
    const icebergVersion = icebergFormatVersion(detail.properties);
    const storageEntries = [
        ...(detail.provider == null ? [] : [{ label: 'Provider', value: detail.provider }]),
        ...(icebergVersion == null ? [] : [{ label: 'Iceberg format version', value: icebergVersion }]),
        ...(detail.location == null ? [] : [{ label: 'Location', value: detail.location }]),
    ];

    return (
        <aside className="catalog-about">
            <section className="catalog-about-section">
                <h2>About this {detail.tableType === 'VIEW' ? 'view' : 'table'}</h2>
                <MetadataList
                    entries={[
                        { label: 'Type', value: tableTypeLabel(detail.tableType) },
                        { label: 'Catalog', value: detail.catalog },
                        { label: 'Schema', value: detail.schema },
                        { label: 'Name', value: detail.name },
                    ]}
                />
            </section>
            {storageEntries.length > 0 && (
                <section className="catalog-about-section">
                    <h2>Storage</h2>
                    <MetadataList entries={storageEntries} />
                </section>
            )}
        </aside>
    );
}
