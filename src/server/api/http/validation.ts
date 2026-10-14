/**
 * @fileoverview Generic query and body value validation for API routes.
 */

import { ControlPlaneApiError } from '../../errors/controlPlaneApiError.ts';

/** Returns a trimmed, non-empty query value or throws a 400 API error. */
export function requiredQueryParam(url: URL, name: string): string {
    const value = url.searchParams.get(name)?.trim();
    if (!value) {
        throw new ControlPlaneApiError(400, 'Missing ' + name + '.');
    }
    return value;
}

/** Returns a validated, trimmed query string, or undefined when the parameter is absent. */
export function optionalQueryString(url: URL, name: string): string | undefined {
    const value = url.searchParams.get(name);
    return value == null ? undefined : optionalString(value, name);
}

/** Reads the page limit with a default of 50 and an allowed range of 1 through 100. */
export function pageLimit(url: URL): number {
    return pageNumber(url.searchParams.get('limit'), 'limit', 50, 1, 100);
}

/** Reads a non-negative page offset, defaulting to zero. */
export function pageOffset(url: URL): number {
    return pageNumber(url.searchParams.get('offset'), 'offset', 0, 0, Number.MAX_SAFE_INTEGER);
}

/** Parses a decimal, non-negative integer query value and enforces its supplied bounds. */
export function pageNumber(
    rawValue: string | null,
    name: string,
    defaultValue: number,
    minimum: number,
    maximum: number,
): number {
    if (rawValue == null || rawValue.trim() === '') {
        return defaultValue;
    }
    if (!/^\d+$/.test(rawValue.trim())) {
        throw new ControlPlaneApiError(400, name + ' must be a non-negative integer.');
    }
    const value = Number.parseInt(rawValue, 10);
    if (value < minimum || value > maximum) {
        throw new ControlPlaneApiError(
            400,
            name + ' must be between ' + minimum + ' and ' + maximum + '.',
        );
    }
    return value;
}

/** Accepts an optional array only when every item is a string; otherwise throws a 400 API error. */
export function stringArray(value: unknown, name: string): string[] | undefined {
    if (value == null) {
        return undefined;
    }
    if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
        throw new ControlPlaneApiError(400, name + ' must be an array of strings.');
    }
    return value;
}

/** Validates a string of at most 256 characters, trims it, and maps blank input to undefined. */
export function optionalString(value: unknown, name: string): string | undefined {
    if (value == null) {
        return undefined;
    }
    if (typeof value !== 'string') {
        throw new ControlPlaneApiError(400, name + ' must be a string.');
    }
    if (value.length > 256) {
        throw new ControlPlaneApiError(400, name + ' must not exceed 256 characters.');
    }
    return value.trim() || undefined;
}

/** Returns a trimmed, non-empty body string or throws a 400 API error. */
export function requiredBodyString(value: unknown, name: string): string {
    const normalized = optionalString(value, name);
    if (normalized == null) {
        throw new ControlPlaneApiError(400, name + ' must be a non-empty string.');
    }
    return normalized;
}

/** Validates a boolean body value, using the optional default only when input is absent or null. */
export function booleanValue(value: unknown, name: string, defaultValue?: boolean): boolean | undefined {
    if (value == null && defaultValue !== undefined) {
        return defaultValue;
    }
    if (typeof value !== 'boolean') {
        throw new ControlPlaneApiError(400, name + ' must be a boolean.');
    }
    return value;
}

/** Requires a non-null, non-array object for JSON request bodies. */
export function requestObject(value: unknown): Record<string, unknown> {
    if (value == null || typeof value !== 'object' || Array.isArray(value)) {
        throw new ControlPlaneApiError(400, 'Request body must be a JSON object.');
    }
    return value as Record<string, unknown>;
}
