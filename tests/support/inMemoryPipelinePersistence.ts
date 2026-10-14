/**
 * @fileoverview In-memory pipeline identity and deployment persistence for tests.
 */

import crypto from 'node:crypto';
import type {
    PersistedPipeline,
    PersistedPipelineSnapshot,
    PipelineDeployment,
    PipelinePersistence,
} from '../../src/server/types/pipelinePersistenceTypes.ts';

/**
 * Pipeline persistence and the deployment lookup used by run submission.
 */
export interface InMemoryPipelinePersistenceStore {
    getDeploymentForRun(pipelineId: string, versionId: string): PipelineDeployment | undefined;
    persistence: PipelinePersistence;
}

/**
 * Creates isolated pipeline identity and deployment state for the aggregate
 * in-memory persistence adapter. The lookup lets run submission validate the
 * exact deployed version without exposing deployment storage to callers.
 */
export function createInMemoryPipelinePersistence(): InMemoryPipelinePersistenceStore {
    const pipelines = new Map<string, PersistedPipeline>();
    const sourceVersions = new Map<string, PersistedPipelineSnapshot>();
    const deployments: PipelineDeployment[] = [];

    return {
        getDeploymentForRun(pipelineId, versionId) {
            return deployments.find((deployment) =>
                deployment.pipelineId === pipelineId && deployment.versionId === versionId
            );
        },
        persistence: {
            async deactivatePipelinesNotIn(pipelineIds) {
                const currentIds = new Set(pipelineIds);
                const deactivated: string[] = [];
                for (const pipeline of pipelines.values()) {
                    if (pipeline.active && !currentIds.has(pipeline.id)) {
                        pipeline.active = false;
                        deactivated.push(pipeline.id);
                    }
                }
                return deactivated;
            },
            async ensurePipeline(discovered) {
                const existing = Array.from(pipelines.values()).find((pipeline) =>
                    pipeline.normalizedName === normalizeName(discovered.name)
                );
                const now = new Date().toISOString();
                const pipeline = existing ?? {
                    active: true,
                    createdAt: now,
                    currentSourceHash: discovered.sourceHash,
                    currentVersionId: discovered.versionId,
                    id: crypto.randomUUID(),
                    name: discovered.name,
                    normalizedName: normalizeName(discovered.name),
                    specPath: discovered.specPath,
                    policy: discovered.policy ?? { allowOverlap: false },
                    updatedAt: now,
                };
                Object.assign(pipeline, {
                    active: true,
                    currentSourceHash: discovered.sourceHash,
                    currentVersionId: discovered.versionId,
                    name: discovered.name,
                    specPath: discovered.specPath,
                    policy: discovered.policy ?? { allowOverlap: false },
                    updatedAt: now,
                });
                pipelines.set(pipeline.id, pipeline);
                sourceVersions.set(`${pipeline.id}:${discovered.versionId}`, {
                    ...structuredClone(discovered),
                    createdAt: now,
                    pipelineId: pipeline.id,
                });
                return pipeline;
            },
            async getLatestDeployment(pipelineId) {
                return deployments.find((deployment) => deployment.pipelineId === pipelineId);
            },
            async getPersistedPipeline(pipelineId) {
                const pipeline = pipelines.get(pipelineId);
                return pipeline == null
                    ? undefined
                    : {
                        ...pipeline,
                        policy: pipeline.policy == null ? undefined : { ...pipeline.policy },
                    };
            },
            async getPipelineSnapshot(pipelineId, versionId) {
                const pipeline = pipelines.get(pipelineId);
                if (pipeline == null || (versionId == null && !pipeline.active)) {
                    return undefined;
                }
                const selectedVersionId = versionId ?? pipeline.currentVersionId;
                const snapshot = sourceVersions.get(`${pipelineId}:${selectedVersionId}`);
                return snapshot == null ? undefined : structuredClone(snapshot);
            },
            async listCurrentPipelineSnapshots() {
                const snapshots = [...pipelines.values()]
                    .filter((pipeline) => pipeline.active)
                    .map((pipeline) => sourceVersions.get(`${pipeline.id}:${pipeline.currentVersionId}`))
                    .filter((snapshot): snapshot is PersistedPipelineSnapshot => snapshot != null)
                    .map((snapshot) => structuredClone(snapshot));
                return snapshots.sort((left, right) => left.name.localeCompare(right.name));
            },
            async saveDeployment(deployment) {
                const index = deployments.findIndex((item) =>
                    item.pipelineId === deployment.pipelineId &&
                    item.versionId === deployment.versionId
                );
                if (index === -1) {
                    deployments.unshift(deployment);
                } else {
                    deployments[index] = deployment;
                }
            },
        },
    };
}

function normalizeName(name: string): string {
    return name.trim().toLowerCase();
}
