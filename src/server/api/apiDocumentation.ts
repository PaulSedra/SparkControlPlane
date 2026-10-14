/**
 * @fileoverview Serves the checked-in OpenAPI document and a lightweight
 * Swagger UI page from the standalone server.
 */

import fs from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const OPENAPI_DOCUMENT_PATH = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../../docs/openapi.json',
);
const SWAGGER_UI_BUNDLE_URL =
    'https://cdn.jsdelivr.net/npm/swagger-ui-dist@5.11.10/swagger-ui-bundle.js';
const SWAGGER_UI_CSS_URL =
    'https://cdn.jsdelivr.net/npm/swagger-ui-dist@5.11.10/swagger-ui.css';
const DOCUMENTATION_PATHS = new Set(['/docs', '/openapi.json']);

let openApiDocumentPromise: Promise<string> | undefined;

/**
 * Serves the checked-in OpenAPI document or the lightweight Swagger page.
 *
 * `false` means the request belongs to the normal application router; a
 * recognized documentation path is fully handled here, including `HEAD` and
 * method-not-allowed responses. The OpenAPI file is read once and reused for
 * later requests, while failures return a generic JSON error rather than
 * exposing filesystem details.
 */
export async function handleApiDocumentationRequest(
    request: IncomingMessage,
    response: ServerResponse,
): Promise<boolean> {
    const pathname = normalizedDocumentationPath(request.url);
    if (!DOCUMENTATION_PATHS.has(pathname)) {
        return false;
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
        response.statusCode = 405;
        response.setHeader('Allow', 'GET, HEAD');
        sendText(response, request.method, 'application/json; charset=utf-8', JSON.stringify({
            code: 'METHOD_NOT_ALLOWED',
            message: 'Method not allowed',
        }));
        return true;
    }

    if (pathname === '/docs') {
        sendText(response, request.method, 'text/html; charset=utf-8', swaggerUiHtml());
        return true;
    }

    try {
        sendText(
            response,
            request.method,
            'application/json; charset=utf-8',
            await readOpenApiDocument(),
        );
    } catch {
        response.statusCode = 500;
        sendText(response, request.method, 'application/json; charset=utf-8', JSON.stringify({
            code: 'INTERNAL_ERROR',
            message: 'OpenAPI document is unavailable.',
        }));
    }
    return true;
}

function normalizedDocumentationPath(requestUrl: string | undefined): string {
    const pathname = new URL(requestUrl ?? '/', 'http://localhost').pathname;
    return pathname.length > 1 ? pathname.replace(/\/$/, '') : pathname;
}

function readOpenApiDocument(): Promise<string> {
    openApiDocumentPromise ??= fs.readFile(OPENAPI_DOCUMENT_PATH, 'utf8');
    return openApiDocumentPromise;
}

function swaggerUiHtml(): string {
    return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Spark Control Plane API</title>
    <link rel="stylesheet" href="${SWAGGER_UI_CSS_URL}">
  </head>
  <body>
    <div id="swagger-ui"></div>
    <script src="${SWAGGER_UI_BUNDLE_URL}"></script>
    <script>
      window.ui = SwaggerUIBundle({
        deepLinking: true,
        dom_id: '#swagger-ui',
        layout: 'BaseLayout',
        presets: [SwaggerUIBundle.presets.apis],
        url: '/openapi.json'
      });
    </script>
  </body>
</html>
`;
}

function sendText(
    response: ServerResponse,
    method: string | undefined,
    contentType: string,
    body: string,
): void {
    response.setHeader('Content-Type', contentType);
    response.setHeader('Cache-Control', 'no-cache');
    response.end(method === 'HEAD' ? undefined : body);
}
