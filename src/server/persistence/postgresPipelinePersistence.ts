/**
 * @fileoverview PostgreSQL persistence for pipeline identities, source
 * versions, and deployments.
 */

import crypto from 'node:crypto';
import type { Pool, QueryResultRow } from 'pg';
import type {
    DiscoveredPipeline,
    PipelineDeployment,
    PipelinePersistence,
    PersistedPipeline,
    PersistedPipelineSnapshot,
    AuditContext,
} from '../types/pipelinePersistenceTypes.ts';
import type { PipelineEdge, PipelineNode, PipelineSpec } from '../../shared/pipelineRegistryTypes.ts';
import type { TriggerDefinitionInput } from '../types/triggerTypes.ts';
import { insertAuditEvent } from './postgresAuditPersistence.ts';
import { dateString, normalizeName } from './postgresPersistenceUtils.ts';

interface PipelineRow extends QueryResultRow {
    active: boolean;
    allow_overlap: boolean;
    created_at: Date | string;
    current_source_hash: string;
    current_version_id: string;
    display_name: string;
    id: string;
    normalized_name: string;
    spec_path: string;
    timeout_seconds: number | null;
    updated_at: Date | string;
}

interface PipelineSnapshotRow extends QueryResultRow {
    created_at: Date | string;
    current_allow_overlap: boolean;
    current_timeout_seconds: number | null;
    edges_json: PipelineEdge[];
    name: string;
    nodes_json: PipelineNode[];
    pipeline_id: string;
    policy_json: PersistedPipeline['policy'] | null;
    spec_content: string | null;
    spec_json: PipelineSpec;
    spec_path: string;
    source_contents: Array<{ content: string; sourceFile: string }>;
    source_files: string[];
    source_hash: string;
    validation_messages: string[];
    version_id: string;
    yaml_trigger_definitions: Array<Omit<TriggerDefinitionInput, 'pipelineId'>>;
}

interface DeploymentRow extends QueryResultRow {
    deployed_at: Date | string;
    pipeline_id: string;
    source_hash: string;
    status: PipelineDeployment['status'];
    validation_messages: string[];
    version_id: string;
}

/**
 * Binds pipeline identity, source-version, and deployment operations to one
 * PostgreSQL pool.
 *
 * Pipeline names are normalized for identity while display names and source
 * versions remain durable, allowing repeated discovery to update the current
 * pointer without duplicating an unchanged source version.
 */
export function createPostgresPipelinePersistence(pool: Pool): PipelinePersistence {
    return {
        deactivatePipelinesNotIn: (pipelineIds) => deactivatePipelinesNotIn(pool, pipelineIds),
        ensurePipeline: (discovered) => ensurePipeline(pool, discovered),
        getLatestDeployment: (pipelineId) => getLatestDeployment(pool, pipelineId),
        getPipelineSnapshot: (pipelineId, versionId) =>
            getPipelineSnapshot(pool, pipelineId, versionId),
        getPersistedPipeline: (pipelineId) => getPersistedPipeline(pool, pipelineId),
        listCurrentPipelineSnapshots: () => listCurrentPipelineSnapshots(pool),
        saveDeployment: (deployment, context) => saveDeployment(pool, deployment, context),
    };
}

async function ensurePipeline(
    pool: Pool,
    discovered: DiscoveredPipeline,
): Promise<PersistedPipeline> {
    const client = await pool.connect();
    const pipelineId = crypto.randomUUID();
    const now = new Date().toISOString();
    try {
        await client.query('BEGIN');
        const pipelineResult = await client.query<PipelineRow>(
            `
                INSERT INTO pipelines (
                    id, normalized_name, display_name, spec_path,
                    current_source_hash, current_version_id, created_at, updated_at,
                    allow_overlap, timeout_seconds, active
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $7, $8, $9, TRUE)
                ON CONFLICT (normalized_name) DO UPDATE SET
                    display_name = EXCLUDED.display_name,
                    spec_path = EXCLUDED.spec_path,
                    current_source_hash = EXCLUDED.current_source_hash,
                    current_version_id = EXCLUDED.current_version_id,
                    allow_overlap = EXCLUDED.allow_overlap,
                    timeout_seconds = EXCLUDED.timeout_seconds,
                    active = TRUE,
                    updated_at = EXCLUDED.updated_at
                RETURNING *
            `,
            [
                pipelineId,
                normalizeName(discovered.name),
                discovered.name,
                discovered.specPath,
                discovered.sourceHash,
                discovered.versionId,
                now,
                discovered.policy?.allowOverlap ?? false,
                discovered.policy?.timeoutSeconds ?? null,
            ],
        );
        const pipeline = pipelineResult.rows[0];
        if (pipeline == null) {
            throw new Error('PostgreSQL did not return the pipeline identity.');
        }

        await client.query(
            `
                INSERT INTO source_versions (
                    pipeline_id, version_id, source_hash, spec_path, spec_json,
                    source_files, nodes_json, edges_json, validation_messages, created_at,
                    spec_content, source_contents, yaml_trigger_definitions, policy_json
                ) VALUES (
                    $1, $2, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb, $8::jsonb,
                    $9::jsonb, $10, $11, $12::jsonb, $13::jsonb, $14::jsonb
                )
                ON CONFLICT (pipeline_id, source_hash) DO UPDATE SET
                    spec_path = EXCLUDED.spec_path,
                    spec_json = EXCLUDED.spec_json,
                    source_files = EXCLUDED.source_files,
                    nodes_json = EXCLUDED.nodes_json,
                    edges_json = EXCLUDED.edges_json,
                    validation_messages = EXCLUDED.validation_messages,
                    spec_content = EXCLUDED.spec_content,
                    source_contents = EXCLUDED.source_contents,
                    yaml_trigger_definitions = EXCLUDED.yaml_trigger_definitions,
                    policy_json = EXCLUDED.policy_json
            `,
            [
                pipeline.id,
                discovered.versionId,
                discovered.sourceHash,
                discovered.specPath,
                JSON.stringify(discovered.spec),
                JSON.stringify(discovered.sourceFiles),
                JSON.stringify(discovered.nodes),
                JSON.stringify(discovered.edges),
                JSON.stringify(discovered.validationMessages),
                now,
                discovered.specContent ?? null,
                JSON.stringify(discovered.sourceContents ?? []),
                JSON.stringify(discovered.yamlTriggerDefinitions ?? []),
                discovered.policy == null ? null : JSON.stringify(discovered.policy),
            ],
        );
        const sourceVersionResult = await client.query<{ version_id: string }>(
            `
                SELECT version_id
                FROM source_versions
                WHERE pipeline_id = $1 AND source_hash = $2
            `,
            [pipeline.id, discovered.sourceHash],
        );
        const currentVersionId = sourceVersionResult.rows[0]?.version_id;
        if (currentVersionId == null) {
            throw new Error('PostgreSQL did not return the current source version.');
        }
        const currentPipelineResult = await client.query<PipelineRow>(
            `
                UPDATE pipelines
                SET current_source_hash = $2, current_version_id = $3, updated_at = $4
                WHERE id = $1
                RETURNING *
            `,
            [pipeline.id, discovered.sourceHash, currentVersionId, now],
        );
        const currentPipeline = currentPipelineResult.rows[0];
        if (currentPipeline == null) {
            throw new Error('PostgreSQL did not return the updated pipeline identity.');
        }
        await client.query('COMMIT');
        return mapPipeline(currentPipeline);
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }
}

async function deactivatePipelinesNotIn(
    pool: Pool,
    pipelineIds: string[],
): Promise<string[]> {
    const result = await pool.query<{ id: string }>(
        `
            UPDATE pipelines
            SET active = FALSE, updated_at = NOW()
            WHERE active = TRUE AND NOT (id = ANY($1::uuid[]))
            RETURNING id
        `,
        [pipelineIds],
    );
    return result.rows.map((row) => row.id);
}

async function getPipelineSnapshot(
    pool: Pool,
    pipelineId: string,
    versionId?: string,
): Promise<PersistedPipelineSnapshot | undefined> {
    const result = await pool.query<PipelineSnapshotRow>(
        `
            SELECT p.id AS pipeline_id, p.display_name AS name,
                p.allow_overlap AS current_allow_overlap,
                p.timeout_seconds AS current_timeout_seconds,
                s.version_id, s.source_hash, s.spec_path, s.spec_json,
                s.source_files, s.nodes_json, s.edges_json, s.validation_messages,
                s.created_at, s.spec_content, s.source_contents,
                s.yaml_trigger_definitions, s.policy_json
            FROM pipelines p
            JOIN source_versions s ON s.pipeline_id = p.id
            WHERE p.id = $1
                AND ($2::text IS NULL AND p.active = TRUE OR s.version_id = $2)
                AND ($2::text IS NOT NULL OR s.version_id = p.current_version_id)
        `,
        [pipelineId, versionId ?? null],
    );
    const row = result.rows[0];
    return row == null ? undefined : mapPipelineSnapshot(row);
}

async function listCurrentPipelineSnapshots(
    pool: Pool,
): Promise<PersistedPipelineSnapshot[]> {
    const result = await pool.query<PipelineSnapshotRow>(
        `
            SELECT p.id AS pipeline_id, p.display_name AS name,
                p.allow_overlap AS current_allow_overlap,
                p.timeout_seconds AS current_timeout_seconds,
                s.version_id, s.source_hash, s.spec_path, s.spec_json,
                s.source_files, s.nodes_json, s.edges_json, s.validation_messages,
                s.created_at, s.spec_content, s.source_contents,
                s.yaml_trigger_definitions, s.policy_json
            FROM pipelines p
            JOIN source_versions s
                ON s.pipeline_id = p.id AND s.version_id = p.current_version_id
            WHERE p.active = TRUE
            ORDER BY p.display_name, p.id
        `,
    );
    return result.rows.map(mapPipelineSnapshot);
}

async function saveDeployment(
    pool: Pool,
    deployment: PipelineDeployment,
    context?: AuditContext,
): Promise<void> {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await client.query(
            `
                INSERT INTO pipeline_deployments (
                    pipeline_id, version_id, deployed_at, status, validation_messages
                ) VALUES ($1, $2, $3, $4, $5::jsonb)
                ON CONFLICT (pipeline_id, version_id) DO UPDATE SET
                    deployed_at = EXCLUDED.deployed_at,
                    status = EXCLUDED.status,
                    validation_messages = EXCLUDED.validation_messages
            `,
            [
                deployment.pipelineId,
                deployment.versionId,
                deployment.deployedAt,
                deployment.status,
                JSON.stringify(deployment.validationMessages),
            ],
        );
        await insertAuditEvent(client, {
            eventType: 'PIPELINE_DEPLOYED',
            payload: {
                sourceHash: deployment.sourceHash,
                status: deployment.status,
                versionId: deployment.versionId,
            },
            pipelineId: deployment.pipelineId,
            correlationId: context?.correlationId,
            requestSource: context?.requestSource,
        });
        await client.query('COMMIT');
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }
}

async function getLatestDeployment(
    pool: Pool,
    pipelineId: string,
): Promise<PipelineDeployment | undefined> {
    const result = await pool.query<DeploymentRow>(
        `
            SELECT d.*, s.source_hash
            FROM pipeline_deployments d
            JOIN source_versions s
                ON s.pipeline_id = d.pipeline_id AND s.version_id = d.version_id
            WHERE d.pipeline_id = $1
            ORDER BY d.deployed_at DESC, d.version_id DESC
            LIMIT 1
        `,
        [pipelineId],
    );
    const row = result.rows[0];
    return row == null ? undefined : mapDeployment(row);
}

async function getPersistedPipeline(
    pool: Pool,
    pipelineId: string,
): Promise<PersistedPipeline | undefined> {
    const result = await pool.query<PipelineRow>(
        'SELECT * FROM pipelines WHERE id = $1',
        [pipelineId],
    );
    const row = result.rows[0];
    return row == null ? undefined : mapPipeline(row);
}

function mapPipeline(row: PipelineRow): PersistedPipeline {
    return {
        active: row.active,
        policy: {
            allowOverlap: row.allow_overlap,
            ...(row.timeout_seconds == null ? {} : { timeoutSeconds: row.timeout_seconds }),
        },
        createdAt: dateString(row.created_at),
        currentSourceHash: row.current_source_hash,
        currentVersionId: row.current_version_id,
        id: row.id,
        name: row.display_name,
        normalizedName: row.normalized_name,
        specPath: row.spec_path,
        updatedAt: dateString(row.updated_at),
    };
}

function mapPipelineSnapshot(row: PipelineSnapshotRow): PersistedPipelineSnapshot {
    const policy = row.policy_json ?? {
        allowOverlap: row.current_allow_overlap,
        ...(row.current_timeout_seconds == null
            ? {}
            : { timeoutSeconds: row.current_timeout_seconds }),
    };
    return {
        createdAt: dateString(row.created_at),
        edges: row.edges_json,
        name: row.name,
        nodes: row.nodes_json,
        pipelineId: row.pipeline_id,
        policy,
        sourceContents: row.source_contents ?? [],
        sourceFiles: row.source_files,
        sourceHash: row.source_hash,
        spec: row.spec_json,
        specContent: row.spec_content ?? undefined,
        specPath: row.spec_path,
        validationMessages: row.validation_messages,
        versionId: row.version_id,
        yamlTriggerDefinitions: row.yaml_trigger_definitions ?? [],
    };
}

function mapDeployment(row: DeploymentRow): PipelineDeployment {
    return {
        deployedAt: dateString(row.deployed_at),
        pipelineId: row.pipeline_id,
        sourceHash: row.source_hash,
        status: row.status,
        validationMessages: row.validation_messages,
        versionId: row.version_id,
    };
}
