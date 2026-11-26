/** Builds Spark commands and exchanges JSON messages with the Python supervisor. */
import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolvePythonExecutable } from '../../runtime/pythonRuntime.ts';
import type { PipelineSpec, RunMode } from '../../../shared/pipelineRegistryTypes.ts';
import { CLI_EXECUTION_STATUS_PROTOCOL, isCliExecutionState, type CliExecutionState } from '../../../shared/status/execution.ts';
import { pipelineProjectRoot, pipelineRunStateDirectory } from '../execution/pipelineRuntime.ts';

const PIPELINE_SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
/** Directory of the Spark Python adapters. */
export const PIPELINE_SPEC_ADAPTER_DIRECTORY = PIPELINE_SCRIPT_DIRECTORY;
const SUPERVISOR_SCRIPT = path.join(PIPELINE_SCRIPT_DIRECTORY, 'spark_cli_supervisor.py');
const SPARK_CONNECT_PORT_TOKEN = '<SPARK_CONNECT_PORT>';
const SPARK_CONNECT_SERVER_CLASS = 'org.apache.spark.sql.connect.service.SparkConnectServer';

/** Local supervisor runtime configuration. */
export interface CliConfiguration {
    binaryPath: string;
    driverHost?: string;
    executorPython: string;
    masterUrl?: string;
    propertiesFile?: string;
    pythonPath: string;
    stateDirectory: string;
}

/** Status and log cursors returned by inspection. */
export interface SupervisorResponse {
    endedAt?: string;
    exitCode?: number;
    processId?: number;
    reason?: string;
    runDirectory: string;
    runId: string;
    startedAt?: string;
    state: CliExecutionState;
    stderrChunk: string;
    stderrOffset: number;
    stdoutChunk: string;
    stdoutOffset: number;
    stderrRemaining: boolean;
    stdoutRemaining: boolean;
}

/** Runtime inputs for the supervisor's start action. */
export interface SupervisorStartRequest {
    command: string[];
    connectServerCommand: string[];
    pipelineSpecAdapterDirectory: string;
    pythonPath: string;
    runId: string;
    sourceFiles: string[];
    sourceHash: string;
    stateDirectory: string;
    timeoutSeconds: number | null;
    workingDirectory: string;
}

interface CapturedProcessResult {
    exitCode: number;
    stderr: string;
    stdout: string;
}

/** Reads the local Spark launcher settings. */
export function loadCliConfiguration(environment: NodeJS.ProcessEnv = process.env): CliConfiguration {
    const propertiesFile = environment.SPARK_CLI_PROPERTIES_FILE?.trim() || undefined;
    return {
        binaryPath: environment.SPARK_CLI_BINARY?.trim() || 'spark-pipelines',
        driverHost: environment.SPARK_DRIVER_HOST?.trim() || undefined,
        executorPython: environment.SPARK_EXECUTOR_PYTHON?.trim() || 'python3',
        masterUrl: environment.SPARK_MASTER_URL?.trim() || undefined,
        propertiesFile,
        pythonPath: resolvePythonExecutable(environment),
        stateDirectory: pipelineRunStateDirectory(environment),
    };
}

/** Builds the Spark Connect client command for one complete pipeline run. */
export function buildSparkPipelinesArguments(
    config: Pick<CliConfiguration, 'binaryPath'>,
    spec: PipelineSpec,
    mode: RunMode,
    _runId: string,
    targetNodeNames?: string[],
): string[] {
    const specPath = path.resolve(spec.specPath);
    const args = [
        config.binaryPath,
        '--remote', `sc://127.0.0.1:${SPARK_CONNECT_PORT_TOKEN}`,
        mode === 'dry-run' ? 'dry-run' : 'run',
        '--spec', specPath,
    ];
    if (mode === 'full-refresh-all') {
        args.push('--full-refresh-all');
    }
    if ((mode === 'repair-failed' || mode === 'refresh-selected') && targetNodeNames != null) {
        args.push('--refresh', targetNodeNames.join(','));
    }
    if (mode === 'full-refresh-selected' && targetNodeNames != null) {
        args.push('--full-refresh', targetNodeNames.join(','));
    }
    return args;
}

/** Builds one Standalone Connect server application for a complete pipeline run. */
export function buildSparkConnectServerArguments(
    config: Pick<CliConfiguration, 'driverHost' | 'executorPython' | 'masterUrl' | 'propertiesFile' | 'pythonPath' | 'stateDirectory'>,
    spec: PipelineSpec,
    runId: string,
): string[] {
    const runDirectory = path.join(config.stateDirectory, 'runs', runId);
    const projectRoot = pipelineProjectRoot(spec.specPath);
    const specPath = path.resolve(spec.specPath);
    const relativeSpecPath = path.relative(projectRoot, specPath);
    if (relativeSpecPath === '..' || relativeSpecPath.startsWith(`..${path.sep}`)) {
        throw new Error('Pipeline spec path escapes the run source snapshot.');
    }
    const masterUrl = requireStandaloneMasterUrl(config.masterUrl);
    const driverHost = requireStandaloneDriverHost(config.driverHost);
    const executorPython = config.executorPython.trim() || 'python3';
    const args = [
        'spark-submit',
        '--class', SPARK_CONNECT_SERVER_CLASS,
        '--master', masterUrl,
        '--deploy-mode', 'client',
        '--name', `spark-control-plane-${runId}`,
        '--conf', `spark.driver.host=${driverHost}`,
        '--conf', 'spark.driver.bindAddress=0.0.0.0',
        '--conf', 'spark.connect.grpc.binding.address=0.0.0.0',
        '--conf', 'spark.connect.grpc.binding.port=0',
        '--conf', `spark.pyspark.driver.python=${config.pythonPath}`,
        '--conf', `spark.pyspark.python=${executorPython}`,
        '--conf', `spark.executorEnv.PYSPARK_PYTHON=${executorPython}`,
        '--archives', `${path.join(runDirectory, 'pipeline-source.zip')}#pipeline-source`,
        '--py-files', [
            path.join(runDirectory, 'spark-pipeline-adapter.zip'),
            path.join(runDirectory, 'pipeline-source.zip'),
        ].join(','),
    ];
    if (config.propertiesFile != null) {
        args.push('--properties-file', config.propertiesFile);
    }
    return args;
}

/** Returns a display-safe command without local archive paths or credentials. */
export function previewSparkPipelinesCommand(
    spec: PipelineSpec,
    mode: RunMode,
    targetNodeNames?: string[],
): string[] {
    return displayClientCommand(
        buildSparkPipelinesArguments({ binaryPath: 'spark-pipelines' }, spec, mode, '', targetNodeNames),
        spec.specPath,
    );
}

/** Substitutes the display path and port without changing the client flags. */
export function displayClientCommand(command: string[], specPath: string): string[] {
    const display = [...command];
    const remoteIndex = command.indexOf('--remote', 1);
    const specIndex = command.indexOf('--spec', 1);
    if (remoteIndex >= 0 && remoteIndex + 1 < display.length) {
        display[remoteIndex + 1] = 'sc://127.0.0.1:<per-run-port>';
    }
    if (specIndex >= 0 && specIndex + 1 < display.length) {
        display[specIndex + 1] = specPath;
    }
    return display;
}

/** Calls a snapshot action or a mutation that returns a small acknowledgment. */
export function invokeSupervisor(
    config: CliConfiguration,
    action: 'inspect',
    args: string[],
    runId: string,
    onProcess?: (child: ChildProcess) => void,
): Promise<SupervisorResponse>;
export function invokeSupervisor(
    config: CliConfiguration,
    action: 'start' | 'cancel',
    args: string[],
    runId: string,
    onProcess?: (child: ChildProcess) => void,
): Promise<void>;
export async function invokeSupervisor(
    config: CliConfiguration,
    action: 'inspect' | 'start' | 'cancel',
    args: string[],
    runId: string,
    onProcess?: (child: ChildProcess) => void,
): Promise<SupervisorResponse | void> {
    const result = await captureCommand(
        config.pythonPath,
        [SUPERVISOR_SCRIPT, action, ...args],
        onProcess,
        {
            ...process.env,
            SPARK_CONTROL_PLANE_CLI_STATUS_PROTOCOL: JSON.stringify(CLI_EXECUTION_STATUS_PROTOCOL),
        },
    );
    if (result.exitCode !== 0) {
        throw new Error(result.stderr.trim() || `Local CLI supervisor ${action} returned ${result.exitCode}.`);
    }
    try {
        const response: unknown = JSON.parse(result.stdout);
        if (!isRecord(response) || response.runId !== runId) {
            throw new Error('Invalid run identity.');
        }
        if (action === 'inspect') {
            return parseSnapshot(response, Number(args[2]), Number(args[3]));
        }
        if (response.accepted !== true) {
            throw new Error('Missing acknowledgment.');
        }
    } catch {
        throw new Error(`Local CLI supervisor ${action} returned invalid status data.`);
    }
}

async function captureCommand(
    executable: string,
    args: string[],
    onProcess?: (child: ChildProcess) => void,
    environment: NodeJS.ProcessEnv = process.env,
): Promise<CapturedProcessResult> {
    const child = spawn(executable, args, {
        cwd: process.cwd(),
        env: environment,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    onProcess?.(child);
    const maxResponseCharacters = 1_048_576;
    let stdout = '';
    let stderr = '';
    let outputExceeded = false;
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    const append = (captured: string, chunk: string) => {
        if (captured.length + chunk.length > maxResponseCharacters) {
            outputExceeded = true;
            child.kill();
            return captured;
        }
        return captured + chunk;
    };
    child.stdout?.on('data', (chunk: string) => { stdout = append(stdout, chunk); });
    child.stderr?.on('data', (chunk: string) => { stderr = append(stderr, chunk); });
    return await new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('close', (code) => {
            if (outputExceeded) {
                reject(new Error('Local CLI supervisor exceeded its response limit.'));
                return;
            }
            resolve({ exitCode: code ?? 1, stderr, stdout });
        });
    });
}

/** Encodes a supervisor submission for argv transport. */
export function encodePayload(payload: SupervisorStartRequest): string {
    return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
}

function requireStandaloneMasterUrl(value: string | undefined): string {
    const masterUrl = value?.trim() ?? '';
    if (masterUrl === '') {
        throw new Error('SPARK_MASTER_URL is required to submit a pipeline run to Spark Standalone.');
    }
    if (!masterUrl.startsWith('spark://') || /\s/.test(masterUrl)) {
        throw new Error('SPARK_MASTER_URL must be a Spark Standalone URL such as spark://spark-master:7077.');
    }
    return masterUrl;
}

function requireStandaloneDriverHost(value: string | undefined): string {
    const driverHost = value?.trim() ?? '';
    if (driverHost === '') {
        throw new Error('SPARK_DRIVER_HOST must be reachable from Spark workers for client-mode execution.');
    }
    return driverHost;
}


function parseSnapshot(
    value: Record<string, unknown>,
    stdoutOffset: number,
    stderrOffset: number,
): SupervisorResponse {
    const { state, runDirectory, runId, processId, startedAt, endedAt, reason, exitCode } = value;
    if (typeof state !== 'string' || !isCliExecutionState(state) ||
        typeof runDirectory !== 'string' || runDirectory === '' || typeof runId !== 'string' ||
        !isOptionalString(startedAt) || !isOptionalString(endedAt) || !isOptionalString(reason) ||
        (exitCode != null && !Number.isSafeInteger(exitCode)) ||
        (processId != null && (typeof processId !== 'number' || !Number.isSafeInteger(processId) || processId <= 0))) {
        throw new Error('Invalid supervisor status.');
    }
    const stdout = parseLog(value.stdoutChunk, value.stdoutOffset, value.stdoutRemaining, stdoutOffset);
    const stderr = parseLog(value.stderrChunk, value.stderrOffset, value.stderrRemaining, stderrOffset);
    return {
        state, runDirectory, runId,
        processId: processId ?? undefined,
        startedAt: startedAt ?? undefined,
        endedAt: endedAt ?? undefined,
        reason: reason ?? undefined,
        exitCode: typeof exitCode === 'number' ? exitCode : undefined,
        stdoutChunk: stdout.chunk, stdoutOffset: stdout.offset, stdoutRemaining: stdout.remaining,
        stderrChunk: stderr.chunk, stderrOffset: stderr.offset, stderrRemaining: stderr.remaining,
    };
}

function parseLog(chunk: unknown, offset: unknown, remaining: unknown, previousOffset: number) {
    if (typeof chunk !== 'string' || chunk.length > 349_528 ||
        typeof offset !== 'number' || !Number.isSafeInteger(offset) || typeof remaining !== 'boolean') {
        throw new Error('Invalid supervisor log fields.');
    }
    const bytes = Buffer.from(chunk, 'base64');
    if (bytes.length > 262_144 || bytes.toString('base64') !== chunk ||
        offset !== previousOffset + bytes.length) {
        throw new Error('Invalid supervisor log cursor.');
    }
    return { chunk, offset, remaining };
}

function isOptionalString(value: unknown): value is string | null | undefined {
    return value == null || typeof value === 'string';
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value != null && typeof value === 'object' && !Array.isArray(value);
}
