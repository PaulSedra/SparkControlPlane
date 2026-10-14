/**
 * @fileoverview Unit coverage for executable pipeline source identity.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { hashPipelineSource } from '../../../../src/server/pipeline/discovery/pipelineVersion.ts';

const root = 'C:/pipelines/example';
const sources = [{ content: 'SELECT 1 AS value;\n', sourceFile: `${root}/sql/model.sql` }];

test('control-plane timeout, trigger, and success metadata do not change source identity', () => {
    const base = [
        'name: Example Silver',
        'storage: s3a://warehouse/',
        'libraries:',
        '  - glob:',
        '      include: ../src/**',
        '',
    ].join('\n');
    const configured = [
        'name: Example Silver',
        'storage: s3a://warehouse/',
        'libraries:',
        '  - glob:',
        '      include: ../src/**',
        'triggers:',
        '  - name: source-events',
        '    schedule:',
        '      cron: "0 3 * * *"',
        '      timezone_id: UTC',
        'on_success:',
        '  pipeline: Example Gold',
        'timeout_seconds: 7200',
        '',
    ].join('\n');

    assert.equal(
        hashPipelineSource(root, base, sources),
        hashPipelineSource(root, configured, sources),
    );
});
