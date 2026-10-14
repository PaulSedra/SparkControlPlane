/**
 * @fileoverview Catalog route composition: browser tree, detail tabs, and
 * retryable loading feedback.
 */

import { Book, Layers3 } from 'lucide-react';
import type { ReactNode } from 'react';
import { ApplicationShell } from '../components/shell/ApplicationShell';
import { AppIcon } from '../components/ui/AppIcon';
import { EmptyState } from '../components/ui/EmptyState';
import { CatalogBrowser } from '../components/catalog/CatalogBrowser';
import { CatalogDetailPanel } from '../components/catalog/CatalogDetailPanel';
import { CatalogFeedback } from '../components/catalog/CatalogFeedback';
import { CatalogHeader, CatalogTabs } from '../components/catalog/CatalogHeader';
import { useCatalogController } from '../components/catalog/hooks/useCatalogController';
import { useCurrentRoute } from '../routes/useCurrentRoute';

type CatalogMainBodyProps = Pick<
    ReturnType<typeof useCatalogController>,
    | 'activeTab'
    | 'catalogs'
    | 'columnQuery'
    | 'loadCatalogs'
    | 'loadState'
    | 'retryDetail'
    | 'retrySample'
    | 'sampleQuery'
    | 'selectedSampleData'
    | 'selectedSampleDataState'
    | 'selectedTableDetail'
    | 'selectedTableDetailState'
    | 'selectedTable'
    | 'setColumnQuery'
    | 'setSampleQuery'
>;

/**
 * Connects the URL-backed catalog controller to the browser tree and detail
 * panes inside the application shell. The page keeps tree discovery,
 * selected-detail loading, and sample retry state in the controller so a
 * catalog refresh does not turn presentation components into data owners.
 */
export default function CatalogPage() {
    const { search } = useCurrentRoute();
    const controller = useCatalogController(search);
    const {
        activeTab,
        catalogs,
        columnQuery,
        expandedCatalogs,
        expandedSchemas,
        loadCatalogs,
        loadState,
        catalogSearchQuery,
        refreshCatalog,
        retryDetail,
        retrySample,
        sampleQuery,
        schemasByCatalog,
        schemaStates,
        selectedCatalog,
        selectedSampleData,
        selectedSampleDataState,
        selectedTableDetail,
        selectedTableDetailState,
        selectedTable,
        selectTab,
        setColumnQuery,
        setCatalogSearchQuery,
        setSampleQuery,
        tableStates,
        tablesBySchema,
    } = controller;

    return (
        <ApplicationShell
            activeItem="catalog"
            className="catalog-app-shell"
            contentAriaLabel="Catalog"
            contentClassName="catalog-page"
        >
            <div className="catalog-layout">
                <CatalogBrowser
                    catalogs={catalogs}
                    expandedCatalogs={expandedCatalogs}
                    expandedSchemas={expandedSchemas}
                    loadState={loadState}
                    onSelectCatalog={controller.selectCatalog}
                    onSelectSchema={controller.selectSchema}
                    onSelectTable={controller.selectTable}
                    onToggleCatalog={controller.toggleCatalog}
                    onToggleSchema={controller.toggleSchema}
                    query={catalogSearchQuery}
                    schemaStates={schemaStates}
                    schemasByCatalog={schemasByCatalog}
                    selectedCatalog={selectedCatalog}
                    selectedTable={selectedTable}
                    setQuery={setCatalogSearchQuery}
                    tableStates={tableStates}
                    tablesBySchema={tablesBySchema}
                />

                <section className="catalog-main">
                    <CatalogHeader
                        onRefresh={refreshCatalog}
                        selectedDetail={selectedTableDetail}
                        selectedTable={selectedTable}
                    />
                    <CatalogTabs
                        activeTab={activeTab}
                        onSelectTab={selectTab}
                        selectedTable={selectedTable}
                    />
                    <CatalogMainBody
                        activeTab={activeTab}
                        catalogs={catalogs}
                        columnQuery={columnQuery}
                        loadCatalogs={loadCatalogs}
                        loadState={loadState}
                        retryDetail={retryDetail}
                        retrySample={retrySample}
                        sampleQuery={sampleQuery}
                        selectedSampleData={selectedSampleData}
                        selectedSampleDataState={selectedSampleDataState}
                        selectedTableDetail={selectedTableDetail}
                        selectedTableDetailState={selectedTableDetailState}
                        selectedTable={selectedTable}
                        setColumnQuery={setColumnQuery}
                        setSampleQuery={setSampleQuery}
                    />
                </section>
            </div>
        </ApplicationShell>
    );
}

function CatalogMainBody(props: Readonly<CatalogMainBodyProps>) {
    const {
        catalogs,
        loadCatalogs,
        loadState,
        retryDetail,
        selectedTableDetailState,
        selectedTable,
    } = props;
    let content: ReactNode;

    if (selectedTable != null) {
        content = selectedTableContent(props);
    } else if (loadState.kind === 'loading') {
        content = <div aria-busy="true" className="catalog-blank-results" />;
    } else if (catalogs.length === 0 && loadState.kind === 'ready') {
        content = (
            <EmptyState
                detail="Polaris returned no catalogs for the configured PostgreSQL connection."
                icon={<AppIcon icon={Book} size="empty" />}
                title="No Polaris catalogs"
            />
        );
    } else {
        content = (
            <EmptyState
                detail="Choose a catalog, schema, and table or view to inspect its metadata."
                icon={<AppIcon icon={Layers3} size="empty" />}
                title="Select a catalog asset"
            />
        );
    }

    return (
        <div className="catalog-main-body">
            <CatalogFeedback
                detailState={selectedTableDetailState}
                loadState={loadState}
                onRetryCatalog={() => void loadCatalogs(true)}
                onRetryDetail={retryDetail}
            />

            {content}
        </div>
    );
}

function selectedTableContent({
    activeTab,
    columnQuery,
    retrySample,
    sampleQuery,
    selectedSampleData,
    selectedSampleDataState,
    selectedTableDetail,
    selectedTableDetailState,
    selectedTable,
    setColumnQuery,
    setSampleQuery,
}: CatalogMainBodyProps) {
    if (selectedTableDetail != null) {
        return (
            <CatalogDetailPanel
                activeTab={activeTab}
                columnQuery={columnQuery}
                detail={selectedTableDetail}
                onRetrySample={retrySample}
                sampleData={selectedSampleData}
                sampleQuery={sampleQuery}
                sampleState={selectedSampleDataState}
                setColumnQuery={setColumnQuery}
                setSampleQuery={setSampleQuery}
            />
        );
    }
    if (selectedTable != null && selectedTableDetailState?.kind === 'loading') {
        return null;
    }
    return <div className="catalog-blank-results" />;
}
