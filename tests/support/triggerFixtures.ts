/**
 * @fileoverview Canonical trigger inputs and events shared by trigger tests.
 */

import type { CanonicalTriggerEvent, TriggerDefinitionInput, TriggerPersistence } from '../../src/server/types/triggerTypes.ts';
import { createTriggerEventService } from '../../src/server/triggers/triggerEventService.ts';
import type { TriggerEventService, TriggerEventServiceOptions } from '../../src/server/triggers/triggerEventService.ts';
import { createTriggerServices } from '../../src/server/triggers/triggerServices.ts';
import type { TriggerDeadLetterService } from '../../src/server/triggers/triggerDeadLetterService.ts';
import { createTestDataLoader } from './testData.ts';

interface TriggerFixtureData {
    canonicalTriggerEvent: CanonicalTriggerEvent;
    triggerDefinition: TriggerDefinitionInput;
}

const serverUnitTestData = createTestDataLoader('server/unit');
const triggerFixtureData = serverUnitTestData.loadYaml<TriggerFixtureData>('fixtures/triggers.yaml');

/** Stable trigger definition input shared by trigger tests. */
export const triggerDefinitionFixture = triggerFixtureData.triggerDefinition;

/** Stable canonical event shared by trigger tests. */
export const canonicalTriggerEventFixture = triggerFixtureData.canonicalTriggerEvent;

/** Builds a valid trigger definition input with optional test overrides. */
export function triggerDefinition(overrides: Partial<TriggerDefinitionInput> = {}): TriggerDefinitionInput {
    return { ...triggerDefinitionFixture, ...overrides };
}

/** Builds a valid canonical event with optional test overrides. */
export function canonicalTriggerEvent(overrides: Partial<CanonicalTriggerEvent> = {}): CanonicalTriggerEvent {
    return { ...canonicalTriggerEventFixture, ...overrides };
}

/** Builds a canonical AIStor file-arrival event. */
export function fileArrivalEvent(eventId: string, bucket: string, objectKey: string): CanonicalTriggerEvent {
    return canonicalTriggerEvent({ attributes: { bucket, eventName: 's3:ObjectCreated:Put', objectKey }, deduplicationKey: 'aistor:' + bucket + ':' + objectKey, eventId, eventType: 'file.arrived', payload: { bucket, objectKey }, source: 'aistor' });
}

/** Creates a trigger service around the shared in-memory persistence. */
export function createTriggerService(
    persistence: TriggerPersistence,
    submitRun: TriggerEventServiceOptions['submitRun'],
): TriggerEventService & TriggerDeadLetterService {
    const services = createTriggerServices({ persistence, submitRun });
    return {
        ...createTriggerEventService({ persistence, services, submitRun }),
        ...services.deadLetters,
    };
}
