/** @fileoverview Read-only Spark query requests shared by catalog and preview adapters. */

/** One bounded, read-only query submitted to the configured Spark cluster. */
export type SparkQueryRequest =
    | { command: 'catalogs'; maximumResponseBytes?: number }
    | { command: 'schemas'; catalog: string; maximumResponseBytes?: number }
    | { command: 'tables'; catalog: string; schema: string; maximumResponseBytes?: number }
    | {
        command: 'detail';
        catalog: string;
        schema: string;
        table: string;
        maximumResponseBytes?: number;
    }
    | {
        command: 'sample';
        catalog: string;
        schema: string;
        table: string;
        limit: number;
        maximumResponseBytes?: number;
    }
    | { command: 'preview'; qualifiedName: string; limit: number; maximumResponseBytes?: number };

/** Submits one bounded Spark application and returns its JSON result. */
export interface SparkQueryService {
    query: (request: SparkQueryRequest, signal?: AbortSignal) => Promise<unknown>;
}
