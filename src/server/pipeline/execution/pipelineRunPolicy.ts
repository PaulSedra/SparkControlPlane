/**
 * @fileoverview Loads per-pipeline overlap defaults from environment
 * configuration and combines them with YAML timeout settings.
 */

import type { PipelineRunPolicy } from '../../types/pipelineRunPolicyTypes.ts';

/** Default policy used when no pipeline-specific overlap setting is configured. */
export const DEFAULT_PIPELINE_RUN_POLICY: PipelineRunPolicy = {
    allowOverlap: false,
};

/**
 * Parses environment policy settings into normalized per-pipeline policies.
 *
 * Missing configuration yields a serialized-run default. Malformed JSON,
 * unknown shapes, and timeout settings in this environment-only configuration
 * throw before the service starts; per-pipeline timeouts belong in pipeline
 * YAML. `allowOverlap` is captured with each submitted run so PostgreSQL
 * claims can apply the admission rule that was in effect when accepted.
 */
export function loadPipelineRunPolicies(
    environment: NodeJS.ProcessEnv = process.env,
): Map<string, PipelineRunPolicy> {
    const raw = environment.PIPELINE_RUN_POLICIES?.trim();
    if (!raw) {
        return new Map([['__default__', DEFAULT_PIPELINE_RUN_POLICY]]);
    }
    let value: unknown;
    try {
        value = JSON.parse(raw);
    } catch {
        throw new Error('PIPELINE_RUN_POLICIES must be valid JSON.');
    }
    if (value == null || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('PIPELINE_RUN_POLICIES must be a JSON object keyed by pipeline name.');
    }

    const policies = new Map<string, PipelineRunPolicy>([
        ['__default__', DEFAULT_PIPELINE_RUN_POLICY],
    ]);
    for (const [name, rawPolicy] of Object.entries(value)) {
        if (rawPolicy == null || typeof rawPolicy !== 'object' || Array.isArray(rawPolicy)) {
            throw new Error(`Pipeline policy for ${name} must be an object.`);
        }
        const policy = rawPolicy as Record<string, unknown>;
        const allowOverlap = policy.allowOverlap;
        if (allowOverlap != null && typeof allowOverlap !== 'boolean') {
            throw new Error(`Pipeline policy allowOverlap for ${name} must be boolean.`);
        }
        if (policy.timeoutSeconds != null) {
            throw new Error(
                `Pipeline policy timeoutSeconds for ${name} is unsupported; use timeout_seconds in pipeline YAML.`,
            );
        }
        policies.set(normalizeName(name), {
            allowOverlap: allowOverlap ?? false,
        });
    }
    return policies;
}

/**
 * Looks up a policy by trimmed, case-insensitive pipeline name and falls back
 * to the normalized default policy when no specific entry exists.
 */
export function pipelineRunPolicy(
    name: string,
    policies: Map<string, PipelineRunPolicy>,
    timeoutSeconds?: number,
): PipelineRunPolicy {
    const policy = policies.get(normalizeName(name)) ??
        policies.get('__default__') ?? DEFAULT_PIPELINE_RUN_POLICY;
    return {
        allowOverlap: policy.allowOverlap,
        ...(timeoutSeconds == null ? {} : { timeoutSeconds }),
    };
}

function normalizeName(name: string): string {
    return name.trim().toLowerCase();
}
