/**
 * @fileoverview Regression coverage for shared lifecycle and status rules.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import {
    ACTIVE_CLI_EXECUTION_STATUSES,
    CLI_EXECUTION_STATES,
    CliExecutionState,
    TERMINAL_CLI_EXECUTION_STATUSES,
} from '../../../../src/shared/status/execution.ts';
import {
    ACTIVE_PIPELINE_RUN_NODE_STATUSES,
    PipelineRunNodeStatus,
    TERMINAL_PIPELINE_RUN_NODE_EVENT_STATUSES,
    TERMINAL_PIPELINE_RUN_NODE_STATUSES,
    pipelineRunNodeStatusForRun,
} from '../../../../src/shared/status/node.ts';
import {
    PIPELINE_RUN_STATUS_LABELS,
    STATUS_PRESENTATION_LABELS,
    pipelineAssetStateForIncomingFlows,
    sparkStatusPresentationState,
    statusPresentationForPipelineNodeStatus,
    statusPresentationForPipelineState,
    statusPresentationForRunStatus,
    type StatusPresentationState,
} from '../../../../src/shared/status/presentation.ts';
import {
    ACTIVE_PIPELINE_RUN_STATUSES,
    RunStatus,
    TERMINAL_PIPELINE_RUN_STATUSES,
    WORKER_ACTIVE_PIPELINE_RUN_STATUSES,
    auditEventTypeForRunStatus,
    pipelineRunFailureMessage,
    pipelineRunFailureTitle,
    pipelineRunStatusForCliExecution,
    workerRunStatusForCliState,
    type TerminalRunStatus,
} from '../../../../src/shared/status/run.ts';
import {
    ACCEPTED_TRIGGER_INGESTION_STATUSES,
    FINAL_TRIGGER_DELIVERY_STATUSES,
    TriggerDeliveryStatus,
    TriggerIngestionStatus,
} from '../../../../src/shared/status/trigger.ts';
import { normalizeTerminalNodeStatuses } from '../../../../src/server/persistence/run/postgresRunMappers.ts';

const cliTerminalCases: Array<{
    exitCode?: number;
    expected: TerminalRunStatus;
    state: CliExecutionState;
}> = [
    { expected: RunStatus.SUCCEEDED, exitCode: 0, state: CliExecutionState.COMPLETED },
    { expected: RunStatus.FAILED, exitCode: 0, state: CliExecutionState.FAILED },
    { expected: RunStatus.CANCELED, exitCode: 130, state: CliExecutionState.CANCELED },
    { expected: RunStatus.TIMED_OUT, exitCode: 130, state: CliExecutionState.TIMED_OUT },
    { expected: RunStatus.UNKNOWN, state: CliExecutionState.UNKNOWN },
];

for (const scenario of cliTerminalCases) {
    test(`maps terminal CLI state ${scenario.state} directly to ${scenario.expected}`, () => {
        assert.equal(pipelineRunStatusForCliExecution(scenario), scenario.expected);
    });
}

test('cancellation and timeout flags take precedence over the reported CLI state', () => {
    const conflicts: Array<{
        canceled?: boolean;
        expected: TerminalRunStatus;
        state: CliExecutionState;
        timedOut?: boolean;
    }> = [
        { canceled: true, expected: RunStatus.CANCELED, state: CliExecutionState.COMPLETED },
        { canceled: true, expected: RunStatus.CANCELED, state: CliExecutionState.TIMED_OUT, timedOut: true },
        { canceled: true, expected: RunStatus.CANCELED, state: CliExecutionState.UNKNOWN },
        { expected: RunStatus.TIMED_OUT, state: CliExecutionState.COMPLETED, timedOut: true },
        { expected: RunStatus.TIMED_OUT, state: CliExecutionState.CANCELED, timedOut: true },
        { expected: RunStatus.TIMED_OUT, state: CliExecutionState.UNKNOWN, timedOut: true },
        { expected: RunStatus.CANCELED, state: CliExecutionState.STARTING, canceled: true },
        { expected: RunStatus.TIMED_OUT, state: CliExecutionState.RUNNING, timedOut: true },
    ];

    for (const scenario of conflicts) {
        assert.equal(pipelineRunStatusForCliExecution(scenario), scenario.expected);
    }
});

test('active CLI states cannot be mistaken for terminal run outcomes', () => {
    for (const state of ACTIVE_CLI_EXECUTION_STATUSES) {
        assert.throws(
            () => pipelineRunStatusForCliExecution({ state }),
            /still active/,
        );
    }
});

test('worker status mapping accepts only the active CLI states', () => {
    assert.equal(workerRunStatusForCliState(CliExecutionState.STARTING), RunStatus.SUBMITTING);
    assert.equal(workerRunStatusForCliState(CliExecutionState.RUNNING), RunStatus.RUNNING);

    const terminalStates = CLI_EXECUTION_STATES.filter(
        (state) => !ACTIVE_CLI_EXECUTION_STATUSES.includes(state),
    );
    for (const state of terminalStates) {
        assert.throws(() => workerRunStatusForCliState(state), /cannot be mapped to an active run/);
    }
});

test('run, node, and CLI lifecycle groups cover each domain without active-terminal overlap', () => {
    assert.deepEqual(new Set([...ACTIVE_PIPELINE_RUN_STATUSES, ...TERMINAL_PIPELINE_RUN_STATUSES]),
        new Set(Object.values(RunStatus)));
    assert.equal(ACTIVE_PIPELINE_RUN_STATUSES.some((status) =>
        TERMINAL_PIPELINE_RUN_STATUSES.includes(status)), false);
    assert.deepEqual(new Set([...ACTIVE_PIPELINE_RUN_NODE_STATUSES,
        ...TERMINAL_PIPELINE_RUN_NODE_STATUSES]),
    new Set(Object.values(PipelineRunNodeStatus)));
    assert.equal(ACTIVE_PIPELINE_RUN_NODE_STATUSES.some((status) =>
        TERMINAL_PIPELINE_RUN_NODE_STATUSES.includes(status)), false);
    assert.equal(TERMINAL_PIPELINE_RUN_NODE_EVENT_STATUSES.includes(PipelineRunNodeStatus.UNKNOWN), false);
    assert.deepEqual(new Set([...ACTIVE_CLI_EXECUTION_STATUSES, ...TERMINAL_CLI_EXECUTION_STATUSES]),
        new Set(CLI_EXECUTION_STATES));
    assert.equal(ACTIVE_CLI_EXECUTION_STATUSES.some((status) =>
        TERMINAL_CLI_EXECUTION_STATUSES.includes(status)), false);
    assert.deepEqual(new Set(WORKER_ACTIVE_PIPELINE_RUN_STATUSES), new Set([
        RunStatus.SUBMITTING,
        RunStatus.RUNNING,
    ]));
    assert.equal(WORKER_ACTIVE_PIPELINE_RUN_STATUSES.every((status) =>
        ACTIVE_PIPELINE_RUN_STATUSES.includes(status)), true);
});

test('every run outcome maps to a node status only after it becomes terminal', () => {
    const mappings: Array<[RunStatus, PipelineRunNodeStatus | undefined]> = [
        [RunStatus.QUEUED, undefined],
        [RunStatus.SUBMITTING, undefined],
        [RunStatus.RUNNING, undefined],
        [RunStatus.SUCCEEDED, PipelineRunNodeStatus.COMPLETED],
        [RunStatus.FAILED, PipelineRunNodeStatus.FAILED],
        [RunStatus.CANCELED, PipelineRunNodeStatus.CANCELED],
        [RunStatus.TIMED_OUT, PipelineRunNodeStatus.FAILED],
        [RunStatus.UNKNOWN, PipelineRunNodeStatus.UNKNOWN],
    ];

    for (const [runStatus, expected] of mappings) {
        assert.equal(pipelineRunNodeStatusForRun(runStatus), expected);
    }
});

test('UNKNOWN finalization preserves confirmed node outcomes and closes active nodes as UNKNOWN', () => {
    const endedAt = '2026-09-27T12:00:00.000Z';
    const activeNode = {
        lastUpdatedAt: '2026-09-27T11:59:00.000Z',
        qualifiedName: 'sales.active',
        startedAt: '2026-09-27T11:58:00.000Z',
        status: PipelineRunNodeStatus.RUNNING,
    };
    const completedNode = {
        completedAt: '2026-09-27T11:59:30.000Z',
        lastUpdatedAt: '2026-09-27T11:59:30.000Z',
        qualifiedName: 'sales.completed',
        status: PipelineRunNodeStatus.COMPLETED,
    };

    const normalized = normalizeTerminalNodeStatuses(RunStatus.UNKNOWN, {
        active: activeNode,
        completed: completedNode,
    }, endedAt);

    assert.equal(normalized.active?.status, 'UNKNOWN');
    assert.equal(normalized.active?.completedAt, endedAt);
    assert.equal(normalized.active?.startedAt, activeNode.startedAt);
    assert.equal(normalized.completed, completedNode);
});

test('all terminal run outcomes map to their audit events and presentation states', () => {
    const terminalCases: Array<{
        audit: string;
        expectedPresentation: StatusPresentationState;
        label: string;
        status: TerminalRunStatus;
    }> = [
        { audit: 'RUN_SUCCEEDED', expectedPresentation: 'succeeded', label: 'Completed', status: RunStatus.SUCCEEDED },
        { audit: 'RUN_FAILED', expectedPresentation: 'failed', label: 'Failed', status: RunStatus.FAILED },
        { audit: 'RUN_CANCELED', expectedPresentation: 'unknown', label: 'Canceled', status: RunStatus.CANCELED },
        { audit: 'RUN_TIMED_OUT', expectedPresentation: 'failed', label: 'Timed Out', status: RunStatus.TIMED_OUT },
        { audit: 'RUN_OUTCOME_UNKNOWN', expectedPresentation: 'unknown', label: 'Outcome Unknown', status: RunStatus.UNKNOWN },
    ];

    for (const scenario of terminalCases) {
        assert.equal(auditEventTypeForRunStatus(scenario.status), scenario.audit);
        assert.equal(statusPresentationForRunStatus(scenario.status), scenario.expectedPresentation);
        assert.equal(statusPresentationForPipelineState(scenario.status),
            scenario.status === RunStatus.CANCELED ? 'canceled' : scenario.expectedPresentation);
    }
});

test('pipeline lifecycle presentation maps known run, node, and CLI states exhaustively', () => {
    const mappings: Array<[string, StatusPresentationState]> = [
        [RunStatus.QUEUED, 'waiting'],
        [RunStatus.SUBMITTING, 'running'],
        [RunStatus.RUNNING, 'running'],
        [RunStatus.SUCCEEDED, 'succeeded'],
        [RunStatus.FAILED, 'failed'],
        [RunStatus.CANCELED, 'canceled'],
        [RunStatus.TIMED_OUT, 'failed'],
        [RunStatus.UNKNOWN, 'unknown'],
        [PipelineRunNodeStatus.PLANNING, 'running'],
        [PipelineRunNodeStatus.STARTING, 'running'],
        [PipelineRunNodeStatus.RUNNING, 'running'],
        [PipelineRunNodeStatus.COMPLETED, 'succeeded'],
        [PipelineRunNodeStatus.FAILED, 'failed'],
        [PipelineRunNodeStatus.CANCELED, 'canceled'],
        [PipelineRunNodeStatus.UNKNOWN, 'unknown'],
        [CliExecutionState.STARTING, 'running'],
        [CliExecutionState.RUNNING, 'running'],
        [CliExecutionState.COMPLETED, 'succeeded'],
        [CliExecutionState.FAILED, 'failed'],
        [CliExecutionState.CANCELED, 'canceled'],
        [CliExecutionState.TIMED_OUT, 'failed'],
        [CliExecutionState.UNKNOWN, 'unknown'],
    ];

    for (const [status, expected] of mappings) {
        assert.equal(statusPresentationForPipelineState(status), expected, status);
    }
    assert.equal(statusPresentationForRunStatus(RunStatus.QUEUED), 'waiting');
    assert.equal(PIPELINE_RUN_STATUS_LABELS[RunStatus.QUEUED], 'Waiting for resources...');
    assert.equal(STATUS_PRESENTATION_LABELS.waiting, 'Waiting for resources...');
    assert.equal(statusPresentationForPipelineNodeStatus(
        PipelineRunNodeStatus.QUEUED,
        RunStatus.QUEUED,
    ), undefined);
    assert.equal(statusPresentationForPipelineNodeStatus(
        PipelineRunNodeStatus.QUEUED,
        RunStatus.RUNNING,
    ), undefined);
    assert.equal(statusPresentationForPipelineNodeStatus(undefined, RunStatus.QUEUED), undefined);
    for (const status of [undefined, null, '', '  ', 'INACTIVE', 'UNSUCCESSFUL', 'NOT_A_STATUS']) {
        assert.equal(statusPresentationForPipelineState(status), 'unknown');
    }
    assert.equal(STATUS_PRESENTATION_LABELS.unknown, 'Unknown');
    assert.equal(STATUS_PRESENTATION_LABELS.canceled, 'Canceled');
});

test('legacy canceled runs present unfinished failed node records as canceled', () => {
    assert.equal(
        statusPresentationForPipelineNodeStatus(
            PipelineRunNodeStatus.FAILED,
            RunStatus.CANCELED,
        ),
        'canceled',
    );
    assert.equal(
        statusPresentationForPipelineNodeStatus(
            PipelineRunNodeStatus.FAILED,
            RunStatus.CANCELED,
            '2026-09-28T20:09:00.000Z',
        ),
        'failed',
    );
    assert.equal(
        statusPresentationForPipelineNodeStatus(
            PipelineRunNodeStatus.FAILED,
            RunStatus.FAILED,
        ),
        'failed',
    );
});

test('asset flow aggregation handles empty, absent, unknown, active, and terminal inputs', () => {
    const cases: Array<{
        expected: StatusPresentationState | undefined;
        name: string;
        statuses: Array<StatusPresentationState | undefined>;
    }> = [
        { expected: undefined, name: 'no incoming flows', statuses: [] },
        { expected: undefined, name: 'only absent flow states', statuses: [undefined, undefined] },
        { expected: undefined, name: 'success mixed with an absent state', statuses: ['succeeded', undefined] },
        { expected: 'succeeded', name: 'all flows succeeded', statuses: ['succeeded', 'succeeded'] },
        { expected: 'canceled', name: 'canceled flow takes precedence over success', statuses: ['succeeded', 'canceled'] },
        { expected: 'waiting', name: 'waiting flow takes precedence over success', statuses: ['succeeded', 'waiting'] },
        { expected: 'waiting', name: 'waiting flow takes precedence over active flow', statuses: ['unknown', 'running', 'waiting'] },
        { expected: 'running', name: 'active flow takes precedence over success', statuses: ['succeeded', 'running'] },
        { expected: 'running', name: 'active flow takes precedence over unknown', statuses: ['unknown', 'running'] },
        { expected: 'failed', name: 'failure takes precedence over active flow', statuses: ['running', 'failed'] },
        { expected: 'failed', name: 'failure takes precedence over cancellation', statuses: ['canceled', 'failed'] },
        { expected: 'failed', name: 'failure takes precedence over unknown', statuses: ['unknown', 'failed'] },
        { expected: 'unknown', name: 'explicit unknown remains visible', statuses: ['unknown'] },
        { expected: 'unknown', name: 'unknown mixed with success remains uncertain', statuses: ['succeeded', 'unknown'] },
    ];

    for (const scenario of cases) {
        assert.equal(
            pipelineAssetStateForIncomingFlows(scenario.statuses),
            scenario.expected,
            scenario.name,
        );
    }
});

test('Spark presentation recognizes exact normalized statuses and rejects substring lookalikes', () => {
    const cases: Array<[string, StatusPresentationState]> = [
        ['RUNNING', 'running'],
        [' active ', 'running'],
        ['PENDING', 'running'],
        ['SUCCEEDED', 'succeeded'],
        ['COMPLETE', 'succeeded'],
        ['completed', 'succeeded'],
        ['FAILED', 'failed'],
        ['KILLED', 'failed'],
        ['UNKNOWN', 'unknown'],
        ['SKIPPED', 'unknown'],
        ['INACTIVE', 'unknown'],
        ['UNSUCCESSFUL', 'unknown'],
        ['NOT_RUNNING_YET', 'unknown'],
    ];

    for (const [status, expected] of cases) {
        assert.equal(sparkStatusPresentationState(status), expected, status);
    }
});

test('failure copy rejects statuses that are not failed outcomes', () => {
    assert.equal(pipelineRunFailureTitle(RunStatus.UNKNOWN), 'Pipeline run outcome unknown');
    assert.equal(pipelineRunFailureMessage({ status: RunStatus.CANCELED }, 'jobs'),
        'Pipeline run was canceled.');
    assert.equal(pipelineRunFailureMessage({ status: RunStatus.TIMED_OUT }, 'jobs'),
        'Pipeline run timed out.');
    assert.match(pipelineRunFailureMessage({ status: RunStatus.UNKNOWN }, 'registry'),
        /cannot verify whether Spark finished/);
    assert.throws(() => pipelineRunFailureTitle(RunStatus.SUCCEEDED), /no failure title/);
    assert.throws(() => pipelineRunFailureMessage({ status: RunStatus.RUNNING }, 'pipeline'),
        /not a failed outcome/);
});

test('trigger terminal and accepted groups retain their own vocabularies', () => {
    assert.deepEqual(new Set(FINAL_TRIGGER_DELIVERY_STATUSES), new Set([
        TriggerDeliveryStatus.ACCEPTED,
        TriggerDeliveryStatus.FAILED,
        TriggerDeliveryStatus.REPLAYED,
    ]));
    assert.equal(FINAL_TRIGGER_DELIVERY_STATUSES.includes(TriggerDeliveryStatus.PENDING), false);
    assert.deepEqual(new Set(ACCEPTED_TRIGGER_INGESTION_STATUSES), new Set([
        TriggerIngestionStatus.ACCEPTED,
        TriggerIngestionStatus.DEBOUNCED,
    ]));
});
