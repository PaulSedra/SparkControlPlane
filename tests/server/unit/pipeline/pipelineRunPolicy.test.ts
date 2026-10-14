/**
 * @fileoverview Unit coverage for pipeline run policy loading and defaults.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { createTestDataLoader } from '../../../support/testData.ts';
import {
    loadPipelineRunPolicies,
    pipelineRunPolicy,
} from '../../../../src/server/pipeline/execution/pipelineRunPolicy.ts';

interface PipelineRunPolicyFixture {
    cases: Array<{
        configuredPolicies?: Record<string, Record<string, unknown>>;
        errorIncludes?: string;
        expected?: { allowOverlap: boolean; timeoutSeconds?: number };
        name: string;
        policyName: string;
    }>;
}

const cases = createTestDataLoader('server/unit')
    .loadYaml<PipelineRunPolicyFixture>('fixtures/pipeline-run-policy.yaml')
    .cases;

for (const scenario of cases) {
    test('pipeline run policies ' + scenario.name, () => {
        const environment = scenario.configuredPolicies == null
            ? {}
            : { PIPELINE_RUN_POLICIES: JSON.stringify(scenario.configuredPolicies) };
        if (scenario.errorIncludes != null) {
            assert.throws(
                () => loadPipelineRunPolicies(environment),
                new RegExp(scenario.errorIncludes),
            );
            return;
        }

        const policies = loadPipelineRunPolicies(environment);
        assert.deepEqual(
            pipelineRunPolicy(scenario.policyName, policies),
            scenario.expected,
        );
    });
}

test('does not apply a global environment timeout', () => {
    const policies = loadPipelineRunPolicies({ PIPELINE_RUN_TIMEOUT_SECONDS: '1' });

    assert.deepEqual(pipelineRunPolicy('Example', policies), { allowOverlap: false });
});
