/**
 * @fileoverview Expandable catalog/schema/table browser with search and
 * selection state.
 */

import {
    Book,
    ChevronDown,
    ChevronRight,
    Database,
    Search,
} from 'lucide-react';
import { AppIcon } from '../ui/AppIcon';
import { DataAssetIcon } from '../ui/DataAssetIcon';
import { matchesQuery, namespaceKey, tableTypeLabel } from './catalogPresentation';
import type {
    SparkCatalog,
    SparkSchema,
    SparkTable,
} from '../../../shared/catalogTypes.ts';
import type {
    CatalogLoadState,
    SelectedTable,
} from '../../types/catalogTypes';

/**
 * Presents the catalog tree, search filter, and lazy-loaded branches.
 *
 * Catalogs, schemas, and tables are expanded independently so opening one
 * branch does not require loading the whole catalog. Search filters the
 * visible hierarchy while preserving the controller's selected table; all
 * selection and expansion changes are delegated to the controller, which owns
 * URL synchronization and request cancellation.
 */
export function CatalogBrowser({
    catalogs,
    expandedCatalogs,
    expandedSchemas,
    loadState,
    onSelectCatalog,
    onSelectSchema,
    onSelectTable,
    onToggleCatalog,
    onToggleSchema,
    query,
    schemaStates,
    schemasByCatalog,
    selectedCatalog,
    selectedTable,
    setQuery,
    tableStates,
    tablesBySchema,
}: Readonly<{
    catalogs: SparkCatalog[];
    expandedCatalogs: Set<string>;
    expandedSchemas: Set<string>;
    loadState: CatalogLoadState;
    onSelectCatalog: (catalog: string) => void;
    onSelectSchema: (catalog: string, schema: string) => void;
    onSelectTable: (catalog: string, schema: string, table: string) => void;
    onToggleCatalog: (catalog: string) => void;
    onToggleSchema: (catalog: string, schema: string) => void;
    query: string;
    schemaStates: Record<string, CatalogLoadState>;
    schemasByCatalog: Record<string, SparkSchema[]>;
    selectedCatalog?: string;
    selectedTable?: SelectedTable;
    setQuery: (value: string) => void;
    tableStates: Record<string, CatalogLoadState>;
    tablesBySchema: Record<string, SparkTable[]>;
}>) {
    const normalizedQuery = query.trim().toLowerCase();

    return (
        <aside className="catalog-browser">
            <div className="catalog-browser-header">
                <div className="catalog-tree-root-label">
                    <AppIcon icon={Book} size="status" />
                    <span>Catalogs</span>
                </div>
                <label className="catalog-search">
                    <AppIcon icon={Search} size="status" />
                    <input
                        aria-label="Search catalogs, schemas, and tables"
                        onChange={(event) => setQuery(event.target.value)}
                        placeholder="Search catalog objects"
                        type="search"
                        value={query}
                    />
                </label>
            </div>
            <div className="catalog-browser-body">
                {loadState.kind === 'loading' ? (
                    <div className="catalog-tree-blank" />
                ) : catalogs.length === 0 ? (
                    <div className="catalog-tree-empty">No catalogs returned by Polaris.</div>
                ) : (
                    <div className="catalog-tree-list">
                        {catalogs.map((catalog) => {
                            const schemas = schemasByCatalog[catalog.name] ?? [];
                            const schemasLoaded = schemasByCatalog[catalog.name] != null;
                            const catalogMatches = matchesQuery(normalizedQuery, catalog.name);
                            const visibleSchemas = schemas.filter((schema) => {
                                const key = namespaceKey(catalog.name, schema.name);
                                const tables = tablesBySchema[key] ?? [];
                                const tableSearchPending = normalizedQuery !== '' &&
                                    tablesBySchema[key] == null && tableStates[key]?.kind !== 'error';
                                return matchesQuery(normalizedQuery, catalog.name, schema.name) ||
                                    tables.some((table) => matchesQuery(
                                        normalizedQuery,
                                        catalog.name,
                                        schema.name,
                                        table.name,
                                    )) || tableSearchPending;
                            });
                            const schemaState = schemaStates[catalog.name];
                            const searchPending = normalizedQuery !== '' && (
                                (!schemasLoaded && schemaState?.kind !== 'error') ||
                                schemas.some((schema) => {
                                    const key = namespaceKey(catalog.name, schema.name);
                                    return tablesBySchema[key] == null && tableStates[key]?.kind !== 'error';
                                })
                            );
                            if (normalizedQuery !== '' && !catalogMatches && visibleSchemas.length === 0 && !searchPending) {
                                return null;
                            }
                            const expanded = expandedCatalogs.has(catalog.name) ||
                                (normalizedQuery !== '' && (catalogMatches || visibleSchemas.length > 0 || searchPending));
                            return (
                                <div className="catalog-tree-entry" key={catalog.name}>
                                    <div className={selectedCatalog === catalog.name ? 'catalog-tree-row selected' : 'catalog-tree-row'}>
                                        <button
                                            aria-label={`${expanded ? 'Collapse' : 'Expand'} catalog ${catalog.name}`}
                                            className="catalog-tree-expander"
                                            onClick={() => onToggleCatalog(catalog.name)}
                                            type="button"
                                        >
                                            <AppIcon icon={expanded ? ChevronDown : ChevronRight} size="status" />
                                        </button>
                                        <button
                                            className="catalog-tree-item"
                                            onClick={() => onSelectCatalog(catalog.name)}
                                            type="button"
                                        >
                                            <AppIcon icon={Book} size="status" />
                                            <span>{catalog.name}</span>
                                        </button>
                                    </div>
                                    {expanded && (
                                        <div className="catalog-tree-children">
                                            {schemaState?.kind === 'loading' ||
                                            (normalizedQuery !== '' && !schemasLoaded && schemaState?.kind !== 'error') ? (
                                                <div className="catalog-tree-loading" />
                                            ) : schemaState?.kind === 'error' ? (
                                                <div className="catalog-tree-error">{schemaState.message}</div>
                                            ) : visibleSchemas.length === 0 ? (
                                                <div className="catalog-tree-empty">No schemas returned.</div>
                                            ) : visibleSchemas.map((schema) => (
                                                <SchemaTreeEntry
                                                    expanded={expandedSchemas.has(namespaceKey(catalog.name, schema.name))}
                                                    key={namespaceKey(catalog.name, schema.name)}
                                                    normalizedQuery={normalizedQuery}
                                                    onSelectSchema={onSelectSchema}
                                                    onSelectTable={onSelectTable}
                                                    onToggleSchema={onToggleSchema}
                                                    schema={schema}
                                                    selectedTable={selectedTable}
                                                    tableState={tableStates[namespaceKey(catalog.name, schema.name)]}
                                                    tables={tablesBySchema[namespaceKey(catalog.name, schema.name)] ?? []}
                                                />
                                            ))}
                                        </div>
                                    )}
                                </div>
                            );
                        })}
                    </div>
                )}
            </div>
        </aside>
    );
}

function SchemaTreeEntry({
    expanded,
    normalizedQuery,
    onSelectSchema,
    onSelectTable,
    onToggleSchema,
    schema,
    selectedTable,
    tableState,
    tables,
}: Readonly<{
    expanded: boolean;
    normalizedQuery: string;
    onSelectSchema: (catalog: string, schema: string) => void;
    onSelectTable: (catalog: string, schema: string, table: string) => void;
    onToggleSchema: (catalog: string, schema: string) => void;
    schema: SparkSchema;
    selectedTable?: SelectedTable;
    tableState?: CatalogLoadState;
    tables: SparkTable[];
}>) {
    const visibleTables = tables.filter((table) =>
        matchesQuery(normalizedQuery, schema.catalog, schema.name, table.name),
    );
    const schemaMatches = matchesQuery(normalizedQuery, schema.catalog, schema.name);
    const tableSearchPending = normalizedQuery !== '' &&
        tables.length === 0 && tableState?.kind !== 'ready' && tableState?.kind !== 'error';
    const schemaKey = namespaceKey(schema.catalog, schema.name);
    const isExpanded = expanded ||
        (normalizedQuery !== '' && (schemaMatches || visibleTables.length > 0 || tableSearchPending));

    return (
        <div className="catalog-tree-entry">
            <div className="catalog-tree-row">
                <button
                    aria-label={`${isExpanded ? 'Collapse' : 'Expand'} schema ${schema.name}`}
                    className="catalog-tree-expander"
                    onClick={() => onToggleSchema(schema.catalog, schema.name)}
                    type="button"
                >
                    <AppIcon icon={isExpanded ? ChevronDown : ChevronRight} size="status" />
                </button>
                <button
                    className="catalog-tree-item"
                    onClick={() => onSelectSchema(schema.catalog, schema.name)}
                    type="button"
                >
                    <AppIcon icon={Database} size="status" />
                    <span>{schema.name}</span>
                </button>
            </div>
            {isExpanded && (
                <div className="catalog-tree-children catalog-tree-children--assets">
                    {tableState?.kind === 'loading' || tableSearchPending ? (
                        <div className="catalog-tree-loading" />
                    ) : tableState?.kind === 'error' ? (
                        <div className="catalog-tree-error">{tableState.message}</div>
                    ) : visibleTables.length === 0 ? (
                        <div className="catalog-tree-empty">No tables or views returned.</div>
                    ) : visibleTables.map((table) => {
                        const selected = selectedTable?.catalog === table.catalog &&
                            selectedTable.schema === table.schema &&
                            selectedTable.name === table.name;
                        return (
                            <button
                                className={selected ? 'catalog-tree-node selected' : 'catalog-tree-node'}
                                key={`${schemaKey}:${table.name}`}
                                onClick={() => onSelectTable(table.catalog, table.schema, table.name)}
                                type="button"
                            >
                                <DataAssetIcon kind={table.tableType === 'VIEW' ? 'view' : 'table'} />
                                <span>{table.name}</span>
                                <small>{tableTypeLabel(table.tableType)}</small>
                            </button>
                        );
                    })}
                </div>
            )}
        </div>
    );
}
