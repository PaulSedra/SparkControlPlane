/**
 * @fileoverview Catalog detail tabs for overview, metadata, and bounded sample
 * data.
 */

import { AlertCircle, Info, Rows3, Search } from 'lucide-react';
import { AppIcon } from '../ui/AppIcon';
import { catalogPropertyLabel, formatCell, matchesQuery } from './catalogPresentation';
import { MetadataList } from './MetadataList';
import type {
    SparkSampleData,
    SparkTableDetail,
} from '../../../shared/catalogTypes.ts';
import type { CatalogLoadState } from '../../types/catalogTypes';
import type { CatalogTableTab } from '../../utils/catalogNavigation.ts';

/**
 * Switches among overview, metadata, and bounded sample data for one asset.
 *
 * Overview and metadata are immediately available from the selected detail;
 * sample rows are an independent Spark request and therefore have their own
 * loading, retry, filtering, and empty states. A sample failure does not hide
 * the catalog identity or the other detail tabs.
 */
export function CatalogAssetDetail({
    activeTab,
    columnQuery,
    detail,
    onRetrySample,
    sampleData,
    sampleQuery,
    sampleState,
    setColumnQuery,
    setSampleQuery,
}: Readonly<{
    activeTab: CatalogTableTab;
    columnQuery: string;
    detail: SparkTableDetail;
    onRetrySample: () => void;
    sampleData?: SparkSampleData;
    sampleQuery: string;
    sampleState?: CatalogLoadState;
    setColumnQuery: (value: string) => void;
    setSampleQuery: (value: string) => void;
}>) {
    if (activeTab === 'sample-data') {
        return (
            <div className="catalog-detail-content">
                <section className="catalog-section catalog-sample-panel">
                    <div className="catalog-section-heading">
                        <div>
                            <h2>Sample data</h2>
                            <p>Read-only rows queried from the selected Polaris asset through Spark.</p>
                        </div>
                        <AppIcon icon={Rows3} size="status" />
                    </div>
                    {sampleState?.kind === 'loading' ? (
                        <div aria-busy="true" className="catalog-blank-results catalog-blank-results--sample" />
                    ) : sampleState?.kind === 'error' ? (
                        <div className="catalog-sample-error" role="alert">
                            <AppIcon icon={AlertCircle} size="empty" />
                            <strong>Sample data unavailable</strong>
                            <span>{sampleState.message}</span>
                            <button className="catalog-secondary-button" onClick={onRetrySample} type="button">
                                Retry
                            </button>
                        </div>
                    ) : sampleData == null ? (
                        <div className="catalog-blank-results catalog-blank-results--sample" />
                    ) : (
                        <SampleTable data={sampleData} query={sampleQuery} setQuery={setSampleQuery} />
                    )}
                </section>
            </div>
        );
    }

    if (activeTab === 'details') {
        return (
            <div className="catalog-detail-content">
                <section className="catalog-section">
                    <div className="catalog-section-heading">
                        <div>
                            <h2>Metadata</h2>
                            <p>Properties read from Polaris and Spark DESCRIBE TABLE EXTENDED, including expanded table properties.</p>
                        </div>
                        <AppIcon icon={Info} size="status" />
                    </div>
                    <MetadataList
                        entries={Object.entries(detail.properties).map(([propertyName, value]) => ({
                            label: catalogPropertyLabel(propertyName),
                            value,
                        }))}
                    />
                </section>
            </div>
        );
    }

    return (
        <div className="catalog-detail-content">
            <div className="catalog-tab-stack">
                <section className="catalog-section">
                    <div className="catalog-section-heading">
                        <div>
                            <h2>Description</h2>
                        </div>
                    </div>
                    <p className="catalog-description">
                        {detail.comment ?? 'No description registered for this asset.'}
                    </p>
                </section>
                {detail.viewDefinition != null && (
                    <section className="catalog-section">
                        <div className="catalog-section-heading">
                            <div>
                                <h2>Definition</h2>
                                <p>View definition returned by Spark when available.</p>
                            </div>
                        </div>
                        <div className="catalog-definition">
                            <pre>{detail.viewDefinition}</pre>
                        </div>
                    </section>
                )}
                <section className="catalog-section">
                    <div className="catalog-section-heading">
                        <div>
                            <h2>Columns</h2>
                        </div>
                    </div>
                    {detail.columns.length === 0 ? (
                        <div className="catalog-table-empty">No column metadata was returned.</div>
                    ) : (
                        <div className="catalog-column-table-shell">
                            <div className="catalog-column-toolbar">
                                <label className="catalog-column-filter">
                                    <AppIcon icon={Search} size="status" />
                                    <input
                                        aria-label="Filter columns"
                                        onChange={(event) => setColumnQuery(event.target.value)}
                                        placeholder="Filter columns..."
                                        type="search"
                                        value={columnQuery}
                                    />
                                </label>
                            </div>
                            <ColumnTable
                                columns={detail.columns.filter((column) =>
                                    matchesQuery(columnQuery.trim().toLowerCase(), column.name, column.type, column.comment ?? ''),
                                )}
                            />
                        </div>
                    )}
                </section>
            </div>
        </div>
    );
}

function ColumnTable({ columns }: Readonly<{ columns: SparkTableDetail['columns'] }>) {
    if (columns.length === 0) {
        return <div className="catalog-table-empty">No columns match this filter.</div>;
    }

    return (
        <div className="catalog-column-table-wrap">
            <table className="catalog-column-table">
                <thead>
                    <tr>
                        <th>Column</th>
                        <th>Type</th>
                        <th>Comment</th>
                    </tr>
                </thead>
                <tbody>
                    {columns.map((column) => (
                        <tr key={column.name}>
                            <td><code>{column.name}</code></td>
                            <td><code>{column.type}</code></td>
                            <td>{column.comment ?? '—'}</td>
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );
}

function SampleTable({
    data,
    query,
    setQuery,
}: Readonly<{
    data: SparkSampleData;
    query: string;
    setQuery: (value: string) => void;
}>) {
    const normalizedQuery = query.trim().toLowerCase();
    const rows = data.rows.filter((row) =>
        normalizedQuery === '' || row.some((value) => formatCell(value).toLowerCase().includes(normalizedQuery)),
    );

    return (
        <div className="catalog-sample-panel">
            <div className="catalog-sample-toolbar">
                <label className="catalog-column-filter">
                    <AppIcon icon={Search} size="status" />
                    <input
                        aria-label="Filter sample data"
                        onChange={(event) => setQuery(event.target.value)}
                        placeholder="Filter rows"
                        type="search"
                        value={query}
                    />
                </label>
                <span>{rows.length} of {data.rows.length} rows</span>
            </div>
            {data.columns.length === 0 ? (
                <div className="catalog-table-empty">The selected catalog asset has no columns.</div>
            ) : (
                <div className="catalog-sample-table-wrap">
                    <table className="catalog-sample-table">
                        <thead>
                            <tr>
                                <th className="catalog-row-number">#</th>
                                {data.columns.map((column) => (
                                    <th key={column.name}>
                                        <span>{column.name}</span>
                                        <small>{column.type}</small>
                                    </th>
                                ))}
                            </tr>
                        </thead>
                        <tbody>
                            {rows.map((row, rowIndex) => (
                                <tr key={`row-${rowIndex}`}>
                                    <td className="catalog-row-number">{rowIndex + 1}</td>
                                    {data.columns.map((column, columnIndex) => (
                                        <td key={`${column.name}-${columnIndex}`} title={formatCell(row[columnIndex])}>
                                            {formatCell(row[columnIndex])}
                                        </td>
                                    ))}
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}
        </div>
    );
}
