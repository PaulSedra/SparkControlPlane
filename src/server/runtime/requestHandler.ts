/**
 * @fileoverview Routes standalone HTTP requests to focused endpoint handlers.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { handleApiDocumentationRequest } from '../api/apiDocumentation.ts';
import { prometheusMetrics } from '../observability/observability.ts';
import { createSparkMonitoringProxy } from './sparkMonitoringProxy.ts';
import { createStaticFileHandler } from './staticFileHandler.ts';
import { setSecurityHeaders } from './httpResponse.ts';

type ApiRequestHandler = (
    request: IncomingMessage,
    response: ServerResponse,
) => Promise<void>;

type HealthRequestHandler = (
    request: IncomingMessage,
    response: ServerResponse,
) => boolean;

/** Dependencies used to compose standalone route handling. */
export interface RequestHandlerOptions {
    apiHandler: ApiRequestHandler;
    healthHandler: HealthRequestHandler;
    sparkHistoryUrl?: string;
    staticDirectory: string;
}

/** Creates the route dispatcher used by the standalone Node server. */
export function createRequestHandler(
    options: RequestHandlerOptions,
): ApiRequestHandler {
    const staticFileHandler = createStaticFileHandler(options.staticDirectory);
    const sparkMonitoringProxy = createSparkMonitoringProxy(options.sparkHistoryUrl);

    return async (request, response) => {
        setSecurityHeaders(response);
        const url = new URL(request.url ?? '/', 'http://localhost');
        if (await handleApiDocumentationRequest(request, response)) {
            return;
        }
        if (options.healthHandler(request, response)) {
            return;
        }
        if (url.pathname === '/metrics') {
            response.statusCode = 200;
            response.setHeader('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
            response.end(prometheusMetrics());
            return;
        }
        if (isSparkMonitoringPath(url.pathname)) {
            await sparkMonitoringProxy(request, response);
            return;
        }
        if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
            await options.apiHandler(request, response);
            return;
        }
        await staticFileHandler(request, response);
    };
}

function isSparkMonitoringPath(pathname: string): boolean {
    return pathname === '/spark-api' || pathname.startsWith('/spark-api/');
}
