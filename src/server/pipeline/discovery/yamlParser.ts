/**
 * @fileoverview Parses pipeline YAML documents with the YAML 1.2 core schema.
 *
 * It also provides the source-qualified root-mapping boundary used by pipeline
 * discovery; trigger-specific validation remains in yamlTriggerConfiguration.ts.
 */

import { ControlPlaneApiError } from '../../errors/controlPlaneApiError.ts';
import { CORE_SCHEMA, load } from 'js-yaml';

/** Parses a YAML document and retains the pipeline parser's undefined null-value contract. */
export function parseYamlDocument(content: string): unknown {
    return normalizeNullValues(load(content, { schema: CORE_SCHEMA }), new WeakMap());
}

/**
 * Parses a pipeline YAML document as a root mapping.
 *
 * YAML syntax and root-shape failures become source-qualified HTTP 400 errors;
 * successful parsing returns the normalized values used by discovery.
 */
export function parsePipelineYamlDocument(
    content: string,
    sourcePath: string,
): Record<string, unknown> {
    try {
        return recordValue(parseYamlDocument(content), sourcePath);
    } catch (error) {
        throw pipelineYamlError(sourcePath, error);
    }
}

/**
 * Recursively visits nested objects and arrays so nulls anywhere become
 * undefined; a top-level check would miss this nested value:
 *
 * ```yaml
 *   libraries:
 *     glob:
 *       include: null
 * ```
 *
 * The WeakMap reuses alias targets and stops cycles from looping forever.
 */
function normalizeNullValues(value: unknown, visited: WeakMap<object, unknown>): unknown {
    if (value === null) {
        return undefined;
    }
    if (Array.isArray(value)) {
        const existing = visited.get(value);
        if (visited.has(value)) {
            return existing;
        }
        const normalized: unknown[] = [];
        visited.set(value, normalized);
        normalized.push(...value.map((item) => normalizeNullValues(item, visited)));
        return normalized;
    }
    if (value != null && typeof value === 'object') {
        const existing = visited.get(value);
        if (visited.has(value)) {
            return existing;
        }
        const normalized: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
        visited.set(value, normalized);
        for (const [key, nested] of Object.entries(value)) {
            normalized[key] = normalizeNullValues(nested, visited);
        }
        return normalized;
    }
    return value;
}

function recordValue(value: unknown, sourcePath: string): Record<string, unknown> {
    if (value == null || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error(`${sourcePath} must be a YAML mapping`);
    }
    return value as Record<string, unknown>;
}

function pipelineYamlError(sourcePath: string, error: unknown): ControlPlaneApiError {
    return new ControlPlaneApiError(
        400,
        `Invalid pipeline YAML in ${sourcePath}: ${error instanceof Error ? error.message : String(error)}`,
    );
}
