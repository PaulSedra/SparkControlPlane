/**
 * @fileoverview Server-side catalog adapter and construction option contracts.
 */

import type {
    SparkCatalog,
    SparkSampleData,
    SparkSchema,
    SparkTable,
    SparkTableDetail,
} from '../../shared/catalogTypes.ts';

/** Catalog hierarchy source used by the catalog API. */
export type CatalogBackend = 'polaris' | 'spark';

/** Server-side adapter for Spark catalog listing and bounded table samples. */
export interface CatalogService {
    getTable: (
        catalog: string,
        schema: string,
        table: string,
    ) => Promise<SparkTableDetail>;
    getTableData: (
        catalog: string,
        schema: string,
        table: string,
        limit: number,
    ) => Promise<SparkSampleData>;
    listCatalogs: () => Promise<SparkCatalog[]>;
    listSchemas: (catalog: string) => Promise<SparkSchema[]>;
    listTables: (catalog: string, schema: string) => Promise<SparkTable[]>;
    shutdown?: () => Promise<void>;
}

/** Optional runtime settings used when constructing a catalog adapter. */
export interface CatalogServiceOptions {
    pythonExecutable?: string;
    sparkConnectUrl?: string;
}
