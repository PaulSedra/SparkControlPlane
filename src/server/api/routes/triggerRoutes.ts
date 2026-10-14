/**
 * @fileoverview HTTP routes for trigger administration, ingestion, diagnostics, and dead letters.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { ControlPlaneApiError } from '../../errors/controlPlaneApiError.ts';
import { normalizeCanonicalTriggerEvent } from '../../triggers/eventEnvelope.ts';
import type { PipelineRegistryService } from '../../types/pipelineServiceTypes.ts';
import type {
    TriggerDefinitionInput,
    TriggerDefinitionPatch,
    TriggerType,
} from '../../types/triggerTypes.ts';
import {
    TRIGGER_DEAD_LETTER_STATUSES,
    TriggerDeadLetterStatus,
} from '../../../shared/status/trigger.ts';
import type { PipelineHttpHandlerOptions } from '../httpTypes.ts';
import { requireAistorAuthorization } from '../http/authorization.ts';
import { decodeSegment, readJsonBody, requireMethod } from '../http/request.ts';
import {
    booleanValue,
    pageLimit,
    optionalQueryString,
    requestObject,
    requiredBodyString,
    stringArray,
} from '../http/validation.ts';
import { callerMetadata, runMode } from './pipelineRunValidation.ts';
import { sendJson } from '../http/response.ts';

/**
 * Handles trigger definitions, schedule status, event ingestion, delivery diagnostics, and dead letters.
 * AIStor notifications pass the configured bearer-token check before ingestion; unmatched paths return false.
 */
export async function routeTriggerRequest(
    service: PipelineRegistryService,
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
    path: string,
    options: PipelineHttpHandlerOptions,
): Promise<boolean> {
    if (await routeTriggerEventRequest(service, request, response, url, path, options)) {
        return true;
    }
    if (await routeDeadLetterRequest(service, request, response, url, path)) {
        return true;
    }
    return routeTriggerDefinitionRequest(service, request, response, url, path);
}

async function routeTriggerEventRequest(
    service: PipelineRegistryService,
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
    path: string,
    options: PipelineHttpHandlerOptions,
): Promise<boolean> {
    if (path === '/api/v1/triggers/events') {
        if (request.method === 'GET') {
            sendJson(response, 200, { events: await service.listTriggerEvents(pageLimit(url)) });
            return true;
        }
        requireMethod(request, response, ['POST']);
        const event = normalizeCanonicalTriggerEvent(await readJsonBody(request));
        sendJson(response, 202, await service.ingestTriggerEvent(event));
        return true;
    }
    if (path === '/api/v1/triggers/aistor/events') {
        requireMethod(request, response, ['POST']);
        requireAistorAuthorization(request, response, options.aistorWebhookToken);
        sendJson(response, 202, await service.ingestAistorNotification(await readJsonBody(request)));
        return true;
    }
    if (path === '/api/v1/triggers/routing-decisions') {
        requireMethod(request, response, ['GET']);
        sendJson(response, 200, {
            decisions: await service.listTriggerRoutingDecisions(
                optionalQueryString(url, 'eventId'),
                optionalQueryString(url, 'triggerId'),
                pageLimit(url),
            ),
        });
        return true;
    }
    if (path === '/api/v1/triggers/delivery-attempts') {
        requireMethod(request, response, ['GET']);
        sendJson(response, 200, {
            attempts: await service.listTriggerDeliveryAttempts(
                optionalQueryString(url, 'triggerId'),
                pageLimit(url),
            ),
        });
        return true;
    }
    return false;
}

async function routeDeadLetterRequest(
    service: PipelineRegistryService,
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
    path: string,
): Promise<boolean> {
    if (path === '/api/v1/triggers/dead-letters') {
        requireMethod(request, response, ['GET']);
        sendJson(response, 200, {
            deadLetters: await service.listTriggerDeadLetters(
                triggerDeadLetterStatus(url),
                pageLimit(url),
            ),
        });
        return true;
    }

    const match = path.match(/^\/api\/v1\/triggers\/dead-letters\/([^/]+)\/(replay|discard)$/);
    if (match == null) {
        return false;
    }
    requireMethod(request, response, ['POST']);
    const deadLetterId = decodeSegment(match[1]);
    if (match[2] === 'replay') {
        sendJson(response, 202, await service.replayTriggerDeadLetter(deadLetterId));
    } else {
        sendJson(response, 200, await service.discardTriggerDeadLetter(deadLetterId));
    }
    return true;
}

async function routeTriggerDefinitionRequest(
    service: PipelineRegistryService,
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
    path: string,
): Promise<boolean> {
    if (path === '/api/v1/triggers') {
        if (request.method === 'GET') {
            sendJson(response, 200, { triggers: await service.listTriggers() });
            return true;
        }
        requireMethod(request, response, ['POST']);
        const body = requestObject(await readJsonBody(request));
        const input: TriggerDefinitionInput = {
            callerMetadata: callerMetadata(body.callerMetadata),
            configuration: configurationObject(body.configuration),
            enabled: booleanValue(body.enabled, 'enabled', true),
            mode: runMode(body.mode),
            name: requiredBodyString(body.name, 'name'),
            nodeNames: stringArray(body.nodeNames, 'nodeNames'),
            pipelineId: requiredBodyString(body.pipelineId, 'pipelineId'),
            type: triggerType(body.type),
        };
        sendJson(response, 201, await service.createTrigger(input));
        return true;
    }

    const scheduleMatch = path.match(/^\/api\/v1\/triggers\/([^/]+)\/schedule$/);
    if (scheduleMatch != null) {
        requireMethod(request, response, ['GET']);
        sendJson(
            response,
            200,
            await service.getTriggerScheduleStatus(decodeSegment(scheduleMatch[1])),
        );
        return true;
    }

    const triggerMatch = path.match(/^\/api\/v1\/triggers\/([^/]+)$/);
    if (triggerMatch == null) {
        return false;
    }
    const triggerId = decodeSegment(triggerMatch[1]);
    if (request.method === 'GET') {
        sendJson(response, 200, await service.getTrigger(triggerId));
        return true;
    }
    requireMethod(request, response, ['PATCH']);
    const body = requestObject(await readJsonBody(request));
    sendJson(response, 200, await service.updateTrigger(triggerId, triggerPatch(body)));
    return true;
}

function triggerPatch(body: Record<string, unknown>): TriggerDefinitionPatch {
    const patch: TriggerDefinitionPatch = {};
    if (Object.prototype.hasOwnProperty.call(body, 'callerMetadata')) {
        patch.callerMetadata = callerMetadata(body.callerMetadata);
    }
    if (Object.prototype.hasOwnProperty.call(body, 'configuration')) {
        patch.configuration = configurationObject(body.configuration);
    }
    if (Object.prototype.hasOwnProperty.call(body, 'enabled')) {
        patch.enabled = booleanValue(body.enabled, 'enabled');
    }
    if (Object.prototype.hasOwnProperty.call(body, 'mode')) {
        patch.mode = runMode(body.mode);
    }
    if (Object.prototype.hasOwnProperty.call(body, 'name')) {
        patch.name = requiredBodyString(body.name, 'name');
    }
    if (Object.prototype.hasOwnProperty.call(body, 'nodeNames')) {
        patch.nodeNames = stringArray(body.nodeNames, 'nodeNames');
    }
    if (Object.prototype.hasOwnProperty.call(body, 'pipelineId')) {
        patch.pipelineId = requiredBodyString(body.pipelineId, 'pipelineId');
    }
    if (Object.prototype.hasOwnProperty.call(body, 'type')) {
        patch.type = triggerType(body.type);
    }
    return patch;
}

/** Requires a non-null, non-array object for trigger configuration. */
function configurationObject(value: unknown): Record<string, unknown> {
    if (value == null || typeof value !== 'object' || Array.isArray(value)) {
        throw new ControlPlaneApiError(400, 'configuration must be an object.');
    }
    return value as Record<string, unknown>;
}

/** Parses the optional dead-letter status filter and rejects values outside its three states. */
function triggerDeadLetterStatus(url: URL): TriggerDeadLetterStatus | undefined {
    const value = optionalQueryString(url, 'status');
    if (value == null) {
        return undefined;
    }
    const status = value as TriggerDeadLetterStatus;
    if (TRIGGER_DEAD_LETTER_STATUSES.includes(status)) {
        return status;
    }
    throw new ControlPlaneApiError(400, 'status must be PENDING, REPLAYED, or DISCARDED.');
}

/** Parses one of the supported trigger types or throws a 400 API error. */
function triggerType(value: unknown): TriggerType {
    if (value === 'FILE_ARRIVAL' || value === 'SCHEDULE' || value === 'WEBHOOK') {
        return value;
    }
    throw new ControlPlaneApiError(400, 'Unsupported trigger type: ' + String(value));
}

