/**
 * @fileoverview HTTP routes for pipeline discovery, deployment, source, data, and run listing/submission.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { ControlPlaneApiError } from '../../errors/controlPlaneApiError.ts';
import type { PipelineRegistryService, RunSubmission } from '../../types/pipelineServiceTypes.ts';
import {
    decodeSegment,
    readJsonBody,
    requireMethod,
    requestHeader,
} from '../http/request.ts';
import {
    optionalString,
    pageLimit,
    pageOffset,
    requiredQueryParam,
    stringArray,
} from '../http/validation.ts';
import { callerMetadata, runMode } from './pipelineRunValidation.ts';
import { sendJson, setRunHeaders } from '../http/response.ts';

/**
 * Handles pipeline list/detail, deployment, source, node-data, and run listing/submission routes.
 * Run submissions return 202 with run-location and retry headers; unmatched paths return false.
 */
export async function routePipelineRequest(
    service: PipelineRegistryService,
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
    path: string,
    correlationId: string,
    requestSource?: string,
): Promise<boolean> {
    if (path === '/api/v1/pipelines/refresh-from-source') {
        requireMethod(request, response, ['POST']);
        const pipelines = await service.refreshPipelinesFromSource();
        sendJson(response, 200, { pipelines, total: pipelines.length });
        return true;
    }

    if (path === '/api/v1/pipelines') {
        requireMethod(request, response, ['GET']);
        const page = await service.listPipelinesPage(pageLimit(url), pageOffset(url));
        sendJson(response, 200, {
            items: page.items,
            nextOffset: page.nextOffset,
            offset: page.offset,
            pipelines: page.items,
            total: page.total,
        }, 'private, max-age=1, stale-while-revalidate=5');
        return true;
    }

    const dataMatch = path.match(/^\/api\/v1\/pipelines\/([^/]+)\/nodes\/([^/]+)\/data$/);
    if (dataMatch != null) {
        requireMethod(request, response, ['GET']);
        sendJson(response, 200, await service.getPipelineNodeData(
            decodeSegment(dataMatch[1]),
            decodeSegment(dataMatch[2]),
        ));
        return true;
    }

    const sourceMatch = path.match(/^\/api\/v1\/pipelines\/([^/]+)\/source$/);
    if (sourceMatch != null) {
        requireMethod(request, response, ['GET']);
        sendJson(response, 200, await service.getPipelineSourceFile(
            decodeSegment(sourceMatch[1]),
            requiredQueryParam(url, 'file'),
        ));
        return true;
    }

    const pipelineRunsMatch = path.match(/^\/api\/v1\/pipelines\/([^/]+)\/runs$/);
    if (pipelineRunsMatch != null) {
        requireMethod(request, response, ['GET', 'POST']);
        if (request.method === 'GET') {
            const page = await service.listPipelineRunsPage(
                decodeSegment(pipelineRunsMatch[1]),
                pageLimit(url),
                pageOffset(url),
            );
            sendJson(response, 200, page);
        } else {
            await submitPipelineRun(
                service,
                request,
                response,
                pipelineRunsMatch[1],
                correlationId,
                requestSource,
            );
        }
        return true;
    }

    const deployMatch = path.match(/^\/api\/v1\/pipelines\/([^/]+)\/deploy$/);
    if (deployMatch != null) {
        requireMethod(request, response, ['POST']);
        sendJson(response, 200, await service.deployPipeline(decodeSegment(deployMatch[1]), {
            correlationId,
            requestSource,
        }));
        return true;
    }

    const pipelineMatch = path.match(/^\/api\/v1\/pipelines\/([^/]+)$/);
    if (pipelineMatch == null) {
        return false;
    }
    requireMethod(request, response, ['GET']);
    const includeRuns = url.searchParams.get('includeRuns') !== 'false';
    sendJson(
        response,
        200,
        await service.getPipeline(decodeSegment(pipelineMatch[1]), { includeRuns }),
        includeRuns ? undefined : 'private, max-age=5, stale-while-revalidate=30',
    );
    return true;
}

async function submitPipelineRun(
    service: PipelineRegistryService,
    request: IncomingMessage,
    response: ServerResponse,
    encodedPipelineId: string,
    correlationId: string,
    requestSource?: string,
): Promise<void> {
    requireMethod(request, response, ['POST']);
    const body = await readJsonBody(request) as Partial<RunSubmission>;
    const bodyIdempotencyKey = optionalString(body.idempotencyKey, 'idempotencyKey');
    const headerIdempotencyKey = requestHeader(request, 'idempotency-key');
    if (bodyIdempotencyKey != null && headerIdempotencyKey != null &&
        bodyIdempotencyKey !== headerIdempotencyKey) {
        throw new ControlPlaneApiError(400, 'The body idempotencyKey and Idempotency-Key header must match.');
    }
    const result = await service.submitRun({
        callerMetadata: callerMetadata(body.callerMetadata),
        correlationId,
        idempotencyKey: headerIdempotencyKey ?? bodyIdempotencyKey,
        mode: runMode(body.mode),
        nodeNames: stringArray(body.nodeNames, 'nodeNames'),
        pipelineId: decodeSegment(encodedPipelineId),
        requestSource: optionalString(body.requestSource, 'requestSource') ?? requestSource,
    });
    setRunHeaders(response, result.run.runId, result.replayed);
    sendJson(response, 202, result.run);
}

