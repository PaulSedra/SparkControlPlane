/** @fileoverview Temporary examples for validating SonarQube PR issue reporting. */

/**
 * Deliberately exceeds Sonar's cognitive complexity threshold for gate testing.
 */
export function getBlockingSonarExample(value) {
  let score = 0;

  if (value) {
    if (value.primary) {
      if (value.primary.enabled) score += 1;
    }
    if (value.secondary) {
      if (value.secondary.enabled) score += 1;
    }
    if (value.tertiary) {
      if (value.tertiary.enabled) score += 1;
    }
  }

  return score;
}

// TODO: Remove this deliberately nonblocking issue after gate validation.
export const nonblockingSonarExample = "temporary";
