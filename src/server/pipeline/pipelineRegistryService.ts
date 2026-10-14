/**
 * @fileoverview Composes pipeline discovery, persistence, runs, and triggers.
 */

import { ControlPlaneApiError } from '../errors/controlPlaneApiError.ts';
import type {
    PipelineDetail,
    PipelineRun,
    PipelineSummary,
} from '../../shared/pipelineRegistryTypes.ts';
import { createPostgresPersistence } from '../persistence/postgresPersistence.ts';
import { loadPostgresConfig } from '../config/postgresConfig.ts';
import { exportHistoryBatch as buildHistoryExportBatch } from '../history/historyExport.ts';
import type {
    AuditContext,
    ControlPlanePersistence,
    PipelineDeployment,
    PipelineRunEvent,
} from '../types/pipelinePersistenceTypes.ts';
import {
    loadPipelineRunPolicies,
} from './execution/pipelineRunPolicy.ts';
import type {
    PipelineDetailOptions,
    PipelinePage,
    PipelineRegistryService,
    PipelineRegistryServiceOptions,
    RunSubmission,
    RunSubmissionResult,
} from '../types/pipelineServiceTypes.ts';
import { incrementMetric } from '../observability/observability.ts';
import { createTriggerScheduler } from '../triggers/triggerScheduler.ts';
import { createTriggerEventService } from '../triggers/triggerEventService.ts';
import { createTriggerServices } from '../triggers/triggerServices.ts';
import { publicErrorMessage } from '../utils/sanitization.ts';
import { logStructured } from '../utils/structuredLogging.ts';
import { getPipelineNodeData } from './pipelineNodeService.ts';
import { getPipelineSourceFile } from './discovery/pipelineSourceService.ts';
import { hydratePersistedPipelineSnapshot } from './discovery/pipelineRegistryDiscovery.ts';
import type { PipelineParseCache } from './discovery/pipelineDiscovery.ts';
import { createPipelineSourceRefreshService } from './discovery/pipelineSourceRefreshService.ts';
import { versionId } from './discovery/pipelineVersion.ts';
import { createRunCoordinator } from './execution/runCoordinator.ts';
import { createRunSuccessDependencyDispatcher } from './execution/runSuccessDependencyDispatcher.ts';
import { submitRun } from './execution/runSubmission.ts';
import { createPipelineReadinessService } from './pipelineReadinessService.ts';
import { createTriggerRegistryService } from './triggerRegistryService.ts';

/**
 * Composes the registry around persistence, discovery, run coordination, and trigger services.
 * The host must call initialize before handling requests; it initializes
 * persistence and starts workers from the saved registry snapshot. Source
 * discovery and YAML trigger reconciliation happen only on explicit refresh.
 * shutdown stops trigger work, drains runs, and closes persistence.
 */
export function createPipelineRegistryService(
    options: PipelineRegistryServiceOptions = {},
): PipelineRegistryService {
    const sparkConnectUrl = options.sparkConnectUrl?.trim();
    const persistence = options.persistence ?? createPostgresPersistence(
        options.postgresConfig ?? loadPostgresConfig(),
    );
    const pipelineRunPolicies = options.pipelineRunPolicies ?? loadPipelineRunPolicies();
    const pipelineParseCache: PipelineParseCache = new Map();
    const sourceRefresh = createPipelineSourceRefreshService({
        persistence,
        pipelineParseCache,
        pipelineRunPolicies,
    });
    const now = options.now ?? (() => Date.now());
    let listPipelinesInFlight: Promise<PipelineSummary[]> | undefined;
    let sourceRefreshInFlight: Promise<PipelineSummary[]> | undefined;
    const runCoordinator = createRunCoordinator(
        sparkConnectUrl,
        persistence,
        options.runExecutor,
    );
    const readiness = createPipelineReadinessService({
        isAcceptingWork: () => runCoordinator.isAcceptingWork(),
        now,
        persistence,
    });

    const submitManagedRun = async (submission: RunSubmission): Promise<RunSubmissionResult> => {
        if (!runCoordinator.isAcceptingWork()) {
            throw new ControlPlaneApiError(
                503,
                'SHUTTING_DOWN',
                'The control plane is shutting down.',
            );
        }
        const result = await submitRun(
            submission,
            persistence,
        );
        incrementMetric('control_plane_submissions_total');
        logStructured('run_submitted', {
            correlationId: submission.correlationId,
            requestSource: submission.requestSource,
            runId: result.run.runId,
            status: result.run.status,
        });
        runCoordinator.wake();
        return result;
    };

    const triggerServices = createTriggerServices({
        now,
        onError: (message, error) => logStructured('trigger_event_error', {
            detail: publicErrorMessage(error),
            message,
        }),
        persistence,
        submitRun: submitManagedRun,
    });
    const triggerScheduler = createTriggerScheduler({
        delivery: triggerServices.deliver,
        intervalMilliseconds: options.triggerSchedulerIntervalMilliseconds,
        now,
        onError: (message, error) => logStructured('scheduled_trigger_error', {
            detail: publicErrorMessage(error),
            message,
        }),
        persistence,
    });
    const triggerEventService = createTriggerEventService({
        now,
        persistence,
        services: triggerServices,
        submitRun: submitManagedRun,
    });
    const successDependencyDispatcher = createRunSuccessDependencyDispatcher({
        now,
        onError: (message, error) => logStructured('pipeline_success_dependency_error', {
            detail: publicErrorMessage(error),
            message,
        }),
        persistence,
        submitRun: submitManagedRun,
    });
    const triggerRegistry = createTriggerRegistryService({
        eventService: triggerEventService,
        now,
        persistence,
        triggerServices,
    });

    return {
        ...triggerRegistry,
        cancelRun: async (runId, requestedBy, reason, context) => {
            const run = await persistence.cancelRun(runId, requestedBy, reason, context);
            incrementMetric('control_plane_cancellations_total');
            logStructured('run_cancellation_requested', {
                correlationId: context?.correlationId,
                requestSource: context?.requestSource,
                runId,
            });
            runCoordinator.wake();
            return run;
        },
        deployPipeline,
        getPipeline,
        getPipelineNodeData: (pipelineId, nodeId) =>
            getPipelineNodeData(
                pipelineId,
                nodeId,
                sparkConnectUrl,
                persistence,
            ),
        getPipelineSourceFile: (pipelineId, sourceFile) =>
            getPipelineSourceFile(
                pipelineId,
                sourceFile,
                persistence,
            ),
        getRun,
        getRunSummary,
        exportHistoryBatch: (cursor, limit) => buildHistoryExportBatch(persistence, cursor, limit),
        persistenceKind: () => persistence.kind,
        isPersistenceReady: persistence.isReady,
        async initialize() {
            await persistence.initialize();
            readiness.markDiscoveryReady((await persistence.listCurrentPipelineSnapshots()).length);
            runCoordinator.start();
            successDependencyDispatcher.start();
            triggerScheduler.start();
            runCoordinator.wake();
            await readiness.start();
        },
        isAcceptingWork: runCoordinator.isAcceptingWork,
        readinessSnapshot: readiness.snapshot,
        listPipelineRunsPage,
        listPipelinesPage,
        listRunEventsPage,
        listPipelines,
        refreshPipelinesFromSource,
        operationalSnapshot: readiness.readOperationalSnapshot,
        async shutdown(drainMilliseconds) {
            const shutdownErrors: unknown[] = [];
            await captureShutdownError(() => readiness.stop(), shutdownErrors);
            await captureShutdownError(() => triggerEventService.stop(), shutdownErrors);
            await captureShutdownError(() => triggerScheduler.stop(), shutdownErrors);
            await captureShutdownError(() => successDependencyDispatcher.stop(), shutdownErrors);
            await captureShutdownError(() => runCoordinator.shutdown(drainMilliseconds), shutdownErrors);
            await captureShutdownError(() => persistence.shutdown(), shutdownErrors);
            if (shutdownErrors.length > 0) {
                throw new AggregateError(shutdownErrors, 'Control-plane service shutdown failed.');
            }
        },
        submitRun: submitManagedRun,
    };

    async function refreshPipelinesFromSource(): Promise<PipelineSummary[]> {
        if (sourceRefreshInFlight != null) {
            return sourceRefreshInFlight;
        }
        const refresh = loadSourceRefreshResult();
        sourceRefreshInFlight = refresh;
        try {
            return await refresh;
        } finally {
            if (sourceRefreshInFlight === refresh) {
                sourceRefreshInFlight = undefined;
            }
        }
    }

    async function loadSourceRefreshResult(): Promise<PipelineSummary[]> {
        try {
            const pipelines = await sourceRefresh.refreshFromSource();
            listPipelinesInFlight = undefined;
            readiness.markDiscoveryReady(pipelines.length);
            return await loadPipelineSummaries();
        } catch (error) {
            readiness.markDiscoveryFailed();
            throw error;
        }
    }

    async function deployPipeline(
        pipelineId: string,
        context?: AuditContext,
    ): Promise<PipelineDetail> {
        const parsed = await getSavedPipeline(pipelineId);
        const status = parsed.detail.validationMessages.length === 0
            ? 'DEPLOYED'
            : 'DEPLOYED_WITH_WARNINGS';
        const deployment: PipelineDeployment = {
            deployedAt: new Date(now()).toISOString(),
            pipelineId,
            sourceHash: parsed.sourceHash,
            status,
            validationMessages: parsed.detail.validationMessages,
            versionId: versionId(parsed.sourceHash),
        };

        await persistence.saveDeployment(deployment, context);
        return withPersistence(parsed.detail, persistence);
    }

    async function getPipeline(
        pipelineId: string,
        options: PipelineDetailOptions = {},
    ): Promise<PipelineDetail> {
        const parsed = await getSavedPipeline(pipelineId);
        return withPersistence(
            parsed.detail,
            persistence,
            options.includeRuns !== false,
        );
    }

    async function getRun(runId: string): Promise<PipelineRun> {
        const run = await persistence.getRun(runId);
        if (run == null) {
            throw new ControlPlaneApiError(404, `Unknown pipeline run: ${runId}`);
        }
        return run;
    }

    async function getRunSummary(runId: string): Promise<PipelineRun> {
        return summarizePipelineRun(await getRun(runId));
    }

    async function listPipelines(): Promise<PipelineSummary[]> {
        if (listPipelinesInFlight != null) {
            return listPipelinesInFlight;
        }

        const request = loadPipelineSummaries();
        listPipelinesInFlight = request;
        try {
            return await request;
        } finally {
            if (listPipelinesInFlight === request) {
                listPipelinesInFlight = undefined;
            }
        }
    }

    async function loadPipelineSummaries(): Promise<PipelineSummary[]> {
        const snapshots = await persistence.listCurrentPipelineSnapshots();
        readiness.markDiscoveryReady(snapshots.length);
        const summaries = await Promise.all(snapshots.map(async (snapshot) =>
            summaryFromDetail(await withPersistence(
                hydratePersistedPipelineSnapshot(snapshot).detail,
                persistence,
                true,
                5,
            ))
        ));
        return summaries.sort((left, right) => left.name.localeCompare(right.name));
    }

    async function getSavedPipeline(pipelineId: string) {
        const snapshot = await persistence.getPipelineSnapshot(pipelineId);
        if (snapshot == null) {
            throw new ControlPlaneApiError(404, `Unknown pipeline: ${pipelineId}`);
        }
        return hydratePersistedPipelineSnapshot(snapshot);
    }

    async function listPipelinesPage(limit: number, offset: number): Promise<PipelinePage> {
        return page(await listPipelines(), limit, offset);
    }

    async function listPipelineRunsPage(
        pipelineId: string,
        limit: number,
        offset: number,
    ): Promise<PipelinePage<PipelineRun>> {
        await getSavedPipeline(pipelineId);
        if (persistence.listRunsPage != null) {
            const pagination = normalizePagination(limit, offset);
            const persistedPage = await persistence.listRunsPage(
                pipelineId,
                pagination.limit,
                pagination.offset,
            );
            return {
                items: persistedPage.items.map(summarizePipelineRun),
                nextOffset: persistedPage.offset + persistedPage.items.length < persistedPage.total
                    ? persistedPage.offset + persistedPage.items.length
                    : undefined,
                offset: persistedPage.offset,
                total: persistedPage.total,
            };
        }
        const runs = await persistence.listRuns(pipelineId);
        return page(runs.map((run) => summarizePipelineRun(run)), limit, offset);
    }

    async function listRunEventsPage(
        runId: string,
        limit: number,
        offset: number,
    ): Promise<PipelinePage<PipelineRunEvent>> {
        await getRun(runId);
        return page(await persistence.listRunEvents(runId), limit, offset);
    }
}

function summaryFromDetail(detail: PipelineDetail): PipelineSummary {
    return {
        currentVersionId: detail.currentVersionId,
        id: detail.id,
        lastRun: detail.lastRun,
        name: detail.name,
        nodeCount: detail.nodeCount,
        recentRuns: detail.runs.slice(0, 5),
        sourceHash: detail.sourceHash,
        specPath: detail.specPath,
        status: detail.status,
        updatedAt: detail.updatedAt,
    };
}

async function withPersistence(
    detail: PipelineDetail,
    persistence: ControlPlanePersistence,
    includeRuns = true,
    runLimit?: number,
): Promise<PipelineDetail> {
    const deployment = await persistence.getLatestDeployment(detail.id);
    const currentDeployment = deployment?.sourceHash === detail.sourceHash
        ? deployment
        : undefined;
    const persistedRuns = !includeRuns
        ? []
        : runLimit != null && persistence.listRunsPage != null
            ? (await persistence.listRunsPage(detail.id, runLimit, 0)).items
            : await persistence.listRuns(detail.id);
    const runs = persistedRuns.map(summarizePipelineRun);

    return {
        ...detail,
        currentVersionId: currentDeployment?.versionId,
        lastRun: runs[0],
        recentRuns: runs.slice(0, 5),
        runs,
        status: currentDeployment?.status ?? detail.status,
        updatedAt: currentDeployment?.deployedAt ?? detail.updatedAt,
    };
}

function summarizePipelineRun(run: PipelineRun): PipelineRun {
    const summary = { ...run };
    delete summary.command;
    delete summary.stderr;
    delete summary.stdout;
    return summary;
}

function page<T>(items: T[], limit: number, offset: number): PipelinePage<T> {
    const { limit: boundedLimit, offset: boundedOffset } = normalizePagination(limit, offset);
    const pageItems = items.slice(boundedOffset, boundedOffset + boundedLimit);
    return {
        items: pageItems,
        nextOffset: boundedOffset + pageItems.length < items.length
            ? boundedOffset + pageItems.length
            : undefined,
        offset: boundedOffset,
        total: items.length,
    };
}

function normalizePagination(limit: number, offset: number): { limit: number; offset: number } {
    return {
        limit: Number.isFinite(limit)
            ? Math.min(100, Math.max(1, Math.floor(limit)))
            : 100,
        offset: Number.isFinite(offset)
            ? Math.max(0, Math.floor(offset))
            : 0,
    };
}

async function captureShutdownError(
    operation: () => void | Promise<void>,
    errors: unknown[],
): Promise<void> {
    try {
        await operation();
    } catch (error) {
        errors.push(error);
    }
}
