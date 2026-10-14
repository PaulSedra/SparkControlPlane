/**
 * @fileoverview Unit coverage for YAML decoding and pipeline document roots.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { ControlPlaneApiError } from '../../../../src/server/errors/controlPlaneApiError.ts';
import { parsePipelineYamlDocument } from '../../../../src/server/pipeline/discovery/yamlParser.ts';

test('parses a pipeline YAML root mapping with normalized values', () => {
    const document = parsePipelineYamlDocument(
        'name: orders\nnullable: null\n',
        'resources/orders.pipeline.yaml',
    );

    assert.equal(document.name, 'orders');
    assert.equal(document.nullable, undefined);
});

test('reports a non-mapping root as a source-qualified pipeline YAML error', () => {
    assert.throws(
        () => parsePipelineYamlDocument('- orders\n', 'resources/orders.pipeline.yaml'),
        (error: unknown) => {
            assert.ok(error instanceof ControlPlaneApiError);
            assert.equal(error.statusCode, 400);
            assert.match(error.message, /Invalid pipeline YAML in resources\/orders\.pipeline\.yaml/);
            assert.match(error.message, /must be a YAML mapping/);
            return true;
        },
    );
});

test('reports YAML syntax errors with the pipeline source path', () => {
    assert.throws(
        () => parsePipelineYamlDocument('name: [orders\n', 'resources/orders.pipeline.yaml'),
        (error: unknown) => {
            assert.ok(error instanceof ControlPlaneApiError);
            assert.equal(error.statusCode, 400);
            assert.match(error.message, /Invalid pipeline YAML in resources\/orders\.pipeline\.yaml/);
            return true;
        },
    );
});
