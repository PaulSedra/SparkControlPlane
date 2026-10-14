/**
 * @fileoverview Presentation helpers for the trigger configuration shown in
 * the jobs-and-pipelines registry.
 */

import type { TriggerDefinition } from '../../types/triggerTypes.ts';

/**
 * Returns the currently configured trigger label for a pipeline.
 *
 * Historical runs retain their original request source, so the registry table
 * must use active trigger definitions rather than the last run when reporting
 * whether a pipeline is scheduled or event-driven. A pipeline with no active
 * definition remains manually runnable.
 */
export function pipelineTriggerLabel(
    pipelineId: string,
    triggers: readonly Pick<TriggerDefinition, 'active' | 'pipelineId' | 'type'>[],
): string {
    const labels = Array.from(new Set(
        triggers
            .filter((trigger) => trigger.pipelineId === pipelineId && trigger.active)
            .map((trigger) => triggerTypeLabel(trigger.type)),
    ));
    return labels.length === 0 ? 'Manual' : labels.join(', ');
}

function triggerTypeLabel(type: TriggerDefinition['type']): string {
    if (type === 'FILE_ARRIVAL') {
        return 'File arrival';
    }
    if (type === 'SCHEDULE') {
        return 'Schedule';
    }
    return 'Webhook';
}
