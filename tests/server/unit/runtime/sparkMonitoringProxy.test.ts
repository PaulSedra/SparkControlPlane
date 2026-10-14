/**
 * @fileoverview Spark monitoring proxy path, response, and timeout contracts.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createServer, type AddressInfo, type Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createHttpRequestListener } from '../../../../src/server/runtime/httpResponse.ts';
import { createRequestHandler } from '../../../../src/server/runtime/requestHandler.ts';
import { createSparkMonitoringProxy } from '../../../../src/server/runtime/sparkMonitoringProxy.ts';

test('proxy maps only /spark-api and preserves upstream path, query, status, and content type', async () => {
    const upstreamRequests: string[] = [];
    const upstreamServer = createServer((request, response) => {
        upstreamRequests.push(request.url ?? '');
        response.statusCode = 206;
        response.setHeader('Content-Type', 'application/vnd.apache.spark.v1+json');
        response.end('{"application":"spark"}');
    });
    const upstream = await listen(upstreamServer);
    const staticDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'scp-monitoring-static-'));
    const requestHandler = createRequestHandler({
        apiHandler: async (_request, response) => {
            response.statusCode = 404;
            response.end();
        },
        healthHandler: () => false,
        sparkHistoryUrl: upstream.baseUrl,
        staticDirectory,
    });
    const proxyServer = createServer(createHttpRequestListener(requestHandler));
    const proxy = await listen(proxyServer);

    try {
        const response = await fetch(
            `${proxy.baseUrl}/spark-api/applications/app-1?limit=5&status=running`,
        );
        assert.equal(response.status, 206);
        assert.equal(
            response.headers.get('content-type'),
            'application/vnd.apache.spark.v1+json',
        );
        assert.equal(await response.text(), '{"application":"spark"}');
        assert.deepEqual(upstreamRequests, [
            '/api/v1/applications/app-1?limit=5&status=running',
        ]);

        const unrelatedPath = await fetch(`${proxy.baseUrl}/spark-apix/applications`, {
            headers: { accept: 'application/json' },
        });
        assert.equal(unrelatedPath.status, 404);
        assert.equal(upstreamRequests.length, 1);
    } finally {
        await Promise.all([closeServer(proxyServer), closeServer(upstreamServer)]);
        await fs.rm(staticDirectory, { force: true, recursive: true });
    }
});

test('proxy timeout is translated to the public monitoring error response', async () => {
    const proxyHandler = createSparkMonitoringProxy('http://127.0.0.1:1', {
        fetch: async (_target, init) => new Promise<Response>((_resolve, reject) => {
            const signal = init?.signal;
            if (signal == null) {
                reject(new Error('Proxy timeout signal was not provided.'));
                return;
            }
            signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        }),
        timeoutMilliseconds: 10,
    });
    const server = createServer(createHttpRequestListener(proxyHandler));
    const address = await listen(server);

    try {
        const response = await fetch(`${address.baseUrl}/spark-api/applications`);
        assert.equal(response.status, 502);
        const body = await response.json() as { code: string; message: string };
        assert.equal(body.code, 'MONITORING_UNAVAILABLE');
        assert.ok(body.message.length > 0);
        assert.doesNotMatch(body.message, /stack|node_modules/i);
    } finally {
        await closeServer(server);
    }
});

async function listen(server: Server): Promise<{ baseUrl: string; port: number }> {
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
    return { baseUrl: `http://127.0.0.1:${address.port}`, port: address.port };
}

function closeServer(server: Server): Promise<void> {
    return new Promise((resolve, reject) => {
        server.close((error) => error == null ? resolve() : reject(error));
    });
}
