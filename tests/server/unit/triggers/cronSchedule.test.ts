/**
 * @fileoverview Unit coverage for cron configuration and occurrence calculations.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import {
    latestOccurrenceAtOrBefore,
    nextOccurrenceAfter,
    parseScheduleConfiguration,
} from '../../../../src/server/triggers/cronSchedule.ts';
import type { ScheduleConfiguration } from '../../../../src/server/types/triggerTypes.ts';
import { createTestDataLoader } from '../../../support/testData.ts';

interface CronFixtureData {
    occurrences: CronOccurrenceFixture[];
    parse: CronParseFixture[];
    reject: CronRejectFixture[];
}

interface CronParseFixture {
    expected: ScheduleConfiguration;
    input: Record<string, unknown>;
    name: string;
}

interface CronRejectFixture {
    errorIncludes: string;
    input: Record<string, unknown>;
    name: string;
}

interface CronOccurrenceFixture {
    configuration: Record<string, unknown>;
    expected: {
        latest?: {
            at: string;
            localTime?: string;
        };
        next?: {
            at: string;
            localTime?: string;
        };
    };
    name: string;
    now: string;
}

const testData = createTestDataLoader('server/unit');
const cronFixtures = testData.loadYaml<CronFixtureData>('fixtures/cron.yaml');

for (const scenario of cronFixtures.parse) {
    test('cron schedules ' + scenario.name, () => {
        assert.deepEqual(
            parseScheduleConfiguration(scenario.input),
            scenario.expected,
        );
    });
}

for (const scenario of cronFixtures.reject) {
    test('cron schedules ' + scenario.name, () => {
        assert.throws(
            () => parseScheduleConfiguration(scenario.input),
            (error: unknown) => error instanceof Error &&
                error.message.includes(scenario.errorIncludes),
        );
    });
}

for (const scenario of cronFixtures.occurrences) {
    test('cron schedules ' + scenario.name, () => {
        const configuration = parseScheduleConfiguration(scenario.configuration);
        const now = new Date(scenario.now);

        if (scenario.expected.latest != null) {
            const latest = latestOccurrenceAtOrBefore(now, configuration);
            assert.equal(latest?.at.toISOString(), scenario.expected.latest.at);
            if (scenario.expected.latest.localTime != null) {
                assert.equal(latest?.localTime, scenario.expected.latest.localTime);
            }
        }

        if (scenario.expected.next != null) {
            const next = nextOccurrenceAfter(now, configuration);
            assert.equal(next?.at.toISOString(), scenario.expected.next.at);
            if (scenario.expected.next.localTime != null) {
                assert.equal(next?.localTime, scenario.expected.next.localTime);
            }
        }
    });
}
