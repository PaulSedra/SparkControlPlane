/**
 * @fileoverview Shared types for pipeline run admission and timeout policy.
 */

/** Per-pipeline admission and optional timeout settings for submitted runs. */
export interface PipelineRunPolicy {
    allowOverlap: boolean;
    timeoutSeconds?: number;
}
