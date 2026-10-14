/**
 * @fileoverview Runs the stock Spark Pipelines CLI in SCP's runtime and tracks its local process.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
    PipelineRun,
    PipelineSpec,
    RunMode,
} from '../../../shared/pipelineRegistryTypes.ts';
import {
    ACTIVE_CLI_EXECUTION_STATUSES,
    CLI_EXECUTION_STATUS_PROTOCOL,
    CliExecutionState,
    isCliExecutionState,
} from '../../../shared/status/execution.ts';
import { pipelineProjectRoot, pipelineRunStateDirectory } from '../execution/pipelineRuntime.ts';
import { SparkCliLogCollector, type CliLogUpdate } from './sparkCliLogCollector.ts';

const PIPELINE_SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const PIPELINE_SPEC_ADAPTER_DIRECTORY = PIPELINE_SCRIPT_DIRECTORY;
const SUPERVISOR_SCRIPT = path.join(PIPELINE_SCRIPT_DIRECTORY, 'spark_cli_supervisor.py');
const POLL_INTERVAL_MILLISECONDS = 1_000;
const RECONNECT_GRACE_MILLISECONDS = 5 * 60 * 1_000;
const SUPERVISOR_LOG_CHUNK_LIMIT_BYTES = 262_144;

function normalizeExecutionState(value: string): CliExecutionState {
    const normalized = value.trim().toUpperCase();
    return isCliExecutionState(normalized)
        ? normalized
        : CliExecutionState.UNKNOWN;
}

function exitCodeForState(state: CliExecutionState): number | undefined {
    if (state === CliExecutionState.COMPLETED) {
        return 0;
    }
    if (state === CliExecutionState.UNKNOWN) {
        return undefined;
    }
    return state === CliExecutionState.CANCELED || state === CliExecutionState.TIMED_OUT
        ? 130
        : 1;
}

/** Controls SCP's monitor without signaling the independently supervised CLI. */
export interface LocalCliRunController {
    detach: () => void;
    requestStop: () => void;
}

/** Process identity and log cursors recorded for one CLI execution. */
export interface LocalCliRunSnapshot {
    command: string[];
    executionId: string;
    processId?: number;
    reason?: string;
    runDirectory: string;
    startedAt?: string;
    state: CliExecutionState;
    stderrOffset: number;
    stdoutOffset: number;
}

/** Result returned after the supervised stock CLI finishes or the monitor detaches. */
export interface LocalCliCommandResult {
    canceled: boolean;
    command: string[];
    detached: boolean;
    exitCode?: number;
    cliState: CliExecutionState;
    reason?: string;
    stderr: string;
    stdout: string;
    timedOut: boolean;
}

/** Inputs supplied by the run coordinator. */
export interface LocalCliRunOptions {
    executionMode: 'monitor' | 'submit';
    onController: (controller: LocalCliRunController, command: string[]) => void;
    onSnapshot: (
        snapshot: LocalCliRunSnapshot,
        output: CliLogUpdate,
    ) => Promise<void>;
    run: PipelineRun;
    shouldCancel: () => Promise<boolean>;
    spec?: PipelineSpec;
    sparkConnectUrl?: string;
    targetNodeNames?: string[];
}

interface CliConfiguration {
    binaryPath: string;
    propertiesFile?: string;
    pythonPath: string;
    stateDirectory: string;
}

interface SupervisorResponse {
    endedAt?: string;
    exitCode?: number;
    processId?: number;
    reason?: string;
    runDirectory?: string;
    runId?: string;
    startedAt?: string;
    state: string;
    stderrChunk?: string;
    stderrOffset?: number;
    stdoutChunk?: string;
    stdoutOffset?: number;
    stderrRemaining?: boolean;
    stdoutRemaining?: boolean;
}

interface CapturedProcessResult {
    exitCode: number;
    stderr: string;
    stdout: string;
}

interface LocalCliProcessState {
    activeHelper?: ChildProcess;
    cancellationRequested: boolean;
    detached: boolean;
    lastOutput: CliLogUpdate;
    lastSnapshot?: LocalCliRunSnapshot;
    snapshotPersistenceFailed: boolean;
    startAttempted: boolean;
}

type SnapshotPersister = (
    snapshot: LocalCliRunSnapshot,
    output: CliLogUpdate,
) => Promise<void>;

interface CliStartContext {
    command: string[];
    invocation: string[];
    persistSnapshot: SnapshotPersister;
    runDirectory: string;
    runId: string;
    stderr: string;
    stderrOffset: number;
    stdout: string;
    stdoutOffset: number;
}

type CliRunSnapshotInput = Omit<LocalCliRunSnapshot, 'command'>;
type TerminalResultInput = Omit<
    LocalCliCommandResult,
    'canceled' | 'detached' | 'timedOut'
> & Partial<Pick<LocalCliCommandResult, 'canceled' | 'timedOut'>>;

/**
 * Starts a CLI once or monitors its saved local state by run ID. Monitor mode
 * never starts a second CLI invocation.
 */
export async function runSparkCliProcess(
    options: LocalCliRunOptions,
): Promise<LocalCliCommandResult> {
    const config = loadCliConfiguration();
    const runId = options.run.cliExecutionId ?? options.run.runId;
    const stdout = options.run.stdout ?? '';
    const stderr = options.run.stderr ?? '';
    const stdoutOffset = options.run.cliStdoutOffset ?? 0;
    const stderrOffset = options.run.cliStderrOffset ?? 0;
    const runDirectory = options.run.cliRunDirectory ?? path.join(config.stateDirectory, 'runs', runId);
    const command = commandForRun(options);
    const state: LocalCliProcessState = {
        cancellationRequested: false,
        detached: false,
        lastOutput: { stderr, stdout },
        snapshotPersistenceFailed: false,
        startAttempted: false,
    };
    const persistSnapshot = createSnapshotPersister(options, command, state);
    const invocation = invocationForRun(options, config, command);
    const controller: LocalCliRunController = {
        detach: () => {
            state.detached = true;
            state.activeHelper?.kill();
        },
        requestStop: () => {
            state.cancellationRequested = true;
        },
    };
    options.onController(controller, command);

    try {
        const submissionResult = await startCliIfRequested(
            options,
            config,
            state,
            {
                command,
                invocation,
                persistSnapshot,
                runDirectory,
                runId,
                stderr,
                stderrOffset,
                stdout,
                stdoutOffset,
            },
        );
        if (submissionResult != null) {
            return submissionResult;
        }
        const identityResult = incompleteMonitorIdentityResult(options, command, stderr);
        if (identityResult != null) {
            return identityResult;
        }

        return await monitorCliRun({
            activeHelper: (child) => {
                state.activeHelper = child;
            },
            cancellationRequested: () => state.cancellationRequested,
            command,
            config,
            detached: () => state.detached,
            onSnapshot: persistSnapshot,
            run: options.run,
            runDirectory,
            runId,
            snapshotPersistenceFailed: () => state.snapshotPersistenceFailed,
            shouldCancel: options.shouldCancel,
            stderr,
            stderrOffset,
            stdout,
            stdoutOffset,
        });
    } catch (error) {
        return handleSparkCliRunError(error, options, command, state, stdout, stderr, persistSnapshot);
    } finally {
        state.activeHelper = undefined;
    }
}

function commandForRun(options: LocalCliRunOptions): string[] {
    if (options.run.command != null) {
        return options.run.command;
    }
    if (options.spec != null) {
        return previewSparkPipelinesCommand(options.spec, options.run.mode);
    }
    return ['spark-pipelines', options.run.mode === 'dry-run' ? 'dry-run' : 'run'];
}

function invocationForRun(
    options: LocalCliRunOptions,
    config: CliConfiguration,
    command: string[],
): string[] {
    if (options.executionMode !== 'submit') {
        return command;
    }
    return buildSparkPipelinesArguments(
        config,
        requireSparkConnectUrl(options.sparkConnectUrl),
        requirePipelineSpec(options.spec),
        options.run.mode,
        options.targetNodeNames ?? options.run.targetNodeNames ?? options.run.repairedNodeNames,
    );
}

function createSnapshotPersister(
    options: LocalCliRunOptions,
    command: string[],
    state: LocalCliProcessState,
): SnapshotPersister {
    return async (snapshot, output) => {
        try {
            const trackedSnapshot = { ...snapshot, command };
            if (state.lastSnapshot != null &&
                sameSnapshot(state.lastSnapshot, trackedSnapshot) &&
                state.lastOutput.stdout === output.stdout &&
                state.lastOutput.stderr === output.stderr) {
                return;
            }
            await options.onSnapshot(trackedSnapshot, output);
            state.lastSnapshot = trackedSnapshot;
            state.lastOutput = output;
        } catch (error) {
            state.snapshotPersistenceFailed = true;
            throw error;
        }
    };
}

async function startCliIfRequested(
    options: LocalCliRunOptions,
    config: CliConfiguration,
    state: LocalCliProcessState,
    context: CliStartContext,
): Promise<LocalCliCommandResult | undefined> {
    const {
        command,
        invocation,
        persistSnapshot,
        runDirectory,
        runId,
        stderr,
        stderrOffset,
        stdout,
        stdoutOffset,
    } = context;
    if (options.executionMode !== 'submit') {
        return undefined;
    }
    await persistSnapshot(buildSnapshot({
        executionId: runId,
        runDirectory,
        state: CliExecutionState.STARTING,
        stderrOffset,
        stdoutOffset,
    }), { stdout, stderr });
    if (state.cancellationRequested || await options.shouldCancel()) {
        return terminalResult({
            canceled: true,
            cliState: CliExecutionState.CANCELED,
            command,
            exitCode: 130,
            stderr,
            stdout,
        });
    }

    state.startAttempted = true;
    const started = await invokeSupervisor(
        config,
        'start',
        [encodePayload({
            command: invocation,
            pipelineSpecAdapterDirectory: PIPELINE_SPEC_ADAPTER_DIRECTORY,
            pythonPath: config.pythonPath,
            runId,
            sourceHash: options.run.sourceHash ?? '',
            stateDirectory: config.stateDirectory,
            timeoutSeconds: options.run.timeoutSeconds ?? null,
            workingDirectory: pipelineProjectRoot(requirePipelineSpec(options.spec).specPath),
        })],
        (child) => {
            state.activeHelper = child;
        },
    );
    const startedSnapshot = buildSnapshot({
        executionId: runId,
        processId: started.processId,
        runDirectory: started.runDirectory ?? runDirectory,
        startedAt: started.startedAt,
        state: normalizeExecutionState(started.state),
        stderrOffset: started.stderrOffset ?? stderrOffset,
        stdoutOffset: started.stdoutOffset ?? stdoutOffset,
    });
    await persistSnapshot(startedSnapshot, { stdout, stderr });
    return undefined;
}

function incompleteMonitorIdentityResult(
    options: LocalCliRunOptions,
    command: string[],
    stderr: string,
): LocalCliCommandResult | undefined {
    if (options.executionMode === 'submit' ||
        (options.run.cliExecutionId != null && options.run.cliRunDirectory != null)) {
        return undefined;
    }
    return terminalResult({
        cliState: CliExecutionState.UNKNOWN,
        command,
        reason: 'CLI_IDENTITY_INCOMPLETE',
        stderr: `${stderr}${stderr === '' ? '' : '\n'}Persisted CLI process identity is incomplete; the pipeline was not resubmitted.`,
        stdout: options.run.stdout ?? '',
    });
}

async function handleSparkCliRunError(
    error: unknown,
    options: LocalCliRunOptions,
    command: string[],
    state: LocalCliProcessState,
    stdout: string,
    stderr: string,
    persistSnapshot: SnapshotPersister,
): Promise<LocalCliCommandResult> {
    if (state.detached) {
        return {
            canceled: false,
            command,
            detached: true,
            exitCode: 0,
            cliState: options.run.cliState ?? CliExecutionState.RUNNING,
            stderr,
            stdout,
            timedOut: false,
        };
    }
    if (state.lastSnapshot == null || state.snapshotPersistenceFailed) {
        throw error;
    }

    const executionState = options.executionMode === 'monitor' || state.startAttempted
        ? CliExecutionState.UNKNOWN
        : CliExecutionState.FAILED;
    const reason = safeError(error);
    await persistSnapshot({ ...state.lastSnapshot, reason, state: executionState }, state.lastOutput);
    return terminalResult({
        cliState: executionState,
        command,
        exitCode: executionState === CliExecutionState.UNKNOWN ? undefined : 1,
        reason,
        stderr: `${state.lastOutput.stderr}${state.lastOutput.stderr === '' ? '' : '\n'}${reason}`,
        stdout: state.lastOutput.stdout,
    });
}

interface MonitorOptions {
    activeHelper: (child: ChildProcess) => void;
    cancellationRequested: () => boolean;
    command: string[];
    config: CliConfiguration;
    detached: () => boolean;
    onSnapshot: LocalCliRunOptions['onSnapshot'];
    run: PipelineRun;
    runDirectory: string;
    runId: string;
    snapshotPersistenceFailed: () => boolean;
    shouldCancel: () => Promise<boolean>;
    stderr: string;
    stderrOffset: number;
    stdout: string;
    stdoutOffset: number;
}

interface CliMonitorState {
    processId?: number;
    reason?: string;
    startedAt?: string;
    state: CliExecutionState;
}

interface CliCancellationState {
    attempts: number;
    cancelSent: boolean;
    nextAttemptAt: number;
}

type CliMonitorRecovery =
    | { kind: 'detached' }
    | { kind: 'retry'; unreachableSince: number }
    | { kind: 'terminal'; result: LocalCliCommandResult };

interface SupervisorPoll {
    output: CliLogUpdate;
    processId?: number;
    reason?: string;
    result: SupervisorResponse;
    state: CliExecutionState;
    startedAt?: string;
    stderrRemaining: boolean;
    stdoutRemaining: boolean;
    terminal: boolean;
}

async function monitorCliRun(options: MonitorOptions): Promise<LocalCliCommandResult> {
    const logs = new SparkCliLogCollector(
        options.stdout,
        options.stderr,
        options.stdoutOffset,
        options.stderrOffset,
    );
    const monitorState: CliMonitorState = {
        processId: options.run.cliProcessId,
        startedAt: options.run.cliStartedAt,
        state: options.run.cliState ?? CliExecutionState.STARTING,
    };
    const cancellation: CliCancellationState = {
        attempts: 0,
        cancelSent: false,
        nextAttemptAt: 0,
    };
    let unreachableSince: number | undefined;

    while (!options.detached()) {
        await requestCliCancellation(options, cancellation);

        const pollStartedAt = Date.now();
        try {
            const poll = await inspectAndPersistCliSnapshot(options, logs, monitorState);
            unreachableSince = undefined;
            monitorState.processId = poll.processId;
            monitorState.startedAt = poll.startedAt;
            monitorState.reason = poll.reason;
            monitorState.state = poll.state;

            const terminalResult = cliPollTerminalResult(options, poll);
            if (terminalResult != null) {
                return terminalResult;
            }
            if (poll.terminal) {
                continue;
            }
        } catch (error) {
            const recovery = await recoverCliMonitorAfterError(
                options,
                logs,
                monitorState,
                unreachableSince,
                error,
            );
            if (recovery.kind === 'detached') {
                break;
            }
            if (recovery.kind === 'terminal') {
                return recovery.result;
            }
            unreachableSince = recovery.unreachableSince;
        }
        await delay(Math.max(0, POLL_INTERVAL_MILLISECONDS - (Date.now() - pollStartedAt)));
    }

    const output = logs.append(
        Buffer.alloc(0),
        Buffer.alloc(0),
        logs.stdoutOffset,
        logs.stderrOffset,
    );
    return {
        canceled: false,
        command: options.command,
        detached: true,
        exitCode: 0,
        cliState: monitorState.state,
        stderr: output.stderr,
        stdout: output.stdout,
        timedOut: false,
    };
}

async function recoverCliMonitorAfterError(
    options: MonitorOptions,
    logs: SparkCliLogCollector,
    state: CliMonitorState,
    unreachableSince: number | undefined,
    error: unknown,
): Promise<CliMonitorRecovery> {
    if (options.snapshotPersistenceFailed()) {
        throw error;
    }
    if (options.detached()) {
        return { kind: 'detached' };
    }
    const nextUnreachableSince = unreachableSince ?? Date.now();
    if (Date.now() - nextUnreachableSince >= RECONNECT_GRACE_MILLISECONDS) {
        return {
            kind: 'terminal',
            result: await unavailableCliMonitorResult(options, logs, state, error),
        };
    }
    return { kind: 'retry', unreachableSince: nextUnreachableSince };
}

async function requestCliCancellation(
    options: MonitorOptions,
    state: CliCancellationState,
): Promise<void> {
    if (state.cancelSent || Date.now() < state.nextAttemptAt ||
        (!options.cancellationRequested() && !await options.shouldCancel())) {
        return;
    }
    try {
        await invokeSupervisor(options.config, 'cancel', [
            options.config.stateDirectory,
            options.runId,
        ], options.activeHelper);
        state.cancelSent = true;
    } catch (error) {
        console.warn(`Could not cancel local Spark CLI run ${options.runId}: ${safeError(error)}`);
        state.attempts += 1;
        const retryDelay = Math.min(
            30_000,
            POLL_INTERVAL_MILLISECONDS * 2 ** Math.min(5, state.attempts),
        );
        state.nextAttemptAt = Date.now() + retryDelay;
    }
}

async function inspectAndPersistCliSnapshot(
    options: MonitorOptions,
    logs: SparkCliLogCollector,
    current: CliMonitorState,
): Promise<SupervisorPoll> {
    const result = await invokeSupervisor(options.config, 'inspect', [
        options.config.stateDirectory,
        options.runId,
        String(logs.stdoutOffset),
        String(logs.stderrOffset),
    ], options.activeHelper);
    const nextState = normalizeExecutionState(result.state);
    const previousStdoutOffset = logs.stdoutOffset;
    const previousStderrOffset = logs.stderrOffset;
    const stdoutBytes = decodeChunk(result.stdoutChunk);
    const stderrBytes = decodeChunk(result.stderrChunk);
    let output = logs.append(
        stdoutBytes,
        stderrBytes,
        result.stdoutOffset ?? logs.stdoutOffset + stdoutBytes.length,
        result.stderrOffset ?? logs.stderrOffset + stderrBytes.length,
    );
    const terminal = !ACTIVE_CLI_EXECUTION_STATUSES.includes(nextState);
    const stdoutRemaining = hasRemainingOutput(result.stdoutRemaining, stdoutBytes);
    const stderrRemaining = hasRemainingOutput(result.stderrRemaining, stderrBytes);
    if (terminal && !stdoutRemaining && !stderrRemaining) {
        const finishedOutput = logs.finish();
        output = {
            ...finishedOutput,
            stderrChunk: output.stderrChunk + (finishedOutput.stderrChunk ?? ''),
            stdoutChunk: output.stdoutChunk + (finishedOutput.stdoutChunk ?? ''),
        };
    }

    const processId = result.processId ?? current.processId;
    const startedAt = result.startedAt ?? current.startedAt;
    const reason = result.reason;
    const changed = nextState !== current.state || output.stdoutOffset !== previousStdoutOffset ||
        output.stderrOffset !== previousStderrOffset || processId !== current.processId ||
        startedAt !== current.startedAt || reason !== current.reason;
    if (changed) {
        await options.onSnapshot(buildSnapshot({
            executionId: options.runId,
            processId: result.processId,
            reason,
            runDirectory: result.runDirectory ?? options.runDirectory,
            startedAt: result.startedAt,
            state: nextState,
            stderrOffset: output.stderrOffset,
            stdoutOffset: output.stdoutOffset,
        }), output);
    }
    return {
        output,
        processId,
        reason,
        result,
        startedAt,
        state: nextState,
        stderrRemaining,
        stdoutRemaining,
        terminal,
    };
}

function cliPollTerminalResult(
    options: MonitorOptions,
    poll: SupervisorPoll,
): LocalCliCommandResult | undefined {
    if (!poll.terminal || poll.stdoutRemaining || poll.stderrRemaining) {
        return undefined;
    }
    return terminalResult({
        canceled: poll.state === CliExecutionState.CANCELED,
        cliState: poll.state,
        command: options.command,
        exitCode: poll.result.exitCode ?? exitCodeForState(poll.state),
        reason: poll.result.reason,
        stderr: poll.output.stderr,
        stdout: poll.output.stdout,
        timedOut: poll.state === CliExecutionState.TIMED_OUT,
    });
}

async function unavailableCliMonitorResult(
    options: MonitorOptions,
    logs: SparkCliLogCollector,
    state: CliMonitorState,
    error: unknown,
): Promise<LocalCliCommandResult> {
    const reason = `CLI_MONITOR_UNAVAILABLE:${safeError(error)}`;
    const unknown = buildSnapshot({
        executionId: options.runId,
        processId: state.processId,
        reason,
        runDirectory: options.runDirectory,
        startedAt: state.startedAt,
        state: CliExecutionState.UNKNOWN,
        stderrOffset: logs.stderrOffset,
        stdoutOffset: logs.stdoutOffset,
    });
    const output = logs.append(
        Buffer.alloc(0),
        Buffer.alloc(0),
        logs.stdoutOffset,
        logs.stderrOffset,
    );
    await options.onSnapshot(unknown, output);
    return terminalResult({
        cliState: CliExecutionState.UNKNOWN,
        command: options.command,
        reason,
        stderr: `${output.stderr}${output.stderr === '' ? '' : '\n'}Could not read local CLI state for five minutes: ${safeError(error)}`,
        stdout: output.stdout,
    });
}

function loadCliConfiguration(environment: NodeJS.ProcessEnv = process.env): CliConfiguration {
    const propertiesFile = environment.SPARK_CLI_PROPERTIES_FILE?.trim() || undefined;
    return {
        binaryPath: environment.SPARK_CLI_BINARY?.trim() || 'spark-pipelines',
        propertiesFile,
        pythonPath: environment.SPARK_CLI_PYTHON?.trim() ||
            environment.PYTHON_EXECUTABLE?.trim() || 'python3',
        stateDirectory: pipelineRunStateDirectory(environment),
    };
}

/** Builds the stock CLI invocation from pipeline mode and Connect configuration. */
export function buildSparkPipelinesArguments(
    config: Pick<CliConfiguration, 'binaryPath' | 'propertiesFile'>,
    sparkConnectUrl: string,
    spec: PipelineSpec,
    mode: RunMode,
    targetNodeNames?: string[],
): string[] {
    const args = [config.binaryPath, mode === 'dry-run' ? 'dry-run' : 'run'];
    if (config.propertiesFile != null) {
        args.push('--properties-file', config.propertiesFile);
    }
    args.push(
        '--remote',
        sparkConnectUrl,
        '--spec',
        spec.specPath,
    );
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

/** Returns a display-safe command without embedding the Connect URL or credentials. */
export function previewSparkPipelinesCommand(spec: PipelineSpec, mode: RunMode): string[] {
    return ['spark-pipelines', mode === 'dry-run' ? 'dry-run' : 'run', '--spec', spec.specPath];
}

async function invokeSupervisor(
    config: CliConfiguration,
    action: string,
    args: string[],
    onProcess: (child: ChildProcess) => void,
): Promise<SupervisorResponse> {
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
        return JSON.parse(result.stdout.trim()) as SupervisorResponse;
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
    let stdout = '';
    let stderr = '';
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr?.on('data', (chunk: string) => { stderr += chunk; });
    return await new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('close', (code) => resolve({ exitCode: code ?? 1, stderr, stdout }));
    });
}

function buildSnapshot(snapshot: CliRunSnapshotInput): LocalCliRunSnapshot {
    return {
        command: [],
        ...snapshot,
    };
}

function encodePayload(payload: Record<string, unknown>): string {
    return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
}

function decodeChunk(encoded: string | undefined): Buffer {
    return encoded == null || encoded === ''
        ? Buffer.alloc(0)
        : Buffer.from(encoded, 'base64');
}

function hasRemainingOutput(explicitValue: boolean | undefined, chunk: Buffer): boolean {
    return explicitValue ?? chunk.length >= SUPERVISOR_LOG_CHUNK_LIMIT_BYTES;
}

function sameSnapshot(left: LocalCliRunSnapshot, right: LocalCliRunSnapshot): boolean {
    return left.command.join('\0') === right.command.join('\0') &&
        left.executionId === right.executionId &&
        left.processId === right.processId &&
        left.reason === right.reason &&
        left.runDirectory === right.runDirectory &&
        left.startedAt === right.startedAt &&
        left.state === right.state &&
        left.stderrOffset === right.stderrOffset &&
        left.stdoutOffset === right.stdoutOffset;
}

function terminalResult(result: TerminalResultInput): LocalCliCommandResult {
    return {
        canceled: result.canceled ?? false,
        command: result.command,
        detached: false,
        exitCode: result.exitCode,
        cliState: result.cliState,
        reason: result.reason,
        stderr: result.stderr,
        stdout: result.stdout,
        timedOut: result.timedOut ?? false,
    };
}

function requireSparkConnectUrl(value: string | undefined): string {
    if (value == null || value.trim() === '') {
        throw new Error('SPARK_CONNECT_URL is required for a new Spark Pipelines CLI run.');
    }
    return value;
}

function requirePipelineSpec(value: PipelineSpec | undefined): PipelineSpec {
    if (value == null) {
        throw new Error('Pipeline metadata is required for a new Spark Pipelines CLI run.');
    }
    return value;
}

function safeError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function delay(milliseconds: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
