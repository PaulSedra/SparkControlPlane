/**
 * @fileoverview Authorization checks for external API integrations.
 */

import crypto from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { ControlPlaneApiError } from '../../errors/controlPlaneApiError.ts';
import { requestHeader } from './request.ts';

/**
 * Requires a configured Bearer token for AIStor ingestion and compares it without content-dependent timing.
 * Missing server configuration produces 503; an invalid request receives WWW-Authenticate and 401.
 */
export function requireAistorAuthorization(
    request: IncomingMessage,
    response: ServerResponse,
    expectedToken: string | undefined,
): void {
    if (expectedToken == null || expectedToken.trim() === '') {
        throw new ControlPlaneApiError(
            503,
            'AISTOR_NOT_CONFIGURED',
            'AIStor authorization is not configured.',
        );
    }
    if (bearerTokenMatches(requestHeader(request, 'authorization'), expectedToken)) {
        return;
    }
    response.setHeader('WWW-Authenticate', 'Bearer');
    throw new ControlPlaneApiError(401, 'Valid AIStor authorization is required.');
}

function bearerTokenMatches(
    authorization: string | undefined,
    expectedToken: string,
): boolean {
    const match = /^Bearer[ \t]+(\S+)$/i.exec(authorization ?? '');
    const presentedToken = match?.[1]?.trim();
    if (presentedToken == null || presentedToken === '') {
        return false;
    }
    const expectedBytes = Buffer.from(expectedToken.trim(), 'utf8');
    const presentedBytes = Buffer.from(presentedToken, 'utf8');
    // timingSafeEqual throws on unequal lengths, so reject that case before comparing token contents.
    return expectedBytes.length === presentedBytes.length &&
        crypto.timingSafeEqual(expectedBytes, presentedBytes);
}
