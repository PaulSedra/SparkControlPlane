/**
 * @fileoverview Validates the supported five-field cron subset and resolves
 * occurrences in named IANA time zones.
 */

import type {
    MisfirePolicy,
    ScheduleConfiguration,
    ScheduleOccurrence,
} from '../types/triggerTypes.ts';

const MISFIRE_POLICY: MisfirePolicy = 'CATCH_UP_ONCE';
const CRON_FIELD_NAMES = [
    'minute',
    'hour',
    'day-of-month',
    'month',
    'day-of-week',
] as const;
const CRON_FIELD_RANGES: ReadonlyArray<readonly [number, number]> = [
    [0, 59],
    [0, 23],
    [1, 31],
    [1, 12],
    [0, 7],
];
const MINUTE_MILLISECONDS = 60_000;
const MAX_SEARCH_MINUTES = 366 * 24 * 60;

interface ParsedCronExpression {
    dayOfMonth: Set<number>;
    dayOfMonthWildcard: boolean;
    dayOfWeek: Set<number>;
    dayOfWeekWildcard: boolean;
    hour: Set<number>;
    minute: Set<number>;
    month: Set<number>;
}

/**
 * Parses the supported five-field schedule configuration.
 *
 * Numeric lists, ranges, and steps are accepted for minute, hour,
 * day-of-month, month, and day-of-week fields. The time zone must be a valid
 * IANA name, and the only supported misfire policy is `CATCH_UP_ONCE`.
 */
export function parseScheduleConfiguration(
    configuration: Record<string, unknown>,
): ScheduleConfiguration {
    const cron = requiredString(configuration.cron, 'Schedule configuration cron');
    const timeZone = requiredString(configuration.timeZone, 'Schedule configuration timeZone');
    const misfirePolicy = configuration.misfirePolicy ?? MISFIRE_POLICY;
    if (misfirePolicy !== MISFIRE_POLICY) {
        throw new Error(`Unsupported schedule misfirePolicy: ${String(misfirePolicy)}`);
    }
    parseCronExpression(cron);
    validateTimeZone(timeZone);
    return { cron, misfirePolicy: MISFIRE_POLICY, timeZone };
}

/**
 * Finds the latest cron occurrence at or before an instant in the configured
 * IANA time zone.
 *
 * The search is bounded to one year, returns local display time alongside the
 * UTC `Date`, and returns `undefined` when no occurrence is found in that
 * bound. When both cron day fields are restricted, matching follows the
 * conventional OR rule implemented by this module.
 */
export function latestOccurrenceAtOrBefore(
    now: Date,
    configuration: ScheduleConfiguration,
): ScheduleOccurrence | undefined {
    const parsed = parseCronExpression(configuration.cron);
    validateTimeZone(configuration.timeZone);
    const start = floorToMinute(now.getTime());
    for (let offset = 0; offset <= MAX_SEARCH_MINUTES; offset += 1) {
        const at = new Date(start - offset * MINUTE_MILLISECONDS);
        if (matchesCron(at, parsed, configuration.timeZone)) {
            return occurrence(at, configuration.timeZone);
        }
    }
    return undefined;
}

/**
 * Finds the next cron occurrence strictly after an instant in the configured
 * IANA time zone, using the same one-year search bound and day-field semantics
 * as `latestOccurrenceAtOrBefore`.
 */
export function nextOccurrenceAfter(
    now: Date,
    configuration: ScheduleConfiguration,
): ScheduleOccurrence | undefined {
    const parsed = parseCronExpression(configuration.cron);
    validateTimeZone(configuration.timeZone);
    const start = floorToMinute(now.getTime()) + MINUTE_MILLISECONDS;
    for (let offset = 0; offset <= MAX_SEARCH_MINUTES; offset += 1) {
        const at = new Date(start + offset * MINUTE_MILLISECONDS);
        if (matchesCron(at, parsed, configuration.timeZone)) {
            return occurrence(at, configuration.timeZone);
        }
    }
    return undefined;
}

function parseCronExpression(expression: string): ParsedCronExpression {
    const fields = expression.trim().split(/\s+/);
    if (fields.length !== 5) {
        throw new Error('A schedule cron expression must contain five fields: minute hour day-of-month month day-of-week.');
    }
    const parsed = fields.map((field, index) => parseCronField(
        field,
        CRON_FIELD_RANGES[index]!,
        CRON_FIELD_NAMES[index]!,
    ));
    return {
        dayOfMonth: parsed[2]!.values,
        dayOfMonthWildcard: parsed[2]!.wildcard,
        dayOfWeek: new Set([...parsed[4]!.values].map((value) => value === 7 ? 0 : value)),
        dayOfWeekWildcard: parsed[4]!.wildcard,
        hour: parsed[1]!.values,
        minute: parsed[0]!.values,
        month: parsed[3]!.values,
    };
}

function parseCronField(
    field: string,
    range: readonly [number, number],
    fieldName: string,
): { values: Set<number>; wildcard: boolean } {
    if (!field) {
        throw new Error(`Schedule cron ${fieldName} must not be empty.`);
    }
    const values = new Set<number>();
    const tokens = field.split(',');
    tokens.forEach((token) => addCronToken(values, token, range, fieldName));
    return {
        values,
        wildcard: isWildcardToken(tokens),
    };
}

function addCronToken(
    values: Set<number>,
    token: string,
    range: readonly [number, number],
    fieldName: string,
): void {
    const { start, end, step } = parseCronToken(token, range, fieldName);
    for (let value = start; value <= end; value += step) {
        values.add(value);
    }
}

function parseCronToken(
    token: string,
    range: readonly [number, number],
    fieldName: string,
): { end: number; start: number; step: number } {
    if (!token) {
        throw new Error(`Schedule cron ${fieldName} contains an empty list item.`);
    }
    const stepParts = token.split('/');
    if (stepParts.length > 2) {
        throw new Error(`Schedule cron ${fieldName} contains an invalid step.`);
    }
    const base = stepParts[0]!;
    const step = stepParts[1] == null ? 1 : parsePositiveInteger(
        stepParts[1]!,
        `Schedule cron ${fieldName} step`,
    );
    const bounds = parseCronBounds(
        base,
        range,
        fieldName,
        stepParts[1] != null,
    );
    return { ...bounds, step };
}

function parseCronBounds(
    base: string,
    range: readonly [number, number],
    fieldName: string,
    hasStep: boolean,
): { end: number; start: number } {
    const [minimum, maximum] = range;
    if (base === '*') {
        return { end: maximum, start: minimum };
    }
    const rangeParts = base.split('-');
    if (rangeParts.length > 2 || rangeParts.some((part) => part === '')) {
        throw new Error(`Schedule cron ${fieldName} contains an invalid range.`);
    }
    const start = parseCronNumber(rangeParts[0]!, range, fieldName);
    const end = rangeParts.length === 1
        ? (hasStep ? maximum : start)
        : parseCronNumber(rangeParts[1]!, range, fieldName);
    if (end < start) {
        throw new Error(`Schedule cron ${fieldName} range must be ascending.`);
    }
    return { end, start };
}

function isWildcardToken(tokens: string[]): boolean {
    return tokens.length === 1 && (tokens[0] === '*' || tokens[0]!.startsWith('*/'));
}

function validateTimeZone(timeZone: string): void {
    try {
        new Intl.DateTimeFormat('en-US', { timeZone }).format();
    } catch {
        throw new Error(`Schedule timeZone must be a valid IANA time-zone name: ${timeZone}`);
    }
}

function matchesCron(
    date: Date,
    parsed: ParsedCronExpression,
    timeZone: string,
): boolean {
    const parts = timeZoneParts(date, timeZone);
    if (!parsed.minute.has(parts.minute) ||
        !parsed.hour.has(parts.hour) ||
        !parsed.month.has(parts.month)) {
        return false;
    }
    const dayOfMonthMatches = parsed.dayOfMonth.has(parts.day);
    const dayOfWeekMatches = parsed.dayOfWeek.has(parts.weekday);
    if (parsed.dayOfMonthWildcard || parsed.dayOfWeekWildcard) {
        return dayOfMonthMatches && dayOfWeekMatches;
    }
    // Follow the conventional cron rule: when both day fields are restricted,
    // either matching day is sufficient.
    return dayOfMonthMatches || dayOfWeekMatches;
}

function parseCronNumber(
    value: string,
    range: readonly [number, number],
    fieldName: string,
): number {
    if (!/^\d+$/.test(value)) {
        throw new Error(`Schedule cron ${fieldName} supports numeric values only.`);
    }
    const parsed = Number.parseInt(value, 10);
    if (parsed < range[0]! || parsed > range[1]!) {
        throw new Error(`Schedule cron ${fieldName} value must be between ${range[0]} and ${range[1]}.`);
    }
    return parsed;
}

function parsePositiveInteger(value: string, description: string): number {
    if (!/^\d+$/.test(value)) {
        throw new Error(`${description} must be a positive integer.`);
    }
    const parsed = Number.parseInt(value, 10);
    if (parsed < 1) {
        throw new Error(`${description} must be a positive integer.`);
    }
    return parsed;
}

function requiredString(value: unknown, description: string): string {
    if (typeof value !== 'string' || value.trim() === '') {
        throw new Error(`${description} must be a non-empty string.`);
    }
    return value.trim();
}

function floorToMinute(timestamp: number): number {
    return Math.floor(timestamp / MINUTE_MILLISECONDS) * MINUTE_MILLISECONDS;
}

function occurrence(date: Date, timeZone: string): ScheduleOccurrence {
    const parts = timeZoneParts(date, timeZone);
    return {
        at: date,
        localTime: `${parts.year.toString().padStart(4, '0')}-${parts.month.toString().padStart(2, '0')}-${parts.day.toString().padStart(2, '0')}T${parts.hour.toString().padStart(2, '0')}:${parts.minute.toString().padStart(2, '0')}`,
    };
}

function timeZoneParts(date: Date, timeZone: string): {
    day: number;
    hour: number;
    minute: number;
    month: number;
    weekday: number;
    year: number;
} {
    const parts = new Intl.DateTimeFormat('en-US', {
        day: '2-digit',
        hour: '2-digit',
        hourCycle: 'h23',
        minute: '2-digit',
        month: '2-digit',
        timeZone,
        weekday: 'short',
        year: 'numeric',
    }).formatToParts(date);
    const values = new Map(parts
        .filter((part) => part.type !== 'literal')
        .map((part) => [part.type, part.value]));
    const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(values.get('weekday') ?? '');
    if (weekday < 0) {
        throw new Error('Unable to determine the schedule time-zone weekday.');
    }
    return {
        day: Number.parseInt(values.get('day')!, 10),
        hour: Number.parseInt(values.get('hour')!, 10),
        minute: Number.parseInt(values.get('minute')!, 10),
        month: Number.parseInt(values.get('month')!, 10),
        weekday,
        year: Number.parseInt(values.get('year')!, 10),
    };
}
