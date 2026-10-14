/**
 * @fileoverview Small numeric helpers shared by graph and progress views.
 */

/** Clamps a number to an inclusive range. */
export function clamp(value: number, minimum: number, maximum: number): number {
    return Math.min(maximum, Math.max(minimum, value));
}
