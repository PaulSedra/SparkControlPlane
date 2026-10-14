/**
 * @fileoverview Selected-node Sample Data view and its bounded server query.
 * Owns query loading, error, empty, and result presentation while mounted.
 */

import { useQuery } from '@tanstack/react-query';
import type { PipelineNode } from '../../../../shared/pipelineRegistryTypes.ts';
import { pipelineNodeDataQueryOptions } from '../../../query/pipelineQueries.ts';
import { formatNumber } from '../../../lib/format';

/** Fetches the selected node while mounted and presents loading, error, and empty states. */
export function PipelineSampleDataView({
    pipelineId,
    node,
}: Readonly<{
    pipelineId: string;
    node: PipelineNode;
}>) {
    const query = useQuery(pipelineNodeDataQueryOptions(pipelineId, node.id));
    const data = query.data;
    const isLoading = query.isLoading;
    const error = query.isError
        ? query.error instanceof Error ? query.error.message : 'Unable to load sample data.'
        : undefined;
    return (
        <>
            <div className="bottom-panel-toolbar sample-data-toolbar">
                <strong>{node.qualifiedName}</strong>
                <span>
                    {data == null
                        ? 'Up to 100 records'
                        : `${formatNumber(data.rows.length)} records (maximum 100)`}
                </span>
            </div>
            {isLoading ? (
                <output aria-busy="true" className="bottom-panel-empty">
                    Loading sample data for {node.name}…
                </output>
            ) : error != null ? (
                <div className="bottom-panel-empty" role="alert">
                    Unable to load sample data: {error}
                </div>
            ) : data == null ? (
                <output className="bottom-panel-empty">
                    No sample data is available for {node.name}.
                </output>
            ) : (
                <div className="bottom-panel-table-wrap">
                    <table
                        aria-label={`Sample data for ${node.name}`}
                        className="pipeline-sample-data-table"
                    >
                        <thead>
                            <tr>
                                {data.columns.map((column, index) => (
                                    <th key={`${column.name}-${index}`} scope="col" title={column.type}>
                                        {column.name}
                                        <small>{column.type}</small>
                                    </th>
                                ))}
                            </tr>
                        </thead>
                        <tbody>
                            {data.rows.map((row, rowIndex) => (
                                <tr key={rowIndex}>
                                    {data.columns.map((column, columnIndex) => (
                                        <td key={`${column.name}-${columnIndex}`}>
                                            {formatSampleDataValue(row[columnIndex])}
                                        </td>
                                    ))}
                                </tr>
                            ))}
                        </tbody>
                    </table>
                    {data.rows.length === 0 && (
                        <div className="bottom-panel-empty">No sample records found.</div>
                    )}
                </div>
            )}
        </>
    );
}

function formatSampleDataValue(value: unknown): string {
    if (value == null) {
        return 'NULL';
    }
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        return String(value);
    }

    return JSON.stringify(value) ?? String(value);
}
