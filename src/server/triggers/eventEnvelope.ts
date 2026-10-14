/**
 * @fileoverview Validation and normalization for caller-supplied trigger
 * event envelopes.
 */

import { ControlPlaneApiError } from '../errors/controlPlaneApiError.ts';
import type { CanonicalTriggerEvent } from '../types/triggerTypes.ts';

const MAX_EVENT_ID_LENGTH = 512;
const MAX_EVENT_TYPE_LENGTH = 256;
const MAX_SOURCE_LENGTH = 256;
const MAX_DEDUPLICATION_KEY_LENGTH = 1024;

/**
 * Validates and canonicalizes an externally supplied trigger event.
 *
 * The boundary rejects non-objects, missing/oversized identifiers, invalid
 * timestamps, non-string attributes, and non-object payloads; accepted strings
 * are trimmed and timestamps are rewritten to ISO form. It has no persistence
 * side effect, so callers can safely validate before recording the event.
 */
export function normalizeCanonicalTriggerEvent(
    value: unknown,
): CanonicalTriggerEvent {
    if (value == null || typeof value !== 'object' || Array.isArray(value)) {
        throw new ControlPlaneApiError(400, 'Trigger event must be a JSON object.');
    }
    const body = value as Record<string, unknown>;
    const eventId = requiredString(body.eventId, 'eventId', MAX_EVENT_ID_LENGTH);
    const eventType = requiredString(body.eventType, 'eventType', MAX_EVENT_TYPE_LENGTH);
    const source = requiredString(body.source, 'source', MAX_SOURCE_LENGTH);
    const occurredAt = eventTimestamp(body.occurredAt);
    const attributes = stringRecord(body.attributes, 'attributes');
    const payload = jsonObject(body.payload, 'payload');
    const deduplicationKey = requiredString(
        body.deduplicationKey,
        'deduplicationKey',
        MAX_DEDUPLICATION_KEY_LENGTH,
    );
    return {
        attributes,
        deduplicationKey,
        eventId,
        eventType,
        occurredAt,
        payload,
        source,
    };
}

function requiredString(value: unknown, name: string, maximum: number): string {
    if (typeof value !== 'string' || value.trim() === '') {
        throw new ControlPlaneApiError(400, `${name} must be a non-empty string.`);
    }
    const normalized = value.trim();
    if (normalized.length > maximum) {
        throw new ControlPlaneApiError(400, `${name} must not exceed ${maximum} characters.`);
    }
    return normalized;
}

function eventTimestamp(value: unknown): string {
    if (typeof value !== 'string' || value.trim() === '' || !Number.isFinite(Date.parse(value))) {
        throw new ControlPlaneApiError(400, 'occurredAt must be a valid RFC3339 timestamp.');
    }
    return new Date(value).toISOString();
}

function stringRecord(value: unknown, name: string): Record<string, string> {
    if (value == null || typeof value !== 'object' || Array.isArray(value)) {
        throw new ControlPlaneApiError(400, `${name} must be an object of string values.`);
    }
    const entries = Object.entries(value);
    if (entries.length > 64 || entries.some(([key, item]) =>
        key.length === 0 || key.length > 128 || typeof item !== 'string' || item.length > 1024
    )) {
        throw new ControlPlaneApiError(400, `${name} must contain at most 64 bounded string entries.`);
    }
    return Object.fromEntries(entries.map(([key, item]) => [key, item as string]));
}

function jsonObject(value: unknown, name: string): Record<string, unknown> {
    if (value == null || typeof value !== 'object' || Array.isArray(value)) {
        throw new ControlPlaneApiError(400, `${name} must be a JSON object.`);
    }
    return value as Record<string, unknown>;
}
