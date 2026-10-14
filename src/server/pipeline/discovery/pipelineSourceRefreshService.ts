/**
 * @fileoverview Applies the source folder to the persisted pipeline snapshots.
 */

import type { ControlPlanePersistence } from '../../types/pipelinePersistenceTypes.ts';
import type { PipelineRunPolicy } from '../../types/pipelineRunPolicyTypes.ts';
import type { PipelineParseCache } from './pipelineDiscovery.ts';
import { discoverAndPersistPipelines } from './pipelineRegistryDiscovery.ts';

export interface PipelineSourceRefreshServiceOptions {
    persistence: ControlPlanePersistence;
    pipelineParseCache: PipelineParseCache;
    pipelineRunPolicies: Map<string, PipelineRunPolicy>;
}

/** Owns the only operation that reads the source folder and updates saved snapshots. */
export function createPipelineSourceRefreshService(
    options: PipelineSourceRefreshServiceOptions,
) {
    const { persistence, pipelineParseCache, pipelineRunPolicies } = options;

    return {
        async refreshFromSource() {
            const pipelines = await discoverAndPersistPipelines(
                persistence,
                pipelineRunPolicies,
                pipelineParseCache,
            );
            const activePipelineIds = pipelines.map((pipeline) => pipeline.detail.id);
            const removedPipelineIds = await persistence.deactivatePipelinesNotIn(activePipelineIds);
            await Promise.all(removedPipelineIds.map((pipelineId) =>
                persistence.reconcileYamlTriggers(pipelineId, [])));
            return pipelines;
        },
    };
}
