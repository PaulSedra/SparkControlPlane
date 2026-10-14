/**
 * @fileoverview Shared validation for run submissions from pipeline and trigger routes.
 */

import { ControlPlaneApiError } from '../../errors/controlPlaneApiError.ts';
import type { RunMode } from '../../../shared/pipelineRegistryTypes.ts';

const RUN_MODES = new Set<RunMode>([
    'incremental',
    'full-refresh-all',
    'repair-failed',
    'dry-run',
    'refresh-selected',
    'full-refresh-selected',
]);

/** Parses a supported run mode, defaulting omitted or empty input to incremental. */
export function runMode(value: unknown): RunMode {
    if (value == null || value === '') {
        return 'incremental';
    }
    if (typeof value === 'string' && RUN_MODES.has(value as RunMode)) {
        return value as RunMode;
    }
    throw new ControlPlaneApiError(
        400,
        'Unsupported pipeline run mode: ' + String(value),
    );
}

/**
 * Validates bounded caller metadata and redacts values whose keys resemble credentials.
 * Metadata is capped at 32 entries, with each string value truncated to 512 characters.
 */
export function callerMetadata(value: unknown): Record<string, string> | undefined {
    if (value == null) {
        return undefined;
    }
    if (typeof value !== 'object' || Array.isArray(value)) {
        throw new ControlPlaneApiError(400, 'callerMetadata must be an object of string values.');
    }
    const entries = Object.entries(value);
    if (entries.length > 32) {
        throw new ControlPlaneApiError(400, 'callerMetadata must not contain more than 32 entries.');
    }
    return Object.fromEntries(entries.map(([key, item]) => {
        if (!/^[A-Za-z0-9_.-]{1,64}$/.test(key) || typeof item !== 'string') {
            throw new ControlPlaneApiError(400, 'callerMetadata keys and values must be bounded strings.');
        }
        const normalized = item.slice(0, 512);
        return [
            key,
            /(password|passwd|token|secret|access[_-]?key|authorization|cookie)/i.test(key)
                ? '[REDACTED]'
                : normalized,
        ];
    }));
}
