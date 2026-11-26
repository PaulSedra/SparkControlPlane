/** @fileoverview Submits bounded catalog and preview queries to Spark Standalone. */

import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SparkQueryRequest, SparkQueryService } from '../types/sparkQueryServiceTypes.ts';
import { boundedPositiveInteger } from '../config/configValues.ts';
import { resolvePythonExecutable } from '../runtime/pythonRuntime.ts';
import { sanitizeText } from '../utils/sanitization.ts';

const SCRIPT_PATH = fileURLToPath(new URL('./spark_catalog_query.py', import.meta.url));
const DEFAULT_TIMEOUT_MILLISECONDS = 45_000;
const MAX_TIMEOUT_MILLISECONDS = 120_000;
const DEFAULT_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 64 * 1024 * 1024;

/** Spark-submit settings shared with pipeline runs. */
export interface SparkStandaloneQueryServiceOptions {
    driverHost?: string;
    executorPython?: string;
    masterUrl?: string;
    propertiesFile?: string;
    timeoutMilliseconds?: number;
}

interface ResolvedSparkOptions {
    driverHost: string;
    executorPython: string;
    masterUrl: string;
    propertiesFile?: string;
    pythonExecutable: string;
}

/**
 * Creates a query adapter that submits one bounded, short-lived Spark app for
 * each catalog or preview request. The helper uses the same master,
 * worker-reachable driver address, Python settings, and Spark properties file
 * as pipeline submissions.
 */
export function createSparkStandaloneQueryService(
    options: SparkStandaloneQueryServiceOptions = {},
): SparkQueryService {
    const pythonExecutable = resolvePythonExecutable();
    const timeoutMilliseconds = boundedPositiveInteger(
        options.timeoutMilliseconds,
        DEFAULT_TIMEOUT_MILLISECONDS,
        MAX_TIMEOUT_MILLISECONDS,
    );

    return {
        query: (request, signal) => runQuery(
            resolveSparkOptions(options, pythonExecutable),
            timeoutMilliseconds,
            request,
            signal,
        ),
    };
}

async function runQuery(
    options: ResolvedSparkOptions,
    timeoutMilliseconds: number,
    request: SparkQueryRequest,
    signal?: AbortSignal,
): Promise<unknown> {
    if (signal?.aborted) {
        throw abortError();
    }
    const maximumResponseBytes = boundedResponseBytes(request.maximumResponseBytes);
    const payload = Buffer.from(JSON.stringify({
        ...request,
        maximumResponseBytes,
    }), 'utf8').toString('base64');
    const sparkSubmitArguments = [
        '--master', options.masterUrl,
        '--deploy-mode', 'client',
        '--conf', `spark.app.name=spark-control-plane-query-${request.command}-${randomUUID()}`,
        '--conf', `spark.driver.host=${options.driverHost}`,
        '--conf', 'spark.driver.bindAddress=0.0.0.0',
        '--conf', `spark.pyspark.driver.python=${options.pythonExecutable}`,
        '--conf', `spark.pyspark.python=${options.executorPython}`,
        '--conf', `spark.executorEnv.PYSPARK_PYTHON=${options.executorPython}`,
    ];
    if (options.propertiesFile != null) {
        sparkSubmitArguments.push('--properties-file', options.propertiesFile);
    }
    sparkSubmitArguments.push(SCRIPT_PATH, '--request-base64', payload);

    const sparkHome = process.env.SPARK_HOME?.trim();
    const pythonBin = path.isAbsolute(options.pythonExecutable)
        ? path.dirname(options.pythonExecutable)
        : '/usr/local/bin';
    const sparkBin = sparkHome && path.isAbsolute(sparkHome)
        ? path.join(sparkHome, 'bin')
        : pythonBin;
    const child = spawn(path.join(sparkBin, 'spark-submit'), sparkSubmitArguments, {
        cwd: path.dirname(SCRIPT_PATH),
        env: { ...process.env, PYTHONUNBUFFERED: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let failure: Error | undefined;
    let killTimer: NodeJS.Timeout | undefined;
    const terminate = (error: Error) => {
        failure ??= error;
        child.kill('SIGTERM');
        killTimer ??= setTimeout(() => child.kill('SIGKILL'), 1_000);
        killTimer.unref();
    };
    const capture = (destination: Buffer[], chunk: Buffer) => {
        if (failure != null) return;
        outputBytes += chunk.byteLength;
        if (outputBytes > maximumResponseBytes) {
            terminate(new Error('Spark query response exceeded its configured byte limit.'));
            return;
        }
        destination.push(chunk);
    };
    child.stdout?.on('data', (chunk: Buffer) => capture(stdout, chunk));
    child.stderr?.on('data', (chunk: Buffer) => capture(stderr, chunk));

    return await new Promise((resolve, reject) => {
        let settled = false;
        const timeout = setTimeout(() => {
            terminate(new Error(`Spark query exceeded its ${timeoutMilliseconds}ms time limit.`));
        }, timeoutMilliseconds);
        timeout.unref();
        const onAbort = () => {
            terminate(abortError());
        };
        signal?.addEventListener('abort', onAbort, { once: true });
        const finish = (error?: Error, value?: unknown) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            if (killTimer != null) clearTimeout(killTimer);
            signal?.removeEventListener('abort', onAbort);
            if (error != null) reject(error);
            else resolve(value);
        };
        child.once('error', (error) => finish(error));
        child.once('close', (exitCode) => {
            if (failure != null) {
                finish(failure);
                return;
            }
            if (exitCode !== 0) {
                const output = Buffer.concat(stdout).toString('utf8');
                // Spark's Python runner can merge Python stderr into its stdout.
                const adapterDiagnostic = /^SPARK_CATALOG_ERROR: [^\r\n]+/m.exec(output)?.[0];
                const diagnostic = sanitizeText(
                    adapterDiagnostic ?? (Buffer.concat(stderr).toString('utf8').trim() ||
                        `Spark query exited with code ${exitCode ?? 'unknown'}.`),
                    [options.masterUrl],
                );
                finish(new Error(diagnostic));
                return;
            }
            try {
                finish(undefined, JSON.parse(Buffer.concat(stdout).toString('utf8')) as unknown);
            } catch {
                finish(new Error('Spark returned an invalid query response.'));
            }
        });
    });
}

function resolveSparkOptions(
    options: SparkStandaloneQueryServiceOptions,
    pythonExecutable: string,
): ResolvedSparkOptions {
    const masterUrl = (options.masterUrl ?? process.env.SPARK_MASTER_URL ?? '').trim();
    if (!masterUrl.startsWith('spark://') || /\s/.test(masterUrl)) {
        throw new Error('SPARK_MASTER_URL must be a Spark Standalone URL such as spark://spark-master:7077.');
    }
    const driverHost = (options.driverHost ?? process.env.SPARK_DRIVER_HOST ?? '').trim();
    if (driverHost === '') {
        throw new Error('SPARK_DRIVER_HOST must be reachable from Spark workers for client-mode queries.');
    }
    return {
        driverHost,
        executorPython: options.executorPython?.trim() || process.env.SPARK_EXECUTOR_PYTHON?.trim() || 'python3',
        masterUrl,
        propertiesFile: options.propertiesFile?.trim() || process.env.SPARK_CLI_PROPERTIES_FILE?.trim() || undefined,
        pythonExecutable,
    };
}

function boundedResponseBytes(value: number | undefined): number {
    if (value == null) return DEFAULT_RESPONSE_BYTES;
    if (!Number.isSafeInteger(value) || value < 1 || value > MAX_RESPONSE_BYTES) {
        throw new Error(`Spark response limit must be between 1 and ${MAX_RESPONSE_BYTES} bytes.`);
    }
    return value;
}

function abortError(): Error {
    const error = new Error('Spark query was canceled.');
    error.name = 'AbortError';
    return error;
}
