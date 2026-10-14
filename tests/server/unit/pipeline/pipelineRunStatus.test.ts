/**
 * @fileoverview Regression coverage for Spark flow lifecycle parsing and retry identity.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { RunStatus } from '../../../../src/shared/status/run.ts';
import { parseRunNodeStatuses } from '../../../../src/server/pipeline/execution/runStatusParser.ts';

test('normalizes quoted flow names and keeps a retry active', () => {
    const statuses = parseRunNodeStatuses([
        '2026-09-21 22:00:00: Flow sample_catalog.silver.append_events_root is RUNNING.',
        "2026-09-21 22:00:05: Flow 'sample_catalog.silver.append_events_root' has FAILED.",
        '2026-09-21 22:00:06: Flow sample_catalog.silver.append_events_root is RUNNING.',
    ].join('\n'), RunStatus.SUCCEEDED);

    assert.deepEqual(Object.keys(statuses), ['sample_catalog.silver.append_events_root']);
    assert.equal(statuses['sample_catalog.silver.append_events_root']?.status, 'RUNNING');
    assert.equal(
        statuses['sample_catalog.silver.append_events_root']?.startedAt,
        statuses['sample_catalog.silver.append_events_root']?.lastUpdatedAt,
    );
    assert.equal(statuses['sample_catalog.silver.append_events_root']?.completedAt, undefined);
});

test('keeps a terminal quoted failure red when no retry follows', () => {
    const statuses = parseRunNodeStatuses(
        "2026-09-21 22:00:05: Flow 'sample_catalog.silver.append_events_root' has FAILED.",
        RunStatus.SUCCEEDED,
    );

    assert.equal(statuses['sample_catalog.silver.append_events_root']?.status, 'FAILED');
    assert.equal(statuses["'sample_catalog.silver.append_events_root'"], undefined);
});
