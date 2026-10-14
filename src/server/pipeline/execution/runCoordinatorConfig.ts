/** @fileoverview Loads the queue coordinator's runtime settings. */

/** Effective lease, concurrency, and recovery settings for one worker process. */
export interface RunCoordinatorConfig {
    leaseMilliseconds: number;
    maxConcurrentRuns: number;
    recoveryBatchSize: number;
    recoveryIntervalMilliseconds: number;
}

/**
 * Reads `PIPELINE_RUN_*` settings and applies their defaults and bounds.
 *
 * Lease and recovery intervals are clamped to one second through 24 hours.
 * Lease defaults to 30 seconds; recovery defaults to one third of the lease,
 * with a one-second minimum. Concurrency defaults to one, and recovery batch
 * size defaults to 100 with a maximum of 1,000.
 */
export function loadRunCoordinatorConfig(): RunCoordinatorConfig {
    const leaseMilliseconds = configuredLeaseMilliseconds();
    return {
        leaseMilliseconds,
        maxConcurrentRuns: configuredRunConcurrency(),
        recoveryBatchSize: configuredRecoveryBatchSize(),
        recoveryIntervalMilliseconds: configuredRecoveryIntervalMilliseconds(leaseMilliseconds),
    };
}

function configuredLeaseMilliseconds(): number {
    const configured = Number.parseInt(
        process.env.PIPELINE_RUN_LEASE_SECONDS?.trim() ?? '',
        10,
    );
    if (!Number.isFinite(configured)) {
        return 30_000;
    }
    return Math.min(86_400, Math.max(1, configured)) * 1000;
}

function configuredRunConcurrency(): number {
    const configured = Number(process.env.PIPELINE_RUN_CONCURRENCY?.trim() ?? '');
    return Number.isSafeInteger(configured) && configured > 0 ? configured : 1;
}

function configuredRecoveryIntervalMilliseconds(leaseMilliseconds: number): number {
    const configured = Number.parseInt(
        process.env.PIPELINE_RUN_RECOVERY_INTERVAL_SECONDS?.trim() ?? '',
        10,
    );
    if (!Number.isFinite(configured)) {
        return Math.max(1_000, Math.floor(leaseMilliseconds / 3));
    }
    return Math.min(86_400, Math.max(1, configured)) * 1000;
}

function configuredRecoveryBatchSize(): number {
    const configured = Number.parseInt(
        process.env.PIPELINE_RUN_RECOVERY_BATCH_SIZE?.trim() ?? '',
        10,
    );
    if (!Number.isFinite(configured)) {
        return 100;
    }
    return Math.min(1_000, Math.max(1, configured));
}
