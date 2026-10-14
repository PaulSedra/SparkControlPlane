/**
 * @fileoverview Contract coverage for PySpark CLI spec loading with control-plane metadata.
 */

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
const pipelineRootDirectory = path.join(repositoryRoot, 'src', 'server', 'pipeline');

test('loads the original PySpark spec path after removing SCP-only metadata', {
    skip: !existsSync(pythonExecutable),
}, async () => {
    const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'spark-pipeline-spec-'));
    const specPath = path.join(temporaryDirectory, 'pipeline.yml');
    await writeFile(specPath, [
        'name: Source Pipeline',
        'storage: /app/checkpoints/source',
        'libraries:',
        '  - glob:',
        '      include: ../src/**',
        'triggers:',
        '  - name: source-schedule',
        '    schedule:',
        '      cron: "0 0 * * *"',
        '      timezone_id: UTC',
        '      pause_status: PAUSED',
        'on_success:',
        '  pipeline: Target Pipeline',
        'timeout_seconds: 3600',
        '',
    ].join('\n'));

    try {
        const script = [
            'import json',
            'import sys',
            'from pyspark.pipelines import cli',
            'import spark_pipeline_cli',
            'def capture_run(spec_path, **_options):',
            '    spec = cli.load_pipeline_spec(spec_path)',
            '    print(json.dumps({"name": spec.name, "storage": spec.storage, "library_count": len(spec.libraries), "spec_path": str(spec_path)}))',
            'cli.run = capture_run',
            'sys.argv = ["spark-pipelines", "run", "--spec", sys.argv[1]]',
            'spark_pipeline_cli.main()',
        ].join('\n');
        const result = spawnSync(pythonExecutable, ['-c', script, specPath], {
            cwd: repositoryRoot,
            encoding: 'utf8',
            env: {
                ...process.env,
                PYTHONPATH: [pipelineAdapterDirectory, pipelineRootDirectory, process.env.PYTHONPATH]
                    .filter((entry) => entry != null && entry !== '')
                    .join(path.delimiter),
            },
        });

        assert.equal(result.status, 0, result.stderr || result.error?.message);
        const output = result.stdout.trim().split(/\r?\n/).at(-1);
        assert.deepEqual(JSON.parse(output ?? ''), {
            library_count: 1,
            name: 'Source Pipeline',
            spec_path: specPath,
            storage: '/app/checkpoints/source',
        });
    } finally {
        await rm(temporaryDirectory, { force: true, recursive: true });
    }
});
