/**
 * @fileoverview Shared JSON request and bounded polling helpers for tests.
 */

import assert from 'node:assert/strict';

/** Waits without blocking the event loop between polling attempts. */
export const delay = (milliseconds: number): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, milliseconds));

/** HTTP response body and status captured without throwing on non-2xx results. */
export type JsonResponse<T> = { body: T; status: number };

/** Fetches JSON and asserts the exact status expected by a contract test. */
export async function fetchJson<T = Record<string, unknown>>(url: string, expectedStatus: number, init?: RequestInit): Promise<T> {
    const response = await fetch(url, init);
    assert.equal(response.status, expectedStatus);
    return await response.json() as T;
}

/** Fetches JSON while preserving the response status for negative-path tests. */
export async function requestJson<T = Record<string, unknown>>(url: string, init?: RequestInit): Promise<JsonResponse<T>> {
    const response = await fetch(url, init);
    const body = await response.json().catch(() => ({})) as T;
    return { body, status: response.status };
}

/** Verifies the API's method-not-allowed response and its advertised methods. */
export async function assertMethodNotAllowed(url: string, method: string, allow: string): Promise<void> {
    const response = await fetch(url, { method });
    assert.equal(response.status, 405);
    assert.equal(response.headers.get('allow'), allow);
    assert.deepEqual(await response.json(), {
        code: 'METHOD_NOT_ALLOWED',
        message: 'Method not allowed',
    });
}

/**
 * Repeats an async read until a predicate succeeds or the bounded deadline
 * expires, preserving the final failure as the supplied test error.
 */
export async function pollUntil<T>(read: () => Promise<T>, predicate: (value: T) => boolean, timeoutMs: number, intervalMs: number, errorMessage: string): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const value = await read();
        if (predicate(value)) {
            return value;
        }
        await delay(intervalMs);
    }
    throw new Error(errorMessage);
}
