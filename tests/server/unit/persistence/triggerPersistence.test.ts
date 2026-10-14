/**
 * @fileoverview Unit coverage for trigger persistence operations.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { createInMemoryPersistence } from '../../../support/inMemoryPersistence.ts';
import { createTestDataLoader } from '../../../support/testData.ts';
import { triggerDefinition } from '../../../support/triggerFixtures.ts';
import type {
    CanonicalTriggerEvent,
    TriggerDefinitionInput,
} from '../../../../src/server/types/triggerTypes.ts';

interface TriggerPersistenceFixture {
    definition: Partial<TriggerDefinitionInput> & { configuration: Record<string, unknown>; name: string };
    duplicateEventId: string;
    event: CanonicalTriggerEvent;
    eventIdReuse: {
        first: CanonicalTriggerEvent;
        second: CanonicalTriggerEvent;
    };
    fileTrigger: Partial<TriggerDefinitionInput> & { configuration: Record<string, unknown>; name: string };
    outcome: {
        detail: string;
        eventId: string;
        occurredAt: string;
        runId: string;
        status: 'ACCEPTED';
    };
}

const fixture = createTestDataLoader('server/unit')
    .loadYaml<TriggerPersistenceFixture>('fixtures/trigger-persistence.yaml');

test('in-memory trigger definitions retain configuration and last outcome', async () => {
    const persistence = createInMemoryPersistence({ now: () => Date.parse('2026-09-08T12:00:00.000Z') });
    await persistence.initialize();
    const input: TriggerDefinitionInput = triggerDefinition(fixture.definition);

    const created = await persistence.createTrigger(input);
    assert.equal(created.active, true);
    assert.equal(created.enabled, true);
    assert.equal(created.type, 'SCHEDULE');
    assert.deepEqual(created.configuration, input.configuration);

    const disabled = await persistence.updateTrigger(created.id, { enabled: false });
    assert.equal(disabled.enabled, false);

    const withOutcome = await persistence.updateTriggerOutcome(created.id, fixture.outcome);
    assert.deepEqual(withOutcome.lastOutcome, fixture.outcome);
    assert.equal((await persistence.listTriggers()).length, 1);
});

test('in-memory trigger events deduplicate and retain routing and delivery evidence', async () => {
    const persistence = createInMemoryPersistence();
    await persistence.initialize();
    const trigger = await persistence.createTrigger(triggerDefinition({
        ...fixture.fileTrigger,
    }));
    const event = fixture.event;

    const first = await persistence.recordTriggerEvent(event);
    const duplicate = await persistence.recordTriggerEvent({
        ...event,
        eventId: fixture.duplicateEventId,
    });
    assert.equal(first.duplicate, false);
    assert.equal(duplicate.duplicate, true);
    assert.equal(duplicate.event.status, 'DUPLICATE');
    assert.equal(duplicate.event.duplicateOfEventId, 'file-event-1');
    assert.equal(duplicate.event.duplicateCount, 1);

    const routed = await persistence.updateTriggerEventStatus(event.eventId, 'ROUTED');
    assert.equal(routed.status, 'ROUTED');
    const decision = await persistence.recordRoutingDecision({
        eventId: event.eventId,
        outcome: 'MATCHED',
        reason: 'bucket and prefix matched',
        triggerId: trigger.id,
        runId: 'run-1',
    });
    const attempt = await persistence.recordTriggerDeliveryAttempt({
        attemptNumber: 1,
        completedAt: '2026-09-08T12:00:01.000Z',
        correlationId: 'corr-1',
        eventId: event.eventId,
        runId: 'run-1',
        startedAt: '2026-09-08T12:00:00.500Z',
        status: 'ACCEPTED',
        triggerId: trigger.id,
    });
    assert.equal((await persistence.listTriggerEvents())[0]?.duplicateCount, 1);
    assert.equal((await persistence.listTriggerRoutingDecisions(event.eventId, trigger.id))[0]?.decisionId, decision.decisionId);
    assert.equal((await persistence.listTriggerDeliveryAttempts(trigger.id))[0]?.attemptId, attempt.attemptId);
});

test('in-memory trigger event ids cannot be reused for another deduplication key', async () => {
    const persistence = createInMemoryPersistence();
    await persistence.initialize();
    await persistence.recordTriggerEvent(fixture.eventIdReuse.first);

    await assert.rejects(
        () => persistence.recordTriggerEvent(fixture.eventIdReuse.second),
        /different event/,
    );
});
