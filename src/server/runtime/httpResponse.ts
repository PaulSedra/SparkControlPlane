/**
 * @fileoverview Shared response serialization and HTTP boundary safeguards.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { sanitizeFields } from '../utils/sanitization.ts';

type AsyncRequestHandler = (
    request: IncomingMessage,
    response: ServerResponse,
) => Promise<void>;

/** Applies the security headers shared by standalone HTTP responses. */
export function setSecurityHeaders(response: ServerResponse): void {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('X-Frame-Options', 'DENY');
    response.setHeader('Referrer-Policy', 'no-referrer');
}

/** Sends JSON after redacting sensitive fields in externally returned data. */
export function sendJson(
    response: ServerResponse,
    statusCode: number,
    value: unknown,
): void {
    response.statusCode = statusCode;
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.end(JSON.stringify(sanitizeFields(value)));
}

/** Logs an unexpected request failure and closes the response safely. */
export function handleUnexpectedRequestError(
    response: ServerResponse,
    error: unknown,
    logError: (error: unknown) => void = (failure) =>
        console.error('Unexpected HTTP request failure', failure),
): void {
    logError(error);
    if (response.headersSent) {
        if (!response.destroyed) {
            response.destroy();
        }
        return;
    }
    if (!response.writableEnded) {
        sendJson(response, 500, {
            code: 'INTERNAL_SERVER_ERROR',
            message: 'An unexpected error occurred.',
        });
    }
}

/** Adapts an async handler to Node's callback without leaving rejections unhandled. */
export function createHttpRequestListener(
    requestHandler: AsyncRequestHandler,
    logError?: (error: unknown) => void,
): (request: IncomingMessage, response: ServerResponse) => void {
    return (request, response) => {
        void requestHandler(request, response).catch((error: unknown) => {
            handleUnexpectedRequestError(response, error, logError);
        });
    };
}

/** Returns whether a caught value is a Node filesystem or socket error. */
export function isNodeError(error: unknown): error is NodeJS.ErrnoException {
    return error instanceof Error &&
        'code' in error &&
        typeof error.code === 'string';
}
