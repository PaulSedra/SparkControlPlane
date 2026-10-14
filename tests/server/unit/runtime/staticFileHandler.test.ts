/**
 * @fileoverview Static asset, SPA fallback, path, and MIME contracts.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http, { createServer, type AddressInfo, type Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createHttpRequestListener } from '../../../../src/server/runtime/httpResponse.ts';
import {
    createStaticFileHandler,
    mimeTypeForPath,
} from '../../../../src/server/runtime/staticFileHandler.ts';

test('only browser routes use the SPA fallback and HEAD responses have no body', async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'scp-static-handler-'));
    const staticDirectory = path.join(workspace, 'public');
    await fs.mkdir(path.join(staticDirectory, 'assets'), { recursive: true });
    await fs.writeFile(
        path.join(staticDirectory, 'index.html'),
        '<!doctype html><div id="root"></div>',
    );
    await fs.writeFile(path.join(staticDirectory, 'assets', 'app.js'), 'globalThis.ready = true;');
    const server = await startStaticServer(staticDirectory);

    try {
        const route = await fetch(`${server.baseUrl}/pipelines/example`, {
            headers: { accept: 'text/html,application/xhtml+xml' },
        });
        assert.equal(route.status, 200);
        assert.match(route.headers.get('content-type') ?? '', /^text\/html/);
        assert.match(await route.text(), /id="root"/);

        const missingAsset = await fetch(`${server.baseUrl}/assets/missing.js`, {
            headers: { accept: 'text/html' },
        });
        assert.equal(missingAsset.status, 404);
        assert.deepEqual(await missingAsset.json(), {
            code: 'NOT_FOUND',
            message: 'Static asset not found.',
        });

        const htmlHead = await fetch(`${server.baseUrl}/pipelines/example`, {
            headers: { accept: 'text/html' },
            method: 'HEAD',
        });
        assert.equal(htmlHead.status, 200);
        assert.match(htmlHead.headers.get('content-type') ?? '', /^text\/html/);
        assert.equal(await htmlHead.text(), '');

        const assetHead = await fetch(`${server.baseUrl}/assets/app.js`, { method: 'HEAD' });
        assert.equal(assetHead.status, 200);
        assert.equal(assetHead.headers.get('content-type'), 'text/javascript; charset=utf-8');
        assert.equal(await assetHead.text(), '');
    } finally {
        await closeServer(server.server);
        await fs.rm(workspace, { force: true, recursive: true });
    }
});

test('static paths reject traversal and malformed percent encoding', async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'scp-static-path-'));
    const staticDirectory = path.join(workspace, 'public');
    await fs.mkdir(staticDirectory);
    await fs.writeFile(path.join(staticDirectory, 'index.html'), 'safe index');
    await fs.writeFile(path.join(workspace, 'secret.txt'), 'outside static root');
    const server = await startStaticServer(staticDirectory);

    try {
        const traversal = await fetch(`${server.baseUrl}/%2e%2e%2fsecret.txt`);
        assert.equal(traversal.status, 404);
        assert.doesNotMatch(await traversal.text(), /outside static root/);

        const malformed = await getRawResponse(server.port, '/bad%ZZ');
        assert.equal(malformed.statusCode, 404);
        assert.doesNotMatch(malformed.body, /safe index/);
    } finally {
        await closeServer(server.server);
        await fs.rm(workspace, { force: true, recursive: true });
    }
});

test('common frontend and browser assets have explicit MIME types', () => {
    const expected: Record<string, string> = {
        'app.js': 'text/javascript; charset=utf-8',
        'app.css': 'text/css; charset=utf-8',
        'index.html': 'text/html; charset=utf-8',
        'manifest.json': 'application/json; charset=utf-8',
        'asset.svg': 'image/svg+xml',
        'asset.png': 'image/png',
        'asset.jpeg': 'image/jpeg',
        'asset.webp': 'image/webp',
        'favicon.ico': 'image/x-icon',
        'font.woff': 'font/woff',
        'font.woff2': 'font/woff2',
        'app.js.map': 'application/json; charset=utf-8',
        'module.wasm': 'application/wasm',
        'readme.txt': 'text/plain; charset=utf-8',
    };

    for (const [filePath, mimeType] of Object.entries(expected)) {
        assert.equal(mimeTypeForPath(filePath), mimeType, filePath);
    }
});

async function startStaticServer(
    staticDirectory: string,
): Promise<{ baseUrl: string; port: number; server: Server }> {
    const server = createServer(
        createHttpRequestListener(createStaticFileHandler(staticDirectory)),
    );
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
    return {
        baseUrl: `http://127.0.0.1:${address.port}`,
        port: address.port,
        server,
    };
}

function getRawResponse(
    port: number,
    requestPath: string,
): Promise<{ body: string; statusCode: number }> {
    return new Promise((resolve, reject) => {
        const request = http.request({
            host: '127.0.0.1',
            method: 'GET',
            path: requestPath,
            port,
        }, (response) => {
            const chunks: Buffer[] = [];
            response.on('data', (chunk: Buffer) => chunks.push(chunk));
            response.on('end', () => resolve({
                body: Buffer.concat(chunks).toString('utf8'),
                statusCode: response.statusCode ?? 0,
            }));
        });
        request.on('error', reject);
        request.end();
    });
}

function closeServer(server: Server): Promise<void> {
    return new Promise((resolve, reject) => {
        server.close((error) => error == null ? resolve() : reject(error));
    });
}
