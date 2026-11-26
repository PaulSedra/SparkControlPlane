/**
 * @fileoverview Creates the configured catalog adapter while keeping each backend's ownership separate.
 */

import type { CatalogBackend, CatalogService } from '../types/catalogServiceTypes.ts';
import type { SparkQueryService } from '../types/sparkQueryServiceTypes.ts';
import type { PostgresConfig } from '../types/postgresConfigTypes.ts';
import { createPolarisCatalogService } from './polarisCatalogService.ts';
import { createSparkCatalogService } from './sparkCatalogService.ts';

/** Options used to create the configured catalog service. */
export interface CatalogServiceFactoryOptions {
    backend: CatalogBackend;
    polarisPostgresConfig?: PostgresConfig;
    postgresConfig?: PostgresConfig;
    queryService?: SparkQueryService;
}

/**
 * Creates a catalog adapter backed by Polaris metadata or Spark Standalone.
 * The Spark backend exposes its configured catalog hierarchy.
 */
export function createCatalogService(
    options: CatalogServiceFactoryOptions,
): CatalogService {
    if (options.backend === 'spark') {
        return createSparkCatalogService(options.queryService);
    }
    return createPolarisCatalogService({
        postgresConfig: options.polarisPostgresConfig ?? options.postgresConfig,
        queryService: options.queryService,
    });
}
