/**
 * @fileoverview HTTP routes for catalog hierarchy, table metadata, and bounded table samples.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { CatalogService } from '../../types/catalogServiceTypes.ts';
import { decodeSegment, requireMethod } from '../http/request.ts';
import { pageNumber } from '../http/validation.ts';
import { sendJson } from '../http/response.ts';

/**
 * Handles catalog hierarchy, table detail, and bounded table-data endpoints.
 * Returns true after responding to a catalog path, or false for the shared router to continue.
 */
export async function routeCatalogRequest(
    service: CatalogService,
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
    path: string,
): Promise<boolean> {
    if (path === '/api/v1/catalogs') {
        requireMethod(request, response, ['GET']);
        sendJson(response, 200, { catalogs: await service.listCatalogs() });
        return true;
    }

    const schemasMatch = path.match(/^\/api\/v1\/catalogs\/([^/]+)\/schemas$/);
    if (schemasMatch != null) {
        requireMethod(request, response, ['GET']);
        sendJson(response, 200, {
            schemas: await service.listSchemas(decodeSegment(schemasMatch[1])),
        });
        return true;
    }

    const tablesMatch = path.match(
        /^\/api\/v1\/catalogs\/([^/]+)\/schemas\/([^/]+)\/tables$/,
    );
    if (tablesMatch != null) {
        requireMethod(request, response, ['GET']);
        sendJson(response, 200, {
            tables: await service.listTables(
                decodeSegment(tablesMatch[1]),
                decodeSegment(tablesMatch[2]),
            ),
        });
        return true;
    }

    const tableDataMatch = path.match(
        /^\/api\/v1\/catalogs\/([^/]+)\/schemas\/([^/]+)\/tables\/([^/]+)\/data$/,
    );
    if (tableDataMatch != null) {
        requireMethod(request, response, ['GET']);
        sendJson(response, 200, await service.getTableData(
            decodeSegment(tableDataMatch[1]),
            decodeSegment(tableDataMatch[2]),
            decodeSegment(tableDataMatch[3]),
            pageNumber(url.searchParams.get('limit'), 'limit', 100, 1, 100),
        ));
        return true;
    }

    const tableMatch = path.match(
        /^\/api\/v1\/catalogs\/([^/]+)\/schemas\/([^/]+)\/tables\/([^/]+)$/,
    );
    if (tableMatch != null) {
        requireMethod(request, response, ['GET']);
        sendJson(response, 200, await service.getTable(
            decodeSegment(tableMatch[1]),
            decodeSegment(tableMatch[2]),
            decodeSegment(tableMatch[3]),
        ));
        return true;
    }

    return false;
}

