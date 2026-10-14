/**
 * @fileoverview Parses Spark flow lifecycle output into per-node run status records.
 */

import type {
    PipelineRunNodeStatusRecord,
} from '../../../shared/pipelineRegistryTypes.ts';
import { normalizePipelineNodeName } from '../../../shared/pipelineRegistryTypes.ts';
import {
    ACTIVE_PIPELINE_RUN_NODE_STATUSES,
    pipelineRunNodeStatusForRun,
    PipelineRunNodeStatus,
    STARTED_PIPELINE_RUN_NODE_STATUSES,
    TERMINAL_PIPELINE_RUN_NODE_EVENT_STATUSES,
} from '../../../shared/status/node.ts';
import type { TerminalRunStatus } from '../../../shared/status/run.ts';

const activeNodeStatusPattern = ACTIVE_PIPELINE_RUN_NODE_STATUSES.join('|');
const terminalNodeStatusPattern = TERMINAL_PIPELINE_RUN_NODE_EVENT_STATUSES.join('|');
const flowStatusLinePattern = new RegExp(
    String.raw`^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?):\s+Flow\s+(\S+)\s+(?:(?:is\s+(${activeNodeStatusPattern}))|(?:has\s+(${terminalNodeStatusPattern})(?:\s+[^.]+)?))\.`,
);
const MAX_INCOMPLETE_STATUS_LINE_LENGTH = 16_384;

/**
 * Parses Spark flow lifecycle lines into one current status per logical node.
 * Repeated flow names are normalized, and a later active event starts a new
 * attempt after a terminal status.
 */

export function parseRunNodeStatuses(
    stdout: string,
    terminalRunStatus: TerminalRunStatus,
): Record<string, PipelineRunNodeStatusRecord> {
    const parser = new IncrementalRunNodeStatusParser();
    parser.append(stdout);
    return parser.finish(terminalRunStatus);
}

/** Parses appended log chunks once while retaining the current node projection. */
export class IncrementalRunNodeStatusParser {
    private buffer = '';
    private readonly statuses = new Map<string, PipelineRunNodeStatusRecord>();
    private finished = false;

    constructor(initialOutput = '') {
        if (initialOutput !== '') {
            this.append(initialOutput);
        }
    }

    /** Adds one stdout or stderr chunk and parses only newly completed lines. */
    append(chunk: string): void {
        if (this.finished) {
            throw new Error('Run node status parser is already finalized.');
        }
        const lines = `${this.buffer}${chunk}`.split(/\r?\n/);
        this.buffer = lines.pop() ?? '';
        for (const line of lines) {
            applyRunNodeStatusLine(this.statuses, line);
        }
        if (this.buffer.length > MAX_INCOMPLETE_STATUS_LINE_LENGTH) {
            this.buffer = '';
        }
    }

    /** Returns the parsed node states without changing incomplete active rows. */
    snapshot(): Record<string, PipelineRunNodeStatusRecord> {
        return Object.fromEntries(this.statuses);
    }

    /** Flushes the final line and closes unfinished nodes after failure or cancellation. */
    finish(terminalRunStatus: TerminalRunStatus): Record<string, PipelineRunNodeStatusRecord> {
        if (!this.finished) {
            if (this.buffer.length <= MAX_INCOMPLETE_STATUS_LINE_LENGTH) {
                applyRunNodeStatusLine(this.statuses, this.buffer);
            }
            this.buffer = '';
            const terminalNodeStatus = pipelineRunNodeStatusForRun(terminalRunStatus);
            if (terminalNodeStatus === PipelineRunNodeStatus.FAILED ||
                terminalNodeStatus === PipelineRunNodeStatus.CANCELED) {
                markIncompleteRunNodeStatuses(this.statuses, terminalNodeStatus);
            }
            this.finished = true;
        }
        return this.snapshot();
    }
}

function applyRunNodeStatusLine(
    statuses: Map<string, PipelineRunNodeStatusRecord>,
    line: string,
): void {
    const match = line.match(flowStatusLinePattern);
    if (match == null) {
        return;
    }

    const timestamp = normalizeRunTimestamp(match[1]);
    const qualifiedName = normalizePipelineNodeName(match[2]);
    const status = (match[3] ?? match[4]) as PipelineRunNodeStatus;
    const current = statuses.get(qualifiedName);
    const startsRetry = current != null &&
        TERMINAL_PIPELINE_RUN_NODE_EVENT_STATUSES.includes(current.status) &&
        ACTIVE_PIPELINE_RUN_NODE_STATUSES.includes(status);
    const startedAt = startsRetry
        ? timestamp
        : current?.startedAt ??
            (STARTED_PIPELINE_RUN_NODE_STATUSES.includes(status) ? timestamp : undefined);
    const completedAt = TERMINAL_PIPELINE_RUN_NODE_EVENT_STATUSES.includes(status)
        ? timestamp
        : startsRetry
            ? undefined
            : current?.completedAt;

    statuses.set(qualifiedName, {
        completedAt,
        durationMs: durationMs(startedAt, completedAt),
        lastUpdatedAt: timestamp,
        qualifiedName,
        startedAt,
        status,
    });
}

function markIncompleteRunNodeStatuses(
    statuses: Map<string, PipelineRunNodeStatusRecord>,
    terminalNodeStatus: PipelineRunNodeStatus,
): void {
    for (const [qualifiedName, status] of statuses) {
        if (TERMINAL_PIPELINE_RUN_NODE_EVENT_STATUSES.includes(status.status)) {
            continue;
        }
        statuses.set(qualifiedName, {
            ...status,
            status: terminalNodeStatus,
        });
    }
}

function normalizeRunTimestamp(value: string): string {
    return new Date(value.replace(' ', 'T')).toISOString();
}

function durationMs(startedAt?: string, completedAt?: string): number | undefined {
    if (startedAt == null || completedAt == null) {
        return undefined;
    }

    return Math.max(0, Date.parse(completedAt) - Date.parse(startedAt));
}


