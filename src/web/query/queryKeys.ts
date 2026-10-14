/**
 * @fileoverview Shared cache identity for server-owned browser state.
 *
 * Resource roots are intentionally stable prefixes: invalidating `catalogs`,
 * `pipelines`, or `triggers` refreshes a collection, while narrower keys target
 * the dependent detail, source, schedule, or monitoring query. UI-only state
 * such as selection, filters, and tree expansion does not belong in these keys.
 */

/**
 * Builds canonical query keys for catalog, registry, pipeline, node-preview,
 * trigger, and source resources. Path-bearing values
 * must be normalized by the caller before being used as identity.
 */
export const queryKeys = {
    catalogs: {
        all: ['catalogs'] as const,
        schemas: (catalogId: string) => ['catalog', catalogId, 'schemas'] as const,
        tables: (catalogId: string, schemaId: string) =>
            ['catalog', catalogId, schemaId, 'tables'] as const,
        tableDetail: (catalogId: string, schemaId: string, tableName: string) =>
            ['catalog', catalogId, schemaId, tableName, 'detail'] as const,
        sampleData: (catalogId: string, schemaId: string, tableName: string) =>
            ['catalog', catalogId, schemaId, tableName, 'sample'] as const,
    },
    pipelines: {
        all: ['pipelines'] as const,
        detail: (pipelineId: string) => ['pipeline', pipelineId, 'detail'] as const,
        runs: (pipelineId: string) => ['pipeline', pipelineId, 'runs'] as const,
        nodeData: (pipelineId: string, nodeId: string) =>
            ['pipeline', pipelineId, 'node', nodeId, 'data'] as const,
        run: (pipelineId: string, runId: string) =>
            ['pipeline', pipelineId, 'run', runId] as const,
        source: (pipelineId: string, normalizedSourcePath: string) =>
            ['pipeline', pipelineId, 'source', normalizedSourcePath] as const,
        triggers: (pipelineId: string) => ['pipeline', pipelineId, 'triggers'] as const,
        runMonitoring: (pipelineId: string, runId: string) =>
            ['pipeline', pipelineId, 'run-monitoring', runId] as const,
    },
    triggers: {
        all: ['triggers'] as const,
        scheduleStatus: (triggerId: string) =>
            ['trigger', triggerId, 'schedule-status'] as const,
    },
};
