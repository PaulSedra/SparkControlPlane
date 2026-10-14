/**
 * @fileoverview HTTP routes for run state, events, status, and cancellation.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { PipelineRegistryService } from '../../types/pipelineServiceTypes.ts';
import {
    decodeSegment,
    readJsonBody,
    requireMethod,
    requestHeader,
} from '../http/request.ts';
import { optionalString, pageLimit, pageOffset } from '../http/validation.ts';
import { sendJson } from '../http/response.ts';

/**
 * Handles run history, event pages, status, detail, and cancellation endpoints.
 * Returns false when the path is not a run resource so the shared router can continue.
 */
export async function routeRunRequest(
    service: PipelineRegistryService,
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
    path: string,
    correlationId: string,
    requestSource?: string,
): Promise<boolean> {
    const runEventsMatch = path.match(/^\/api\/v1\/runs\/([^/]+)\/events$/);
    if (runEventsMatch != null) {
        requireMethod(request, response, ['GET']);
        const page = await service.listRunEventsPage(
            decodeSegment(runEventsMatch[1]),
            pageLimit(url),
            pageOffset(url),
        );
        sendJson(response, 200, page);
        return true;
    }

    const runStatusMatch = path.match(/^\/api\/v1\/runs\/([^/]+)\/status$/);
    if (runStatusMatch != null) {
        requireMethod(request, response, ['GET']);
        sendJson(response, 200, await service.getRunSummary(decodeSegment(runStatusMatch[1])));
        return true;
    }

    const runMatch = path.match(/^\/api\/v1\/runs\/([^/]+)$/);
    if (runMatch != null) {
        requireMethod(request, response, ['GET']);
        sendJson(response, 200, await service.getRun(decodeSegment(runMatch[1])));
        return true;
    }

    const cancelMatch = path.match(/^\/api\/v1\/runs\/([^/]+)\/cancel$/);
    if (cancelMatch == null) {
        return false;
    }
    requireMethod(request, response, ['POST']);
    const body = await readJsonBody(request) as { reason?: unknown };
    sendJson(
        response,
        200,
        await service.cancelRun(
            decodeSegment(cancelMatch[1]),
            requestHeader(request, 'x-actor'),
            optionalString(body.reason, 'reason'),
            { correlationId, requestSource },
        ),
    );
    return true;
}

