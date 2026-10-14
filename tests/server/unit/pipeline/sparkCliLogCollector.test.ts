/**
 * @fileoverview Regression coverage for bounded incremental CLI log collection.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { SparkCliLogCollector } from '../../../../src/server/pipeline/spark/sparkCliLogCollector.ts';

test('collects large stdout and stderr streams once with their byte offsets', () => {
    const collector = new SparkCliLogCollector();
    const stdout = Buffer.from('stdout line\n'.repeat(100_000));
    const stderr = Buffer.from('stderr line\n'.repeat(100_000));
    const snapshot = collector.append(stdout, stderr, stdout.length, stderr.length);

    assert.equal(snapshot.stdout, stdout.toString('utf8'));
    assert.equal(snapshot.stderr, stderr.toString('utf8'));
    assert.equal(snapshot.stdoutOffset, stdout.length);
    assert.equal(snapshot.stderrOffset, stderr.length);
});

test('rereads and joins an incomplete UTF-8 tail without duplicating bytes', () => {
    const collector = new SparkCliLogCollector();
    const completeOutput = Buffer.from('event before emoji 🌍\n');
    const firstChunk = completeOutput.subarray(0, completeOutput.length - 2);
    const first = collector.append(firstChunk, Buffer.alloc(0), firstChunk.length, 0);

    assert.equal(first.stdout, 'event before emoji ');
    assert.equal(first.stdoutOffset, firstChunk.length - 3);

    const rereadChunk = completeOutput.subarray(first.stdoutOffset);
    const second = collector.append(
        rereadChunk,
        Buffer.alloc(0),
        completeOutput.length,
        0,
    );

    assert.equal(second.stdout, 'event before emoji 🌍\n');
    assert.equal(second.stdoutChunk, '🌍\n');
    assert.equal(second.stdoutOffset, completeOutput.length);
});

test('flushes a truncated final byte sequence only after terminal EOF', () => {
    const collector = new SparkCliLogCollector();
    const incompleteBytes = Buffer.from([0xe2, 0x82]);
    const appended = collector.append(incompleteBytes, Buffer.alloc(0), incompleteBytes.length, 0);

    assert.equal(appended.stdout, '');
    assert.equal(appended.stdoutOffset, 0);

    const finished = collector.finish();
    assert.equal(finished.stdout, '�');
    assert.equal(finished.stdoutOffset, incompleteBytes.length);
});
