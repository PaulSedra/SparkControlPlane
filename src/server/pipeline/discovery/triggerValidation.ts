/**
 * @fileoverview Validates trigger inputs and delegates type-specific selector
 * validation to the routing and schedule parsers.
 */

import { ControlPlaneApiError } from '../../errors/controlPlaneApiError.ts';
import type {
    TriggerDefinitionInput,
    TriggerType,
} from '../../types/triggerTypes.ts';
import type { RunMode } from '../../../shared/pipelineRegistryTypes.ts';
import { parseScheduleConfiguration } from '../../triggers/cronSchedule.ts';
import {
    parseFileArrivalConfiguration,
    parseWebhookConfiguration,
} from '../../triggers/triggerRouting.ts';

const RUN_MODES = new Set<RunMode>([
    'incremental',
    'full-refresh-all',
    'repair-failed',
    'dry-run',
    'refresh-selected',
    'full-refresh-selected',
]);

const TRIGGER_TYPES = new Set<TriggerType>([
    'FILE_ARRIVAL',
    'SCHEDULE',
    'WEBHOOK',
]);

/**
 * Validates a trigger at the service boundary and normalizes its identity.
 *
 * Common fields are checked before the type-specific parser enforces schedule,
 * file-arrival, or webhook semantics. Parser failures are converted to the
 * API's deliberate `400` shape, so persistence never receives a trigger that
 * another ingestion path would interpret differently. Only surrounding name
 * and pipeline whitespace is normalized; configuration is preserved for the
 * selected parser and caller metadata remains the caller's responsibility.
 */
export function validateTriggerInput(input: TriggerDefinitionInput): TriggerDefinitionInput {
    if (typeof input.name !== 'string' || input.name.trim() === '' || input.name.length > 256) {
        throw new ControlPlaneApiError(400, 'Trigger name must be a non-empty string of at most 256 characters.');
    }
    if (typeof input.pipelineId !== 'string' || input.pipelineId.trim() === '') {
        throw new ControlPlaneApiError(400, 'Trigger pipelineId must be a non-empty string.');
    }
    if (!TRIGGER_TYPES.has(input.type)) {
        throw new ControlPlaneApiError(400, `Unsupported trigger type: ${String(input.type)}`);
    }
    if (!RUN_MODES.has(input.mode)) {
        throw new ControlPlaneApiError(400, `Unsupported pipeline run mode: ${String(input.mode)}`);
    }
    validateConfiguration(input.configuration);
    validateTypeConfiguration(input.type, input.configuration);
    return {
        ...input,
        name: input.name.trim(),
        pipelineId: input.pipelineId.trim(),
    };
}

function validateTypeConfiguration(
    type: TriggerType,
    configuration: Record<string, unknown>,
): void {
    try {
        if (type === 'SCHEDULE') {
            parseScheduleConfiguration(configuration);
        } else if (type === 'FILE_ARRIVAL') {
            parseFileArrivalConfiguration(configuration);
        } else {
            parseWebhookConfiguration(configuration);
        }
    } catch (error) {
        throw new ControlPlaneApiError(400, error instanceof Error ? error.message : String(error));
    }
}

function validateConfiguration(value: unknown): asserts value is Record<string, unknown> {
    if (value == null || typeof value !== 'object' || Array.isArray(value)) {
        throw new ControlPlaneApiError(400, 'Trigger configuration must be an object.');
    }
}
