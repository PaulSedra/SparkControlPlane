/**
 * @fileoverview Contract tests for building official Spark Pipelines CLI arguments.
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import type { PipelineRun, PipelineSpec } from '../../../../src/shared/pipelineRegistryTypes.ts';
import {
    buildSparkConnectServerArguments,
    buildSparkPipelinesArguments,
    previewSparkPipelinesCommand,
    runSparkCliProcess,
} from '../../../../src/server/pipeline/spark/sparkCliProcess.ts';

import { displayClientCommand } from '../../../../src/server/pipeline/spark/sparkCliProtocol.ts';

const config = {
    binaryPath: 'spark-pipelines',
    driverHost: 'spark-control-plane.example',
    executorPython: 'python3',
    masterUrl: 'spark://spark-master:7077',
    propertiesFile: '/app/spark/spark-defaults.conf',
    pythonPath: '/usr/local/bin/python',
    stateDirectory: '/app/run-state',
};
const spec = {
    name: 'Example pipeline',
    specPath: '/app/pipelines/example/resources/pipeline.yml',
} as unknown as PipelineSpec;
const runId = 'run-123';

function expectedClientArguments(
    mode: 'incremental' | 'dry-run' | 'full-refresh-all' | 'refresh-selected' | 'full-refresh-selected',
    targetNodeNames?: string[],
): string[] {
    const command = [
        'spark-pipelines',
        '--remote', 'sc://127.0.0.1:<SPARK_CONNECT_PORT>',
        mode === 'dry-run' ? 'dry-run' : 'run',
        '--spec', path.resolve(spec.specPath),
    ];
    if (mode === 'full-refresh-all') {
        command.push('--full-refresh-all');
    }
    if (mode === 'refresh-selected' && targetNodeNames != null) {
        command.push('--refresh', targetNodeNames.join(','));
    }
    if (mode === 'full-refresh-selected' && targetNodeNames != null) {
        command.push('--full-refresh', targetNodeNames.join(','));
    }
    return command;
}

function expectedServerArguments(): string[] {
    const runDirectory = path.join('/app/run-state', 'runs', runId);
    return [
        'spark-submit',
        '--class', 'org.apache.spark.sql.connect.service.SparkConnectServer',
        '--master', config.masterUrl,
        '--deploy-mode', 'client',
        '--name', `spark-control-plane-${runId}`,
        '--conf', `spark.driver.host=${config.driverHost}`,
        '--conf', 'spark.driver.bindAddress=0.0.0.0',
        '--conf', 'spark.connect.grpc.binding.address=0.0.0.0',
        '--conf', 'spark.connect.grpc.binding.port=0',
        '--conf', `spark.pyspark.driver.python=${config.pythonPath}`,
        '--conf', `spark.pyspark.python=${config.executorPython}`,
        '--conf', `spark.executorEnv.PYSPARK_PYTHON=${config.executorPython}`,
        '--archives', `${path.join(runDirectory, 'pipeline-source.zip')}#pipeline-source`,
        '--py-files', [
            path.join(runDirectory, 'spark-pipeline-adapter.zip'),
            path.join(runDirectory, 'pipeline-source.zip'),
        ].join(','),
        '--properties-file', config.propertiesFile,
    ];
}

test('builds a Connect client and one Standalone server application for a complete pipeline', () => {
    assert.deepEqual(
        buildSparkPipelinesArguments(config, spec, 'incremental', runId),
        expectedClientArguments('incremental'),
    );
    assert.deepEqual(
        buildSparkConnectServerArguments(config, spec, runId),
        expectedServerArguments(),
    );
});

test('maps refresh modes to Spark Pipelines flags without splitting the application', () => {
    assert.deepEqual(
        buildSparkPipelinesArguments(config, spec, 'full-refresh-all', runId),
        expectedClientArguments('full-refresh-all'),
    );
    assert.deepEqual(
        buildSparkPipelinesArguments(
            config,
            spec,
            'refresh-selected',
            runId,
            ['bronze.input', 'silver.output'],
        ),
        expectedClientArguments('refresh-selected', ['bronze.input', 'silver.output']),
    );
    assert.deepEqual(
        buildSparkPipelinesArguments(
            config,
            spec,
            'full-refresh-selected',
            runId,
            ['silver.output'],
        ),
        expectedClientArguments('full-refresh-selected', ['silver.output']),
    );
});

test('builds a dry-run and keeps local archive paths out of the preview', () => {
    assert.deepEqual(
        buildSparkPipelinesArguments(config, spec, 'dry-run', runId),
        expectedClientArguments('dry-run'),
    );
    assert.deepEqual(previewSparkPipelinesCommand(spec, 'incremental'), [
        'spark-pipelines',
        '--remote', 'sc://127.0.0.1:<per-run-port>',
        'run',
        '--spec',
        spec.specPath,
    ]);
});

test('requires an existing Spark Standalone master and a worker-reachable driver host', () => {
    assert.throws(
        () => buildSparkConnectServerArguments({ ...config, masterUrl: undefined }, spec, runId),
        /SPARK_MASTER_URL is required/,
    );
    assert.throws(
        () => buildSparkConnectServerArguments({ ...config, driverHost: undefined }, spec, runId),
        /SPARK_DRIVER_HOST must be reachable/,
    );
});

test('previews the same full refresh selection sent to Spark', () => {
    assert.deepEqual(
        previewSparkPipelinesCommand(spec, 'full-refresh-selected', ['silver.output']).slice(-2),
        ['--full-refresh', 'silver.output'],
    );
});

test('detaches a recovered monitor without reporting an exit code', async () => {
    const result = await runSparkCliProcess({
        executionMode: 'monitor',
        onController: (controller) => controller.detach(),
        onSnapshot: async () => assert.fail('A detached monitor should not persist a snapshot.'),
        run: { runId, mode: 'incremental', cliExecutionId: runId, cliRunDirectory: '/run/example' } as PipelineRun,
        shouldCancel: async () => false,
    });
    assert.equal(result.detached, true);
    assert.equal(result.exitCode, undefined);
});

test('replaces display values by flag even when client arguments move', () => {
    const command = ['spark-pipelines', 'run', '--spec', '/app/staged.yml', '--remote', 'sc://127.0.0.1:1234'];
    assert.deepEqual(displayClientCommand(command, 'pipeline.yml'), [
        'spark-pipelines', 'run', '--spec', 'pipeline.yml', '--remote', 'sc://127.0.0.1:<per-run-port>',
    ]);
    assert.equal(command[3], '/app/staged.yml');
});

test('rejects a submission without a verified source file list before starting a helper', async () => {
    const options = {
        executionMode: 'submit',
        onController: () => assert.fail('A submission requires a verified file list.'),
        onSnapshot: async () => assert.fail('An invalid submission should not persist a snapshot.'),
        run: { runId, mode: 'incremental' } as PipelineRun,
        shouldCancel: async () => false,
        spec,
    } as Parameters<typeof runSparkCliProcess>[0];
    await assert.rejects(runSparkCliProcess(options), /verified pipeline source file list is required/);
});
