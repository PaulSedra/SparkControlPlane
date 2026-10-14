/**
 * @fileoverview Shared transport boundary for pipeline registry HTTP routes.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { CatalogService } from '../types/catalogServiceTypes.ts';
import type { PipelineRegistryService } from '../types/pipelineServiceTypes.ts';
import { routeCatalogRequest } from './routes/catalogRoutes.ts';
import { routeHistoryRequest } from './routes/historyRoutes.ts';
import { routePipelineRequest } from './routes/pipelineRoutes.ts';
import { routeRunRequest } from './routes/runRoutes.ts';
import { routeTriggerRequest } from './routes/triggerRoutes.ts';
import {
    normalizedPath,
    requestCorrelationId,
    requestHeader,
} from './http/request.ts';
import { sendError, sendJson } from './http/response.ts';
import type {
    NextFunction,
    PipelineHttpDependencies,
    PipelineHttpHandlerOptions,
} from './httpTypes.ts';

interface VersionedRequestContext {
    correlationId: string;
    path: string;
    request: IncomingMessage;
    requestSource: string | undefined;
    response: ServerResponse;
    url: URL;
}

/**
 * Creates the shared HTTP adapter used by Vite and the standalone server.
 *
 * Route groups own endpoint-specific validation and service calls. This
 * boundary adds a correlation ID, serializes sanitized errors, and delegates
 * unknown paths to host middleware when available (otherwise returning JSON
 * 404). The host remains responsible for service initialization and shutdown.
 */
export function createPipelineHttpHandler({
    pipelineService,
    catalogService,
    options = {},
}: PipelineHttpDependencies) {
    return async function pipelineHttpHandler(
        request: IncomingMessage,
        response: ServerResponse,
        next?: NextFunction,
    ): Promise<void> {
        try {
            const handled = await routeRequest(
                pipelineService,
                catalogService,
                request,
                response,
                options,
            );
            if (!handled) {
                if (next != null) {
                    next();
                } else {
                    sendJson(response, 404, {
                        code: 'NOT_FOUND',
                        message: 'API route not found.',
                    });
                }
            }
        } catch (error) {
            sendError(response, error);
        }
    };
}

async function routeRequest(
    service: PipelineRegistryService,
    catalogService: CatalogService,
    request: IncomingMessage,
    response: ServerResponse,
    options: PipelineHttpHandlerOptions,
): Promise<boolean> {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const path = normalizedPath(url.pathname);
    const correlationId = requestCorrelationId(request);
    response.setHeader('X-Correlation-ID', correlationId);
    const requestSource = requestHeader(request, 'x-request-source');

    return routeVersionedRequest(
        service,
        catalogService,
        { correlationId, path, request, requestSource, response, url },
        options,
    );
}

async function routeVersionedRequest(
    service: PipelineRegistryService,
    catalogService: CatalogService,
    context: VersionedRequestContext,
    options: PipelineHttpHandlerOptions,
): Promise<boolean> {
    const { correlationId, path, request, requestSource, response, url } = context;
    if (await routeCatalogRequest(catalogService, request, response, url, path)) {
        return true;
    }
    if (await routeHistoryRequest(service, request, response, url, path)) {
        return true;
    }
    if (await routeTriggerRequest(service, request, response, url, path, options)) {
        return true;
    }
    if (await routeRunRequest(service, request, response, url, path, correlationId, requestSource)) {
        return true;
    }
    return routePipelineRequest(
        service,
        request,
        response,
        url,
        path,
        correlationId,
        requestSource,
    );
}
