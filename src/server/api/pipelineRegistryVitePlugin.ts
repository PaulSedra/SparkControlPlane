/**
 * @fileoverview Vite development-server adapter that mounts the shared
 * pipeline HTTP handler.
 */

import type { ViteDevServer } from 'vite';
import { handleApiDocumentationRequest } from './apiDocumentation.ts';
import { createPipelineHttpHandler } from './pipelineRegistryHttp.ts';
import { createPipelineRegistryService } from '../pipeline/pipelineRegistryService.ts';
import type { PipelineRegistryServiceOptions } from '../types/pipelineServiceTypes.ts';
import { loadCatalogBackend } from '../config/catalogBackendConfig.ts';
import { createCatalogService } from '../catalog/catalogServiceFactory.ts';
import type { CatalogBackend, CatalogService } from '../types/catalogServiceTypes.ts';
import type { PostgresConfig } from '../types/postgresConfigTypes.ts';

/** Options used to construct the Vite API plugin. */
export interface PipelineRegistryApiPluginOptions extends PipelineRegistryServiceOptions {
    aistorWebhookToken?: string;
    catalogBackend?: CatalogBackend;
    catalogService?: CatalogService;
    polarisPostgresConfig?: PostgresConfig;
}

/**
 * Registers the shared control-plane API with a Vite development server.
 *
 * The plugin creates one registry service and catalog adapter for the server
 * lifetime, mounts the same HTTP handler used by the standalone process, and
 * starts persistence recovery asynchronously after middleware is installed.
 * API documentation is handled before registry routing so the development
 * server can serve both the OpenAPI contract and the application API. When
 * Vite closes, the plugin stops the service and invokes the catalog adapter's
 * optional shutdown hook; callers supplying an adapter should account for
 * that lifecycle call.
 */
export function pipelineRegistryApiPlugin(
    options: PipelineRegistryApiPluginOptions = {},
) {
    return {
        name: 'spark-control-plane-pipeline-registry-api',
        configureServer(server: ViteDevServer) {
            const service = createPipelineRegistryService(options);
            const catalogService = options.catalogService ?? createCatalogService({
                backend: options.catalogBackend ?? loadCatalogBackend(process.env),
                postgresConfig: options.polarisPostgresConfig ?? options.postgresConfig,
                sparkConnectUrl: options.sparkConnectUrl,
            });
            const handler = createPipelineHttpHandler({
                pipelineService: service,
                catalogService,
                options: {
                    aistorWebhookToken: options.aistorWebhookToken ??
                        process.env.AISTOR_WEBHOOK_TOKEN?.trim(),
                },
            });
            server.middlewares.use((request, response, next) => {
                void handleApiDocumentationRequest(request, response).then((handled) => {
                    if (!handled) {
                        return handler(request, response, next);
                    }
                    return undefined;
                }).catch(next);
            });
            void service.initialize().catch((error: unknown) => {
                const detail = error instanceof Error ? error.message : String(error);
                console.error(`Run recovery failed: ${detail}`);
            });
            server.httpServer?.once('close', () => {
                void Promise.all([
                    service.shutdown(0),
                    catalogService.shutdown?.(),
                ]);
            });
        },
    };
}
