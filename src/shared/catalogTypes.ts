/**
 * @fileoverview Shared catalog and bounded table-sample contracts.
 */

/** Identifies the catalog object kind exposed by the control plane. */
export type SparkCatalogObjectType = 'TABLE' | 'UNKNOWN' | 'VIEW';

/** A catalog returned by the Spark catalog adapter. */
export interface SparkCatalog {
    id?: string;
    name: string;
}

/** A schema returned by the Spark catalog adapter. */
export interface SparkSchema {
    catalog: string;
    id?: string;
    name: string;
}

/** A table or view listed in a Spark schema. */
export interface SparkTable {
    catalog: string;
    id?: string;
    isTemporary: boolean;
    name: string;
    schema: string;
    tableType: SparkCatalogObjectType;
}

/** A column in a catalog table, including an optional provider comment. */
export interface SparkColumn {
    comment?: string;
    name: string;
    type: string;
}

/** Detailed metadata for a Spark table or view. */
export interface SparkTableDetail extends SparkTable {
    comment?: string;
    columns: SparkColumn[];
    location?: string;
    partitionColumns?: string[];
    properties: Record<string, string>;
    provider?: string;
    viewDefinition?: string;
}

/** A bounded, JSON-ready sample returned for a selected table. */
export interface SparkSampleData {
    columns: Array<{
        name: string;
        type: string;
    }>;
    rows: unknown[][];
    truncated?: boolean;
    truncation?: {
        maximumResponseBytes?: number;
        maximumRows: number;
        reason: 'max_response_bytes' | 'row_limit';
    };
}
