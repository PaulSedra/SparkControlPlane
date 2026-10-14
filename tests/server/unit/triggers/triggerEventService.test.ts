/**
 * @fileoverview Unit coverage for trigger event ingestion and delivery.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { createInMemoryTriggerPersistence } from '../../../support/inMemoryTriggerPersistence.ts';
import {
    createTriggerService,
    triggerDefinition,
} from '../../../support/triggerFixtures.ts';
import { createTestDataLoader } from '../../../support/testData.ts';
import type {
    CanonicalTriggerEvent,
    TriggerDefinitionInput,
} from '../../../../src/server/types/triggerTypes.ts';

interface TriggerEventServiceFixture {
    aistorRouting: {
        notification: Record<string, unknown>;
        trigger: TriggerDefinitionFixture;
    };
    debounce: Array<{
        assertDebounceDecision?: boolean;
        events: CanonicalTriggerEvent[];
        name: string;
        trigger: TriggerDefinitionFixture;
    }>;
    discardDelivery: {
        event: CanonicalTriggerEvent;
        trigger: TriggerDefinitionFixture;
    };
    failedDelivery: {
        event: CanonicalTriggerEvent;
        trigger: TriggerDefinitionFixture;
    };
    generic: {
        duplicateEventId: string;
        event: CanonicalTriggerEvent;
        expectedSubmissionEventId: string;
        trigger: TriggerDefinitionFixture;
    };
    independentFileArrival: {
        events: CanonicalTriggerEvent[];
        triggers: TriggerDefinitionFixture[];
    };
    routing: {
        multiMatch: CanonicalTriggerEvent;
        noMatch: CanonicalTriggerEvent;
        triggers: TriggerDefinitionFixture[];
    };
}

interface TriggerDefinitionFixture extends Partial<TriggerDefinitionInput> {
    configuration: Record<string, unknown>;
    name: string;
}

const fixture = createTestDataLoader('server/unit')
    .loadYaml<TriggerEventServiceFixture>('fixtures/trigger-events.yaml');

test('generic canonical events share one deduplicated delivery path', async () => {
    const persistence = createInMemoryTriggerPersistence();
    await persistence.createTrigger(triggerDefinition(fixture.generic.trigger));
    let submissionCount = 0;
    const service = createTriggerService(persistence, async (submission) => {
            submissionCount += 1;
            assert.equal(submission.requestSource, 'trigger:webhook');
            assert.equal(
                submission.callerMetadata?.triggerEventId,
                fixture.generic.expectedSubmissionEventId,
            );
            return {
                replayed: false,
                run: { runId: 'run-1' } as never,
            };
    });
    const event = fixture.generic.event;

    const first = await service.ingestCanonicalEvent(event);
    const duplicate = await service.ingestCanonicalEvent({
        ...event,
        eventId: fixture.generic.duplicateEventId,
    });

    assert.equal(first.accepted, 1);
    assert.equal(duplicate.duplicates, 1);
    assert.equal(submissionCount, 1);
    assert.equal((await persistence.listTriggerDeliveryAttempts())[0]?.status, 'ACCEPTED');
    assert.equal((await persistence.listTriggerEvents())[0]?.status, 'ROUTED');
});

for (const scenario of fixture.debounce) {
    test(scenario.name, async () => {
        await assertLatestDebouncedFileEvent(
            scenario.trigger,
            scenario.name,
            scenario.events,
            scenario.assertDebounceDecision,
        );
    });
}

test('separate file-arrival triggers keep independent debounce groups', async () => {
    const persistence = createInMemoryTriggerPersistence();
    for (const trigger of fixture.independentFileArrival.triggers) {
        await persistence.createTrigger(triggerDefinition({
            ...trigger,
            type: 'FILE_ARRIVAL',
        }));
    }
    const submissions: string[] = [];
    const service = createTriggerService(persistence, async (submission) => {
            submissions.push(String(submission.callerMetadata?.triggerId));
            return {
                replayed: false,
                run: { runId: `run-${submissions.length}` } as never,
            };
    });
    for (const event of fixture.independentFileArrival.events) {
        await service.ingestCanonicalEvent(event);
    }
    await service.flushDebounces();

    assert.equal(submissions.length, 2);
    service.stop();
});

test('file-arrival routing requires the AIStor source and decoded object prefix', async () => {
    const persistence = createInMemoryTriggerPersistence();
    await persistence.createTrigger(triggerDefinition({
        ...fixture.aistorRouting.trigger,
        type: 'FILE_ARRIVAL',
    }));
    let submissions = 0;
    const service = createTriggerService(persistence, async () => {
            submissions += 1;
            return { replayed: false, run: { runId: 'run-1' } as never };
    });
    const result = await service.ingestAistorNotification(fixture.aistorRouting.notification);
    assert.equal(result.accepted, 1);
    assert.equal(submissions, 1);
    service.stop();
});

test('failed deliveries create recoverable dead letters and replay through normal idempotency', async () => {
    const persistence = createInMemoryTriggerPersistence();
    const trigger = await persistence.createTrigger(triggerDefinition(fixture.failedDelivery.trigger));
    const submissions: Array<Record<string, unknown>> = [];
    const service = createTriggerService(persistence, async (submission) => {
            submissions.push(submission);
            if (submissions.length === 1) {
                throw new Error('pipeline is temporarily unavailable');
            }
            return {
                replayed: false,
                run: { runId: 'run-replayed' } as never,
            };
    });
    const event = fixture.failedDelivery.event;

    const failed = await service.ingestCanonicalEvent(event);
    const pending = (await persistence.listTriggerDeadLetters('PENDING'))[0];
    assert.equal(failed.failed, 1);
    assert.ok(pending);
    assert.deepEqual(pending.event, event);
    assert.equal(pending.replayCount, 0);

    const replayed = await service.replayDeadLetter(pending.id);
    const stored = await persistence.getTriggerDeadLetter(pending.id);
    const attempts = await persistence.listTriggerDeliveryAttempts(trigger.id, 10);
    assert.equal(replayed.accepted, 1);
    assert.equal(stored?.status, 'REPLAYED');
    assert.equal(stored?.replayCount, 1);
    assert.equal((await persistence.listTriggerEvents())[0]?.status, 'ROUTED');
    assert.deepEqual(
        submissions.map((submission) => submission.idempotencyKey),
        ['trigger:' + trigger.id + ':warehouse:job-1', 'trigger:' + trigger.id + ':warehouse:job-1'],
    );
    assert.deepEqual(attempts.map((attempt) => attempt.status), ['REPLAYED', 'FAILED']);
    await assert.rejects(
        () => service.replayDeadLetter(pending.id),
        /already replayed/,
    );
    service.stop();
});

test('discarding a dead letter records an operator delivery outcome without submitting a run', async () => {
    const persistence = createInMemoryTriggerPersistence();
    const trigger = await persistence.createTrigger(triggerDefinition(fixture.discardDelivery.trigger));
    let submissionCount = 0;
    const service = createTriggerService(persistence, async () => {
            submissionCount += 1;
            throw new Error('pipeline is unavailable');
    });
    await service.ingestCanonicalEvent(fixture.discardDelivery.event);
    const pending = (await persistence.listTriggerDeadLetters('PENDING'))[0];
    assert.ok(pending);

    const discarded = await service.discardDeadLetter(pending.id);
    assert.equal(discarded.status, 'DISCARDED');
    assert.equal(submissionCount, 1);
    assert.equal((await persistence.listTriggerDeliveryAttempts(trigger.id, 10))[0]?.status, 'DISCARDED');
    assert.equal((await persistence.listTriggerEvents())[0]?.status, 'FAILED');
    service.stop();
});

test('routing records no-match decisions and delivers one event to every matching trigger', async () => {
    const persistence = createInMemoryTriggerPersistence();
    const createdTriggers = await Promise.all(fixture.routing.triggers.map((trigger) =>
        persistence.createTrigger(triggerDefinition(trigger))));
    const firstTrigger = createdTriggers[0];
    const secondTrigger = createdTriggers[1];
    assert.ok(firstTrigger);
    assert.ok(secondTrigger);
    const submissions: string[] = [];
    const service = createTriggerService(persistence, async (submission) => {
            submissions.push(submission.pipelineId);
            return { replayed: false, run: { runId: `run-${submissions.length}` } as never };
    });

    const multiMatch = await service.ingestCanonicalEvent(fixture.routing.multiMatch);
    const noMatch = await service.ingestCanonicalEvent(fixture.routing.noMatch);

    assert.equal(multiMatch.accepted, 2);
    assert.deepEqual(submissions.sort(), ['pipeline-1', 'pipeline-2']);
    assert.equal(noMatch.ignored, 1);
    const decisions = await persistence.listTriggerRoutingDecisions(undefined, undefined, 20);
    assert.equal(decisions.filter((decision) => decision.outcome === 'MATCHED').length, 2);
    assert.equal(decisions.filter((decision) => decision.outcome === 'NO_MATCH').length, 4);
    assert.ok(decisions.some((decision) => decision.triggerId === firstTrigger.id));
    assert.ok(decisions.some((decision) => decision.triggerId === secondTrigger.id));
    service.stop();
});

async function assertLatestDebouncedFileEvent(
    trigger: TriggerDefinitionFixture,
    name: string,
    events: CanonicalTriggerEvent[],
    assertDebounceDecision = false,
): Promise<void> {
    const persistence = createInMemoryTriggerPersistence();
    await persistence.createTrigger(triggerDefinition({
        ...trigger,
        name,
        type: 'FILE_ARRIVAL',
    }));
    const submissions: string[] = [];
    const service = createTriggerService(persistence, async (submission) => {
        submissions.push(String(submission.callerMetadata?.triggerEventId));
        return {
            replayed: false,
            run: { runId: 'run-' + submissions.length } as never,
        };
    });
    const first = await service.ingestCanonicalEvent(events[0]!);
    const second = await service.ingestCanonicalEvent(events[1]!);
    await service.flushDebounces();

    assert.equal(first.accepted, 1);
    assert.equal(second.accepted, 1);
    assert.deepEqual(submissions, [events[1]!.eventId]);
    const storedEvents = await persistence.listTriggerEvents(10);
    assert.equal(storedEvents.find((item) => item.event.eventId === events[0].eventId)?.status, 'IGNORED');
    assert.equal(storedEvents.find((item) => item.event.eventId === events[1].eventId)?.status, 'ROUTED');
    if (assertDebounceDecision) {
        assert.equal((await persistence.listTriggerRoutingDecisions(undefined, undefined, 10))
            .some((decision) => decision.outcome === 'DEBOUNCED'), true);
    }
    service.stop();
}
