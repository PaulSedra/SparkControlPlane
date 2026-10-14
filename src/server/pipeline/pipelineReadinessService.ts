/**
 * @fileoverview Tracks discovery and cached operational readiness for the registry.
 */

import type {
    OperationalSnapshot,
    ControlPlanePersistence,
} from '../types/pipelinePersistenceTypes.ts';
import type {
    PipelineServiceReadinessSnapshot,
} from '../types/pipelineServiceTypes.ts';
import { setMetric } from '../observability/observability.ts';
import { publicErrorMessage } from '../utils/sanitization.ts';
import { logStructured } from '../utils/structuredLogging.ts';

const READINESS_SNAPSHOT_REFRESH_MILLISECONDS = 5_000;

/** Dependencies used to track registry readiness and refresh its queue snapshot. */
export interface PipelineReadinessServiceOptions {
    isAcceptingWork: () => boolean;
    now: () => number;
    persistence: ControlPlanePersistence;
}

/** Readiness state and lifecycle operations owned by the pipeline registry. */
export interface PipelineReadinessService {
    markDiscoveryFailed: () => void;
    markDiscoveryReady: (pipelineCount: number) => void;
    readOperationalSnapshot: () => Promise<OperationalSnapshot>;
    refreshCachedOperationalSnapshot: () => Promise<void>;
    snapshot: () => PipelineServiceReadinessSnapshot;
    start: () => Promise<void>;
    stop: () => void;
}

/**
 * Creates the cached readiness view used by probes and registry diagnostics.
 * Operational snapshots refresh immediately at startup and then every five
 * seconds; failed background refreshes are logged and leave readiness false.
 */
export function createPipelineReadinessService(
    options: PipelineReadinessServiceOptions,
): PipelineReadinessService {
    let discoveredPipelineCount = 0;
    let discoveryReady = false;
    let initialized = false;
    let operationalSnapshotReady = false;
    let lastOperationalSnapshot: OperationalSnapshot | undefined;
    let refreshInFlight: Promise<void> | undefined;
    let refreshTimer: NodeJS.Timeout | undefined;

    function markDiscoveryReady(pipelineCount: number): void {
        discoveredPipelineCount = pipelineCount;
        discoveryReady = true;
    }

    function markDiscoveryFailed(): void {
        discoveryReady = false;
    }

    function snapshot(): PipelineServiceReadinessSnapshot {
        return {
            acceptingWork: options.isAcceptingWork(),
            discoveredPipelineCount,
            discoveryReady,
            initialized,
            operationalSnapshot: lastOperationalSnapshot == null
                ? undefined
                : { ...lastOperationalSnapshot },
            operationalSnapshotReady,
            persistenceKind: options.persistence.kind,
            persistenceReady: options.persistence.isReady(),
        };
    }

    async function readOperationalSnapshot(): Promise<OperationalSnapshot> {
        try {
            const operationalSnapshot = await options.persistence.operationalSnapshot();
            lastOperationalSnapshot = { ...operationalSnapshot };
            operationalSnapshotReady = true;
            setMetric('control_plane_queued_runs', operationalSnapshot.queuedRuns);
            setMetric('control_plane_active_runs', operationalSnapshot.activeRuns);
            setMetric('control_plane_stuck_runs', operationalSnapshot.stuckRuns);
            const oldestQueuedAgeSeconds = operationalSnapshot.oldestQueuedAt == null
                ? 0
                : Math.max(
                    0,
                    (options.now() - Date.parse(operationalSnapshot.oldestQueuedAt)) / 1000,
                );
            setMetric('control_plane_oldest_queued_age_seconds', oldestQueuedAgeSeconds);
            return operationalSnapshot;
        } catch (error) {
            operationalSnapshotReady = false;
            throw error;
        }
    }

    function refreshCachedOperationalSnapshot(): Promise<void> {
        if (refreshInFlight != null) {
            return refreshInFlight;
        }
        const refresh = readOperationalSnapshot()
            .then(() => undefined)
            .catch((error: unknown) => {
                operationalSnapshotReady = false;
                logStructured('readiness_snapshot_refresh_failed', {
                    detail: publicErrorMessage(error),
                });
            })
            .finally(() => {
                if (refreshInFlight === refresh) {
                    refreshInFlight = undefined;
                }
            });
        refreshInFlight = refresh;
        return refresh;
    }

    async function start(): Promise<void> {
        await refreshCachedOperationalSnapshot();
        initialized = true;
        if (refreshTimer != null) {
            clearInterval(refreshTimer);
        }
        refreshTimer = setInterval(() => {
            void refreshCachedOperationalSnapshot();
        }, READINESS_SNAPSHOT_REFRESH_MILLISECONDS);
        refreshTimer.unref();
    }

    function stop(): void {
        initialized = false;
        if (refreshTimer != null) {
            clearInterval(refreshTimer);
            refreshTimer = undefined;
        }
    }

    return {
        markDiscoveryFailed,
        markDiscoveryReady,
        readOperationalSnapshot,
        refreshCachedOperationalSnapshot,
        snapshot,
        start,
        stop,
    };
}
