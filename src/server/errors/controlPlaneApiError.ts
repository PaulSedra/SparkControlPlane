/**
 * @fileoverview Shared server errors that preserve HTTP status and optional application codes.
 *
 * API handlers, domain services, and persistence adapters throw this type when
 * the response layer should return a specific control-plane status and message.
 */

/**
 * Error for a control-plane failure that should retain a specific HTTP status.
 *
 * The API response adapter serializes status, optional application code, and
 * sanitized messages from API, domain, and persistence layers.
 */
export class ControlPlaneApiError extends Error {
    readonly statusCode: number;
    readonly applicationCode: string | undefined;

    constructor(statusCode: number, message: string);
    constructor(statusCode: number, applicationCode: string, message: string);
    constructor(statusCode: number, messageOrCode: string, explicitMessage?: string) {
        const message = explicitMessage ?? messageOrCode;
        const applicationCode = explicitMessage == null ? undefined : messageOrCode;
        super(message);
        this.name = 'ApiError';
        this.statusCode = statusCode;
        this.applicationCode = applicationCode;
    }
}
