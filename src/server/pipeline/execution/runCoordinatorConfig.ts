/** @fileoverview Loads the queue coordinator's runtime settings. */

import {
    boundedIntegerValue,
    boundedPositiveInteger,
} from '../../config/configValues.ts';

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
export function loadRunCoordinatorConfig(
    environment: NodeJS.ProcessEnv = process.env,
): RunCoordinatorConfig {
    const leaseMilliseconds = configuredLeaseMilliseconds(environment);
    return {
        leaseMilliseconds,
        maxConcurrentRuns: configuredRunConcurrency(environment),
        recoveryBatchSize: configuredRecoveryBatchSize(environment),
        recoveryIntervalMilliseconds: configuredRecoveryIntervalMilliseconds(
            leaseMilliseconds,
            environment,
        ),
    };
}

function configuredLeaseMilliseconds(environment: NodeJS.ProcessEnv): number {
    const configured = Number.parseInt(
        environment.PIPELINE_RUN_LEASE_SECONDS?.trim() ?? '',
        10,
    );
    return boundedIntegerValue(configured, 30_000, 1, 86_400, 1_000);
}

function configuredRunConcurrency(environment: NodeJS.ProcessEnv): number {
    const configured = Number(environment.PIPELINE_RUN_CONCURRENCY?.trim() ?? '');
    return boundedPositiveInteger(configured, 1, Number.MAX_SAFE_INTEGER);
}

function configuredRecoveryIntervalMilliseconds(
    leaseMilliseconds: number,
    environment: NodeJS.ProcessEnv,
): number {
    const configured = Number.parseInt(
        environment.PIPELINE_RUN_RECOVERY_INTERVAL_SECONDS?.trim() ?? '',
        10,
    );
    const defaultIntervalMilliseconds = Math.max(1_000, Math.floor(leaseMilliseconds / 3));
    return boundedIntegerValue(
        configured,
        defaultIntervalMilliseconds,
        1,
        86_400,
        1_000,
    );
}

function configuredRecoveryBatchSize(environment: NodeJS.ProcessEnv): number {
    const configured = Number.parseInt(
        environment.PIPELINE_RUN_RECOVERY_BATCH_SIZE?.trim() ?? '',
        10,
    );
    return boundedIntegerValue(configured, 100, 1, 1_000);
}
