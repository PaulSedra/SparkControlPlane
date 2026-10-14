/**
 * @fileoverview HTTP boundary checks for unexpected asynchronous failures.
 */

import assert from 'node:assert/strict';
import { createServer, type AddressInfo, type Server } from 'node:http';
import test from 'node:test';
import { createHttpRequestListener } from '../../../../src/server/runtime/httpResponse.ts';
import { createRequestHandler } from '../../../../src/server/runtime/requestHandler.ts';

test('unexpected request failures return a sanitized 500 response', async () => {
    const loggedErrors: unknown[] = [];
    const server = await startRequestServer(async () => {
        throw new Error('database password=internal-value');
    }, loggedErrors);

    try {
        const response = await fetch(`${server.baseUrl}/api/unexpected`);
        assert.equal(response.status, 500);
        assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
        assert.deepEqual(await response.json(), {
            code: 'INTERNAL_SERVER_ERROR',
            message: 'An unexpected error occurred.',
        });
        assert.equal(loggedErrors.length, 1);
        assert.match(String(loggedErrors[0]), /internal-value/);
    } finally {
        await closeServer(server.server);
    }
});

test('unexpected failures after headers are sent destroy the response', async () => {
    const loggedErrors: unknown[] = [];
    const server = await startRequestServer(async (_request, response) => {
        response.writeHead(200, { 'Content-Type': 'text/plain' });
        response.write('partial response');
        throw new Error('response stream failed');
    }, loggedErrors);

    try {
        await assert.rejects(async () => {
            const response = await fetch(`${server.baseUrl}/api/partial`);
            await response.arrayBuffer();
        });
        assert.equal(loggedErrors.length, 1);
        assert.match(String(loggedErrors[0]), /response stream failed/);
    } finally {
        await closeServer(server.server);
    }
});

async function startRequestServer(
    apiHandler: (
        request: Parameters<Parameters<typeof createServer>[0]>[0],
        response: Parameters<Parameters<typeof createServer>[0]>[1],
    ) => Promise<void>,
    loggedErrors: unknown[],
): Promise<{ baseUrl: string; server: Server }> {
    const requestHandler = createRequestHandler({
        apiHandler,
        healthHandler: () => false,
        staticDirectory: process.cwd(),
    });
    const server = createServer(createHttpRequestListener(requestHandler, (error) => {
        loggedErrors.push(error);
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
