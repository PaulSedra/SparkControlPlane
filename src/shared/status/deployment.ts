/** Canonical deployment lifecycle values returned by the registry API. */
export const DeploymentStatus = {
    DRAFT: 'DRAFT',
    DEPLOYED: 'DEPLOYED',
    DEPLOYED_WITH_WARNINGS: 'DEPLOYED_WITH_WARNINGS',
    INVALID: 'INVALID',
} as const;

/** Describes whether the current pipeline source has been deployed. */
export type DeploymentStatus = typeof DeploymentStatus[keyof typeof DeploymentStatus];
