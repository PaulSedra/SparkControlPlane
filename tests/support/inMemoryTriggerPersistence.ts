/**
 * @fileoverview In-memory trigger persistence used by isolated trigger tests.
 */

import crypto from 'node:crypto';
import { ControlPlaneApiError } from '../../src/server/errors/controlPlaneApiError.ts';
import type {
    TriggerDefinition,
    TriggerDeadLetter,
    TriggerDeadLetterInput,
    TriggerEventRecord,
    TriggerPersistence,
    TriggerRoutingDecision,
    TriggerDeliveryAttempt,
} from '../../src/server/types/triggerTypes.ts';

/** Configuration for the deterministic in-memory trigger adapter. */
export interface InMemoryTriggerPersistenceOptions {
    now?: () => number;
}

/**
 * Creates an isolated trigger persistence double with production-shaped
 * deduplication, routing evidence, delivery attempts, and dead letters.
 *
 * State is private to the returned adapter and timestamps use the injected
 * clock, so tests can assert replay/discard and duplicate-delivery behavior
 * without sharing records across cases or depending on wall-clock timing.
 */
export function createInMemoryTriggerPersistence(
    options: InMemoryTriggerPersistenceOptions = {},
): TriggerPersistence {
    const now = options.now ?? (() => Date.now());
    const triggers = new Map<string, TriggerDefinition>();
    const events = new Map<string, TriggerEventRecord>();
    const deduplicationKeys = new Map<string, string>();
    const routingDecisions: TriggerRoutingDecision[] = [];
    const deliveryAttempts: TriggerDeliveryAttempt[] = [];
    const deadLetters = new Map<string, TriggerDeadLetter>();
    let nextDecisionId = 1;
    let nextAttemptId = 1;

    return {
        async createTrigger(input) {
            if ([...triggers.values()].some((trigger) => trigger.name === input.name)) {
                throw new ControlPlaneApiError(409, 'A trigger with this name already exists.');
            }
            const timestamp = timestampString(now);
            const trigger: TriggerDefinition = {
                ...clone(input),
                active: true,
                createdAt: timestamp,
                enabled: input.enabled ?? true,
                id: crypto.randomUUID(),
                managedByYaml: false,
                updatedAt: timestamp,
            };
            triggers.set(trigger.id, trigger);
            return clone(trigger);
        },
        async getTrigger(triggerId) {
            const trigger = triggers.get(triggerId);
            return trigger == null ? undefined : clone(trigger);
        },
        async listTriggers() {
            return [...triggers.values()]
                .sort((left, right) => left.name.localeCompare(right.name))
                .map(clone);
        },
        async reconcileYamlTriggers(pipelineId, inputs) {
            const yamlTriggers = [...triggers.values()].filter((trigger) =>
                trigger.pipelineId === pipelineId && trigger.managedByYaml === true
            );
            const existingByName = new Map(yamlTriggers.map((trigger) => [trigger.name, trigger]));
            const desiredNames = new Set(inputs.map((input) => input.name));
            const definitions: TriggerDefinition[] = [];
            for (const input of inputs) {
                const current = existingByName.get(input.name);
                if (current != null) {
                    const updated: TriggerDefinition = {
                        ...current,
                        ...clone(input),
                        active: true,
                        enabled: input.enabled ?? true,
                        managedByYaml: true,
                        updatedAt: timestampString(now),
                    };
                    triggers.set(current.id, updated);
                    definitions.push(clone(updated));
                    continue;
                }

                const conflicting = [...triggers.values()].find((trigger) =>
                    trigger.name === input.name
                );
                if (conflicting != null) {
                    throw new ControlPlaneApiError(
                        409,
                        `Trigger name "${input.name}" is already owned by an API or another YAML definition.`,
                    );
                }
                const timestamp = timestampString(now);
                const created: TriggerDefinition = {
                    ...clone(input),
                    active: true,
                    createdAt: timestamp,
                    enabled: input.enabled ?? true,
                    id: crypto.randomUUID(),
                    managedByYaml: true,
                    updatedAt: timestamp,
                };
                triggers.set(created.id, created);
                definitions.push(clone(created));
            }
            for (const trigger of yamlTriggers) {
                if (!desiredNames.has(trigger.name)) {
                    trigger.active = false;
                    trigger.enabled = false;
                    trigger.updatedAt = timestampString(now);
                }
            }
            return definitions;
        },
        async updateTrigger(triggerId, patch) {
            const current = requireTrigger(triggers, triggerId);
            if (patch.name != null && [...triggers.values()].some((trigger) =>
                trigger.id !== triggerId && trigger.name === patch.name
            )) {
                throw new ControlPlaneApiError(409, 'A trigger with this name already exists.');
            }
            const updated: TriggerDefinition = {
                ...current,
                ...clone(patch),
                updatedAt: timestampString(now),
            };
            triggers.set(triggerId, updated);
            return clone(updated);
        },
        async updateTriggerOutcome(triggerId, outcome) {
            const current = requireTrigger(triggers, triggerId);
            const updated = {
                ...current,
                lastOutcome: clone(outcome),
                updatedAt: timestampString(now),
            };
            triggers.set(triggerId, updated);
            return clone(updated);
        },
        async recordTriggerEvent(event) {
            const existingById = events.get(event.eventId);
            if (existingById != null) {
                if (existingById.event.deduplicationKey !== event.deduplicationKey) {
                    throw new ControlPlaneApiError(
                        409,
                        'A trigger event id was already used for a different event.',
                    );
                }
                existingById.duplicateCount += 1;
                return {
                    duplicate: true,
                    event: duplicateEvent(existingById, event.eventId),
                };
            }

            const existingEventId = deduplicationKeys.get(event.deduplicationKey);
            if (existingEventId != null) {
                const existing = events.get(existingEventId);
                if (existing == null) {
                    throw new Error('Trigger deduplication state references a missing event.');
                }
                existing.duplicateCount += 1;
                return {
                    duplicate: true,
                    event: duplicateEvent(existing, event.eventId),
                };
            }

            const record: TriggerEventRecord = {
                duplicateCount: 0,
                event: clone(event),
                receivedAt: timestampString(now),
                status: 'RECEIVED',
            };
            events.set(event.eventId, record);
            deduplicationKeys.set(event.deduplicationKey, event.eventId);
            return { duplicate: false, event: clone(record) };
        },
        async updateTriggerEventStatus(eventId, status) {
            const event = events.get(eventId);
            if (event == null) {
                throw new ControlPlaneApiError(404, `Unknown trigger event: ${eventId}`);
            }
            event.status = status;
            return clone(event);
        },
        async listTriggerEvents(limit = 100) {
            return [...events.values()]
                .reverse()
                .slice(0, boundedLimit(limit))
                .map(clone);
        },
        async recordRoutingDecision(input) {
            const decision: TriggerRoutingDecision = {
                ...clone(input),
                createdAt: timestampString(now),
                decisionId: nextDecisionId++,
            };
            routingDecisions.push(decision);
            return clone(decision);
        },
        async listTriggerRoutingDecisions(eventId, triggerId, limit = 100) {
            return routingDecisions
                .filter((decision) => (eventId == null || decision.eventId === eventId) &&
                    (triggerId == null || decision.triggerId === triggerId))
                .slice(-boundedLimit(limit))
                .reverse()
                .map(clone);
        },
        async recordTriggerDeliveryAttempt(input) {
            const attempt: TriggerDeliveryAttempt = {
                ...clone(input),
                attemptId: nextAttemptId++,
                createdAt: timestampString(now),
            };
            deliveryAttempts.push(attempt);
            return clone(attempt);
        },
        async listTriggerDeliveryAttempts(triggerId, limit = 100) {
            return deliveryAttempts
                .filter((attempt) => triggerId == null || attempt.triggerId === triggerId)
                .slice(-boundedLimit(limit))
                .reverse()
                .map(clone);
        },
        async createTriggerDeadLetter(input: TriggerDeadLetterInput) {
            const existing = [...deadLetters.values()].find((item) =>
                item.eventId === input.eventId && item.triggerId === input.triggerId
            );
            if (existing != null) {
                const updated: TriggerDeadLetter = {
                    ...existing,
                    event: clone(input.event),
                    failureReason: input.failureReason,
                    status: 'PENDING',
                    updatedAt: timestampString(now),
                };
                deadLetters.set(existing.id, updated);
                return clone(updated);
            }
            const timestamp = timestampString(now);
            const deadLetter: TriggerDeadLetter = {
                ...clone(input),
                createdAt: timestamp,
                id: crypto.randomUUID(),
                replayCount: 0,
                status: 'PENDING',
                updatedAt: timestamp,
            };
            deadLetters.set(deadLetter.id, deadLetter);
            return clone(deadLetter);
        },
        async getTriggerDeadLetter(deadLetterId) {
            const deadLetter = deadLetters.get(deadLetterId);
            return deadLetter == null ? undefined : clone(deadLetter);
        },
        async listTriggerDeadLetters(status, limit = 100) {
            return [...deadLetters.values()]
                .filter((item) => status == null || item.status === status)
                .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
                .slice(0, boundedLimit(limit))
                .map(clone);
        },
        async updateTriggerDeadLetter(deadLetterId, patch) {
            const deadLetter = deadLetters.get(deadLetterId);
            if (deadLetter == null) {
                throw new ControlPlaneApiError(404, `Unknown trigger dead letter: ${deadLetterId}`);
            }
            const updated: TriggerDeadLetter = {
                ...deadLetter,
                ...clone(patch),
                updatedAt: timestampString(now),
            };
            deadLetters.set(deadLetterId, updated);
            return clone(updated);
        },
    };
}

function duplicateEvent(
    existing: TriggerEventRecord,
    incomingEventId: string,
): TriggerEventRecord {
    return {
        ...clone(existing),
        duplicateOfEventId: existing.event.eventId === incomingEventId
            ? undefined
            : existing.event.eventId,
        status: 'DUPLICATE',
    };
}

function requireTrigger(
    triggers: Map<string, TriggerDefinition>,
    triggerId: string,
): TriggerDefinition {
    const trigger = triggers.get(triggerId);
    if (trigger == null) {
        throw new ControlPlaneApiError(404, `Unknown trigger: ${triggerId}`);
    }
    return trigger;
}

function boundedLimit(value: number): number {
    return Math.min(1000, Math.max(1, Math.floor(value)));
}

function timestampString(now: () => number): string {
    return new Date(now()).toISOString();
}

function clone<T>(value: T): T {
    return JSON.parse(JSON.stringify(value)) as T;
}
