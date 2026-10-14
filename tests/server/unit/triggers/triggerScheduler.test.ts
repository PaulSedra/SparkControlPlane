/**
 * @fileoverview Unit coverage for scheduled trigger execution.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { createInMemoryTriggerPersistence } from '../../../support/inMemoryTriggerPersistence.ts';
import { createTestDataLoader } from '../../../support/testData.ts';
import { triggerDefinition } from '../../../support/triggerFixtures.ts';
import { createTriggerScheduler } from '../../../../src/server/triggers/triggerScheduler.ts';
import { createTriggerServices } from '../../../../src/server/triggers/triggerServices.ts';

interface TriggerSchedulerFixture {
    configuration: { cron: string; timeZone: string };
    failureMessage: string;
    now: string;
    triggers: {
        failedDelivery: string;
        replayableDelivery: string;
        successfulDelivery: string;
    };
}

const fixture = createTestDataLoader('server/unit')
    .loadYaml<TriggerSchedulerFixture>('fixtures/trigger-scheduler.yaml');
const now = Date.parse(fixture.now);

test('scheduler records one due occurrence and survives a scheduler restart', async () => {
    const persistence = createInMemoryTriggerPersistence({ now: () => now });
    await persistence.createTrigger(triggerDefinition({
        configuration: fixture.configuration,
        name: fixture.triggers.successfulDelivery,
        type: 'SCHEDULE',
    }));
    const submissions: Array<Record<string, unknown>> = [];
    const submitRun = async (submission: Record<string, unknown>) => {
        submissions.push(submission);
        return {
            replayed: false,
            run: { runId: 'run-1' } as never,
        };
    };
    const services = createTriggerServices({ now: () => now, persistence, submitRun });
    const firstScheduler = createTriggerScheduler({
        delivery: services.deliver,
        now: () => now,
        persistence,
    });

    await firstScheduler.tick();
    await firstScheduler.tick();

    assert.equal(submissions.length, 1);
    assert.equal(submissions[0]?.requestSource, 'trigger:schedule');
    assert.match(String(submissions[0]?.idempotencyKey), /^schedule:/);
    assert.equal((await persistence.listTriggerEvents())[0]?.status, 'ROUTED');
    assert.equal((await persistence.listTriggerDeliveryAttempts())[0]?.status, 'ACCEPTED');

    const restartedScheduler = createTriggerScheduler({
        delivery: services.deliver,
        now: () => now,
        persistence,
    });
    await restartedScheduler.tick();

    assert.equal(submissions.length, 1);
    assert.equal((await persistence.listTriggerEvents())[0]?.duplicateCount, 2);
});

test('a failed scheduled delivery is durable and is not retried by the scheduler', async () => {
    const persistence = createInMemoryTriggerPersistence({ now: () => now });
    await persistence.createTrigger(triggerDefinition({
        configuration: fixture.configuration,
        name: fixture.triggers.failedDelivery,
        type: 'SCHEDULE',
    }));
    let submissionCount = 0;
    const services = createTriggerServices({
        now: () => now,
        persistence,
        submitRun: async () => {
            submissionCount += 1;
            throw new Error(fixture.failureMessage);
        },
    });
    const scheduler = createTriggerScheduler({
        delivery: services.deliver,
        now: () => now,
        persistence,
    });

    await scheduler.tick();
    await scheduler.tick();

    assert.equal(submissionCount, 1);
    assert.equal((await persistence.listTriggerDeliveryAttempts())[0]?.status, 'FAILED');
    assert.equal((await persistence.listTriggerEvents())[0]?.status, 'FAILED');
    assert.equal((await persistence.listTriggers())[0]?.lastOutcome?.status, 'FAILED');
    assert.equal((await persistence.listTriggerDeadLetters('PENDING')).length, 1);
});

test('scheduled dead letters replay through the shared recovery service', async () => {
    const persistence = createInMemoryTriggerPersistence({ now: () => now });
    const trigger = await persistence.createTrigger(triggerDefinition({
        configuration: fixture.configuration,
        name: fixture.triggers.replayableDelivery,
        type: 'SCHEDULE',
    }));
    let submissionCount = 0;
    const services = createTriggerServices({
        now: () => now,
        persistence,
        submitRun: async (submission) => {
            submissionCount += 1;
            assert.equal(submission.requestSource, 'trigger:schedule');
            if (submissionCount === 1) {
                throw new Error(fixture.failureMessage);
            }
            return { replayed: false, run: { runId: 'run-replayed' } as never };
        },
    });
    const scheduler = createTriggerScheduler({
        delivery: services.deliver,
        now: () => now,
        persistence,
    });

    await scheduler.tick();
    const pending = (await persistence.listTriggerDeadLetters('PENDING'))[0];
    assert.ok(pending);

    const replayed = await services.deadLetters.replayDeadLetter(pending.id);

    assert.equal(replayed.accepted, 1);
    assert.equal((await persistence.getTriggerDeadLetter(pending.id))?.status, 'REPLAYED');
    assert.deepEqual(
        (await persistence.listTriggerDeliveryAttempts(trigger.id, 10)).map((attempt) => attempt.status),
        ['REPLAYED', 'FAILED'],
    );
});
