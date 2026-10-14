/** @fileoverview Persists live local CLI output and node projections. */

import type { PipelineRun } from '../../../shared/pipelineRegistryTypes.ts';
import { isActiveCliExecutionState } from '../../../shared/status/execution.ts';
import type {
    ControlPlanePersistence,
    LocalCliExecutionUpdate,
    RunLease,
} from '../../types/pipelinePersistenceTypes.ts';
import type {
    LocalCliRunSnapshot,
} from '../spark/sparkCliProcess.ts';
import type { CliLogUpdate } from '../spark/sparkCliLogCollector.ts';
import { workerRunStatusForCliState } from '../../../shared/status/run.ts';
import {
    IncrementalRunNodeStatusParser,
} from './runStatusParser.ts';

interface RunPublisher<T> {
    publish: (value: T) => Promise<void>;
    wait: () => Promise<void>;
}

/**
 * Persistence and fencing controls for one claimed local CLI run.
 *
 * The lease must belong to `run`; `fence` stops later writes after ownership
 * changes, and `isFenced` lets the publisher check that state before each write.
 */
export interface LocalCliExecutionPublisherDependencies {
    fence: () => void;
    isFenced: () => boolean;
    lease: RunLease;
    persistence: ControlPlanePersistence;
    run: PipelineRun;
}

/**
 * Creates an ordered publisher for local CLI snapshots.
 *
 * It parses appended output into node states and persists updates through the
 * run lease. The returned `wait` promise tracks queued writes; fencing stops
 * later writes from a displaced worker.
 */
export function createLocalCliExecutionPublisher(
    dependencies: LocalCliExecutionPublisherDependencies,
): RunPublisher<{ snapshot: LocalCliRunSnapshot; output: CliLogUpdate }> {
    const { fence, isFenced, lease, persistence, run } = dependencies;
    let writes = Promise.resolve();
    const stdoutParser = new IncrementalRunNodeStatusParser(run.stdout ?? '');
    const stderrParser = new IncrementalRunNodeStatusParser(run.stderr ?? '');
    let previousOutput = { stderr: run.stderr ?? '', stdout: run.stdout ?? '' };
    const publish = (value: { snapshot: LocalCliRunSnapshot; output: CliLogUpdate }) => {
        if (isFenced()) {
            return Promise.resolve();
        }
        writes = writes.then(async () => {
            if (isFenced()) {
                return;
            }
            const { snapshot, output } = value;
            if (!isActiveCliExecutionState(snapshot.state)) {
                return;
            }
            stdoutParser.append(output.stdoutChunk ?? appendedOutput(
                previousOutput.stdout,
                output.stdout,
            ));
            stderrParser.append(output.stderrChunk ?? appendedOutput(
                previousOutput.stderr,
                output.stderr,
            ));
            previousOutput = { stderr: output.stderr, stdout: output.stdout };
            const nodeStatuses = {
                ...stdoutParser.snapshot(),
                ...stderrParser.snapshot(),
            };
            const update: LocalCliExecutionUpdate = {
                command: snapshot.command,
                executionId: snapshot.executionId,
                nodeStatuses,
                runStatus: workerRunStatusForCliState(snapshot.state),
                state: snapshot.state,
                stderrOffset: snapshot.stderrOffset,
                stderr: output.stderr,
                stdoutOffset: snapshot.stdoutOffset,
                stdout: output.stdout,
                processId: snapshot.processId,
                reason: snapshot.reason,
                runDirectory: snapshot.runDirectory,
                startedAt: snapshot.startedAt,
            };
            const result = await persistence.updateLocalCliExecution(run.runId, lease, update);
            if (result.kind === 'FENCED' || result.kind === 'ALREADY_TERMINAL') {
                fence();
            }
        });
        return writes;
    };
    return { publish, wait: () => writes };
}

function appendedOutput(previous: string, current: string): string {
    return current.startsWith(previous) ? current.slice(previous.length) : current;
}
