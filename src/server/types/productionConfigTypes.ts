/**
 * @fileoverview Runtime configuration contract for the standalone server.
 */

import type { PostgresConfig } from './postgresConfigTypes.ts';
import type { CatalogBackend } from './catalogServiceTypes.ts';

/** Runtime configuration required by the standalone control-plane server. */
export interface ProductionConfig {
    aistorWebhookToken: string;
    catalogBackend?: CatalogBackend;
    drainMilliseconds: number;
    host: string;
    port: number;
    postgres?: PostgresConfig;
    sparkDriverHost: string;
    sparkExecutorPython?: string;
    sparkHistoryUrl?: string;
    sparkMasterUrl: string;
    sparkPropertiesFile?: string;
    staticDirectory: string;
}
