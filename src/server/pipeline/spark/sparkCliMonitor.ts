/** Polls durable CLI state and keeps log collection and cancellation in sync. */

import { ACTIVE_CLI_EXECUTION_STATUSES, CliExecutionState } from '../../../shared/status/execution.ts';
import { SparkCliLogCollector } from './sparkCliLogCollector.ts';
import type { CliRunContext, LocalCliCommandResult, LocalCliRunSnapshot } from './sparkCliProcess.ts';
import { invokeSupervisor } from './sparkCliProtocol.ts';

const POLL_INTERVAL_MILLISECONDS = 1_000;
const MAX_QUIET_INTERVAL_MILLISECONDS = 4_000;
const RECONNECT_GRACE_MILLISECONDS = 5 * 60 * 1_000;

type TerminalResultInput = Omit<
    LocalCliCommandResult,
    'canceled' | 'detached' | 'timedOut'
> & Partial<Pick<LocalCliCommandResult, 'canceled' | 'timedOut'>>;

interface CliMonitorState {
    logs: SparkCliLogCollector;
    snapshot: LocalCliRunSnapshot;
    cancelSent: boolean;
    cancelAttempts: number;
    nextCancelAttemptAt: number;
    unreachableSince?: number;
    interval: number;
}

/** Monitors a saved CLI execution without submitting it and drains terminal output. */
export async function monitorCliRun(context: CliRunContext): Promise<LocalCliCommandResult> {
    const { run } = context.options;
    const state: CliMonitorState = {
        logs: new SparkCliLogCollector(
            context.lastOutput.stdout,
            context.lastOutput.stderr,
            run.cliStdoutOffset ?? 0,
            run.cliStderrOffset ?? 0,
        ),
        snapshot: context.lastSnapshot ?? {
            command: context.command,
            executionId: context.runId,
            processId: run.cliProcessId,
            runDirectory: context.runDirectory,
            startedAt: run.cliStartedAt,
            state: run.cliState ?? CliExecutionState.STARTING,
            stdoutOffset: run.cliStdoutOffset ?? 0,
            stderrOffset: run.cliStderrOffset ?? 0,
        },
        cancelSent: false,
        cancelAttempts: 0,
        nextCancelAttemptAt: 0,
        interval: POLL_INTERVAL_MILLISECONDS,
    };
    for await (const result of pollCliRun(context, state)) {
        if (result != null) {
            return result;
        }
    }
    return detachedResult(context);
}

async function* pollCliRun(
    context: CliRunContext,
    state: CliMonitorState,
): AsyncGenerator<LocalCliCommandResult | undefined> {
    while (!context.detached) {
        yield runPollCycle(context, state);
    }
}

async function runPollCycle(
    context: CliRunContext,
    state: CliMonitorState,
): Promise<LocalCliCommandResult | undefined> {
    await requestCancellation(context, state);
    if (context.detached) {
        return undefined;
    }
    const pollStartedAt = Date.now();
    try {
        const result = await inspectRun(context, state);
        state.unreachableSince = undefined;
        if (result != null || !ACTIVE_CLI_EXECUTION_STATUSES.includes(state.snapshot.state)) {
            return result;
        }
    } catch (error) {
        const result = retryAfterInspectionFailure(context, state, error);
        if (result != null) {
            return result;
        }
    }
    if (!context.detached) {
        await waitForPoll(context, Math.max(0, state.interval - (Date.now() - pollStartedAt)));
    }
    return undefined;
}

function retryAfterInspectionFailure(
    context: CliRunContext,
    state: CliMonitorState,
    error: unknown,
): Promise<LocalCliCommandResult> | undefined {
    if (context.snapshotPersistenceFailed) {
        throw error;
    }
    if (context.detached) {
        return undefined;
    }
    state.interval = POLL_INTERVAL_MILLISECONDS;
    const now = Date.now();
    state.unreachableSince ??= now;
    return now - state.unreachableSince >= RECONNECT_GRACE_MILLISECONDS
        ? unavailableResult(context, state, error)
        : undefined;
}

async function requestCancellation(context: CliRunContext, state: CliMonitorState): Promise<void> {
    if (state.cancelSent || Date.now() < state.nextCancelAttemptAt ||
        (!context.cancellationRequested && !await context.options.shouldCancel())) {
        return;
    }
    if (context.detached) {
        return;
    }
    try {
        // Detach can release the monitor while the cancellation helper commits.
        const detached = new Promise<void>((resolve) => {
            context.wakeOnDetach = resolve;
        });
        const cancellation = invokeSupervisor(context.config, 'cancel', [
            context.config.stateDirectory,
            context.runId,
        ], context.runId, (child) => {
            context.activeHelper = { child, interruptible: false };
        });
        await Promise.race([cancellation, detached]);
        state.cancelSent = !context.detached;
    } catch (error) {
        console.warn('Could not cancel local Spark CLI run ' + context.runId + ': ' + safeError(error));
        state.cancelAttempts += 1;
        state.nextCancelAttemptAt = Date.now() + Math.min(30_000, 1_000 * 2 ** Math.min(5, state.cancelAttempts));
    } finally {
        context.wakeOnDetach = undefined;
        context.activeHelper = undefined;
    }
}

async function inspectRun(
    context: CliRunContext,
    monitor: CliMonitorState,
): Promise<LocalCliCommandResult | undefined> {
    const { logs, snapshot } = monitor;
    const status = await invokeSupervisor(context.config, 'inspect', [
        context.config.stateDirectory,
        context.runId,
        String(logs.stdoutOffset),
        String(logs.stderrOffset),
    ], context.runId, (child) => {
        context.activeHelper = { child, interruptible: true };
    });
    let output = logs.append(
        Buffer.from(status.stdoutChunk, 'base64'),
        Buffer.from(status.stderrChunk, 'base64'),
        status.stdoutOffset,
        status.stderrOffset,
    );
    const terminal = !ACTIVE_CLI_EXECUTION_STATUSES.includes(status.state);
    const drained = !status.stdoutRemaining && !status.stderrRemaining;
    if (terminal && drained) {
        const finished = logs.finish();
        output = {
            ...finished,
            stdoutChunk: output.stdoutChunk + (finished.stdoutChunk ?? ''),
            stderrChunk: output.stderrChunk + (finished.stderrChunk ?? ''),
        };
    }
    const next = {
        ...snapshot,
        processId: status.processId ?? snapshot.processId,
        reason: status.reason,
        runDirectory: status.runDirectory,
        startedAt: status.startedAt ?? snapshot.startedAt,
        state: status.state,
        stdoutOffset: output.stdoutOffset,
        stderrOffset: output.stderrOffset,
    };
    const changed = next.state !== snapshot.state || next.processId !== snapshot.processId ||
        next.startedAt !== snapshot.startedAt || next.reason !== snapshot.reason ||
        next.runDirectory !== snapshot.runDirectory || next.stdoutOffset !== snapshot.stdoutOffset ||
        next.stderrOffset !== snapshot.stderrOffset || Boolean(output.stdoutChunk || output.stderrChunk);
    if (changed) {
        await context.persistSnapshot(next, output);
    }
    monitor.snapshot = next;
    monitor.interval = !changed && next.processId != null && next.state === CliExecutionState.RUNNING &&
        !context.cancellationRequested && monitor.cancelAttempts === 0 && !monitor.cancelSent
        ? Math.min(MAX_QUIET_INTERVAL_MILLISECONDS, monitor.interval * 2)
        : POLL_INTERVAL_MILLISECONDS;
    if (terminal && drained) {
        return terminalResult({
            canceled: next.state === CliExecutionState.CANCELED,
            cliState: next.state,
            command: context.command,
            exitCode: status.exitCode ?? exitCodeForState(next.state),
            reason: next.reason,
            stderr: output.stderr,
            stdout: output.stdout,
            timedOut: next.state === CliExecutionState.TIMED_OUT,
        });
    }
    return undefined;
}

async function unavailableResult(context: CliRunContext, monitor: CliMonitorState, error: unknown) {
    const detail = safeError(error);
    const reason = 'CLI_MONITOR_UNAVAILABLE:' + detail;
    const logs = monitor.logs;
    const output = logs.append(Buffer.alloc(0), Buffer.alloc(0), logs.stdoutOffset, logs.stderrOffset);
    await context.persistSnapshot({ ...monitor.snapshot, reason, state: CliExecutionState.UNKNOWN }, output);
    return terminalResult({
        cliState: CliExecutionState.UNKNOWN,
        command: context.command,
        reason,
        stderr: [output.stderr, 'Could not read local CLI state for five minutes: ' + detail].filter(Boolean).join('\n'),
        stdout: output.stdout,
    });
}

function waitForPoll(context: CliRunContext, milliseconds: number): Promise<void> {
    return new Promise((resolve) => {
        const wake = () => {
            clearTimeout(timer);
            context.wakeMonitor = undefined;
            resolve();
        };
        const timer = setTimeout(wake, milliseconds);
        context.wakeMonitor = wake;
    });
}

function exitCodeForState(state: CliExecutionState): number | undefined {
    if (state === CliExecutionState.COMPLETED) {
        return 0;
    }
    if (state === CliExecutionState.UNKNOWN) {
        return undefined;
    }
    return state === CliExecutionState.CANCELED || state === CliExecutionState.TIMED_OUT ? 130 : 1;
}

/** Returns the last observed state and output when monitoring is released. */
export function detachedResult(context: CliRunContext): LocalCliCommandResult {
    return {
        canceled: false,
        command: context.command,
        detached: true,
        cliState: context.lastSnapshot?.state ?? context.options.run.cliState ?? CliExecutionState.STARTING,
        stderr: context.lastOutput.stderr,
        stdout: context.lastOutput.stdout,
        timedOut: false,
    };
}

/** Returns a finished monitor result with consistent defaults. */
export function terminalResult(result: TerminalResultInput): LocalCliCommandResult {
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

/** Converts thrown values to diagnostic text. */
export function safeError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
