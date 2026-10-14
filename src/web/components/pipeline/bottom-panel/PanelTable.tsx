/**
 * @fileoverview Shared bottom-panel table structure for Tables and Performance.
 * Owns column headers, the scrolling wrapper, and optional empty feedback.
 */

import type { ReactNode } from 'react';

type PanelTableColumn = Readonly<{
    ariaLabel?: string;
    key: string;
    label: ReactNode;
    title?: string;
}>;

/** Shares accessible column headers, scrolling, and empty feedback across views. */
export function PanelTable({
    children,
    className,
    columns,
    emptyMessage,
}: Readonly<{
    children: ReactNode;
    className: string;
    columns: readonly PanelTableColumn[];
    emptyMessage?: string;
}>) {
    return (
        <div className="bottom-panel-table-wrap">
            <table className={`pipeline-panel-table ${className}`}>
                <thead>
                    <tr>
                        {columns.map(({ ariaLabel, key, label, title }) => (
                            <th aria-label={ariaLabel} key={key} scope="col" title={title}>
                                {label}
                            </th>
                        ))}
                    </tr>
                </thead>
                <tbody>{children}</tbody>
            </table>
            {emptyMessage != null && (
                <div className="bottom-panel-empty">{emptyMessage}</div>
            )}
        </div>
    );
}

