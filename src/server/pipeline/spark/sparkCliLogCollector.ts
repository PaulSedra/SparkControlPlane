/**
 * @fileoverview Collects byte-offset CLI logs without losing split UTF-8 characters.
 */

/** Incremental and cumulative output delivered with one supervisor snapshot. */
export interface CliLogUpdate {
    stderr: string;
    stderrChunk?: string;
    stdout: string;
    stdoutChunk?: string;
}

/** Output and durable byte cursors after collecting one supervisor response. */
export interface CliLogSnapshot extends CliLogUpdate {
    stderrOffset: number;
    stdoutOffset: number;
}

interface LogStreamState {
    pending: Buffer;
    rawOffset: number;
    text: string;
    textOffset: number;
}

/**
 * Appends supervisor byte chunks once and keeps cursors at complete UTF-8
 * boundaries. A later inspect can safely reread an incomplete tail after a
 * worker restart because that tail's bytes are not yet committed as consumed.
 */
export class SparkCliLogCollector {
    private readonly stderrState: LogStreamState;
    private readonly stdoutState: LogStreamState;

    constructor(
        stdout = '',
        stderr = '',
        stdoutOffset = 0,
        stderrOffset = 0,
    ) {
        this.stdoutState = createStreamState(stdout, stdoutOffset);
        this.stderrState = createStreamState(stderr, stderrOffset);
    }

    get stdoutOffset(): number {
        return this.stdoutState.textOffset;
    }

    get stderrOffset(): number {
        return this.stderrState.textOffset;
    }

    /** Appends newly inspected bytes and returns both chunk and cumulative text. */
    append(
        stdoutBytes: Buffer,
        stderrBytes: Buffer,
        stdoutOffset: number,
        stderrOffset: number,
    ): CliLogSnapshot {
        const stdoutChunk = appendStream(this.stdoutState, stdoutBytes, stdoutOffset);
        const stderrChunk = appendStream(this.stderrState, stderrBytes, stderrOffset);
        return this.snapshot(stdoutChunk, stderrChunk);
    }

    /** Flushes an incomplete final UTF-8 sequence after the supervisor confirms EOF. */
    finish(): CliLogSnapshot {
        const stdoutChunk = flushStream(this.stdoutState);
        const stderrChunk = flushStream(this.stderrState);
        return this.snapshot(stdoutChunk, stderrChunk);
    }

    private snapshot(stdoutChunk: string, stderrChunk: string): CliLogSnapshot {
        return {
            stderr: this.stderrState.text,
            stderrChunk,
            stderrOffset: this.stderrState.textOffset,
            stdout: this.stdoutState.text,
            stdoutChunk,
            stdoutOffset: this.stdoutState.textOffset,
        };
    }
}

function createStreamState(text: string, offset: number): LogStreamState {
    const safeOffset = Math.max(0, offset);
    return {
        pending: Buffer.alloc(0),
        rawOffset: safeOffset,
        text,
        textOffset: safeOffset,
    };
}

function appendStream(state: LogStreamState, bytes: Buffer, rawOffset: number): string {
    let appendedBytes = bytes;
    if (state.pending.length > 0 &&
        bytes.length >= state.pending.length &&
        bytes.subarray(0, state.pending.length).equals(state.pending)) {
        appendedBytes = bytes.subarray(state.pending.length);
    }
    const combined = state.pending.length === 0
        ? appendedBytes
        : Buffer.concat([state.pending, appendedBytes]);
    const completeLength = completeUtf8PrefixLength(combined);
    const completeBytes = combined.subarray(0, completeLength);
    state.pending = combined.subarray(completeLength);
    state.rawOffset = Math.max(state.rawOffset, Math.max(0, rawOffset));
    state.textOffset = Math.max(state.textOffset, state.rawOffset - state.pending.length);
    const text = completeBytes.toString('utf8');
    state.text += text;
    return text;
}

function flushStream(state: LogStreamState): string {
    const text = state.pending.toString('utf8');
    state.text += text;
    state.pending = Buffer.alloc(0);
    state.textOffset = Math.max(state.textOffset, state.rawOffset);
    return text;
}

function completeUtf8PrefixLength(bytes: Buffer): number {
    let start = bytes.length - 1;
    let continuationCount = 0;
    while (start >= 0 &&
        continuationCount < 3 &&
        (bytes[start]! & 0xc0) === 0x80) {
        continuationCount += 1;
        start -= 1;
    }
    if (start < 0) {
        return bytes.length;
    }

    const leadingByte = bytes[start]!;
    const expectedLength = leadingByte <= 0x7f
        ? 1
        : (leadingByte & 0xe0) === 0xc0
            ? 2
            : (leadingByte & 0xf0) === 0xe0
                ? 3
                : (leadingByte & 0xf8) === 0xf0
                    ? 4
                    : 1;
    const presentLength = bytes.length - start;
    return expectedLength > presentLength ? start : bytes.length;
}
