/**
 * @fileoverview Validates run targets and persists idempotent pipeline submissions.
 */

import { ControlPlaneApiError } from '../../errors/controlPlaneApiError.ts';
import type {
    PipelineDetail,
    PipelineRun,
    PipelineRunNodeStatusRecord,
    RunMode,
} from '../../../shared/pipelineRegistryTypes.ts';
import {
    PipelineRunNodeStatus,
} from '../../../shared/status/node.ts';
import {
    RunStatus,
} from '../../../shared/status/run.ts';
import type { ControlPlanePersistence } from '../../types/pipelinePersistenceTypes.ts';
import type {
    RunSubmission,
    RunSubmissionResult,
} from '../../types/pipelineServiceTypes.ts';
import {
    hydratePersistedPipelineSnapshot,
    type HydratedPipeline,
} from '../discovery/pipelineRegistryDiscovery.ts';
import { versionId } from '../discovery/pipelineVersion.ts';

/**
 * Validates requested targets against the current graph and asks persistence to create or replay a run.
 * Repair mode defaults to failed nodes from the latest failed run; persistence enforces deployment,
 * idempotency, and queue rules using the parsed source version.
 */

export async function submitRun(
    submission: RunSubmission,
    persistence: ControlPlanePersistence,
): Promise<RunSubmissionResult> {
    const { pipelineId } = submission;
    const mode = submission.mode ?? 'incremental';
    const snapshot = await persistence.getPipelineSnapshot(pipelineId);
    if (snapshot == null) {
        throw new ControlPlaneApiError(404, `Unknown pipeline: ${pipelineId}`);
    }
    if (snapshot.specContent == null) {
        throw new ControlPlaneApiError(
            409,
            'This pipeline has no saved source snapshot. Refresh pipelines from source before running it.',
        );
    }
    const parsed = hydratePersistedPipelineSnapshot(snapshot);
    const successorPipelineId = await resolveSuccessorPipeline(
        parsed.detail.spec.onSuccess?.pipeline,
        pipelineId,
        persistence,
    );
    const idempotencyKey = normalizedIdempotencyKey(submission.idempotencyKey);
    const latestRun = await persistence.getLatestRun(pipelineId);
    const repairedNodeNames = mode === 'repair-failed'
        ? repairNodeNames(submission.nodeNames, parsed.detail, latestRun)
        : undefined;
    const targetNodeNames = selectedRefreshMode(mode)
        ? refreshNodeNames(submission.nodeNames, parsed.detail)
        : undefined;
    return persistence.submitRun({
        callerMetadata: submission.callerMetadata,
        correlationId: submission.correlationId,
        idempotencyKey,
        initialNodeStatuses: mode === 'repair-failed' && repairedNodeNames != null
            ? repairNodeStatusesForStart(latestRun, repairedNodeNames)
            : undefined,
        mode,
        pipelineId,
        repairedNodeNames,
        targetNodeNames,
        sourceHash: parsed.sourceHash,
        sparkAppName: parsed.detail.name,
        successorPipelineId,
        policy: parsed.policy,
        requestSource: submission.requestSource,
        versionId: versionId(parsed.sourceHash),
    });
}

async function resolveSuccessorPipeline(
    successorName: string | undefined,
    sourcePipelineId: string,
    persistence: ControlPlanePersistence,
): Promise<string | undefined> {
    if (successorName == null) {
        return undefined;
    }

    const normalizedSuccessorName = successorName.trim().toLowerCase();
    const pipelines = (await persistence.listCurrentPipelineSnapshots())
        .map(hydratePersistedPipelineSnapshot);
    const pipelinesByName = new Map(pipelines.map((pipeline) => [
        pipeline.detail.name.trim().toLowerCase(),
        pipeline,
    ]));
    const successor = pipelines.find((pipeline) =>
        pipeline.detail.name.trim().toLowerCase() === normalizedSuccessorName
    );
    if (successor == null) {
        throw new ControlPlaneApiError(
            400,
            `Configured on_success.pipeline "${successorName}" does not match a discovered pipeline.`,
        );
    }
    if (successor.detail.id === sourcePipelineId) {
        throw new ControlPlaneApiError(400, 'A pipeline cannot be its own on_success successor.');
    }
    const visitedPipelineIds = new Set<string>();
    let current: HydratedPipeline | undefined = successor;
    while (current != null) {
        if (current.detail.id === sourcePipelineId || visitedPipelineIds.has(current.detail.id)) {
            throw new ControlPlaneApiError(400, 'Configured on_success dependencies must not contain a cycle.');
        }
        visitedPipelineIds.add(current.detail.id);
        const nextName = current.detail.spec.onSuccess?.pipeline;
        if (nextName == null) {
            break;
        }
        current = pipelinesByName.get(nextName.trim().toLowerCase());
        if (current == null) {
            throw new ControlPlaneApiError(
                400,
                `Configured on_success.pipeline "${nextName}" does not match a discovered pipeline.`,
            );
        }
    }
    return successor.detail.id;
}

function normalizedIdempotencyKey(value?: string): string | undefined {
    const normalized = value?.trim();
    if (!normalized) {
        return undefined;
    }
    if (normalized.length > 256) {
        throw new ControlPlaneApiError(
            400,
            'Idempotency-Key must not exceed 256 characters.',
        );
    }
    return normalized;
}

function selectedRefreshMode(mode: RunMode): boolean {
    return mode === 'refresh-selected' || mode === 'full-refresh-selected';
}

function refreshNodeNames(
    requestedNodeNames: string[] | undefined,
    pipeline: PipelineDetail,
): string[] {
    if (requestedNodeNames == null) {
        throw new ControlPlaneApiError(400, 'Select at least one pipeline node to refresh.');
    }

    const targetNodeNames = [...new Set(
        requestedNodeNames.map((name) => name.trim()).filter(Boolean),
    )];
    const pipelineNodeNames = new Set(pipeline.nodes
        .filter((node) => node.nodeType !== 'EXTERNAL_DATASET')
        .map((node) => node.qualifiedName));

    if (targetNodeNames.length === 0) {
        throw new ControlPlaneApiError(400, 'Select at least one pipeline node to refresh.');
    }
    if (targetNodeNames.some((name) => !pipelineNodeNames.has(name))) {
        throw new ControlPlaneApiError(400, 'A selected refresh node is not part of this pipeline.');
    }

    return targetNodeNames;
}

function repairNodeNames(
    requestedNodeNames: string[] | undefined,
    pipeline: PipelineDetail,
    latestRun: PipelineRun | undefined,
): string[] {
    if (requestedNodeNames != null) {
        const repairedNodeNames = [...new Set(
            requestedNodeNames.map((name) => name.trim()).filter(Boolean),
        )];
        const pipelineNodeNames = new Set(pipeline.nodes
            .filter((node) => node.nodeType !== 'EXTERNAL_DATASET')
            .map((node) => node.qualifiedName));

        if (repairedNodeNames.length === 0) {
            throw new Error('Select at least one pipeline node to repair.');
        }
        if (repairedNodeNames.some((name) => !pipelineNodeNames.has(name))) {
            throw new Error('A selected repair node is not part of this pipeline.');
        }

        return repairedNodeNames;
    }

    const nodeStatuses = latestRun?.nodeStatuses;
    const failedNodeNames = Object.values(nodeStatuses ?? {})
        .filter((node) => node.status === PipelineRunNodeStatus.FAILED)
        .map((node) => node.qualifiedName);

    if (latestRun == null || latestRun.status !== RunStatus.FAILED ||
        failedNodeNames.length === 0) {
        throw new Error('The latest pipeline run has no failed nodes to repair.');
    }

    return failedNodeNames;
}

function repairNodeStatusesForStart(
    latestRun: PipelineRun | undefined,
    repairedNodeNames: string[],
): Record<string, PipelineRunNodeStatusRecord> {
    const previousStatuses = latestRun == null
        ? {}
        : latestRun.nodeStatuses ?? {};
    const startedAt = new Date().toISOString();

    return Object.fromEntries(Object.entries(previousStatuses).map(([name, status]) => [
        name,
        repairedNodeNames.includes(name)
            ? {
                lastUpdatedAt: startedAt,
                qualifiedName: name,
                status: RunStatus.QUEUED,
            }
            : status,
    ]));
}

