/**
 * @fileoverview Composes services, HTTP routing, and process lifecycle.
 */

import fs from 'node:fs/promises';
import {
    createServer,
    type Server,
} from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPipelineHttpHandler } from '../api/pipelineRegistryHttp.ts';
import { createCatalogService } from '../catalog/catalogServiceFactory.ts';
import { loadProductionConfig } from '../config/productionConfig.ts';
import { createPipelineRegistryService } from '../pipeline/pipelineRegistryService.ts';
import type { CatalogService } from '../types/catalogServiceTypes.ts';
import type { PipelineRegistryService } from '../types/pipelineServiceTypes.ts';
import type { PostgresConfig } from '../types/postgresConfigTypes.ts';
import type { ProductionConfig } from '../types/productionConfigTypes.ts';
import { createHealthHandler } from './healthHandler.ts';
import { createHttpRequestListener } from './httpResponse.ts';
import { createRequestHandler } from './requestHandler.ts';

/** Lifecycle handles exposed by the standalone control-plane server. */
export interface StandaloneControlPlane {
    close: () => Promise<void>;
    server: Server;
    start: () => Promise<void>;
}

/** Options for constructing caller-owned or server-owned service instances. */
export interface StandaloneServerOptions {
    catalogService?: CatalogService;
    catalogServiceFactory?: () => CatalogService;
    config?: ProductionConfig;
    polarisPostgresConfig?: PostgresConfig;
    service?: PipelineRegistryService;
    serviceFactory?: () => PipelineRegistryService;
}

/**
 * Creates the production HTTP composition root.
 *
 * Services passed directly are caller-owned and must be initialized before
 * `start`. Services returned by factories, or created by default, are
 * initialized and shut down by this server.
 */
export function createStandaloneControlPlane(
    options: StandaloneServerOptions = {},
): StandaloneControlPlane {
    if (options.service != null && options.serviceFactory != null) {
        throw new Error('Provide either service or serviceFactory, not both.');
    }
    if (options.catalogService != null && options.catalogServiceFactory != null) {
        throw new Error('Provide either catalogService or catalogServiceFactory, not both.');
    }

    const config = options.config ?? loadProductionConfig();
    const ownsService = options.service == null;
    const service = options.service ?? options.serviceFactory?.() ?? createPipelineRegistryService({
        postgresConfig: config.postgres,
        sparkConnectUrl: config.sparkConnectUrl,
    });
    const ownsCatalogService = options.catalogService == null;
    const catalogService = options.catalogService ??
        options.catalogServiceFactory?.() ??
        createCatalogService({
            backend: config.catalogBackend ?? 'polaris',
            postgresConfig: options.polarisPostgresConfig ?? config.postgres,
            sparkConnectUrl: config.sparkConnectUrl,
        });
    const apiHandler = createPipelineHttpHandler({
        pipelineService: service,
        catalogService,
        options: {
            aistorWebhookToken: config.aistorWebhookToken,
        },
    });

    let initialized = false;
    let shuttingDown = false;
    let startPromise: Promise<void> | undefined;
    let closePromise: Promise<void> | undefined;
    let resourceShutdownPromise: Promise<void> | undefined;

    const healthHandler = createHealthHandler(
        () => ({ initialized, shuttingDown }),
        service.readinessSnapshot,
    );
    const requestHandler = createRequestHandler({
        apiHandler,
        healthHandler,
        sparkHistoryUrl: config.sparkHistoryUrl,
        staticDirectory: config.staticDirectory,
    });
    const server = createServer(createHttpRequestListener(requestHandler));

    return {
        close,
        server,
        start,
    };

    function start(): Promise<void> {
        if (shuttingDown || closePromise != null) {
            return Promise.reject(new Error('The standalone server is already closing.'));
        }
        if (startPromise != null) {
            return startPromise;
        }
        startPromise = startServer().catch(async (error: unknown) => {
            initialized = false;
            shuttingDown = true;
            try {
                await shutdownOwnedResources();
            } catch (cleanupError) {
                console.error('Standalone startup cleanup failed', cleanupError);
            }
            throw error;
        });
        return startPromise;
    }

    function close(): Promise<void> {
        if (closePromise != null) {
            return closePromise;
        }
        shuttingDown = true;
        closePromise = (async () => {
            if (startPromise != null) {
                try {
                    await startPromise;
                } catch {
                    // Startup already reported the original failure.
                }
            }
            initialized = false;
            await shutdownOwnedResources();
        })();
        return closePromise;
    }

    async function startServer(): Promise<void> {
        await assertStaticBuild(config.staticDirectory);
        if (ownsService) {
            await service.initialize();
        } else if (!service.readinessSnapshot().initialized) {
            throw new Error('An injected pipeline service must be initialized before start.');
        }
        if (shuttingDown) {
            throw new Error('The standalone server is closing.');
        }
        await listen(server, config.host, config.port);
        if (shuttingDown) {
            throw new Error('The standalone server is closing.');
        }
        initialized = true;
    }

    function shutdownOwnedResources(): Promise<void> {
        if (resourceShutdownPromise != null) {
            return resourceShutdownPromise;
        }
        resourceShutdownPromise = closeResources();
        return resourceShutdownPromise;
    }

    async function closeResources(): Promise<void> {
        const errors: unknown[] = [];
        try {
            await closeHttpServer(server);
        } catch (error) {
            errors.push(error);
        }

        const shutdowns: Array<() => Promise<void>> = [];
        if (ownsService) {
            shutdowns.push(() => service.shutdown(config.drainMilliseconds));
        }
        if (ownsCatalogService && catalogService.shutdown != null) {
            shutdowns.push(() => catalogService.shutdown?.() ?? Promise.resolve());
        }
        const results = await Promise.allSettled(
            shutdowns.map(async (shutdown) => shutdown()),
        );
        for (const result of results) {
            if (result.status === 'rejected') {
                errors.push(result.reason);
            }
        }
        if (errors.length > 0) {
            throw new AggregateError(errors, 'Standalone server shutdown failed.');
        }
    }
}

async function assertStaticBuild(staticDirectory: string): Promise<void> {
    try {
        await fs.access(path.join(staticDirectory, 'index.html'));
    } catch {
        throw new Error(
            `Built UI not found at ${path.join(staticDirectory, 'index.html')}. Run npm run build before npm run start.`,
        );
    }
}

function listen(server: Server, host: string, port: number): Promise<void> {
    return new Promise((resolve, reject) => {
        const cleanup = () => {
            server.off('error', onError);
            server.off('listening', onListening);
        };
        const onError = (error: Error) => {
            cleanup();
            reject(error);
        };
        const onListening = () => {
            cleanup();
            resolve();
        };
        server.once('error', onError);
        server.once('listening', onListening);
        try {
            server.listen(port, host);
        } catch (error) {
            cleanup();
            reject(error);
        }
    });
}

function closeHttpServer(server: Server): Promise<void> {
    if (!server.listening) {
        return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
        server.close((error) => error == null ? resolve() : reject(error));
    });
}

function isMainModule(moduleUrl: string): boolean {
    return process.argv[1] != null &&
        path.resolve(process.argv[1]) === path.resolve(fileURLToPath(moduleUrl));
}

if (isMainModule(import.meta.url)) {
    try {
        const controlPlane = createStandaloneControlPlane();
        await controlPlane.start();
        const address = controlPlane.server.address();
        const listeningAddress = typeof address === 'object' && address != null
            ? `${address.address}:${address.port}`
            : String(address);
        console.log(`Spark Control Plane listening on ${listeningAddress}`);

        const close = (signal: string) => {
            console.log(`Received ${signal}; draining control-plane work.`);
            void controlPlane.close().catch((error: unknown) => {
                console.error('Standalone server shutdown failed', error);
                process.exitCode = 1;
            });
        };
        process.once('SIGTERM', () => close('SIGTERM'));
        process.once('SIGINT', () => close('SIGINT'));
    } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
    }
}
