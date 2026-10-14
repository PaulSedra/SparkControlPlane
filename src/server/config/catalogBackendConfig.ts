/**
 * @fileoverview Parses the catalog backend selected for this control-plane process.
 */

import type { CatalogBackend } from '../types/catalogServiceTypes.ts';

/**
 * Returns the selected catalog backend, defaulting production deployments to Polaris.
 */
export function loadCatalogBackend(
    environment: NodeJS.ProcessEnv = process.env,
): CatalogBackend {
    const value = environment.CATALOG_BACKEND?.trim().toLowerCase() || 'polaris';
    if (value === 'polaris' || value === 'spark') {
        return value;
    }
    throw new Error('CATALOG_BACKEND must be either "polaris" or "spark".');
}
