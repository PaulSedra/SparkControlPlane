/**
 * @fileoverview Regression coverage for verified per-run pipeline source snapshots.
 */

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { createPipelineFixture } from '../../../support/pipelineFixture.ts';
import { discoverPipelineAtPath } from '../../../../src/server/pipeline/discovery/pipelineDiscovery.ts';
import { createVerifiedPipelineExecutionSnapshot } from '../../../../src/server/pipeline/execution/pipelineExecutionSnapshot.ts';
import { pipelineProjectRoot } from '../../../../src/server/pipeline/execution/pipelineRuntime.ts';

test('execution continues from a verified snapshot after the mounted source changes', async () => {
    const originalSql = 'CREATE MATERIALIZED VIEW snapshot_view AS SELECT 1 AS value;\n';
    const fixture = await createPipelineFixture({
        files: [{ content: originalSql, relativePath: 'sql/example.sql' }],
        name: 'Snapshot Test',
        prefix: 'spark-control-plane-execution-snapshot-',
        specFilename: 'snapshot.pipeline.yaml',
    });
    const runId = crypto.randomUUID();
    const stateDirectory = path.join(fixture.root, 'run-state');

    try {
        const parsed = await discoverPipelineAtPath(fixture.specPath, new Map());
        const snapshot = await createVerifiedPipelineExecutionSnapshot(
            parsed,
            parsed.sourceHash,
            runId,
            stateDirectory,
        );
        const originalSourcePath = path.join(fixture.pipelineRoot, 'sql', 'example.sql');
        await fs.writeFile(
            originalSourcePath,
            'CREATE MATERIALIZED VIEW snapshot_view AS SELECT 2 AS value;\n',
            'utf8',
        );

        const snapshotRoot = pipelineProjectRoot(snapshot.detail.specPath);
        const snapshotSql = await fs.readFile(path.join(snapshotRoot, 'sql', 'example.sql'), 'utf8');
        const snapshotSpec = await fs.readFile(snapshot.detail.specPath, 'utf8');
        assert.equal(snapshotSql, originalSql);
        assert.equal(snapshot.sourceHash, parsed.sourceHash);
        assert.equal(snapshot.detail.spec.specPath, snapshot.detail.specPath);
        assert.ok(snapshotSpec.includes('Snapshot Test'));
    } finally {
        await fixture.cleanup();
    }
});

test('run staging stays on the saved source after mounted files change', async () => {
    const fixture = await createPipelineFixture({
        files: [{
            content: 'CREATE MATERIALIZED VIEW stale_view AS SELECT 1 AS value;\n',
            relativePath: 'sql/example.sql',
        }],
        name: 'Stale Snapshot Test',
        prefix: 'spark-control-plane-stale-snapshot-',
        specFilename: 'stale.pipeline.yaml',
    });
    const runId = crypto.randomUUID();
    const stateDirectory = path.join(fixture.root, 'run-state');

    try {
        const parsed = await discoverPipelineAtPath(fixture.specPath, new Map());
        await fixture.writeFile(
            'sql/example.sql',
            'CREATE MATERIALIZED VIEW stale_view AS SELECT 2 AS value;\n',
        );

        const snapshot = await createVerifiedPipelineExecutionSnapshot(
            parsed,
            parsed.sourceHash,
            runId,
            stateDirectory,
        );
        const snapshotRoot = pipelineProjectRoot(snapshot.detail.specPath);
        assert.equal(
            await fs.readFile(path.join(snapshotRoot, 'sql', 'example.sql'), 'utf8'),
            'CREATE MATERIALIZED VIEW stale_view AS SELECT 1 AS value;\n',
        );
    } finally {
        await fixture.cleanup();
    }
});
