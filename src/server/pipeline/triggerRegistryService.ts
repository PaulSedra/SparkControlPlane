/**
 * @fileoverview Provides the registry-facing control and query API for triggers.
 */

import { ControlPlaneApiError } from '../errors/controlPlaneApiError.ts';
import type { ControlPlanePersistence } from '../types/pipelinePersistenceTypes.ts';
import type {
    PipelineRegistryService,
} from '../types/pipelineServiceTypes.ts';
import type {
    TriggerDefinitionInput,
    TriggerDefinitionPatch,
    TriggerDefinition,
} from '../types/triggerTypes.ts';
import type {
    TriggerDeadLetterStatus,
} from '../../shared/status/trigger.ts';
import { nextOccurrenceAfter, parseScheduleConfiguration } from '../triggers/cronSchedule.ts';
import type { TriggerEventService } from '../triggers/triggerEventService.ts';
import type { TriggerServices } from '../triggers/triggerServices.ts';
import { validateTriggerInput } from './discovery/triggerValidation.ts';

/** Trigger control, ingestion, and query methods exposed by the registry. */
export type TriggerRegistryOperations = Pick<
    PipelineRegistryService,
    | 'createTrigger'
    | 'getTrigger'
    | 'getTriggerScheduleStatus'
    | 'ingestAistorNotification'
    | 'ingestTriggerEvent'
    | 'listTriggerDeliveryAttempts'
    | 'listTriggerDeadLetters'
    | 'listTriggerEvents'
    | 'listTriggerRoutingDecisions'
    | 'listTriggers'
    | 'replayTriggerDeadLetter'
    | 'discardTriggerDeadLetter'
    | 'updateTrigger'
>;

/** Dependencies connected by the pipeline registry composition root. */
export interface TriggerRegistryServiceOptions {
    eventService: TriggerEventService;
    now: () => number;
    persistence: ControlPlanePersistence;
    triggerServices: TriggerServices;
}

/**
 * Creates the control-plane trigger facade around trigger runtime services.
 * YAML-owned triggers change only when an operator refreshes the source folder.
 */
export function createTriggerRegistryService(
    options: TriggerRegistryServiceOptions,
): TriggerRegistryOperations {
    async function getTrigger(triggerId: string): Promise<TriggerDefinition> {
        return readTrigger(triggerId);
    }

    async function getTriggerScheduleStatus(triggerId: string) {
        const trigger = await getTrigger(triggerId);
        if (trigger.type !== 'SCHEDULE') {
            throw new ControlPlaneApiError(400, 'Schedule status is only available for schedule triggers.');
        }
        let configuration;
        try {
            configuration = parseScheduleConfiguration(trigger.configuration);
        } catch (error) {
            throw new ControlPlaneApiError(400, error instanceof Error ? error.message : String(error));
        }
        return {
            lastOccurrenceAt: trigger.lastOutcome?.occurredAt,
            lastOutcome: trigger.lastOutcome,
            nextOccurrenceAt: trigger.enabled
                ? nextOccurrenceAfter(new Date(options.now()), configuration)?.at.toISOString()
                : undefined,
            triggerId,
        };
    }

    async function readTrigger(triggerId: string): Promise<TriggerDefinition> {
        const trigger = await options.persistence.getTrigger(triggerId);
        if (trigger == null) {
            throw new ControlPlaneApiError(404, `Unknown trigger: ${triggerId}`);
        }
        return trigger;
    }

    return {
        async createTrigger(input: TriggerDefinitionInput): Promise<TriggerDefinition> {
            return options.persistence.createTrigger(validateTriggerInput(input));
        },
        discardTriggerDeadLetter: (deadLetterId) =>
            options.triggerServices.deadLetters.discardDeadLetter(deadLetterId),
        getTrigger,
        getTriggerScheduleStatus,
        ingestAistorNotification: (payload) => options.eventService.ingestAistorNotification(payload),
        ingestTriggerEvent: (event) => options.eventService.ingestCanonicalEvent(event),
        listTriggerDeliveryAttempts: (triggerId, limit) =>
            options.persistence.listTriggerDeliveryAttempts(triggerId, limit),
        listTriggerDeadLetters: (status?: TriggerDeadLetterStatus, limit?: number) =>
            options.persistence.listTriggerDeadLetters(status, limit),
        listTriggerEvents: (limit) => options.persistence.listTriggerEvents(limit),
        listTriggerRoutingDecisions: (eventId, triggerId, limit) =>
            options.persistence.listTriggerRoutingDecisions(eventId, triggerId, limit),
        listTriggers: () => options.persistence.listTriggers(),
        replayTriggerDeadLetter: (deadLetterId) =>
            options.triggerServices.deadLetters.replayDeadLetter(deadLetterId),
        async updateTrigger(
            triggerId: string,
            patch: TriggerDefinitionPatch,
        ): Promise<TriggerDefinition> {
            const current = await readTrigger(triggerId);
            return options.persistence.updateTrigger(
                triggerId,
                validateTriggerPatch(current, patch),
            );
        },
    };
}

function validateTriggerPatch(
    current: TriggerDefinitionInput,
    patch: TriggerDefinitionPatch,
): TriggerDefinitionPatch {
    const merged = validateTriggerInput({
        ...current,
        ...patch,
    });
    return {
        ...patch,
        configuration: merged.configuration,
        name: merged.name,
        pipelineId: merged.pipelineId,
    };
}
