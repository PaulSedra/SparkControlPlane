/**
 * @fileoverview Validates pipeline trigger declarations and binds them to pipeline identities.
 */

import { ControlPlaneApiError } from '../../errors/controlPlaneApiError.ts';
import type { RunMode } from '../../../shared/pipelineRegistryTypes.ts';
import type { TriggerDefinitionInput, TriggerType } from '../../types/triggerTypes.ts';
import { validateTriggerInput } from './triggerValidation.ts';
import { parseYamlDocument } from './yamlParser.ts';

const RUN_MODES = new Set<RunMode>([
    'incremental',
    'full-refresh-all',
    'repair-failed',
    'dry-run',
    'refresh-selected',
    'full-refresh-selected',
]);

/** Trigger definition parsed from YAML before a pipeline ID is bound. */
export type YamlTriggerDefinition = Omit<TriggerDefinitionInput, 'pipelineId'>;

/**
 * Parses and validates trigger entries from a pipeline YAML document.
 *
 * Only the repository's supported root and trigger keys are accepted;
 * duplicate trigger names, unsupported run modes, malformed configurations,
 * and YAML errors are reported with the source path so discovery can surface a
 * precise validation message rather than silently dropping a trigger.
 */
export function parsePipelineYamlTriggers(
    content: string,
    sourcePath: string,
): YamlTriggerDefinition[] {
    let parsed: unknown;
    try {
        parsed = parseYamlDocument(content);
    } catch (error) {
        throw yamlError(sourcePath, error);
    }

    try {
        return parseDefinitions(parsed, sourcePath);
    } catch (error) {
        throw yamlError(sourcePath, error);
    }
}

/**
 * Binds validated, pipeline-local YAML trigger definitions to the durable
 * pipeline identity used by persistence and event routing.
 */
export function bindYamlTriggerDefinitions(
    definitions: YamlTriggerDefinition[],
    pipelineId: string,
): TriggerDefinitionInput[] {
    return definitions.map((definition) => ({
        ...definition,
        pipelineId,
    }));
}

function parseDefinitions(value: unknown, sourcePath: string): YamlTriggerDefinition[] {
    const root = recordValue(value, sourcePath);
    allowedKeys(root, [
        'catalog',
        'configuration',
        'database',
        'libraries',
        'name',
        'on_success',
        'schema',
        'storage',
        'timeout_seconds',
        'triggers',
    ], sourcePath);
    if (!Object.prototype.hasOwnProperty.call(root, 'triggers')) {
        return [];
    }
    if (!Array.isArray(root.triggers)) {
        throw new TypeError('triggers must be a YAML sequence');
    }
    const names = new Set<string>();
    return root.triggers.map((entry, index) => {
        const definition = parseDefinition(entry, `${sourcePath}:triggers[${index}]`);
        if (names.has(definition.name)) {
            throw new Error(`duplicate trigger name "${definition.name}"`);
        }
        names.add(definition.name);
        return definition;
    });
}

function parseDefinition(value: unknown, location: string): YamlTriggerDefinition {
    const entry = recordValue(value, location);
    allowedKeys(entry, [
        'caller_metadata',
        'enabled',
        'mode',
        'name',
        'node_names',
        'schedule',
        'trigger',
    ], location);
    const hasSchedule = Object.prototype.hasOwnProperty.call(entry, 'schedule');
    const hasTrigger = Object.prototype.hasOwnProperty.call(entry, 'trigger');
    if (hasSchedule === hasTrigger) {
        throw new Error('define exactly one of schedule or trigger');
    }

    const triggerKey = hasSchedule ? 'schedule' : 'trigger';
    const enabled = enabledValue(entry, triggerKey, entry[triggerKey], location);
    const definitionBase = {
        callerMetadata: stringRecordValue(entry.caller_metadata, `${location}.caller_metadata`),
        enabled,
        mode: runModeValue(entry.mode, `${location}.mode`),
        name: requiredString(entry.name, `${location}.name`),
        nodeNames: stringArrayValue(entry.node_names, `${location}.node_names`),
    };
    const definition = hasSchedule
        ? {
            ...definitionBase,
            configuration: parseSchedule(entry.schedule, `${location}.schedule`),
            type: 'SCHEDULE' as const,
        }
        : {
            ...definitionBase,
            ...parseEventTrigger(entry.trigger, `${location}.trigger`),
        };

    try {
        const validated = validateTriggerInput({
            ...definition,
            pipelineId: 'yaml-resource',
        });
        return {
            callerMetadata: validated.callerMetadata,
            configuration: validated.configuration,
            enabled: validated.enabled,
            mode: validated.mode,
            name: validated.name,
            nodeNames: validated.nodeNames,
            type: validated.type,
        };
    } catch (error) {
        throw new Error(error instanceof Error ? error.message : String(error));
    }
}

function parseSchedule(value: unknown, location: string): Record<string, unknown> {
    const schedule = recordValue(value, location);
    allowedKeys(schedule, [
        'cron',
        'misfire_policy',
        'pause_status',
        'timezone_id',
    ], location);
    return {
        cron: requiredString(schedule.cron, `${location}.cron`),
        misfirePolicy: optionalString(schedule.misfire_policy, `${location}.misfire_policy`) ??
            'CATCH_UP_ONCE',
        timeZone: requiredString(schedule.timezone_id, `${location}.timezone_id`),
    };
}

function parseEventTrigger(
    value: unknown,
    location: string,
): { configuration: Record<string, unknown>; type: TriggerType } {
    const trigger = recordValue(value, location);
    allowedKeys(trigger, ['file_arrival', 'pause_status', 'webhook'], location);
    const hasFileArrival = Object.prototype.hasOwnProperty.call(trigger, 'file_arrival');
    const hasWebhook = Object.prototype.hasOwnProperty.call(trigger, 'webhook');
    if (hasFileArrival === hasWebhook) {
        throw new Error('define exactly one of file_arrival or webhook under trigger');
    }
    if (hasFileArrival) {
        return {
            configuration: parseFileArrival(trigger.file_arrival, `${location}.file_arrival`),
            type: 'FILE_ARRIVAL',
        };
    }
    return {
        configuration: parseWebhook(trigger.webhook, `${location}.webhook`),
        type: 'WEBHOOK',
    };
}

function parseFileArrival(value: unknown, location: string): Record<string, unknown> {
    const fileArrival = recordValue(value, location);
    allowedKeys(fileArrival, [
        'debounce_milliseconds',
        'event_names',
        'min_time_between_triggers_seconds',
        'url',
        'urls',
        'wait_after_last_change_seconds',
    ], location);
    if (fileArrival.min_time_between_triggers_seconds != null) {
        throw new Error(
            `${location}.min_time_between_triggers_seconds is not supported; use wait_after_last_change_seconds`,
        );
    }
    const hasUrl = Object.prototype.hasOwnProperty.call(fileArrival, 'url');
    const hasUrls = Object.prototype.hasOwnProperty.call(fileArrival, 'urls');
    if (hasUrl === hasUrls) {
        throw new Error(`${location} must define exactly one of url or urls`);
    }
    const storageLocations = hasUrls
        ? requiredStringArrayValue(fileArrival.urls, `${location}.urls`)
            .map((url, index) => storageLocation(url, `${location}.urls[${index}]`))
        : [storageLocation(fileArrival.url, `${location}.url`)];
    const waitSeconds = integerValue(
        fileArrival.wait_after_last_change_seconds,
        `${location}.wait_after_last_change_seconds`,
    );
    const debounceMilliseconds = integerValue(
        fileArrival.debounce_milliseconds,
        `${location}.debounce_milliseconds`,
    );
    if (waitSeconds != null && debounceMilliseconds != null) {
        throw new Error(
            `${location} must define only one of wait_after_last_change_seconds or debounce_milliseconds`,
        );
    }
    return {
        debounceMilliseconds: waitSeconds == null
            ? debounceMilliseconds
            : waitSeconds * 1000,
        eventNames: stringArrayValue(fileArrival.event_names, `${location}.event_names`) ?? [],
        ...(hasUrls
            ? { locations: storageLocations }
            : {
                bucket: storageLocations[0].bucket,
                prefix: storageLocations[0].prefix,
            }),
    };
}

function parseWebhook(value: unknown, location: string): Record<string, unknown> {
    const webhook = recordValue(value, location);
    allowedKeys(webhook, [
        'attributes',
        'debounce_milliseconds',
        'event_type',
        'source',
    ], location);
    return {
        attributes: stringRecordValue(webhook.attributes, `${location}.attributes`) ?? {},
        debounceMilliseconds: integerValue(
            webhook.debounce_milliseconds,
            `${location}.debounce_milliseconds`,
        ),
        eventType: optionalString(webhook.event_type, `${location}.event_type`),
        source: optionalString(webhook.source, `${location}.source`),
    };
}

function enabledValue(
    entry: Record<string, unknown>,
    triggerKey: string,
    triggerValue: unknown,
    location: string,
): boolean {
    const trigger = recordValue(triggerValue, `${location}.${triggerKey}`);
    const pauseStatus = optionalString(trigger.pause_status, `${location}.${triggerKey}.pause_status`);
    const enabled = entry.enabled;
    if (pauseStatus != null && enabled != null) {
        throw new Error(`${location} must define only one of enabled or pause_status`);
    }
    if (enabled != null) {
        if (typeof enabled !== 'boolean') {
            throw new TypeError(`${location}.enabled must be a boolean`);
        }
        return enabled;
    }
    if (pauseStatus == null || pauseStatus === 'UNPAUSED') {
        return true;
    }
    if (pauseStatus === 'PAUSED') {
        return false;
    }
    throw new Error(`${location}.pause_status must be PAUSED or UNPAUSED`);
}

function storageLocation(value: unknown, location: string): { bucket: string; prefix: string } {
    const raw = requiredString(value, location);
    let url: URL;
    try {
        url = new URL(raw);
    } catch {
        throw new Error(`${location} must be an s3:// or aistor:// URL`);
    }
    if (url.protocol !== 's3:' && url.protocol !== 'aistor:') {
        throw new Error(`${location} must be an s3:// or aistor:// URL`);
    }
    if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') {
        throw new Error(`${location} must not contain credentials, query parameters, or fragments`);
    }
    if (url.hostname === '') {
        throw new Error(`${location} must include a bucket name`);
    }
    let prefix: string;
    try {
        prefix = decodeURIComponent(url.pathname.replace(/^\/+/, ''));
    } catch {
        throw new Error(`${location} contains an invalid URL-encoded prefix`);
    }
    return { bucket: url.hostname, prefix };
}

function runModeValue(value: unknown, location: string): RunMode {
    if (value == null) {
        return 'incremental';
    }
    const mode = requiredString(value, location);
    if (RUN_MODES.has(mode as RunMode)) {
        return mode as RunMode;
    }
    throw new Error(`${location} has unsupported pipeline run mode ${mode}`);
}

function requiredString(value: unknown, location: string): string {
    const result = optionalString(value, location);
    if (result == null) {
        throw new Error(`${location} must be a non-empty string`);
    }
    return result;
}

function optionalString(value: unknown, location: string): string | undefined {
    if (value == null) {
        return undefined;
    }
    if (typeof value !== 'string' || value.trim() === '') {
        throw new Error(`${location} must be a non-empty string`);
    }
    return value.trim();
}

function integerValue(value: unknown, location: string): number | undefined {
    if (value == null) {
        return undefined;
    }
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
        throw new Error(`${location} must be a non-negative integer`);
    }
    return value;
}

function stringArrayValue(value: unknown, location: string): string[] | undefined {
    if (value == null) {
        return undefined;
    }
    if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || item.trim() === '')) {
        throw new Error(`${location} must be an array of non-empty strings`);
    }
    return value.map((item) => item.trim());
}

function requiredStringArrayValue(value: unknown, location: string): string[] {
    const result = stringArrayValue(value, location);
    if (result == null || result.length === 0) {
        throw new Error(`${location} must be a non-empty array of non-empty strings`);
    }
    return result;
}

function stringRecordValue(
    value: unknown,
    location: string,
): Record<string, string> | undefined {
    if (value == null) {
        return undefined;
    }
    const record = recordValue(value, location);
    if (Object.entries(record).some(([key, item]) =>
        key.trim() === '' || typeof item !== 'string'
    )) {
        throw new Error(`${location} must be an object of string values`);
    }
    return Object.fromEntries(
        Object.entries(record).map(([key, item]) => [key.trim(), (item as string).trim()]),
    );
}

function recordValue(value: unknown, location: string): Record<string, unknown> {
    if (value == null || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error(`${location} must be a YAML mapping`);
    }
    return value as Record<string, unknown>;
}

function allowedKeys(
    record: Record<string, unknown>,
    allowed: string[],
    location: string,
): void {
    const allowedSet = new Set(allowed);
    const unknown = Object.keys(record).find((key) => !allowedSet.has(key));
    if (unknown != null) {
        throw new Error(`${location}.${unknown} is not supported`);
    }
}

function yamlError(sourcePath: string, error: unknown): ControlPlaneApiError {
    return new ControlPlaneApiError(
        400,
        `Invalid trigger YAML in ${sourcePath}: ${error instanceof Error ? error.message : String(error)}`,
    );
}
