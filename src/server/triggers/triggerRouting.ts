/**
 * @fileoverview Parses trigger selectors and matches canonical events,
 * including backward-compatible single-location file-arrival settings.
 */

import type { CanonicalTriggerEvent, TriggerDefinition } from '../types/triggerTypes.ts';

const DEFAULT_FILE_DEBOUNCE_MILLISECONDS = 5_000;
const MAX_DEBOUNCE_MILLISECONDS = 300_000;

/** Selector and debounce settings for a webhook trigger. */
export interface WebhookConfiguration {
    attributes: Record<string, string>;
    debounceMilliseconds: number;
    eventType?: string;
    source?: string;
}

/** One bucket/prefix location accepted by a file-arrival trigger. */
export interface FileArrivalLocation {
    bucket: string;
    prefix: string;
}

/** Parsed multi-location file-arrival selector and debounce settings. */
export interface FileArrivalConfiguration {
    debounceMilliseconds: number;
    eventNames: string[];
    locations: FileArrivalLocation[];
}

/**
 * Parses a webhook selector and its optional debounce interval.
 *
 * At least one of event type, source, or attribute selectors is required;
 * selector strings are trimmed and the debounce value is bounded to five
 * minutes. The returned selector is pure configuration and does not inspect or
 * persist an event until `matchesTrigger` is called.
 */
export function parseWebhookConfiguration(
    configuration: Record<string, unknown>,
): WebhookConfiguration {
    const eventType = optionalConfigurationString(configuration.eventType, 'eventType');
    const source = optionalConfigurationString(configuration.source, 'source');
    const attributes = configuration.attributes == null
        ? {}
        : stringRecord(configuration.attributes, 'attributes');
    const debounceMilliseconds = debounce(configuration.debounceMilliseconds, 0);
    if (eventType == null && source == null && Object.keys(attributes).length === 0) {
        throw new Error('Webhook configuration must specify an eventType, source, or attributes selector.');
    }
    return { attributes, debounceMilliseconds, eventType, source };
}

/**
 * Parses file-arrival locations while preserving the legacy single-location
 * shape.
 *
 * A plural `locations` array creates OR-matched bucket/prefix selectors; when
 * it is absent, `bucket` and `prefix` are read as the backward-compatible
 * single location. Event-name filters are also OR-matched, and an omitted
 * debounce uses the five-second default.
 */
export function parseFileArrivalConfiguration(
    configuration: Record<string, unknown>,
): FileArrivalConfiguration {
    const locations = Object.hasOwn(configuration, 'locations')
        ? fileArrivalLocations(configuration.locations)
        : [legacyFileArrivalLocation(configuration)];
    const eventNames = configuration.eventNames == null
        ? []
        : stringArray(configuration.eventNames, 'eventNames');
    return {
        debounceMilliseconds: debounce(
            configuration.debounceMilliseconds,
            DEFAULT_FILE_DEBOUNCE_MILLISECONDS,
        ),
        eventNames,
        locations,
    };
}

/**
 * Determines whether an event is eligible for a trigger.
 *
 * Webhooks match their configured event/source/attribute selectors. File
 * arrivals must come from AIStor, use `file.arrived`, match any configured
 * bucket/prefix location, and satisfy the optional event-name filter; schedule
 * triggers are evaluated by the scheduler and never match here. Invalid
 * configuration throws so callers can record an explicit routing failure.
 */
export function matchesTrigger(
    trigger: TriggerDefinition,
    event: CanonicalTriggerEvent,
): boolean {
    if (trigger.type === 'WEBHOOK') {
        const configuration = parseWebhookConfiguration(trigger.configuration);
        return (configuration.eventType == null || configuration.eventType === event.eventType) &&
            (configuration.source == null || configuration.source === event.source) &&
            Object.entries(configuration.attributes).every(([key, value]) =>
                event.attributes[key] === value
            );
    }
    if (trigger.type === 'FILE_ARRIVAL') {
        const configuration = parseFileArrivalConfiguration(trigger.configuration);
        const eventName = event.attributes.eventName;
        return event.source === 'aistor' &&
            event.eventType === 'file.arrived' &&
            configuration.locations.some((location) =>
                event.attributes.bucket === location.bucket &&
                event.attributes.objectKey?.startsWith(location.prefix)
            ) &&
            (configuration.eventNames.length === 0 ||
                (eventName != null && configuration.eventNames.includes(eventName)));
    }
    return false;
}

/**
 * Returns the validated debounce window for a trigger.
 *
 * File-arrival triggers default to five seconds, webhook triggers default to
 * no delay, and schedule triggers never debounce because their occurrence ID
 * already provides the deduplication boundary.
 */
export function debounceMilliseconds(
    trigger: TriggerDefinition,
): number {
    if (trigger.type === 'FILE_ARRIVAL') {
        return parseFileArrivalConfiguration(trigger.configuration).debounceMilliseconds;
    }
    if (trigger.type === 'WEBHOOK') {
        return parseWebhookConfiguration(trigger.configuration).debounceMilliseconds;
    }
    return 0;
}

function requiredConfigurationString(value: unknown, name: string): string {
    const result = optionalConfigurationString(value, name);
    if (result == null) {
        throw new Error(`Trigger configuration ${name} must be a non-empty string.`);
    }
    return result;
}

function optionalConfigurationString(value: unknown, name: string): string | undefined {
    if (value == null) {
        return undefined;
    }
    if (typeof value !== 'string' || value.trim() === '') {
        throw new Error(`Trigger configuration ${name} must be a non-empty string.`);
    }
    return value.trim();
}

function stringRecord(value: unknown, name: string): Record<string, string> {
    if (value == null || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error(`Trigger configuration ${name} must be an object of string values.`);
    }
    const entries = Object.entries(value);
    if (entries.some(([key, item]) => key.trim() === '' || typeof item !== 'string')) {
        throw new Error(`Trigger configuration ${name} must be an object of string values.`);
    }
    return Object.fromEntries(entries.map(([key, item]) => [key, item.trim()]));
}

function stringArray(value: unknown, name: string): string[] {
    if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || item.trim() === '')) {
        throw new Error(`Trigger configuration ${name} must be an array of non-empty strings.`);
    }
    return value.map((item) => item.trim());
}

function legacyFileArrivalLocation(
    configuration: Record<string, unknown>,
): FileArrivalLocation {
    return {
        bucket: requiredConfigurationString(configuration.bucket, 'bucket'),
        prefix: requiredConfigurationString(configuration.prefix, 'prefix'),
    };
}

function fileArrivalLocations(value: unknown): FileArrivalLocation[] {
    if (!Array.isArray(value) || value.length === 0) {
        throw new Error('Trigger configuration locations must be a non-empty array.');
    }
    return value.map((item, index) => {
        if (item == null || typeof item !== 'object' || Array.isArray(item)) {
            throw new Error(`Trigger configuration locations[${index}] must be an object.`);
        }
        const location = item as Record<string, unknown>;
        return {
            bucket: requiredConfigurationString(
                location.bucket,
                `locations[${index}].bucket`,
            ),
            prefix: requiredConfigurationString(
                location.prefix,
                `locations[${index}].prefix`,
            ),
        };
    });
}

function debounce(value: unknown, defaultValue: number): number {
    if (value == null) {
        return defaultValue;
    }
    if (typeof value !== 'number' || !Number.isInteger(value) ||
        value < 0 || value > MAX_DEBOUNCE_MILLISECONDS) {
        throw new Error(`Trigger configuration debounceMilliseconds must be an integer between 0 and ${MAX_DEBOUNCE_MILLISECONDS}.`);
    }
    return value;
}
