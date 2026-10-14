/**
 * @fileoverview Contract tests for building official Spark Pipelines CLI arguments.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import type { PipelineSpec } from '../../../../src/shared/pipelineRegistryTypes.ts';
import {
    buildSparkPipelinesArguments,
    previewSparkPipelinesCommand,
} from '../../../../src/server/pipeline/spark/sparkCliProcess.ts';

const config = {
    binaryPath: 'spark-pipelines',
    propertiesFile: '/app/spark/spark-defaults.conf',
};
const spec = {
    name: 'Example pipeline',
    specPath: '/app/pipelines/example/resources/pipeline.yml',
} as unknown as PipelineSpec;
const remoteUrl = 'sc://spark-connect.internal:15002';

test('builds the documented Spark Connect command with the configured endpoint', () => {
    assert.deepEqual(
        buildSparkPipelinesArguments(config, remoteUrl, spec, 'incremental'),
        [
            'spark-pipelines',
            'run',
            '--properties-file',
            '/app/spark/spark-defaults.conf',
            '--remote',
            remoteUrl,
            '--spec',
            spec.specPath,
        ],
    );
});

test('maps refresh modes to the default CLI flags', () => {
    assert.deepEqual(
        buildSparkPipelinesArguments({ binaryPath: 'spark-pipelines' }, remoteUrl, spec, 'full-refresh-all'),
        ['spark-pipelines', 'run', '--remote', remoteUrl, '--spec', spec.specPath, '--full-refresh-all'],
    );
    assert.deepEqual(
        buildSparkPipelinesArguments(
            { binaryPath: 'spark-pipelines' },
            remoteUrl,
            spec,
            'refresh-selected',
            ['bronze.input', 'silver.output'],
        ),
        [
            'spark-pipelines',
            'run',
            '--remote',
            remoteUrl,
            '--spec',
            spec.specPath,
            '--refresh',
            'bronze.input,silver.output',
        ],
    );
    assert.deepEqual(
        buildSparkPipelinesArguments(
            { binaryPath: 'spark-pipelines' },
            remoteUrl,
            spec,
            'full-refresh-selected',
            ['silver.output'],
        ),
        [
            'spark-pipelines',
            'run',
            '--remote',
            remoteUrl,
            '--spec',
            spec.specPath,
            '--full-refresh',
            'silver.output',
        ],
    );
});

test('uses the default dry-run command and keeps Connect details out of the preview', () => {
    assert.deepEqual(
        buildSparkPipelinesArguments({ binaryPath: 'spark-pipelines' }, remoteUrl, spec, 'dry-run'),
        ['spark-pipelines', 'dry-run', '--remote', remoteUrl, '--spec', spec.specPath],
    );
    assert.deepEqual(previewSparkPipelinesCommand(spec, 'incremental'), [
        'spark-pipelines',
        'run',
        '--spec',
        spec.specPath,
    ]);
});
