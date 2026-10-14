/**
 * @fileoverview Shared empty-state presentation for views with no selectable
 * content.
 */

import type { ReactNode } from 'react';

/** Renders the icon, title, and supporting detail for an empty view. */
export function EmptyState({
    detail,
    icon,
    title,
}: Readonly<{
    detail: string;
    icon: ReactNode;
    title: string;
}>) {
    return (
        <div className="empty-state">
            {icon}
            <strong>{title}</strong>
            <span>{detail}</span>
        </div>
    );
}
