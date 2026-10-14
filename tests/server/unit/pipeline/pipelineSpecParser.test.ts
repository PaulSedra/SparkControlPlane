/**
 * @fileoverview Unit coverage for pipeline YAML metadata parsing.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { parsePipelineSpec } from '../../../../src/server/pipeline/discovery/pipelineSpecParser.ts';

const specPath = 'resources/example-silver.pipeline.yaml';

test('parses a pipeline success dependency by name', () => {
    const spec = parsePipelineSpec(specPath, [
        'name: Example Silver',
        'storage: s3a://warehouse/',
        'on_success:',
        '  pipeline: Example Gold',
        '',
    ].join('\n'));

    assert.deepEqual(spec.onSuccess, { pipeline: 'Example Gold' });
    assert.equal(spec.timeoutSeconds, undefined);
});

test('parses the optional per-pipeline timeout from YAML', () => {
    const spec = parsePipelineSpec(specPath, [
        'name: Example Silver',
        'storage: s3a://warehouse/',
        'timeout_seconds: 7200',
        '',
    ].join('\n'));

    assert.equal(spec.timeoutSeconds, 7200);
});

for (const [name, value] of [
    ['a string', 'timeout_seconds: "60"'],
    ['zero', 'timeout_seconds: 0'],
    ['a fraction', 'timeout_seconds: 1.5'],
    ['more than seven days', 'timeout_seconds: 604801'],
] as const) {
    test(`rejects ${name} YAML timeout values`, () => {
        assert.throws(
            () => parsePipelineSpec(specPath, [
                'name: Example Silver',
                'storage: s3a://warehouse/',
                value,
                '',
            ].join('\n')),
            /timeout_seconds must be an integer from 1 to 604800/,
        );
    });
}

for (const [name, value, error] of [
    ['non-mapping', 'on_success: Example Gold', /on_success must be a YAML mapping/],
    ['empty pipeline', 'on_success: {}', /on_success\.pipeline is required/],
    ['blank pipeline', 'on_success:\n  pipeline: " "', /on_success\.pipeline must be a non-empty string/],
    ['unknown key', 'on_success:\n  pipeline: Example Gold\n  mode: full-refresh-all', /unsupported key "mode"/],
] as const) {
    test(`rejects ${name} success dependency configuration`, () => {
        assert.throws(
            () => parsePipelineSpec(specPath, [
                'name: Example Silver',
                'storage: s3a://warehouse/',
                value,
                '',
            ].join('\n')),
            error,
        );
    });
}
