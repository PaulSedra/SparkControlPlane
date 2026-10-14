/**
 * @fileoverview HTTP route for resumable run and audit history export.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { HistoryExportCursor } from '../../history/historyExport.ts';
import type { PipelineRegistryService } from '../../types/pipelineServiceTypes.ts';
import { requireMethod } from '../http/request.ts';
import { pageNumber } from '../http/validation.ts';
import { sendJson } from '../http/response.ts';

/**
 * Handles resumable history export requests and their cursor and page-limit validation.
 * Returns false for paths outside the history-export endpoint.
 */
export async function routeHistoryRequest(
    service: PipelineRegistryService,
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
    path: string,
): Promise<boolean> {
    if (path !== '/api/v1/history/export') {
        return false;
    }
    requireMethod(request, response, ['GET']);
    sendJson(response, 200, await service.exportHistoryBatch(
        historyCursor(url),
        pageNumber(url.searchParams.get('limit'), 'limit', 100, 1, 1000),
    ));
    return true;
}

/** Parses the independent run-event and audit-event cursors used by history export. */
function historyCursor(url: URL): HistoryExportCursor {
    return {
        auditEventId: pageNumber(
            url.searchParams.get('auditEventId'),
            'auditEventId',
            0,
            0,
            Number.MAX_SAFE_INTEGER,
        ),
        runEventId: pageNumber(
            url.searchParams.get('runEventId'),
            'runEventId',
            0,
            0,
            Number.MAX_SAFE_INTEGER,
        ),
    };
}

