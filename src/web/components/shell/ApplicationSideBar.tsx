/**
 * @fileoverview Primary application navigation and its route-aware active
 * state.
 */

import { Book, FolderOpen, Route, type LucideIcon } from 'lucide-react';
import { AppIcon } from '../ui/AppIcon';
import { navigateTo } from '../../routes/useCurrentRoute';

const APPLICATION_SIDE_BAR_ENTRIES: readonly ApplicationSideBarEntry[] = [
    { href: '/workspace', icon: FolderOpen, key: 'workspace', label: 'Workspace' },
    { href: '/catalog', icon: Book, key: 'catalog', label: 'Catalog' },
    { href: '/pipelines', icon: Route, key: 'pipelines', label: 'Jobs & Pipelines' },
];

/** Application destinations represented in the side navigation. */
export type ApplicationSideBarItem = 'catalog' | 'pipelines' | 'workspace';

type ApplicationSideBarEntry = {
    href?: string;
    icon: LucideIcon;
    key: ApplicationSideBarItem;
    label: string;
};

/**
 * Renders route-aware navigation while keeping navigation inside the SPA.
 *
 * The native `href` remains available for accessibility and fallback, but the
 * click handler prevents a full reload and delegates route state to
 * `navigateTo`. Only the active destination receives `aria-current`, while
 * `aria-hidden` lets the shell collapse the sidebar without removing its
 * route model.
 */
export function ApplicationSideBar({
    activeItem,
    isOpen,
}: Readonly<{
    activeItem: ApplicationSideBarItem;
    isOpen: boolean;
}>) {
    return (
        <nav
            aria-hidden={!isOpen}
            aria-label="Application navigation"
            className="db-side-bar"
            id="application-sidebar"
        >
            <div className="db-side-bar-scroll">
                <div className="db-side-bar-list">
                    {APPLICATION_SIDE_BAR_ENTRIES.map((entry) => {
                        const isActive = entry.key === activeItem;
                        return (
                            <a
                                aria-current={isActive ? 'page' : undefined}
                                className={`db-side-bar-link${isActive ? ' active' : ''}`}
                                href={entry.href}
                                key={entry.key}
                                onClick={(event) => {
                                    event.preventDefault();
                                    navigateTo(entry.href ?? '/');
                                }}
                            >
                                <AppIcon icon={entry.icon} size="status" />
                                {entry.label}
                            </a>
                        );
                    })}
                </div>
            </div>
        </nav>
    );
}
