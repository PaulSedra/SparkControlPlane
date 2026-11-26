/**
 * @fileoverview Validation helpers for bounded environment configuration values.
 */

/**
 * Parses an optional decimal integer and enforces an inclusive configured
 * range; blank input uses the default, while malformed or out-of-range input
 * throws with the supplied environment name.
 */
export function integerValue(
    rawValue: string | undefined,
    name: string,
    defaultValue: number,
    minimum: number,
    maximum: number,
): number {
    if (rawValue == null || rawValue.trim() === '') {
        return defaultValue;
    }
    if (!/^\d+$/.test(rawValue.trim())) {
        throw new Error(`${name} must be an integer.`);
    }
    const value = Number.parseInt(rawValue, 10);
    if (value < minimum || value > maximum) {
        throw new Error(`${name} must be between ${minimum} and ${maximum}.`);
    }
    return value;
}

/**
 * Applies inclusive bounds to a parsed integer and converts it by a
 * multiplier. Invalid values use the supplied default.
 */
export function boundedIntegerValue(
    value: number,
    defaultValue: number,
    minimum: number,
    maximum: number,
    multiplier = 1,
): number {
    if (!Number.isInteger(value)) {
        return defaultValue;
    }
    return Math.min(maximum, Math.max(minimum, value)) * multiplier;
}

/**
 * Uses a fallback for nonpositive or unsafe integers and caps valid values.
 */
export function boundedPositiveInteger(
    value: number | undefined,
    fallback: number,
    maximum: number,
): number {
    if (value == null || !Number.isSafeInteger(value) || value < 1) {
        return fallback;
    }
    return Math.min(maximum, value);
}
