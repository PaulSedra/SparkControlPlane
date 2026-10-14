/**
 * @fileoverview Connects parsed pipeline discovery to persistent identity and trigger ownership.
 */

import { ControlPlaneApiError } from '../../errors/controlPlaneApiError.ts';
import { DeploymentStatus } from '../../../shared/status/deployment.ts';
import type { PipelineDetail } from '../../../shared/pipelineRegistryTypes.ts';
import type {
    ControlPlanePersistence,
    DiscoveredPipeline,
    PersistedPipelineSnapshot,
} from '../../types/pipelinePersistenceTypes.ts';
import type { PipelineRunPolicy } from '../../types/pipelineRunPolicyTypes.ts';
import { pipelineRunPolicy } from '../execution/pipelineRunPolicy.ts';
import {
    bindYamlTriggerDefinitions,
} from './yamlTriggerConfiguration.ts';
import {
    discoverAllPipelines,
    type ParsedPipeline,
    type PipelineParseCache,
} from './pipelineDiscovery.ts';
import { versionId } from './pipelineVersion.ts';

/** Parsed pipeline details enriched with persistent identity, deployment state, and run policy. */
export interface HydratedPipeline extends ParsedPipeline {
    policy?: PipelineRunPolicy;
}

/** Builds the runtime model from the source version already stored in PostgreSQL. */
export function hydratePersistedPipelineSnapshot(
    snapshot: PersistedPipelineSnapshot,
): HydratedPipeline {
    const detail: PipelineDetail = {
        currentVersionId: snapshot.versionId,
        edges: snapshot.edges,
        id: snapshot.pipelineId,
        lastRun: undefined,
        name: snapshot.name,
        nodeCount: snapshot.nodes.filter((node) => node.nodeType !== 'EXTERNAL_DATASET').length,
        nodes: snapshot.nodes,
        recentRuns: [],
        runs: [],
        sourceFiles: snapshot.sourceFiles,
        sourceHash: snapshot.sourceHash,
        spec: snapshot.spec,
        specPath: snapshot.specPath,
        status: DeploymentStatus.DRAFT,
        updatedAt: snapshot.createdAt,
        validationMessages: snapshot.validationMessages,
    };
    return {
        detail,
        policy: snapshot.policy,
        sourceContents: snapshot.sourceContents ?? [],
        sourceHash: snapshot.sourceHash,
        specContent: snapshot.specContent,
        yamlTriggerDefinitions: snapshot.yamlTriggerDefinitions ?? [],
    };
}

/** Resolves a pipeline by persisted ID without reading or reconciling source files. */
export async function parsePipelineById(
    pipelineId: string,
    persistence: ControlPlanePersistence,
): Promise<HydratedPipeline> {
    const snapshot = await persistence.getPipelineSnapshot(pipelineId);
    if (snapshot == null) {
        throw new ControlPlaneApiError(404, `Unknown pipeline: ${pipelineId}`);
    }
    return hydratePersistedPipelineSnapshot(snapshot);
}

/** Discovers current specs and reconciles each parsed pipeline with persistence. */
export async function discoverAndPersistPipelines(
    persistence: ControlPlanePersistence,
    pipelineRunPolicies: Map<string, PipelineRunPolicy>,
    pipelineParseCache: PipelineParseCache,
): Promise<HydratedPipeline[]> {
    const pipelines = await discoverAllPipelines(pipelineParseCache);
    return Promise.all(pipelines.map((pipeline) =>
        hydrateParsedPipeline(pipeline, persistence, pipelineRunPolicies)));
}

async function hydrateParsedPipeline(
    pipeline: ParsedPipeline,
    persistence: ControlPlanePersistence,
    pipelineRunPolicies: Map<string, PipelineRunPolicy>,
): Promise<HydratedPipeline> {
    const policy = pipelineRunPolicy(
        pipeline.detail.name,
        pipelineRunPolicies,
        pipeline.detail.spec.timeoutSeconds,
    );
    const discovered: DiscoveredPipeline = {
        edges: pipeline.detail.edges,
        name: pipeline.detail.name,
        nodes: pipeline.detail.nodes,
        sourceContents: pipeline.sourceContents,
        sourceFiles: pipeline.detail.sourceFiles,
        sourceHash: pipeline.sourceHash,
        spec: pipeline.detail.spec,
        specContent: pipeline.specContent,
        specPath: pipeline.detail.specPath,
        validationMessages: pipeline.detail.validationMessages,
        versionId: versionId(pipeline.sourceHash),
        yamlTriggerDefinitions: pipeline.yamlTriggerDefinitions,
        policy,
    };
    const identity = await persistence.ensurePipeline(discovered);
    await persistence.reconcileYamlTriggers(
        identity.id,
        bindYamlTriggerDefinitions(pipeline.yamlTriggerDefinitions, identity.id),
    );
    return {
        detail: {
            ...pipeline.detail,
            currentVersionId: identity.currentVersionId,
            id: identity.id,
        },
        policy,
        sourceContents: pipeline.sourceContents,
        sourceHash: pipeline.sourceHash,
        specContent: pipeline.specContent,
        yamlTriggerDefinitions: pipeline.yamlTriggerDefinitions,
    };
}
