/**
 * @fileoverview Catalog page header, breadcrumb, refresh, copy, and tab
 * controls.
 */

import { Book, ChevronRight, Copy, RefreshCw } from 'lucide-react';
import { AppIcon } from '../ui/AppIcon';
import { DataAssetIcon } from '../ui/DataAssetIcon';
import type { SparkTableDetail } from '../../../shared/catalogTypes.ts';
import { CATALOG_TABS, type SelectedTable } from '../../types/catalogTypes';
import type { CatalogTableTab } from '../../utils/catalogNavigation.ts';

/**
 * Shows the selected catalog identity and page-level actions.
 *
 * The heading reflects the current URL-backed selection, while refresh asks
 * the controller to reload the catalog tree and detail. Copy is best effort
 * through the browser clipboard API and never changes the selected asset.
 */
export function CatalogHeader({
    onRefresh,
    selectedDetail,
    selectedTable,
}: Readonly<{
    onRefresh: () => void | Promise<void>;
    selectedDetail?: SparkTableDetail;
    selectedTable?: SelectedTable;
}>) {
    const qualifiedName = selectedTable == null
        ? ''
        : `${selectedTable.catalog}.${selectedTable.schema}.${selectedTable.name}`;
    return (
        <header className="catalog-main-header">
            <div className="catalog-heading-copy">
                {selectedTable != null && (
                    <div className="catalog-breadcrumbs">
                        <span>{selectedTable.catalog}</span>
                        <AppIcon icon={ChevronRight} size="status" />
                        <span>{selectedTable.schema}</span>
                    </div>
                )}
                <div className="catalog-title-row">
                    <span className="catalog-title-icon">
                        {selectedTable == null ? (
                            <AppIcon icon={Book} size="control" />
                        ) : (
                            <DataAssetIcon
                                kind={selectedDetail?.tableType === 'VIEW' ? 'view' : 'table'}
                                size="control"
                            />
                        )}
                    </span>
                    <div>
                        <h1>{selectedTable?.name ?? 'Catalog'}</h1>
                    </div>
                </div>
            </div>
            <div className="catalog-header-actions">
                {selectedTable != null && (
                    <button
                        aria-label={`Copy ${qualifiedName}`}
                        className="catalog-icon-button"
                        onClick={() => {
                            if (navigator.clipboard != null) {
                                void navigator.clipboard.writeText(qualifiedName).catch(() => undefined);
                            }
                        }}
                        title={`Copy ${qualifiedName}`}
                        type="button"
                    >
                        <AppIcon icon={Copy} size="status" />
                    </button>
                )}
                <button
                    aria-label="Refresh catalog"
                    className="catalog-icon-button"
                    onClick={() => void onRefresh()}
                    title="Refresh catalog from Polaris"
                    type="button"
                >
                    <AppIcon icon={RefreshCw} size="status" />
                </button>
            </div>
        </header>
    );
}

/**
 * Renders URL-addressable catalog detail tabs and disables them until an asset
 * is selected. Selection is delegated to the controller so the browser URL
 * remains the source of truth for deep links and reloads.
 */
export function CatalogTabs({
    activeTab,
    onSelectTab,
    selectedTable,
}: Readonly<{
    activeTab: CatalogTableTab;
    onSelectTab: (tab: CatalogTableTab) => void;
    selectedTable?: SelectedTable;
}>) {
    return (
        <nav aria-label="Catalog asset views" className="catalog-tabs" role="tablist">
            {CATALOG_TABS.map((tab) => (
                <button
                    aria-selected={activeTab === tab.key}
                    className={activeTab === tab.key ? 'active' : undefined}
                    disabled={selectedTable == null}
                    key={tab.key}
                    onClick={() => onSelectTab(tab.key)}
                    role="tab"
                    type="button"
                >
                    {tab.label}
                </button>
            ))}
        </nav>
    );
}
