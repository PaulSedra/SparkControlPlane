/** Submits one Spark CLI execution and coordinates its independently supervised monitor. */

import type { ChildProcess } from 'node:child_process';
import path from 'node:path';
import type { PipelineRun, PipelineSpec } from '../../../shared/pipelineRegistryTypes.ts';
import { CliExecutionState } from '../../../shared/status/execution.ts';
import { pipelineProjectRoot } from '../execution/pipelineRuntime.ts';
import type { CliLogUpdate } from './sparkCliLogCollector.ts';
import { detachedResult, monitorCliRun, safeError, terminalResult } from './sparkCliMonitor.ts';
import {
    buildSparkConnectServerArguments,
    buildSparkPipelinesArguments,
    displayClientCommand,
    encodePayload,
    invokeSupervisor,
    loadCliConfiguration,
    PIPELINE_SPEC_ADAPTER_DIRECTORY,
    previewSparkPipelinesCommand,
    type CliConfiguration,
} from './sparkCliProtocol.ts';

/** Command builders exposed for callers of the Spark CLI adapter. */
export {
    buildSparkConnectServerArguments,
    buildSparkPipelinesArguments,
    previewSparkPipelinesCommand,
} from './sparkCliProtocol.ts';

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
export type LocalCliRunOptions = {
    onController: (controller: LocalCliRunController, command: string[]) => void;
    onSnapshot: (
        snapshot: LocalCliRunSnapshot,
        output: CliLogUpdate,
    ) => Promise<void>;
    run: PipelineRun;
    shouldCancel: () => Promise<boolean>;
    targetNodeNames?: string[];
} & (
    | { executionMode: 'submit'; spec: PipelineSpec; sourceFiles: readonly string[] }
    | { executionMode: 'monitor'; spec?: PipelineSpec }
);

/** Shared execution identity, runtime, and last durable monitor state. */
export interface CliRunContext {
    options: LocalCliRunOptions;
    command: string[];
    config: CliConfiguration;
    runDirectory: string;
    runId: string;
    activeHelper?: { child: ChildProcess; interruptible: boolean };
    cancellationRequested: boolean;
    detached: boolean;
    lastOutput: CliLogUpdate;
    lastSnapshot?: LocalCliRunSnapshot;
    snapshotPersistenceFailed: boolean;
    startAttempted: boolean;
    persistSnapshot: (snapshot: LocalCliRunSnapshot, output: CliLogUpdate) => Promise<void>;
    wakeMonitor?: () => void;
    wakeOnDetach?: () => void;
}

/**
 * Starts a CLI once or monitors its saved local state by run ID.
 * Detaching ends monitoring while the independent supervisor continues.
 */
export async function runSparkCliProcess(options: LocalCliRunOptions): Promise<LocalCliCommandResult> {
    const { run, spec } = options;
    const config = loadCliConfiguration();
    const runId = run.cliExecutionId ?? run.runId;
    const targets = options.targetNodeNames ?? run.targetNodeNames ?? run.repairedNodeNames;
    if (options.executionMode === 'submit' && !Array.isArray(options.sourceFiles)) {
        throw new Error('The verified pipeline source file list is required for submission.');
    }
    const clientCommand = options.executionMode === 'submit'
        ? buildSparkPipelinesArguments(config, options.spec, run.mode, runId, targets)
        : undefined;
    const command = clientCommand != null && spec != null
        ? displayClientCommand(clientCommand, spec.specPath)
        : commandForRun(options, targets);
    const context: CliRunContext = {
        options,
        config,
        command,
        runId,
        runDirectory: run.cliRunDirectory ?? path.join(config.stateDirectory, 'runs', runId),
        cancellationRequested: false,
        detached: false,
        lastOutput: { stderr: run.stderr ?? '', stdout: run.stdout ?? '' },
        snapshotPersistenceFailed: false,
        startAttempted: false,
        persistSnapshot: (snapshot, output) => persistSnapshot(context, snapshot, output),
    };
    options.onController({
        detach: () => {
            context.detached = true;
            if (context.activeHelper?.interruptible) {
                context.activeHelper.child.kill();
            }
            context.wakeOnDetach?.();
            context.wakeMonitor?.();
        },
        requestStop: () => {
            context.cancellationRequested = true;
            context.wakeMonitor?.();
        },
    }, command);

    try {
        if (clientCommand != null) {
            const result = await submitCliRun(context, clientCommand);
            if (result != null) {
                return result;
            }
        }
        const incomplete = incompleteMonitorIdentityResult(options, command, context.lastOutput.stderr);
        return incomplete ?? await monitorCliRun(context);
    } catch (error) {
        return handleSparkCliRunError(context, error);
    } finally {
        context.activeHelper = undefined;
    }
}

async function submitCliRun(
    context: CliRunContext,
    clientCommand: string[],
): Promise<LocalCliCommandResult | undefined> {
    const { command, config, options, runDirectory, runId } = context;
    const { run } = options;
    if (options.executionMode !== 'submit') {
        throw new Error('A monitor cannot submit a Spark CLI run.');
    }
    const { spec, sourceFiles } = options;
    await context.persistSnapshot({
        command,
        executionId: runId,
        runDirectory,
        state: CliExecutionState.STARTING,
        stderrOffset: run.cliStderrOffset ?? 0,
        stdoutOffset: run.cliStdoutOffset ?? 0,
    }, context.lastOutput);
    if (context.detached) {
        return detachedResult(context);
    }
    if (context.cancellationRequested || await options.shouldCancel()) {
        return terminalResult({
            canceled: true,
            cliState: CliExecutionState.CANCELED,
            command,
            exitCode: 130,
            ...context.lastOutput,
        });
    }
    if (context.detached) {
        return detachedResult(context);
    }

    const workingDirectory = pipelineProjectRoot(spec.specPath);
    const connectServerCommand = buildSparkConnectServerArguments(config, spec, runId);
    context.startAttempted = true;
    await invokeSupervisor(config, 'start', [encodePayload({
        command: clientCommand,
        connectServerCommand,
        pipelineSpecAdapterDirectory: PIPELINE_SPEC_ADAPTER_DIRECTORY,
        pythonPath: config.pythonPath,
        runId,
        sourceFiles: [path.relative(workingDirectory, spec.specPath), ...sourceFiles]
            .map((name) => name.replaceAll('\\', '/')),
        sourceHash: run.sourceHash ?? '',
        stateDirectory: config.stateDirectory,
        timeoutSeconds: run.timeoutSeconds ?? null,
        workingDirectory,
    })], runId, (child) => {
        // The run identity must be durable before detach releases the worker lease.
        context.activeHelper = { child, interruptible: false };
    });
    context.activeHelper = undefined;
    return undefined;
}

async function persistSnapshot(
    context: CliRunContext,
    snapshot: LocalCliRunSnapshot,
    output: CliLogUpdate,
): Promise<void> {
    if (context.lastSnapshot != null && sameSnapshot(context.lastSnapshot, snapshot) &&
        context.lastOutput.stdout === output.stdout && context.lastOutput.stderr === output.stderr) {
        return;
    }
    try {
        await context.options.onSnapshot(snapshot, output);
        context.lastSnapshot = snapshot;
        context.lastOutput = output;
    } catch (error) {
        context.snapshotPersistenceFailed = true;
        throw error;
    }
}

function commandForRun(options: LocalCliRunOptions, targets: string[] | undefined): string[] {
    const { run, spec } = options;
    if (run.command != null) {
        return run.command;
    }
    if (spec != null) {
        return previewSparkPipelinesCommand(spec, run.mode, targets);
    }
    return ['spark-pipelines', run.mode === 'dry-run' ? 'dry-run' : 'run'];
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

async function handleSparkCliRunError(context: CliRunContext, error: unknown): Promise<LocalCliCommandResult> {
    const { command, lastSnapshot, lastOutput, options } = context;
    if (context.detached) {
        return detachedResult(context);
    }
    if (lastSnapshot == null || context.snapshotPersistenceFailed) {
        throw error;
    }
    const state = options.executionMode === 'monitor' || context.startAttempted
        ? CliExecutionState.UNKNOWN
        : CliExecutionState.FAILED;
    const reason = safeError(error);
    await context.persistSnapshot({ ...lastSnapshot, reason, state }, lastOutput);
    return terminalResult({
        cliState: state,
        command,
        exitCode: state === CliExecutionState.UNKNOWN ? undefined : 1,
        reason,
        stderr: [lastOutput.stderr, reason].filter(Boolean).join('\n'),
        stdout: lastOutput.stdout,
    });
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
