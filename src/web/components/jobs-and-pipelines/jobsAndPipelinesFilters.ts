/**
 * @fileoverview Pure filtering, sorting, and favorites helpers for the
 * jobs-and-pipelines registry.
 */

import type { PipelineSummary } from '../../../shared/pipelineRegistryTypes.ts';
import { pipelineTags } from '../../utils/pipelineRunPresentation.ts';

/** Inputs used to derive the visible pipeline list. */
export interface PipelineFilterOptions {
    favoriteIds: ReadonlySet<string>;
    favoritesOnly: boolean;
    searchQuery: string;
    sortDirection: 'ascending' | 'descending';
    tagFilter: string;
    typeFilter: 'all' | 'jobs' | 'pipelines';
}

/**
 * Applies the supported list filters and returns a new, name-sorted array.
 * The registry API currently supplies pipeline definitions only, so the
 * `jobs` selection is empty until a job-record source is available.
 */
export function filterAndSortPipelines(
    pipelines: readonly PipelineSummary[],
    options: PipelineFilterOptions,
): PipelineSummary[] {
    if (options.typeFilter === 'jobs') {
        return [];
    }

    const normalizedSearchQuery = options.searchQuery.trim().toLowerCase();
    const filtered = pipelines.filter((pipeline) => {
        if (options.favoritesOnly && !options.favoriteIds.has(pipeline.id)) {
            return false;
        }
        if (options.tagFilter !== 'all' && !pipelineTags(pipeline).includes(options.tagFilter)) {
            return false;
        }
        if (normalizedSearchQuery === '') {
            return true;
        }

        return [
            pipeline.name,
            pipeline.id,
            pipeline.currentVersionId,
            pipeline.specPath,
        ].some((value) => value?.toLowerCase().includes(normalizedSearchQuery));
    });

    return filtered.sort((left, right) => {
        const comparison = left.name.localeCompare(right.name);
        return options.sortDirection === 'ascending' ? comparison : -comparison;
    });
}

/** Returns unique, locale-sorted display values for filter choices. */
export function uniqueSortedValues(values: readonly string[]): string[] {
    return Array.from(new Set(values)).sort((left, right) => left.localeCompare(right));
}

/** Parses the locally persisted favorite ID list without trusting its shape. */
export function parseFavoriteIds(value: string | null): Set<string> {
    try {
        const parsed: unknown = value == null ? [] : JSON.parse(value);
        return new Set(
            Array.isArray(parsed)
                ? parsed.filter((candidate): candidate is string => typeof candidate === 'string')
                : [],
        );
    } catch {
        return new Set();
    }
}

/** Returns a copied favorite set with one pipeline added or removed. */
export function toggleFavoriteId(
    favoriteIds: ReadonlySet<string>,
    pipelineId: string,
): Set<string> {
    const next = new Set(favoriteIds);
    if (next.has(pipelineId)) {
        next.delete(pipelineId);
    } else {
        next.add(pipelineId);
    }
    return next;
}
