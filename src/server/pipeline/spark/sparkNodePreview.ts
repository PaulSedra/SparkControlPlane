/**
 * @fileoverview Runs bounded Spark Connect dataset preview queries.
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PipelineNodeData } from '../../../shared/pipelineRegistryTypes.ts';
import { resolvePythonExecutable } from '../../runtime/pythonRuntime.ts';

const PIPELINE_SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const PIPELINE_SAMPLE_DATA_SCRIPT = path.join(
    PIPELINE_SCRIPT_DIRECTORY,
    'spark_connect_sample_data.py',
);

/** Runs the Python sampling adapter and parses its bounded JSON result. */
export async function runNodeDataQuery(
    qualifiedName: string,
    sparkConnectUrl: string,
): Promise<PipelineNodeData> {
    const pythonPath = resolvePythonExecutable();
    const child = spawn(pythonPath, [PIPELINE_SAMPLE_DATA_SCRIPT, qualifiedName], {
        cwd: process.cwd(),
        env: {
            ...process.env,
            SPARK_CONNECT_URL: sparkConnectUrl,
        },
        windowsHide: true,
    });
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
    });

    return new Promise((resolve, reject) => {
        child.on('error', reject);
        child.on('close', (exitCode) => {
            if (exitCode !== 0) {
                reject(new Error(stderr.trim() || 'Spark could not read the selected dataset.'));
                return;
            }

            try {
                resolve(JSON.parse(stdout) as PipelineNodeData);
            } catch {
                reject(new Error('Spark returned an invalid data sample.'));
            }
        });
    });
}
