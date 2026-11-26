/** @fileoverview Contract coverage for lightweight Spark pipeline metadata loading. */

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const repositoryRoot = path.resolve(import.meta.dirname, '../../../..');
const pythonExecutable = process.platform === 'win32'
    ? path.join(repositoryRoot, '.venv', 'Scripts', 'python.exe')
    : path.join(repositoryRoot, '.venv', 'bin', 'python');
const pipelineAdapterDirectory = path.join(repositoryRoot, 'src', 'server', 'pipeline', 'spark');

test('loads Spark pipeline fields without importing Spark client dependencies', {
    skip: !existsSync(pythonExecutable),
}, async () => {
    const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'spark-pipeline-spec-'));
    const specPath = path.join(temporaryDirectory, 'pipeline.yml');
    await writeFile(specPath, [
        'name: Source Pipeline',
        'storage: /app/checkpoints/source',
        'catalog: spark_catalog',
        'database: default',
        'configuration:',
        '  spark.sql.shuffle.partitions: "2"',
        'libraries:',
        '  - glob:',
        '      include: ../src/**',
        'triggers:',
        '  - name: source-schedule',
        'on_success:',
        '  pipeline: Target Pipeline',
        'timeout_seconds: 3600',
        '',
    ].join('\n'));

    try {
        const script = [
            'import importlib.abc',
            'import json',
            'import sys',
            'class ConnectDependencyBlocker(importlib.abc.MetaPathFinder):',
            '    def find_spec(self, fullname, _path=None, _target=None):',
            '        if fullname == "grpc" or fullname.startswith(("grpc.", "grpc_status", "google.rpc", "zstandard")):',
            '            raise ImportError("Connect-only dependency was imported: " + fullname)',
            '        return None',
            'sys.meta_path.insert(0, ConnectDependencyBlocker())',
            'from pathlib import Path',
            'from spark_pipeline_spec import load_pipeline_spec_for_control_plane',
            'from pyspark.pipelines import materialized_view',
            'spec = load_pipeline_spec_for_control_plane(Path(sys.argv[1]))',
            'print(json.dumps({"catalog": spec.catalog, "configuration": dict(spec.configuration), "database": spec.database, "libraries": [entry.include for entry in spec.libraries], "name": spec.name, "storage": spec.storage}))',
        ].join('\n');
        const result = spawnSync(pythonExecutable, ['-c', script, specPath], {
            cwd: repositoryRoot,
            encoding: 'utf8',
            env: {
                ...process.env,
                PYTHONPATH: [pipelineAdapterDirectory, process.env.PYTHONPATH]
                    .filter((entry) => entry != null && entry !== '')
                    .join(path.delimiter),
            },
        });

        assert.equal(result.status, 0, result.stderr || result.error?.message);
        const output = result.stdout.trim().split(/\r?\n/).at(-1);
        assert.deepEqual(JSON.parse(output ?? ''), {
            catalog: 'spark_catalog',
            configuration: { 'spark.sql.shuffle.partitions': '2' },
            database: 'default',
            libraries: ['../src/**'],
            name: 'Source Pipeline',
            storage: '/app/checkpoints/source',
        });
    } finally {
        await rm(temporaryDirectory, { force: true, recursive: true });
    }
});
