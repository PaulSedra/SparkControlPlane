/**
 * @fileoverview Application shell layout that coordinates the top bar, side
 * navigation, and route content region.
 */

import { useState } from 'react';
import type { ReactNode } from 'react';
import { ApplicationSideBar, type ApplicationSideBarItem } from './ApplicationSideBar';
import { ApplicationTopBar } from './ApplicationTopBar';

/**
 * Owns the application-wide chrome and the sidebar's open/collapsed state.
 *
 * Route pages remain responsible for their data and content; the shell only
 * supplies stable header/navigation regions and applies the collapsed class
 * that the layout uses to reclaim horizontal space. The content label and
 * class are forwarded so pages can preserve their own accessibility and
 * sizing contracts.
 */
export function ApplicationShell({
    activeItem,
    children,
    className,
    contentAriaLabel,
    contentClassName,
}: Readonly<{
    activeItem: ApplicationSideBarItem;
    children: ReactNode;
    className?: string;
    contentAriaLabel?: string;
    contentClassName?: string;
}>) {
    const [sidebarOpen, setSidebarOpen] = useState(true);
    const shellClassName = ['application-shell', 'db-shell', className]
        .concat(sidebarOpen ? [] : ['sidebar-collapsed'])
        .filter(Boolean)
        .join(' ');
    const routeContentClassName = ['db-route-content', contentClassName]
        .filter(Boolean)
        .join(' ');

    return (
        <main className={shellClassName}>
            <ApplicationTopBar
                onToggleSidebar={() => setSidebarOpen((open) => !open)}
                sidebarOpen={sidebarOpen}
            />
            <div className="db-route-shell">
                <ApplicationSideBar activeItem={activeItem} isOpen={sidebarOpen} />
                <div aria-label={contentAriaLabel} className={routeContentClassName}>
                    {children}
                </div>
            </div>
        </main>
    );
}
