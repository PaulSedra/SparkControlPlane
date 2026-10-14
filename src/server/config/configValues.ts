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
