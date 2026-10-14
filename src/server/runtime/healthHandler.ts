/**
 * @fileoverview Serves standalone liveness and cached readiness diagnostics.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { PipelineServiceReadinessSnapshot } from '../types/pipelineServiceTypes.ts';
import { sendJson } from './httpResponse.ts';

/** Lifecycle state controlled by the standalone HTTP server. */
export interface StandaloneLifecycleState {
    initialized: boolean;
    shuttingDown: boolean;
}

/** Creates handlers for /health and /ready using state-only service snapshots. */
export function createHealthHandler(
    getLifecycleState: () => StandaloneLifecycleState,
    getServiceSnapshot: () => PipelineServiceReadinessSnapshot,
): (request: IncomingMessage, response: ServerResponse) => boolean {
    return (request, response) => {
        const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
        if (pathname === '/health') {
            sendHealthResponse(response, getLifecycleState());
            return true;
        }
        if (pathname !== '/ready') {
            return false;
        }

        sendReadinessResponse(response, getLifecycleState(), getServiceSnapshot());
        return true;
    };
}

function sendHealthResponse(
    response: ServerResponse,
    lifecycle: StandaloneLifecycleState,
): void {
    const shuttingDown = lifecycle.shuttingDown;
    sendJson(response, shuttingDown ? 503 : 200, {
        status: shuttingDown ? 'shutting_down' : 'ok',
    });
}

function sendReadinessResponse(
    response: ServerResponse,
    lifecycle: StandaloneLifecycleState,
    snapshot: PipelineServiceReadinessSnapshot,
): void {
    const queue = snapshot.operationalSnapshot;
    const ready = isReady(lifecycle, snapshot, queue);
    sendJson(response, ready ? 200 : 503, {
        checks: readinessChecks(lifecycle, snapshot, queue),
        queue,
        status: ready ? 'ready' : 'not_ready',
    });
}

function isReady(
    lifecycle: StandaloneLifecycleState,
    snapshot: PipelineServiceReadinessSnapshot,
    queue: PipelineServiceReadinessSnapshot['operationalSnapshot'],
): boolean {
    return lifecycle.initialized && !lifecycle.shuttingDown &&
        snapshot.initialized && snapshot.discoveryReady &&
        snapshot.persistenceReady && snapshot.acceptingWork &&
        snapshot.operationalSnapshotReady && queue != null && queue.stuckRuns === 0;
}

function readinessChecks(
    lifecycle: StandaloneLifecycleState,
    snapshot: PipelineServiceReadinessSnapshot,
    queue: PipelineServiceReadinessSnapshot['operationalSnapshot'],
) {
    return {
        initialized: lifecycle.initialized && snapshot.initialized ? 'ready' : 'not_initialized',
        operationalSnapshot: snapshot.operationalSnapshotReady ? 'ready' : 'unavailable',
        persistence: snapshot.persistenceReady ? snapshot.persistenceKind : 'failed',
        pipelineDiscovery: snapshot.discoveryReady
            ? `ready:${snapshot.discoveredPipelineCount}`
            : 'not_ready',
        stuckRuns: queue == null
            ? 'unknown'
            : queue.stuckRuns === 0
                ? 'none'
                : `detected:${queue.stuckRuns}`,
        worker: !snapshot.initialized
            ? 'not_initialized'
            : snapshot.acceptingWork
                ? 'ready'
                : 'stopping',
    };
}
