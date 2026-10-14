/**
 * @fileoverview Unit coverage for pipeline run timing presentation.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import type {
    PipelineRunNodeStatus,
    RunStatus,
} from '../../../../src/shared/pipelineRegistryTypes.ts';
import { createTestDataLoader } from '../../../support/testData.ts';
import { pipelineNodeDurationMs } from '../../../../src/web/utils/pipelineRunTiming.ts';
import {
    formatPipelineDuration,
    formatPipelineRunDuration,
    hasActiveRunTiming,
} from '../../../../src/web/components/pipeline/pipelineTiming.ts';

interface PipelineRunTimingFixture {
    pipelineRunTiming: {
        durationCases: Array<{
            expected: number | null;
            name: string;
            node: {
                completedAt?: string;
                durationMs?: number;
                startedAt?: string;
                status?: string;
            };
            now: string;
        }>;
        activeRun: {
            nodeStatuses: Record<string, {
                lastUpdatedAt: string;
                qualifiedName: string;
                startedAt: string;
                status: PipelineRunNodeStatus;
            }>;
            status: RunStatus;
        };
    };
}

const fixture = createTestDataLoader('web/unit')
    .loadYaml<PipelineRunTimingFixture>('fixtures/presentation.yaml');

for (const scenario of fixture.pipelineRunTiming.durationCases) {
    test('pipeline node duration ' + scenario.name, () => {
        assert.equal(
            pipelineNodeDurationMs(scenario.node, Date.parse(scenario.now)),
            scenario.expected ?? undefined,
        );
    });
}

test('pipeline duration formats zero milliseconds', () => {
    assert.equal(formatPipelineDuration(0), '0 ms');
});

test('active run total duration advances from its persisted start time', () => {
    const run = {
        mode: 'incremental',
        pipelineId: 'pipeline-1',
        runId: 'run-1',
        sparkAppName: 'application-1',
        startedAt: '2026-09-30T12:00:00.000Z',
        status: 'RUNNING',
    } as const;

    assert.equal(
        formatPipelineRunDuration(run, Date.parse('2026-09-30T12:00:05.400Z')),
        '5.4 s',
    );
});

test('terminal run total duration stays at its persisted end time', () => {
    const run = {
        mode: 'incremental',
        pipelineId: 'pipeline-1',
        runId: 'run-1',
        sparkAppName: 'application-1',
        startedAt: '2026-09-30T12:00:00.000Z',
        endedAt: '2026-09-30T12:00:02.000Z',
        status: 'SUCCEEDED',
    } as const;

    assert.equal(
        formatPipelineRunDuration(run, Date.parse('2026-09-30T12:00:10.000Z')),
        '2.0 s',
    );
});

test('run timing includes active node records even if the run status is terminal', () => {
    assert.equal(hasActiveRunTiming(fixture.pipelineRunTiming.activeRun), true);
});
