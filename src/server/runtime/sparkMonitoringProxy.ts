/**
 * @fileoverview Proxies Spark History requests through the public monitoring route.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { publicErrorMessage } from '../utils/sanitization.ts';
import { sendJson } from './httpResponse.ts';

const DEFAULT_TIMEOUT_MILLISECONDS = 30_000;

/** Fetch and timeout dependencies for a Spark monitoring proxy instance. */
export interface SparkMonitoringProxyOptions {
    fetch?: typeof fetch;
    timeoutMilliseconds?: number;
}

/** Creates a proxy that maps /spark-api paths to Spark History /api/v1. */
export function createSparkMonitoringProxy(
    sparkHistoryUrl: string | undefined,
    options: SparkMonitoringProxyOptions = {},
): (request: IncomingMessage, response: ServerResponse) => Promise<void> {
    const fetchUpstream = options.fetch ?? fetch;
    const timeoutMilliseconds = Math.max(
        1,
        options.timeoutMilliseconds ?? DEFAULT_TIMEOUT_MILLISECONDS,
    );

    return async (request, response) => {
        if (sparkHistoryUrl == null || sparkHistoryUrl.trim() === '') {
            sendJson(response, 503, {
                code: 'MONITORING_NOT_CONFIGURED',
                message: 'SPARK_HISTORY_URL is not configured.',
            });
            return;
        }

        const incomingUrl = new URL(request.url ?? '/', 'http://localhost');
        const target = new URL(sparkHistoryUrl);
        const suffix = incomingUrl.pathname.slice('/spark-api'.length);
        target.pathname = `/api/v1${suffix}`;
        target.search = incomingUrl.search;

        try {
            const upstream = await fetchUpstream(target, {
                headers: { accept: request.headers.accept ?? 'application/json' },
                method: request.method ?? 'GET',
                signal: AbortSignal.timeout(timeoutMilliseconds),
            });
            const body = request.method === 'HEAD'
                ? undefined
                : Buffer.from(await upstream.arrayBuffer());
            response.statusCode = upstream.status;
            response.setHeader(
                'Content-Type',
                upstream.headers.get('content-type') ?? 'application/json',
            );
            if (body != null) {
                response.setHeader('Content-Length', body.byteLength);
            }
            response.end(body);
        } catch (error) {
            sendJson(response, 502, {
                code: 'MONITORING_UNAVAILABLE',
                message: publicErrorMessage(error),
            });
        }
    };
}
