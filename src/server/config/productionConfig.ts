/**
 * @fileoverview Resolves standalone-server and Spark Standalone settings.
 */

import { integerValue } from './configValues.ts';
import { loadCatalogBackend } from './catalogBackendConfig.ts';
import path from 'node:path';
import { loadPostgresConfig } from './postgresConfig.ts';
import type { ProductionConfig } from '../types/productionConfigTypes.ts';

/**
 * Loads the standalone server's required runtime contract from environment
 * variables. Pipeline runs are submitted to the configured Spark Standalone
 * master for pipeline, catalog, and preview work.
 */
export function loadProductionConfig(
    environment: NodeJS.ProcessEnv = process.env,
): ProductionConfig {
    const pipelinesDirectory = requiredValue(environment, 'PIPELINES_DIR');
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
    const sparkMasterUrl = requiredValue(
        environment,
        'SPARK_MASTER_URL',
        'SPARK_MASTER_URL is required for all Spark applications.',
    );
    if (!sparkMasterUrl.startsWith('spark://') || /\s/.test(sparkMasterUrl)) {
        throw new Error('SPARK_MASTER_URL must be a Spark Standalone URL such as spark://spark-master:7077.');
    }
    const sparkDriverHost = requiredValue(
        environment,
        'SPARK_DRIVER_HOST',
        'SPARK_DRIVER_HOST must be reachable from Spark workers for client-mode execution.',
    );
    if (/\s/.test(sparkDriverHost)) {
        throw new Error('SPARK_DRIVER_HOST must be a host or IP address without whitespace.');
    }
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
        sparkDriverHost,
        sparkExecutorPython: environment.SPARK_EXECUTOR_PYTHON?.trim() || 'python3',
        sparkHistoryUrl: environment.SPARK_HISTORY_URL?.trim() || undefined,
        sparkMasterUrl,
        sparkPropertiesFile: environment.SPARK_CLI_PROPERTIES_FILE?.trim() || undefined,
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
