/**
 * @fileoverview PostgreSQL integration coverage for atomic success handoffs.
 */

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import { Pool } from 'pg';
import { loadPostgresConfig } from '../../../src/server/config/postgresConfig.ts';
import { createPostgresPersistence } from '../../../src/server/persistence/postgresPersistence.ts';
import type {
    ControlPlanePersistence,
    DiscoveredPipeline,
    PersistedPipeline,
    PersistedRunSubmission,
} from '../../../src/server/types/pipelinePersistenceTypes.ts';
import {
    isLivePostgresTestEnabled,
    postgresPoolConfig,
} from '../../support/postgresTestSupport.ts';

test('PostgreSQL commits terminal success and a durable handoff atomically', {
    skip: !isLivePostgresTestEnabled(),
}, async () => {
    const config = loadPostgresConfig();
    const schema = `spark_control_plane_success_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
    const pool = new Pool(postgresPoolConfig(config, schema, false));
    const persistence = createPostgresPersistence({ ...config, schema }, { pool });

    try {
        await persistence.initialize();
        const source = await preparePipeline(persistence, `example-silver-${crypto.randomUUID()}`);
        const target = await preparePipeline(persistence, `example-gold-${crypto.randomUUID()}`);
        const parentRequest = parentSubmission(source, target, `parent-${crypto.randomUUID()}`);
        const parent = await persistence.submitRun(parentRequest);
        const parentReplay = await persistence.submitRun(parentRequest);
        assert.equal(parentReplay.replayed, true);
        assert.equal(parentReplay.run.runId, parent.run.runId);

        const claim = await persistence.claimNextQueuedRun('success-dependency-test', 5_000);
        assert.ok(claim);
        assert.equal(claim.run.runId, parent.run.runId);
        await pool.query(`
            CREATE FUNCTION fail_success_dependency_ready() RETURNS trigger
            LANGUAGE plpgsql AS $$
            BEGIN
                IF NEW.status = 'READY' THEN
                    RAISE EXCEPTION 'injected dependency transition failure';
                END IF;
                RETURN NEW;
            END;
            $$
        `);
        await pool.query(`
            CREATE TRIGGER fail_success_dependency_ready
            BEFORE UPDATE ON pipeline_run_success_dependencies
            FOR EACH ROW EXECUTE FUNCTION fail_success_dependency_ready()
        `);
        await assert.rejects(
            () => persistence.completeRun(parent.run.runId, claim.lease, successfulCompletion()),
            /injected dependency transition failure/,
        );

        assert.equal((await persistence.getRun(parent.run.runId))?.status, 'SUBMITTING');
        const waiting = await pool.query<{ status: string }>(
            'SELECT status FROM pipeline_run_success_dependencies WHERE source_run_id = $1',
            [parent.run.runId],
        );
        assert.equal(waiting.rows[0]?.status, 'WAITING');

        await pool.query('DROP TRIGGER fail_success_dependency_ready ON pipeline_run_success_dependencies');
        await pool.query('DROP FUNCTION fail_success_dependency_ready()');
        const completed = await persistence.completeRun(parent.run.runId, claim.lease, successfulCompletion());
        assert.equal(completed.run?.status, 'SUCCEEDED');

        const ready = await pool.query<{
            run_status: string;
            source_status: string;
            target_pipeline_id: string;
        }>(
            `
                SELECT runs.status AS run_status,
                       pipeline_run_success_dependencies.status AS source_status,
                       pipeline_run_success_dependencies.target_pipeline_id
                FROM runs
                JOIN pipeline_run_success_dependencies
                  ON pipeline_run_success_dependencies.source_run_id = runs.run_id
                WHERE runs.run_id = $1
            `,
            [parent.run.runId],
        );
        assert.deepEqual(ready.rows[0], {
            run_status: 'SUCCEEDED',
            source_status: 'READY',
            target_pipeline_id: target.id,
        });

        const childKey = `pipeline-success:${parent.run.runId}:${target.id}`;
        const child = await persistence.submitRun(childSubmission(target, childKey));
        const duplicateChild = await persistence.submitRun(childSubmission(target, childKey));
        assert.equal(duplicateChild.replayed, true);
        assert.equal(duplicateChild.run.runId, child.run.runId);
        assert.equal(await persistence.getRunByIdempotencyKey(childKey).then((run) => run?.runId), child.run.runId);
        await persistence.markRunSuccessDependencySubmitted(parent.run.runId, child.run.runId);
        await persistence.markRunSuccessDependencySubmitted(parent.run.runId, child.run.runId);

        const submitted = await pool.query<{ status: string; target_run_id: string }>(
            'SELECT status, target_run_id FROM pipeline_run_success_dependencies WHERE source_run_id = $1',
            [parent.run.runId],
        );
        assert.deepEqual(submitted.rows[0], {
            status: 'SUBMITTED',
            target_run_id: child.run.runId,
        });

        const canceledParent = await persistence.submitRun(
            parentSubmission(source, target, `cancel-${crypto.randomUUID()}`),
        );
        const canceled = await persistence.cancelRun(canceledParent.run.runId, 'test', 'queued cancellation');
        assert.equal(canceled.status, 'CANCELED');
        const skipped = await pool.query<{ status: string }>(
            'SELECT status FROM pipeline_run_success_dependencies WHERE source_run_id = $1',
            [canceledParent.run.runId],
        );
        assert.equal(skipped.rows[0]?.status, 'SKIPPED');
    } finally {
        await persistence.shutdown();
        await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
        await pool.end();
    }
});

async function preparePipeline(
    persistence: ControlPlanePersistence,
    name: string,
): Promise<PersistedPipeline> {
    const discovered = discoveredPipeline(name);
    const pipeline = await persistence.ensurePipeline(discovered);
    await persistence.saveDeployment({
        deployedAt: new Date().toISOString(),
        pipelineId: pipeline.id,
        sourceHash: discovered.sourceHash,
        status: 'DEPLOYED',
        validationMessages: [],
        versionId: discovered.versionId,
    });
    return pipeline;
}

function discoveredPipeline(name: string): DiscoveredPipeline {
    const id = crypto.randomUUID();
    return {
        edges: [],
        name,
        nodes: [],
        sourceFiles: [],
        sourceHash: `hash-${id}`,
        spec: {
            libraries: [],
            name,
            specPath: `C:\\test\\${id}\\resources\\${id}.pipeline.yaml`,
            storage: 's3a://warehouse/',
        },
        specPath: `C:\\test\\${id}\\resources\\${id}.pipeline.yaml`,
        validationMessages: [],
        versionId: `v-${id}`,
    };
}

function parentSubmission(
    source: PersistedPipeline,
    target: PersistedPipeline,
    idempotencyKey: string,
): PersistedRunSubmission {
    return {
        idempotencyKey,
        mode: 'incremental',
        pipelineId: source.id,
        sourceHash: source.currentSourceHash,
        sparkAppName: source.name,
        successorPipelineId: target.id,
        versionId: source.currentVersionId,
    };
}

function childSubmission(
    target: PersistedPipeline,
    idempotencyKey: string,
): PersistedRunSubmission {
    return {
        idempotencyKey,
        mode: 'incremental',
        pipelineId: target.id,
        sourceHash: target.currentSourceHash,
        sparkAppName: target.name,
        versionId: target.currentVersionId,
    };
}

function successfulCompletion() {
    return {
        command: ['spark-pipelines', 'run'],
        endedAt: new Date().toISOString(),
        exitCode: 0,
        stderr: '',
        stdout: '',
        status: 'SUCCEEDED' as const,
    };
}
