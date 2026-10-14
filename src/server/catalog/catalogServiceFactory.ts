/**
 * @fileoverview Creates the configured catalog adapter while keeping each backend's ownership separate.
 */

import type { CatalogBackend, CatalogService } from '../types/catalogServiceTypes.ts';
import type { PostgresConfig } from '../types/postgresConfigTypes.ts';
import { createPolarisCatalogService } from './polarisCatalogService.ts';
import { createSparkCatalogService } from './sparkCatalogService.ts';

/** Options used to create the configured catalog service. */
export interface CatalogServiceFactoryOptions {
    backend: CatalogBackend;
    polarisPostgresConfig?: PostgresConfig;
    postgresConfig?: PostgresConfig;
    sparkConnectUrl?: string;
}

/**
 * Creates a catalog adapter backed by either Polaris metadata or Spark Connect.
 * The Spark backend is useful for local development where the built-in
 * `spark_catalog` is the only catalog available.
 */
export function createCatalogService(
    options: CatalogServiceFactoryOptions,
): CatalogService {
    if (options.backend === 'spark') {
        return createSparkCatalogService({
            sparkConnectUrl: options.sparkConnectUrl,
        });
    }
    return createPolarisCatalogService({
        postgresConfig: options.polarisPostgresConfig ?? options.postgresConfig,
        sparkConnectUrl: options.sparkConnectUrl,
    });
}
