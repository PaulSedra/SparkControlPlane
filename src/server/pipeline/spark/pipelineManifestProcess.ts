/**
 * @fileoverview Runs the trusted-runtime Python manifest helper with bounded output and time.
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolvePythonExecutable } from '../../runtime/pythonRuntime.ts';
import { pipelinePythonEnvironment } from '../execution/pipelineRuntime.ts';
import type { PythonPipelineManifest } from '../discovery/pipelineDiscovery.ts';

const PIPELINE_SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const PIPELINE_MANIFEST_SCRIPT = path.join(
    PIPELINE_SCRIPT_DIRECTORY,
    'spark_pipeline_manifest.py',
);
const DEFAULT_MANIFEST_TIMEOUT_MILLISECONDS = 30_000;
const MAX_MANIFEST_TIMEOUT_MILLISECONDS = 10 * 60 * 1_000;
const DEFAULT_MANIFEST_OUTPUT_LIMIT_BYTES = 4 * 1024 * 1024;
const MAX_MANIFEST_OUTPUT_LIMIT_BYTES = 16 * 1024 * 1024;
const MANIFEST_KILL_GRACE_MILLISECONDS = 1_000;

/** Runtime overrides used by discovery and deterministic subprocess tests. */
export interface PipelineManifestProcessOptions {
    manifestScriptPath?: string;
    maxOutputBytes?: number;
    pythonExecutable?: string;
    timeoutMilliseconds?: number;
}

/**
 * Invokes the Python graph registry helper and parses its bounded JSON result.
 * The helper imports trusted project definitions, so it must use the configured
 * repository runtime and project-aware PYTHONPATH.
 */
export async function discoverPythonPipelineManifest(
    specPath: string,
    options: PipelineManifestProcessOptions = {},
): Promise<PythonPipelineManifest> {
    const output = await captureManifestOutput(
        options.pythonExecutable ?? resolvePythonExecutable(),
        [options.manifestScriptPath ?? PIPELINE_MANIFEST_SCRIPT, specPath],
        pipelinePythonEnvironment(specPath),
        boundedPositiveInteger(
            options.timeoutMilliseconds,
            configuredManifestTimeoutMilliseconds(),
            MAX_MANIFEST_TIMEOUT_MILLISECONDS,
        ),
        boundedPositiveInteger(
            options.maxOutputBytes,
            configuredManifestOutputLimitBytes(),
            MAX_MANIFEST_OUTPUT_LIMIT_BYTES,
        ),
    );
    try {
        return JSON.parse(output) as PythonPipelineManifest;
    } catch {
        throw new Error('Manifest helper returned invalid JSON.');
    }
}

async function captureManifestOutput(
    executable: string,
    args: string[],
    environment: NodeJS.ProcessEnv,
    timeoutMilliseconds: number,
    maxOutputBytes: number,
): Promise<string> {
    const child = spawn(executable, args, {
        cwd: process.cwd(),
        env: environment,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let capturedBytes = 0;
    let failure: Error | undefined;
    let killTimer: NodeJS.Timeout | undefined;
    let settled = false;

    const terminate = (error: Error) => {
        failure ??= error;
        child.kill('SIGTERM');
        killTimer ??= setTimeout(() => child.kill('SIGKILL'), MANIFEST_KILL_GRACE_MILLISECONDS);
        killTimer.unref();
    };
    const capture = (destination: Buffer[], chunk: Buffer) => {
        if (failure != null) {
            return;
        }
        capturedBytes += chunk.length;
        if (capturedBytes > maxOutputBytes) {
            terminate(new Error(`Manifest helper exceeded its ${maxOutputBytes}-byte output limit.`));
            return;
        }
        destination.push(chunk);
    };

    child.stdout?.on('data', (chunk: Buffer) => capture(stdout, chunk));
    child.stderr?.on('data', (chunk: Buffer) => capture(stderr, chunk));

    return await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            terminate(new Error(`Manifest helper exceeded its ${timeoutMilliseconds}ms time limit.`));
        }, timeoutMilliseconds);
        timeout.unref();

        const finish = (error?: Error, value?: string) => {
            if (settled) {
                return;
            }
            settled = true;
            clearTimeout(timeout);
            if (killTimer != null) {
                clearTimeout(killTimer);
            }
            if (error != null) {
                reject(error);
            } else {
                resolve(value ?? '');
            }
        };

        child.once('error', (error) => {
            failure ??= error;
            finish(failure);
        });
        child.once('close', (exitCode) => {
            if (failure != null) {
                finish(failure);
                return;
            }
            if (exitCode !== 0) {
                const diagnostic = Buffer.concat(stderr).toString('utf8').trim();
                finish(new Error(diagnostic || `Manifest helper exited with code ${exitCode}.`));
                return;
            }
            finish(undefined, Buffer.concat(stdout).toString('utf8'));
        });
    });
}

function configuredManifestTimeoutMilliseconds(): number {
    const configuredSeconds = Number(process.env.PIPELINE_DISCOVERY_TIMEOUT_SECONDS?.trim() ?? '');
    const seconds = Number.isFinite(configuredSeconds) && configuredSeconds > 0
        ? Math.min(MAX_MANIFEST_TIMEOUT_MILLISECONDS / 1_000, configuredSeconds)
        : DEFAULT_MANIFEST_TIMEOUT_MILLISECONDS / 1_000;
    return Math.max(1, Math.floor(seconds * 1_000));
}

function configuredManifestOutputLimitBytes(): number {
    const configured = Number(process.env.PIPELINE_DISCOVERY_OUTPUT_LIMIT_BYTES?.trim() ?? '');
    return Number.isSafeInteger(configured) && configured > 0
        ? Math.min(MAX_MANIFEST_OUTPUT_LIMIT_BYTES, configured)
        : DEFAULT_MANIFEST_OUTPUT_LIMIT_BYTES;
}

function boundedPositiveInteger(value: number | undefined, fallback: number, maximum: number): number {
    return value == null || !Number.isSafeInteger(value) || value < 1
        ? fallback
        : Math.min(maximum, value);
}
