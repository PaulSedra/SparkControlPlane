/**
 * @fileoverview Regression coverage for bounded Python pipeline manifest helpers.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { discoverPythonPipelineManifest } from '../../../../src/server/pipeline/spark/pipelineManifestProcess.ts';

test('parses a bounded Python manifest response', async () => {
    const fixture = await helperScript('process.stdout.write(JSON.stringify({ flows: [], outputs: [] }));');
    try {
        assert.deepEqual(
            await discoverPythonPipelineManifest('fixture.pipeline.yaml', {
                manifestScriptPath: fixture.scriptPath,
                pythonExecutable: process.execPath,
            }),
            { flows: [], outputs: [] },
        );
    } finally {
        await fixture.cleanup();
    }
});

test('terminates manifest helpers that exceed the combined output limit', async () => {
    const fixture = await helperScript("process.stdout.write('x'.repeat(64 * 1024)); setInterval(() => {}, 1000);");
    try {
        await assert.rejects(
            discoverPythonPipelineManifest('fixture.pipeline.yaml', {
                manifestScriptPath: fixture.scriptPath,
                maxOutputBytes: 1_024,
                pythonExecutable: process.execPath,
                timeoutMilliseconds: 5_000,
            }),
            /output limit/,
        );
    } finally {
        await fixture.cleanup();
    }
});

test('terminates manifest helpers that exceed the execution time limit', async () => {
    const fixture = await helperScript('setInterval(() => {}, 1000);');
    try {
        await assert.rejects(
            discoverPythonPipelineManifest('fixture.pipeline.yaml', {
                manifestScriptPath: fixture.scriptPath,
                maxOutputBytes: 1_024,
                pythonExecutable: process.execPath,
                timeoutMilliseconds: 50,
            }),
            /time limit/,
        );
    } finally {
        await fixture.cleanup();
    }
});

async function helperScript(source: string): Promise<{
    cleanup: () => Promise<void>;
    scriptPath: string;
}> {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'pipeline-manifest-process-'));
    const scriptPath = path.join(directory, 'helper.mjs');
    await fs.writeFile(scriptPath, source, 'utf8');
    return {
        cleanup: () => fs.rm(directory, { force: true, recursive: true }),
        scriptPath,
    };
}
