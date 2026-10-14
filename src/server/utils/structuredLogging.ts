/**
 * @fileoverview Emits JSON logs after applying the repository's secret
 * redaction policy.
 */

import { sanitizeFields } from './sanitization.ts';

/**
 * Writes one JSON event to standard output after applying secret redaction.
 *
 * The logger is intentionally synchronous and process-local: callers get one
 * line suitable for container log collection, while arbitrary fields cannot
 * bypass the shared sanitization policy. The timestamp is added at emission
 * time rather than accepted from caller input.
 */
export function logStructured(
    event: string,
    fields: Record<string, unknown> = {},
): void {
    console.log(structuredLog(event, fields));
}

function structuredLog(
    event: string,
    fields: Record<string, unknown> = {},
): string {
    const sanitizedFields = sanitizeFields(fields) as Record<string, unknown>;
    return JSON.stringify({
        event,
        ...sanitizedFields,
        timestamp: new Date().toISOString(),
    });
}
