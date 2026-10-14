/**
 * @fileoverview Serves static assets and browser application routes safely.
 */

import fs from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import { isNodeError, sendJson } from './httpResponse.ts';

const MIME_TYPES: Readonly<Record<string, string>> = {
    '.avif': 'image/avif',
    '.bmp': 'image/bmp',
    '.css': 'text/css; charset=utf-8',
    '.csv': 'text/csv; charset=utf-8',
    '.gif': 'image/gif',
    '.htm': 'text/html; charset=utf-8',
    '.html': 'text/html; charset=utf-8',
    '.ico': 'image/x-icon',
    '.jpeg': 'image/jpeg',
    '.jpg': 'image/jpeg',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.map': 'application/json; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.mp3': 'audio/mpeg',
    '.mp4': 'video/mp4',
    '.otf': 'font/otf',
    '.pdf': 'application/pdf',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
    '.text': 'text/plain; charset=utf-8',
    '.txt': 'text/plain; charset=utf-8',
    '.ttf': 'font/ttf',
    '.wasm': 'application/wasm',
    '.webm': 'video/webm',
    '.webmanifest': 'application/manifest+json; charset=utf-8',
    '.webp': 'image/webp',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.xml': 'application/xml; charset=utf-8',
    '.yaml': 'application/yaml; charset=utf-8',
    '.yml': 'application/yaml; charset=utf-8',
    '.zip': 'application/zip',
};

/** Creates a GET and HEAD handler for a built frontend directory. */
export function createStaticFileHandler(
    staticDirectory: string,
): (request: IncomingMessage, response: ServerResponse) => Promise<void> {
    const rootDirectory = path.resolve(staticDirectory);
    const indexPath = path.join(rootDirectory, 'index.html');

    return async (request, response) => {
        if (request.method !== 'GET' && request.method !== 'HEAD') {
            sendJson(response, 404, {
                code: 'NOT_FOUND',
                message: 'Route not found.',
            });
            return;
        }

        const url = new URL(request.url ?? '/', 'http://localhost');
        const requestedPath = safeStaticPath(rootDirectory, url.pathname);
        if (requestedPath == null) {
            sendStaticNotFound(response);
            return;
        }

        let filePath = requestedPath;
        let content: Buffer;
        try {
            content = await fs.readFile(filePath);
        } catch (error) {
            if (!isMissingFileError(error)) {
                throw error;
            }
            if (!canUseSpaFallback(request, url.pathname)) {
                sendStaticNotFound(response);
                return;
            }
            filePath = indexPath;
            try {
                content = await fs.readFile(filePath);
            } catch (fallbackError) {
                if (!isMissingFileError(fallbackError)) {
                    throw fallbackError;
                }
                sendStaticNotFound(response);
                return;
            }
        }

        response.statusCode = 200;
        response.setHeader('Content-Type', mimeTypeForPath(filePath));
        response.setHeader('Content-Length', content.byteLength);
        response.setHeader(
            'Cache-Control',
            path.basename(filePath).toLowerCase() === 'index.html'
                ? 'no-cache'
                : 'public, max-age=31536000, immutable',
        );
        response.end(request.method === 'HEAD' ? undefined : content);
    };
}

/** Returns the media type used for a static file extension. */
export function mimeTypeForPath(filePath: string): string {
    return MIME_TYPES[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream';
}

function safeStaticPath(rootDirectory: string, requestPath: string): string | undefined {
    let decodedPath: string;
    try {
        decodedPath = decodeURIComponent(requestPath);
    } catch {
        return undefined;
    }
    if (decodedPath.includes('\0')) {
        return undefined;
    }

    const relativePath = decodedPath.replace(/^\/+/, '');
    const candidate = path.resolve(rootDirectory, relativePath || 'index.html');
    const relative = path.relative(rootDirectory, candidate);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        return undefined;
    }
    return candidate;
}

function canUseSpaFallback(request: IncomingMessage, pathname: string): boolean {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
        return false;
    }
    const finalSegment = pathname.split('/').at(-1) ?? '';
    return path.extname(finalSegment) === '' && acceptsHtml(request.headers.accept);
}

function acceptsHtml(acceptHeader: string | string[] | undefined): boolean {
    const values = Array.isArray(acceptHeader) ? acceptHeader : [acceptHeader ?? ''];
    return values.some((value) => value.split(',').some((entry) => {
        const [mediaType = '', ...parameters] = entry.trim().split(';');
        if (mediaType.trim().toLowerCase() !== 'text/html' &&
            mediaType.trim().toLowerCase() !== 'application/xhtml+xml') {
            return false;
        }
        const quality = parameters
            .map((parameter) => parameter.trim())
            .find((parameter) => parameter.toLowerCase().startsWith('q='));
        return quality == null || Number(quality.slice(2)) > 0;
    }));
}

function isMissingFileError(error: unknown): boolean {
    return isNodeError(error) &&
        (error.code === 'ENOENT' || error.code === 'ENOTDIR' || error.code === 'EISDIR');
}

function sendStaticNotFound(response: ServerResponse): void {
    sendJson(response, 404, {
        code: 'NOT_FOUND',
        message: 'Static asset not found.',
    });
}
