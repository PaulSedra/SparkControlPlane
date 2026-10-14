/**
 * @fileoverview HTTP request mechanics shared by the API route adapter.
 */

import crypto from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { ControlPlaneApiError } from '../../errors/controlPlaneApiError.ts';

/** Enforces the method allow-list, setting Allow and throwing a 405 API error on mismatch. */
export function requireMethod(
    request: IncomingMessage,
    response: ServerResponse,
    allowedMethods: string[],
): void {
    if (request.method != null && allowedMethods.includes(request.method)) {
        return;
    }
    response.setHeader('Allow', allowedMethods.join(', '));
    throw new ControlPlaneApiError(405, 'Method not allowed');
}

/** Returns the first trimmed header value, treating missing or blank values as undefined. */
export function requestHeader(
    request: IncomingMessage,
    name: string,
): string | undefined {
    const value = request.headers[name];
    return (Array.isArray(value) ? value[0] : value)?.trim() || undefined;
}

/**
 * Reuses a safe X-Correlation-ID or creates a UUID.
 * Malformed supplied IDs produce a 400 API error.
 */
export function requestCorrelationId(request: IncomingMessage): string {
    const value = requestHeader(request, 'x-correlation-id');
    if (value == null) {
        return crypto.randomUUID();
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) {
        throw new ControlPlaneApiError(400, 'X-Correlation-ID must contain only safe token characters.');
    }
    return value;
}

/**
 * Consumes and parses a JSON request body, treating an empty body as an empty object.
 * Buffering is capped at 1 MiB; oversized or malformed input becomes a 413 or 400 API error.
 */
export async function readJsonBody(request: IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += buffer.length;
        if (size > 1024 * 1024) {
            throw new ControlPlaneApiError(413, 'Request body exceeds 1 MiB.');
        }
        chunks.push(buffer);
    }
    if (chunks.length === 0) {
        return {};
    }
    try {
        return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
        throw new ControlPlaneApiError(400, 'Request body must be valid JSON.');
    }
}

/** Removes one trailing slash from a non-root request path for route matching. */
export function normalizedPath(path: string): string {
    return path.length > 1 ? path.replace(/\/$/, '') : path;
}

/** Decodes one URL segment and converts malformed percent encoding into a 400 API error. */
export function decodeSegment(value: string): string {
    try {
        return decodeURIComponent(value);
    } catch {
        throw new ControlPlaneApiError(400, 'Path contains invalid percent encoding.');
    }
}
