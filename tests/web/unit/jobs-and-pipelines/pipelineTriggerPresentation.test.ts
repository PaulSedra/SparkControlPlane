/**
 * @fileoverview Unit coverage for pipeline trigger presentation helpers.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import type { TriggerDefinition } from '../../../../src/web/types/triggerTypes.ts';
import { pipelineTriggerLabel } from '../../../../src/web/components/jobs-and-pipelines/pipelineTriggerPresentation.ts';
import { createTestDataLoader } from '../../../support/testData.ts';

interface PipelineTriggerPresentationFixture {
    pipelineTriggerPresentation: Array<{
        expected: string;
        name: string;
        pipelineId: string;
        triggers: Array<Pick<TriggerDefinition, 'active' | 'pipelineId' | 'type'>>;
    }>;
}

const cases = createTestDataLoader('web/unit')
    .loadYaml<PipelineTriggerPresentationFixture>('fixtures/presentation.yaml')
    .pipelineTriggerPresentation;

for (const scenario of cases) {
    test(scenario.name, () => {
        assert.equal(
            pipelineTriggerLabel(scenario.pipelineId, scenario.triggers),
            scenario.expected,
        );
    });
}
