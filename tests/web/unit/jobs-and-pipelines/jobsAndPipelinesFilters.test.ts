/**
 * @fileoverview Pure filtering, sorting, and favorites regression coverage for
 * the jobs-and-pipelines registry.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import type { PipelineSummary } from '../../../../src/shared/pipelineRegistryTypes.ts';
import {
    filterAndSortPipelines,
    parseFavoriteIds,
    toggleFavoriteId,
} from '../../../../src/web/components/jobs-and-pipelines/jobsAndPipelinesFilters.ts';

const pipelines = [
    pipeline('pipeline-zeta', 'Zeta', 'pipelines/example/zeta.pipeline.yaml', 'version-z'),
    pipeline('pipeline-alpha', 'Alpha', 'pipelines/marketing/alpha.pipeline.yaml', 'version-a'),
    pipeline('pipeline-beta', 'Beta', 'pipelines/example/beta.pipeline.yaml', 'version-b'),
];

test('search, tag, and favorites filters compose without mutating source ordering', () => {
    const visible = filterAndSortPipelines(pipelines, {
        favoriteIds: new Set(['pipeline-zeta', 'pipeline-beta']),
        favoritesOnly: true,
        searchQuery: 'VERSION-B',
        sortDirection: 'ascending',
        tagFilter: 'example',
        typeFilter: 'all',
    });

    assert.deepEqual(visible.map(({ id }) => id), ['pipeline-beta']);
    assert.deepEqual(pipelines.map(({ id }) => id), [
        'pipeline-zeta',
        'pipeline-alpha',
        'pipeline-beta',
    ]);
});

test('sorting is deterministic in both directions and unsupported jobs return no rows', () => {
    const baseOptions = {
        favoriteIds: new Set<string>(),
        favoritesOnly: false,
        searchQuery: '',
        tagFilter: 'all',
        typeFilter: 'pipelines' as const,
    };

    assert.deepEqual(
        filterAndSortPipelines(pipelines, { ...baseOptions, sortDirection: 'ascending' })
            .map(({ name }) => name),
        ['Alpha', 'Beta', 'Zeta'],
    );
    assert.deepEqual(
        filterAndSortPipelines(pipelines, { ...baseOptions, sortDirection: 'descending' })
            .map(({ name }) => name),
        ['Zeta', 'Beta', 'Alpha'],
    );
    assert.deepEqual(
        filterAndSortPipelines(pipelines, {
            ...baseOptions,
            sortDirection: 'ascending',
            typeFilter: 'jobs',
        }),
        [],
    );
});

test('favorite storage parsing and toggling ignore malformed entries and preserve inputs', () => {
    const favorites = parseFavoriteIds('["pipeline-alpha", 7, "pipeline-alpha"]');
    assert.deepEqual(Array.from(favorites), ['pipeline-alpha']);
    assert.deepEqual(Array.from(parseFavoriteIds('{bad json')), []);

    const updated = toggleFavoriteId(favorites, 'pipeline-beta');
    assert.deepEqual(Array.from(favorites), ['pipeline-alpha']);
    assert.deepEqual(Array.from(updated), ['pipeline-alpha', 'pipeline-beta']);
    assert.deepEqual(Array.from(toggleFavoriteId(updated, 'pipeline-alpha')), ['pipeline-beta']);
});

function pipeline(
    id: string,
    name: string,
    specPath: string,
    currentVersionId: string,
): PipelineSummary {
    return {
        currentVersionId,
        id,
        name,
        nodeCount: 0,
        recentRuns: [],
        sourceHash: `source-${id}`,
        specPath,
        status: 'DEPLOYED',
    };
}
