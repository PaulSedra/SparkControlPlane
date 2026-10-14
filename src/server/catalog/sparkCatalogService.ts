/**
 * @fileoverview Runs bounded Spark Connect catalog adapters through the
 * repository's Python runtime boundary.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { fileURLToPath } from 'node:url';
import { resolvePythonExecutable } from '../runtime/pythonRuntime.ts';
import type {
    SparkCatalog,
    SparkSampleData,
    SparkSchema,
    SparkTable,
    SparkTableDetail,
} from '../../shared/catalogTypes.ts';
import type {
    CatalogService,
    CatalogServiceOptions,
} from '../types/catalogServiceTypes.ts';

const DEFAULT_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const MAX_CONFIGURED_OUTPUT_BYTES = 64 * 1024 * 1024;
const MAX_DIAGNOSTIC_BYTES = 64 * 1024;
const QUERY_TIMEOUT_MILLISECONDS = 45_000;
const SPARK_CONNECT_URL_ERROR =
    'No Spark Connect target is configured for catalog schema enrichment or sample data. Set SPARK_CONNECT_URL.';
const QUERY_TIMEOUT_ERROR = 'Spark catalog metadata or sample query timed out after 45 seconds.';
const NONZERO_EXIT_ERROR = 'Spark could not read the catalog asset.';
const INVALID_RESPONSE_ERROR = 'Spark returned an invalid catalog asset response.';
const SPARK_CATALOG_SCRIPT = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    'spark_connect_catalog.py',
);

type CatalogOutputStream = 'stderr' | 'stdout';

interface CatalogCommandOutput {
    diagnosticsExceeded: boolean;
    diagnosticBytes: number;
    outputBytes: number;
    stderr: string;
    stdout: string;
}

/**
 * Creates a catalog service backed by bounded PySpark subprocess queries.
 *
 * Each operation requires `SPARK_CONNECT_URL`, uses the repository-selected
 * Python executable, and expects one JSON response on stdout. The adapter
 * limits output to 8 MiB by default (configurable up to 64 MiB) and runtime
 * to 45 seconds so a catalog query cannot hold the API process indefinitely;
 * non-zero exits, malformed responses, and missing configuration surface to
 * the caller.
 */
export function createSparkCatalogService(
    options: CatalogServiceOptions = {},
): CatalogService {
    const sparkConnectUrl = options.sparkConnectUrl?.trim();
    const pythonExecutable = options.pythonExecutable?.trim() ||
        resolvePythonExecutable();
    const maxOutputBytes = configuredMaximumOutputBytes();

    return {
        getTable: (catalog, schema, table) =>
            runCatalogCommand<SparkTableDetail>(
                pythonExecutable,
                sparkConnectUrl,
                ['detail', '--catalog', catalog, '--schema', schema, '--table', table],
                maxOutputBytes,
            ),
        getTableData: (catalog, schema, table, limit) =>
            runCatalogCommand<SparkSampleData>(
                pythonExecutable,
                sparkConnectUrl,
                [
                    'sample',
                    '--catalog',
                    catalog,
                    '--schema',
                    schema,
                    '--table',
                    table,
                    '--limit',
                    String(limit),
                ],
                maxOutputBytes,
            ),
        listCatalogs: () =>
            runCatalogCommand<{ catalogs: SparkCatalog[] }>(
                pythonExecutable,
                sparkConnectUrl,
                ['catalogs'],
                maxOutputBytes,
            ).then((payload) => payload.catalogs),
        listSchemas: (catalog) =>
            runCatalogCommand<{ schemas: SparkSchema[] }>(
                pythonExecutable,
                sparkConnectUrl,
                ['schemas', '--catalog', catalog],
                maxOutputBytes,
            ).then((payload) => payload.schemas),
        listTables: (catalog, schema) =>
            runCatalogCommand<{ tables: SparkTable[] }>(
                pythonExecutable,
                sparkConnectUrl,
                ['tables', '--catalog', catalog, '--schema', schema],
                maxOutputBytes,
            ).then((payload) => payload.tables),
    };
}

async function runCatalogCommand<T>(
    pythonExecutable: string,
    sparkConnectUrl: string | undefined,
    args: string[],
    maxOutputBytes: number,
): Promise<T> {
    const connectUrl = requireSparkConnectUrl(sparkConnectUrl);
    const child = spawnCatalogCommand(pythonExecutable, connectUrl, args);
    return collectCatalogCommand<T>(child, maxOutputBytes);
}

function configuredMaximumOutputBytes(): number {
    const rawValue = process.env.SPARK_CATALOG_MAX_RESPONSE_BYTES?.trim();
    if (!rawValue) {
        return DEFAULT_MAX_OUTPUT_BYTES;
    }
    const configuredValue = Number(rawValue);
    if (!/^[0-9]+$/.test(rawValue) ||
        !Number.isSafeInteger(configuredValue) || configuredValue < 1 ||
        configuredValue > MAX_CONFIGURED_OUTPUT_BYTES) {
        throw new Error(
            'SPARK_CATALOG_MAX_RESPONSE_BYTES must be an integer from 1 to ' +
                String(MAX_CONFIGURED_OUTPUT_BYTES) + '.',
        );
    }
    return configuredValue;
}

function requireSparkConnectUrl(sparkConnectUrl: string | undefined): string {
    if (sparkConnectUrl) {
        return sparkConnectUrl;
    }

    throw new Error(SPARK_CONNECT_URL_ERROR);
}

function spawnCatalogCommand(
    pythonExecutable: string,
    sparkConnectUrl: string,
    args: string[],
): ChildProcessWithoutNullStreams {
    return spawn(pythonExecutable, [SPARK_CATALOG_SCRIPT, ...args], {
        cwd: process.cwd(),
        env: {
            ...process.env,
            SPARK_CONNECT_URL: sparkConnectUrl,
        },
        windowsHide: true,
    });
}

function collectCatalogCommand<T>(
    child: ChildProcessWithoutNullStreams,
    maxOutputBytes: number,
): Promise<T> {
    const output: CatalogCommandOutput = {
        diagnosticsExceeded: false,
        diagnosticBytes: 0,
        outputBytes: 0,
        stderr: '',
        stdout: '',
    };
    let timedOut = false;
    let settled = false;
    const stdoutDecoder = new StringDecoder('utf8');
    const stderrDecoder = new StringDecoder('utf8');

    return new Promise<T>((resolve, reject) => {
        const timeout = setTimeout(() => {
            timedOut = true;
            child.kill();
        }, QUERY_TIMEOUT_MILLISECONDS);

        const finish = (callback: () => void): void => {
            if (settled) {
                return;
            }
            settled = true;
            clearTimeout(timeout);
            callback();
        };

        child.stdout.on('data', (chunk: Buffer) =>
            appendCatalogOutput(
                output,
                'stdout',
                chunk,
                stdoutDecoder,
                child,
                maxOutputBytes,
            ));
        child.stderr.on('data', (chunk: Buffer) =>
            appendCatalogOutput(
                output,
                'stderr',
                chunk,
                stderrDecoder,
                child,
                maxOutputBytes,
            ));
        child.on('error', (error) => finish(() => reject(error)));
        child.on('close', (exitCode) => {
            output.stdout += stdoutDecoder.end();
            output.stderr += stderrDecoder.end();
            finish(() => completeCatalogCommand(
                output,
                exitCode,
                timedOut,
                maxOutputBytes,
                resolve,
                reject,
            ));
        });
    });
}

function appendCatalogOutput(
    output: CatalogCommandOutput,
    stream: CatalogOutputStream,
    chunk: Buffer,
    decoder: StringDecoder,
    child: ChildProcessWithoutNullStreams,
    maxOutputBytes: number,
): void {
    if (stream === 'stdout') {
        output.outputBytes += chunk.length;
        if (output.outputBytes > maxOutputBytes) {
            child.kill();
            return;
        }
    } else {
        output.diagnosticBytes += chunk.length;
        if (output.diagnosticBytes > MAX_DIAGNOSTIC_BYTES) {
            output.diagnosticsExceeded = true;
            child.kill();
            return;
        }
    }

    output[stream] += decoder.write(chunk);
}

function completeCatalogCommand<T>(
    output: CatalogCommandOutput,
    exitCode: number | null,
    timedOut: boolean,
    maxOutputBytes: number,
    resolve: (value: T | PromiseLike<T>) => void,
    reject: (reason?: unknown) => void,
): void {
    const error = catalogCommandError(output, exitCode, timedOut, maxOutputBytes);
    if (error) {
        reject(error);
        return;
    }

    try {
        writeCatalogWarnings(output.stderr);
        resolve(JSON.parse(output.stdout) as T);
    } catch {
        reject(new Error(INVALID_RESPONSE_ERROR));
    }
}

function catalogCommandError(
    output: CatalogCommandOutput,
    exitCode: number | null,
    timedOut: boolean,
    maxOutputBytes: number,
): Error | undefined {
    if (timedOut) {
        return new Error(QUERY_TIMEOUT_ERROR);
    }
    if (output.outputBytes > maxOutputBytes) {
        return new Error(
            'Spark catalog response exceeded the configured ' +
                String(maxOutputBytes) + '-byte limit.',
        );
    }
    if (output.diagnosticsExceeded) {
        return new Error('Spark catalog diagnostics exceeded the 64 KiB limit.');
    }
    if (exitCode !== 0) {
        return catalogDiagnosticError(output.stderr);
    }

    return undefined;
}

function catalogDiagnosticError(stderr: string): Error {
    const prefix = 'SPARK_CATALOG_ERROR: ';
    const line = stderr.split(/\r?\n/).find((entry) => entry.startsWith(prefix));
    const diagnosticCode = line?.slice(prefix.length).split(':', 1)[0];
    const messages: Record<string, string> = {
        configuration: 'Spark catalog configuration is invalid.',
        connection: 'Spark Connect could not complete the catalog operation.',
        permission: 'Spark denied the catalog operation.',
        response_limit: 'Spark catalog response exceeded the configured byte limit.',
        unexpected: 'Spark catalog operation failed unexpectedly.',
        unsupported: 'Spark does not support the catalog operation.',
    };
    const error = new Error(
        diagnosticCode == null ? NONZERO_EXIT_ERROR :
            messages[diagnosticCode] ?? NONZERO_EXIT_ERROR,
    );
    if (diagnosticCode === 'unsupported') {
        error.name = 'SparkCatalogUnsupportedOperationError';
    }
    return error;
}

function writeCatalogWarnings(stderr: string): void {
    const prefix = 'SPARK_CATALOG_WARNING: ';
    const messages = new Map([
        [
            'SHOW TABLE EXTENDED is unsupported; listed object types will be UNKNOWN.',
            'SHOW TABLE EXTENDED is unsupported; listed object types are UNKNOWN.',
        ],
        [
            'DESCRIBE TABLE EXTENDED is unsupported; using basic column metadata.',
            'DESCRIBE TABLE EXTENDED is unsupported; basic column metadata was used.',
        ],
    ]);
    for (const line of stderr.split(/\r?\n/)) {
        if (!line.startsWith(prefix)) {
            continue;
        }
        const warning = messages.get(line.slice(prefix.length));
        if (warning) {
            process.stderr.write('[spark-catalog] ' + warning + '\n');
        }
    }
}
