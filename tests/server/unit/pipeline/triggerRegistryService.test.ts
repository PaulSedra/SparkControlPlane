/**
 * @fileoverview Tests the trigger control-plane facade exposed by the registry.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { createTriggerRegistryService } from '../../../../src/server/pipeline/triggerRegistryService.ts';
import { createTriggerEventService } from '../../../../src/server/triggers/triggerEventService.ts';
import { createTriggerServices } from '../../../../src/server/triggers/triggerServices.ts';
import { createInMemoryPersistence } from '../../../support/inMemoryPersistence.ts';
import { triggerDefinition } from '../../../support/triggerFixtures.ts';

test('schedule status can be called without binding the facade object', async () => {
    const now = Date.parse('2026-10-02T12:02:30.000Z');
    const persistence = createInMemoryPersistence({ now: () => now });
    const submitRun = async () => {
        throw new Error('Run submission is not expected in this test.');
    };
    const triggerServices = createTriggerServices({
        now: () => now,
        persistence,
        submitRun,
    });
    const eventService = createTriggerEventService({
        now: () => now,
        persistence,
        services: triggerServices,
        submitRun,
    });
    const registry = createTriggerRegistryService({
        eventService,
        now: () => now,
        persistence,
        triggerServices,
    });

    try {
        const trigger = await registry.createTrigger(triggerDefinition({
            configuration: {
                cron: '*/5 * * * *',
                timeZone: 'UTC',
            },
            name: 'schedule-status-test',
            type: 'SCHEDULE',
        }));
        const getTriggerScheduleStatus = registry.getTriggerScheduleStatus;
        const status = await getTriggerScheduleStatus(trigger.id);

        assert.equal(status.triggerId, trigger.id);
        assert.equal(status.nextOccurrenceAt, '2026-10-02T12:05:00.000Z');
    } finally {
        eventService.stop();
    }
});

test('YAML trigger pause persists across reads until explicit YAML reconciliation', async () => {
    const now = Date.parse('2026-10-02T12:02:30.000Z');
    const persistence = createInMemoryPersistence({ now: () => now });
    await persistence.initialize();
    const submitRun = async () => {
        throw new Error('Run submission is not expected in this test.');
    };
    const triggerServices = createTriggerServices({ now: () => now, persistence, submitRun });
    const eventService = createTriggerEventService({
        now: () => now,
        persistence,
        services: triggerServices,
        submitRun,
    });
    const pipelineId = 'yaml-trigger-pipeline';
    const yamlTrigger = triggerDefinition({
        configuration: { cron: '*/5 * * * *', timeZone: 'UTC' },
        enabled: true,
        name: 'yaml-schedule-trigger',
        pipelineId,
        type: 'SCHEDULE',
    });
    const registry = createTriggerRegistryService({
        eventService,
        now: () => now,
        persistence,
        triggerServices,
    });

    try {
        await persistence.reconcileYamlTriggers(pipelineId, [yamlTrigger]);
        const trigger = (await registry.listTriggers())[0];
        assert.ok(trigger);
        assert.equal(trigger.managedByYaml, true);

        await registry.updateTrigger(trigger.id, { enabled: false });
        assert.equal((await registry.getTrigger(trigger.id)).enabled, false);
        assert.equal(
            (await registry.getTriggerScheduleStatus(trigger.id)).nextOccurrenceAt,
            undefined,
        );

        await registry.updateTrigger(trigger.id, { enabled: true });
        assert.equal((await registry.getTrigger(trigger.id)).enabled, true);

        await persistence.reconcileYamlTriggers(pipelineId, [{ ...yamlTrigger, enabled: false }]);
        assert.equal((await registry.getTrigger(trigger.id)).enabled, false);

        await persistence.reconcileYamlTriggers(pipelineId, []);
        const removed = (await registry.listTriggers()).find((item) => item.id === trigger.id);
        assert.equal(removed?.active, false);
        assert.equal(removed?.enabled, false);
    } finally {
        eventService.stop();
    }
});
