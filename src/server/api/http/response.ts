/**
 * @fileoverview Common JSON serialization and sanitized API error responses.
 */

import type { ServerResponse } from 'node:http';
import { ControlPlaneApiError } from '../../errors/controlPlaneApiError.ts';
import { publicErrorMessage, sanitizeFields } from '../../utils/sanitization.ts';

/** Maps API and unexpected failures to a sanitized JSON error response. */
export function sendError(response: ServerResponse, error: unknown): void {
    const apiError = error instanceof ControlPlaneApiError ? error : undefined;
    const statusCode = apiError?.statusCode ?? 500;
    sendJson(response, statusCode, {
        code: apiError?.applicationCode ?? errorCode(statusCode),
        message: publicErrorMessage(error),
    });
}

function errorCode(statusCode: number): string {
    switch (statusCode) {
        case 400:
            return 'INVALID_REQUEST';
        case 401:
            return 'UNAUTHORIZED';
        case 404:
            return 'NOT_FOUND';
        case 405:
            return 'METHOD_NOT_ALLOWED';
        case 409:
            return 'CONFLICT';
        case 413:
            return 'PAYLOAD_TOO_LARGE';
        case 503:
            return 'SERVICE_UNAVAILABLE';
        default:
            return 'INTERNAL_ERROR';
    }
}

/**
 * Writes a sanitized JSON response with the requested status and optional cache policy.
 * If the response has already ended, this is a no-op.
 */
export function sendJson(
    response: ServerResponse,
    statusCode: number,
    value: unknown,
    cacheControl?: string,
): void {
    if (response.writableEnded) {
        return;
    }
    response.statusCode = statusCode;
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    if (cacheControl != null) {
        response.setHeader('Cache-Control', cacheControl);
    }
    response.end(JSON.stringify(sanitizeFields(value)));
}

/** Sets run Location and Retry-After headers, adding the replay marker for idempotent replays. */
export function setRunHeaders(
    response: ServerResponse,
    runId: string,
    replayed: boolean,
): void {
    response.setHeader('Location', '/api/v1/runs/' + encodeURIComponent(runId));
    response.setHeader('Retry-After', '1');
    if (replayed) {
        response.setHeader('Idempotent-Replayed', 'true');
    }
}
