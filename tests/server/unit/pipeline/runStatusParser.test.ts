/**
 * @fileoverview Regression coverage for incremental Spark flow status parsing.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { RunStatus } from '../../../../src/shared/status/run.ts';
import { IncrementalRunNodeStatusParser } from '../../../../src/server/pipeline/execution/runStatusParser.ts';

test('buffers incomplete status lines across log chunks and flushes the final line', () => {
    const parser = new IncrementalRunNodeStatusParser();
    parser.append('2026-09-27 10:00:00: Flow bronze.orders is RU');

    assert.deepEqual(parser.snapshot(), {});

    parser.append('NNING.\r\n2026-09-27 10:00:05: Flow bronze.orders has COMPLETED.');
    const statuses = parser.finish(RunStatus.SUCCEEDED);

    assert.equal(statuses['bronze.orders']?.status, 'COMPLETED');
    assert.equal(statuses['bronze.orders']?.startedAt, new Date('2026-09-27T10:00:00').toISOString());
    assert.equal(statuses['bronze.orders']?.completedAt, new Date('2026-09-27T10:00:05').toISOString());
});

test('parses a large stream linearly and marks unfinished nodes failed at run end', () => {
    const parser = new IncrementalRunNodeStatusParser();
    const noiseChunk = 'ordinary pipeline output\n'.repeat(100_000);
    parser.append(noiseChunk);
    parser.append('2026-09-27 10:00:00: Flow bronze.pending is RUNNING.');

    const statuses = parser.finish(RunStatus.FAILED);
    assert.equal(statuses['bronze.pending']?.status, 'FAILED');
    assert.equal(statuses['bronze.pending']?.startedAt, new Date('2026-09-27T10:00:00').toISOString());
});

test('canceled runs cancel unfinished nodes and preserve emitted terminal outcomes', () => {
    const parser = new IncrementalRunNodeStatusParser();
    parser.append([
        '2026-09-27 10:00:00: Flow bronze.completed is RUNNING.',
        '2026-09-27 10:00:05: Flow bronze.completed has COMPLETED.',
        '2026-09-27 10:00:06: Flow bronze.failed is RUNNING.',
        '2026-09-27 10:00:07: Flow bronze.failed has FAILED.',
        '2026-09-27 10:00:08: Flow bronze.pending is RUNNING.',
    ].join('\n'));

    const statuses = parser.finish(RunStatus.CANCELED);

    assert.equal(statuses['bronze.completed']?.status, 'COMPLETED');
    assert.equal(statuses['bronze.failed']?.status, 'FAILED');
    assert.equal(statuses['bronze.pending']?.status, 'CANCELED');
});

test('uses the final failed flow event when Spark appends a retry-exhaustion explanation', () => {
    const parser = new IncrementalRunNodeStatusParser();
    parser.append([
        '2026-09-30 20:00:00: Flow \'sample_catalog.silver.measurements\' is RUNNING.',
        '2026-09-30 20:00:01: Flow \'sample_catalog.silver.measurements\' has COMPLETED.',
        '2026-09-30 20:00:02: Flow \'sample_catalog.silver.measurements\' has FAILED more than 2 times and will not be restarted.',
    ].join('\n'));

    const statuses = parser.finish(RunStatus.FAILED);
    const status = statuses['sample_catalog.silver.measurements'];

    assert.equal(status?.status, 'FAILED');
    assert.equal(status?.startedAt, new Date('2026-09-30T20:00:00').toISOString());
    assert.equal(status?.completedAt, new Date('2026-09-30T20:00:02').toISOString());
    assert.equal(status?.lastUpdatedAt, new Date('2026-09-30T20:00:02').toISOString());
});
