/**
 * @fileoverview Top application bar with sidebar control, search affordance,
 * theme toggle, and profile placeholder.
 */

import { PanelLeftClose, PanelLeftOpen, Search, UserRound } from 'lucide-react';
import { AppIcon } from '../ui/AppIcon';
import { ThemeToggle } from '../ui/ThemeToggle';

/**
 * Renders the persistent header and exposes the shell-level sidebar toggle.
 *
 * The top bar does not own navigation or theme persistence: it reports the
 * toggle intent to the shell, while `ThemeToggle` manages the theme preference
 * and the sidebar consumes the resulting `sidebarOpen` state for ARIA labels.
 */
export function ApplicationTopBar({
    onToggleSidebar,
    sidebarOpen,
}: Readonly<{
    onToggleSidebar: () => void;
    sidebarOpen: boolean;
}>) {
    const sidebarToggleIcon = sidebarOpen ? PanelLeftClose : PanelLeftOpen;

    return (
        <header className="db-top-bar application-top-bar">
            <div className="brand-lockup">
                <button
                    aria-controls="application-sidebar"
                    aria-expanded={sidebarOpen}
                    aria-label={sidebarOpen ? 'Close sidebar' : 'Open sidebar'}
                    className="sidebar-toggle"
                    onClick={onToggleSidebar}
                    title={sidebarOpen ? 'Close sidebar' : 'Open sidebar'}
                    type="button"
                >
                    <AppIcon icon={sidebarToggleIcon} size="control" />
                </button>
                <img
                    alt="Apache Spark"
                    className="application-brand-logo application-brand-logo--dark"
                    src="/apache-spark-wordmark-dark.svg"
                />
                <img
                    alt="Apache Spark"
                    className="application-brand-logo application-brand-logo--light"
                    src="/apache-spark-wordmark.svg"
                />
                <strong className="application-brand-name">Control Plane</strong>
            </div>
            <label className="global-search">
                <AppIcon icon={Search} size="status" />
                <input
                    aria-label="Search data, notebooks, recents, and more"
                    placeholder="Search data, notebooks, recents, and more..."
                />
                <kbd>CTRL + P</kbd>
            </label>
            <div className="global-actions">
                <ThemeToggle />
                <span aria-label="Profile" className="global-avatar" role="img">
                    <AppIcon icon={UserRound} size="status" />
                </span>
            </div>
        </header>
    );
}
