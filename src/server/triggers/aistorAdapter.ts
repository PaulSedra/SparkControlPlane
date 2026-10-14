/**
 * @fileoverview Converts AIStor/S3 notification records into bounded canonical
 * trigger events.
 */

import crypto from 'node:crypto';
import { ControlPlaneApiError } from '../errors/controlPlaneApiError.ts';
import type { CanonicalTriggerEvent } from '../types/triggerTypes.ts';

/** Normalized event plus an optional record-level validation failure. */
export interface NormalizedAistorRecord {
    event: CanonicalTriggerEvent;
    invalidReason?: string;
}

/**
 * Converts an AIStor/S3 notification into one canonical event per record.
 *
 * Object keys are URL-decoded, provider metadata is copied into bounded string
 * attributes, and a stable record hash supplies a fallback identity when the
 * provider omits version, sequencer, or ETag data. Malformed records become
 * explicit invalid events with `invalidReason` instead of being dropped, so a
 * multi-record notification can report failures without losing valid records.
 */
export function normalizeAistorNotification(
    payload: unknown,
    receivedAt = new Date(),
): NormalizedAistorRecord[] {
    if (payload == null || typeof payload !== 'object' || Array.isArray(payload)) {
        throw new ControlPlaneApiError(400, 'AIStor notification must be a JSON object.');
    }
    const body = payload as Record<string, unknown>;
    const records = body.Records;
    if (records == null) {
        return [];
    }
    if (!Array.isArray(records)) {
        throw new ControlPlaneApiError(400, 'AIStor notification Records must be an array.');
    }
    return records.map((record, index) => normalizeRecord(record, index, receivedAt));
}

function normalizeRecord(
    value: unknown,
    index: number,
    receivedAt: Date,
): NormalizedAistorRecord {
    const record = value != null && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : {};
    const hash = stableHash(value);
    const baseAttributes: Record<string, string> = {
        recordIndex: String(index),
    };
    const eventName = stringValue(record.eventName);
    const s3 = objectValue(record.s3);
    const bucket = objectValue(s3?.bucket);
    const object = objectValue(s3?.object);
    if (eventName == null || bucket?.name == null || object?.key == null) {
        return invalidRecordResult(
            value,
            hash,
            baseAttributes,
            eventName,
            bucket?.name,
            object?.key,
            receivedAt,
        );
    }

    let objectKey: string;
    try {
        objectKey = decodeObjectKey(String(object.key));
    } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        return invalidObjectKeyResult(value, hash, baseAttributes, bucket.name, eventName, reason, receivedAt);
    }

    const attributes: Record<string, string> = {
        ...baseAttributes,
        bucket: String(bucket.name),
        eventName,
        objectKey,
    };
    addOptionalAttribute(attributes, 'bucketArn', bucket.arn);
    addOptionalAttribute(attributes, 'versionId', object.versionId);
    addOptionalAttribute(attributes, 'sequencer', object.sequencer);
    addOptionalAttribute(attributes, 'eTag', object.eTag);
    addOptionalAttribute(attributes, 'size', object.size);
    addOptionalAttribute(attributes, 'contentType', object.contentType);
    addOptionalAttribute(attributes, 'userMetadata', object.userMetadata);
    addOptionalAttribute(attributes, 'awsRegion', record.awsRegion);
    addOptionalAttribute(attributes, 'eventSource', record.eventSource);
    addOptionalAttribute(attributes, 'recordSource', record.source);

    const identity = firstString(object.versionId, object.sequencer, object.eTag);
    const deduplicationKey = identity == null
        ? `aistor:${String(bucket.name)}:${objectKey}:${hash}`
        : `aistor:${String(bucket.name)}:${objectKey}:${identity}`;
    const occurredAt = normalizedEventTime(record.eventTime, receivedAt);
    return {
        event: {
            attributes,
            deduplicationKey,
            eventId: `aistor:${hash}`,
            eventType: 'file.arrived',
            occurredAt,
            payload: cloneJson(record) as Record<string, unknown>,
            source: 'aistor',
        },
    };
}

function invalidRecordResult(
    value: unknown,
    hash: string,
    baseAttributes: Record<string, string>,
    eventName: string | undefined,
    bucketName: unknown,
    objectKey: unknown,
    receivedAt: Date,
): NormalizedAistorRecord {
    const missing = [
        eventName == null ? 'eventName' : undefined,
        bucketName == null ? 's3.bucket.name' : undefined,
        objectKey == null ? 's3.object.key' : undefined,
    ].filter((item): item is string => item != null).join(', ');
    const reason = `Missing required AIStor fields: ${missing}.`;
    return {
        event: {
            attributes: {
                ...baseAttributes,
                ...(eventName == null ? {} : { eventName }),
                ...(bucketName == null ? {} : { bucket: String(bucketName) }),
            },
            deduplicationKey: `aistor:invalid:${hash}`,
            eventId: `aistor:invalid:${hash}`,
            eventType: 'file.arrival.invalid',
            occurredAt: receivedAt.toISOString(),
            payload: { error: reason, record: cloneJson(value) },
            source: 'aistor',
        },
        invalidReason: reason,
    };
}

function invalidObjectKeyResult(
    value: unknown,
    hash: string,
    baseAttributes: Record<string, string>,
    bucketName: unknown,
    eventName: string,
    reason: string,
    receivedAt: Date,
): NormalizedAistorRecord {
    return {
        event: {
            attributes: {
                ...baseAttributes,
                bucket: String(bucketName),
                eventName,
            },
            deduplicationKey: `aistor:invalid:${hash}`,
            eventId: `aistor:invalid:${hash}`,
            eventType: 'file.arrival.invalid',
            occurredAt: receivedAt.toISOString(),
            payload: { error: reason, record: cloneJson(value) },
            source: 'aistor',
        },
        invalidReason: reason,
    };
}

function normalizedEventTime(value: unknown, receivedAt: Date): string {
    const eventTime = stringValue(value);
    return eventTime != null && Number.isFinite(Date.parse(eventTime))
        ? new Date(eventTime).toISOString()
        : receivedAt.toISOString();
}

function decodeObjectKey(value: string): string {
    try {
        return decodeURIComponent(value.replaceAll('+', ' '));
    } catch {
        throw new Error('AIStor object key contains invalid percent encoding.');
    }
}

function addOptionalAttribute(
    attributes: Record<string, string>,
    name: string,
    value: unknown,
): void {
    if (value == null) {
        return;
    }
    attributes[name] = typeof value === 'string' ? value : stableStringify(value);
}

function firstString(...values: unknown[]): string | undefined {
    return values
        .map(stringValue)
        .find((value): value is string => value != null);
}

function stringValue(value: unknown): string | undefined {
    return typeof value === 'string' && value !== '' ? value : undefined;
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
    return value != null && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : undefined;
}

function stableHash(value: unknown): string {
    return crypto.createHash('sha256').update(stableStringify(value)).digest('hex');
}

function stableStringify(value: unknown): string {
    if (value == null || typeof value !== 'object') {
        return JSON.stringify(value);
    }
    if (Array.isArray(value)) {
        return `[${value.map(stableStringify).join(',')}]`;
    }
    return `{${Object.keys(value as Record<string, unknown>)
        .sort((left, right) => left.localeCompare(right)).map((key) =>
        `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`
    ).join(',')}}`;
}

function cloneJson<T>(value: T): T {
    return JSON.parse(JSON.stringify(value)) as T;
}
