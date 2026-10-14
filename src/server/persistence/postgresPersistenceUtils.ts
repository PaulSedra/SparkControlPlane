/**
 * @fileoverview Shared value normalization used by PostgreSQL persistence
 * adapters.
 */

/** Converts driver `Date`/string values to the API's canonical ISO timestamp. */
export function dateString(value: Date | string): string {
    return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

/** Clamps persistence page sizes to the API/database safety range of 1..1000. */
export function boundedLimit(value: number): number {
    return Math.min(1000, Math.max(1, Math.floor(value)));
}

/** Normalizes pipeline identity names without changing their display spelling. */
export function normalizeName(name: string): string {
    return name.trim().toLowerCase();
}
