/**
 * @fileoverview State-based health and readiness response contracts.
 */

import assert from 'node:assert/strict';
import { createServer, type AddressInfo, type Server } from 'node:http';
import test from 'node:test';
import type { PipelineServiceReadinessSnapshot } from '../../../../src/server/types/pipelineServiceTypes.ts';
import { createHealthHandler } from '../../../../src/server/runtime/healthHandler.ts';
import { createHttpRequestListener } from '../../../../src/server/runtime/httpResponse.ts';

test('readiness reports cached discovery, persistence, worker, and queue state', async () => {
    let lifecycle = { initialized: false, shuttingDown: false };
    let serviceSnapshot = readyServiceSnapshot();
    let snapshotReads = 0;
    const healthHandler = createHealthHandler(
        () => lifecycle,
        () => {
            snapshotReads += 1;
            return serviceSnapshot;
        },
    );
    const server = await startHealthServer(healthHandler);

    try {
        const beforeStartup = await fetch(`${server.baseUrl}/ready`);
        assert.equal(beforeStartup.status, 503);
        const beforeStartupBody = await beforeStartup.json() as {
            checks: Record<string, string>;
            status: string;
        };
        assert.equal(beforeStartupBody.status, 'not_ready');
        assert.equal(beforeStartupBody.checks.initialized, 'not_initialized');

        lifecycle = { initialized: true, shuttingDown: false };
        const readyResponse = await fetch(`${server.baseUrl}/ready`);
        assert.equal(readyResponse.status, 200);
        const readyBody = await readyResponse.json() as {
            checks: Record<string, string>;
            queue: { activeRuns: number; queuedRuns: number; stuckRuns: number };
            status: string;
        };
        assert.equal(readyBody.status, 'ready');
        assert.equal(readyBody.checks.pipelineDiscovery, 'ready:2');
        assert.equal(readyBody.checks.persistence, 'postgresql');
        assert.equal(readyBody.checks.worker, 'ready');
        assert.equal(readyBody.checks.stuckRuns, 'none');
        assert.deepEqual(readyBody.queue, { activeRuns: 1, queuedRuns: 3, stuckRuns: 0 });

        serviceSnapshot = {
            ...serviceSnapshot,
            operationalSnapshot: {
                activeRuns: 1,
                queuedRuns: 3,
                stuckRuns: 1,
            },
        };
        const stuckResponse = await fetch(`${server.baseUrl}/ready`);
        assert.equal(stuckResponse.status, 503);
        assert.equal(snapshotReads, 3);
    } finally {
        await closeServer(server.server);
    }
});

function readyServiceSnapshot(): PipelineServiceReadinessSnapshot {
    return {
        acceptingWork: true,
        discoveredPipelineCount: 2,
        discoveryReady: true,
        initialized: true,
        operationalSnapshot: {
            activeRuns: 1,
            queuedRuns: 3,
            stuckRuns: 0,
        },
        operationalSnapshotReady: true,
        persistenceKind: 'postgresql',
        persistenceReady: true,
    };
}

async function startHealthServer(
    healthHandler: ReturnType<typeof createHealthHandler>,
): Promise<{ baseUrl: string; server: Server }> {
    const server = createServer(createHttpRequestListener(async (request, response) => {
        if (!healthHandler(request, response)) {
            response.end();
        }
    }));
    await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => {
            server.off('listening', onListening);
            reject(error);
        };
        const onListening = () => {
            server.off('error', onError);
            resolve();
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(0, '127.0.0.1');
    });
    const address = server.address() as AddressInfo;
    return { baseUrl: `http://127.0.0.1:${address.port}`, server };
}

function closeServer(server: Server): Promise<void> {
    return new Promise((resolve, reject) => {
        server.close((error) => error == null ? resolve() : reject(error));
    });
}
