/**
 * @fileoverview Resolves standalone-server settings, including the mounted
 * pipeline directory and Spark execution endpoint.
 */

import { integerValue } from './configValues.ts';
import { loadCatalogBackend } from './catalogBackendConfig.ts';
import path from 'node:path';
import {
    loadPostgresConfig,
} from './postgresConfig.ts';
import type { ProductionConfig } from '../types/productionConfigTypes.ts';

/**
 * Loads the standalone server's required runtime contract from environment
 * variables.
 *
 * A production process cannot serve useful pipeline requests without a
 * mounted pipeline directory, Spark Connect endpoint, AIStor webhook token,
 * and PostgreSQL configuration, so those values fail fast instead of being
 * deferred to the first request. The function also normalizes the pipeline
 * and static paths, converts the drain timeout from seconds to milliseconds,
 * and updates `process.env.PIPELINES_DIR` because downstream discovery reads
 * that process-wide setting. Callers should invoke it once during startup;
 * it validates configuration but does not open external connections.
 */
export function loadProductionConfig(
    environment: NodeJS.ProcessEnv = process.env,
): ProductionConfig {
    const pipelinesDirectory = requiredValue(environment, 'PIPELINES_DIR');
    const sparkConnectUrl = environment.SPARK_CONNECT_URL?.trim();
    if (!sparkConnectUrl) {
        throw new Error(
            'SPARK_CONNECT_URL is required and must be a Spark Connect URL such as sc://spark-connect:15002.',
        );
    }
    process.env.PIPELINES_DIR = path.resolve(pipelinesDirectory);
    const port = integerValue(
        environment.CONTROL_PLANE_PORT,
        'CONTROL_PLANE_PORT',
        8080,
        1,
        65535,
    );
    const aistorWebhookToken = requiredValue(
        environment,
        'AISTOR_WEBHOOK_TOKEN',
        'AISTOR_WEBHOOK_TOKEN is required. Set it to the raw token configured for the AIStor webhook Authorization header.',
    );
    const postgres = loadPostgresConfig(environment);

    return {
        aistorWebhookToken,
        catalogBackend: loadCatalogBackend(environment),
        drainMilliseconds: integerValue(
            environment.CONTROL_PLANE_DRAIN_SECONDS,
            'CONTROL_PLANE_DRAIN_SECONDS',
            30,
            0,
            3600,
        ) * 1000,
        host: environment.CONTROL_PLANE_HOST?.trim() || '0.0.0.0',
        port,
        postgres,
        sparkHistoryUrl: environment.SPARK_HISTORY_URL?.trim() ||
            undefined,
        sparkConnectUrl,
        staticDirectory: path.resolve(
            environment.CONTROL_PLANE_STATIC_DIR?.trim() || 'dist',
        ),
    };
}

function requiredValue(
    environment: NodeJS.ProcessEnv,
    name: string,
    message = `${name} is required. Set it to the container path containing mounted pipeline projects.`,
): string {
    const value = environment[name]?.trim();
    if (!value) {
        throw new Error(message);
    }
    return value;
}
