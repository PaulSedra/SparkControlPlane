/**
 * @fileoverview Resolves discovered pipeline node names into catalog URLs
 * using pipeline-level catalog and schema defaults.
 */

import type {
    PipelineDetail,
    PipelineNode,
    PipelineSpec,
} from '../../shared/pipelineRegistryTypes.ts';
import type { SparkTable } from '../../shared/catalogTypes.ts';

/** Fully qualified catalog target for a pipeline node. */
export interface PipelineCatalogTarget {
    catalog: string;
    schema: string;
    table: string;
}

/** A persistent pipeline output and the catalog location it resolves to. */
export interface PipelineOutputTableTarget extends PipelineCatalogTarget {
    nodeId: string;
}

/** Catalog components inferred for a pipeline node. */
export interface PipelineNodeLocation {
    catalog?: string;
    schema?: string;
    table: string;
}

/**
 * Returns a navigable catalog target only when catalog, schema, and table are
 * all known; unresolved external or partially qualified nodes remain absent
 * instead of producing a misleading catalog URL.
 */
export function pipelineCatalogTarget(
    node: PipelineNode,
    spec: PipelineSpec,
): PipelineCatalogTarget | undefined {
    const location = pipelineNodeLocation(node, spec);
    if (location.catalog == null || location.schema == null || location.table === '') {
        return undefined;
    }

    return {
        catalog: location.catalog,
        schema: location.schema,
        table: location.table,
    };
}

/** Returns catalog targets for persistent table outputs with resolvable locations. */
export function pipelineOutputTableTargets(
    pipeline: Pick<PipelineDetail, 'nodes' | 'spec'> | undefined,
): PipelineOutputTableTarget[] {
    if (pipeline == null) {
        return [];
    }

    return pipeline.nodes.flatMap((node) => {
        if (node.nodeType !== 'STREAMING_TABLE' && node.nodeType !== 'MATERIALIZED_VIEW') {
            return [];
        }
        const target = pipelineCatalogTarget(node, pipeline.spec);
        return target == null ? [] : [{ ...target, nodeId: node.id }];
    });
}

/** Builds a stable cache/map key for one catalog namespace. */
export function pipelineCatalogNamespaceKey(catalog: string, schema: string): string {
    return `${catalog}\u0000${schema}`;
}

/** Maps resolved output nodes to catalog presence, leaving unloaded namespaces unknown. */
export function pipelineTablePresenceByNodeId(
    targets: readonly PipelineOutputTableTarget[],
    tablesByNamespace: ReadonlyMap<string, readonly Pick<SparkTable, 'name'>[]>,
): Map<string, boolean> {
    const presenceByNodeId = new Map<string, boolean>();
    for (const target of targets) {
        const tables = tablesByNamespace.get(
            pipelineCatalogNamespaceKey(target.catalog, target.schema),
        );
        if (tables == null) {
            continue;
        }
        presenceByNodeId.set(
            target.nodeId,
            tables.some((table) => table.name === target.table),
        );
    }
    return presenceByNodeId;
}

/**
 * Resolves a node's qualified name using quoted-identifier cleanup and
 * pipeline catalog/schema defaults. Three-part names override defaults, two-
 * part names are interpreted as schema.table unless the first part is the
 * configured catalog, and one-part names use the node name as the table.
 */
export function pipelineNodeLocation(
    node: PipelineNode,
    spec: PipelineSpec,
): PipelineNodeLocation {
    const parts = node.qualifiedName
        .split('.')
        .map(cleanIdentifier)
        .filter(Boolean);
    const table = parts.at(-1) ?? cleanIdentifier(node.name);
    const catalog = cleanOptional(spec.catalog);
    const schema = cleanOptional(spec.schema ?? spec.database);

    if (parts.length >= 3) {
        return {
            catalog: parts[0],
            schema: parts.slice(1, -1).join('.'),
            table,
        };
    }

    if (parts.length === 2) {
        const [firstPart] = parts;
        return {
            catalog,
            schema: firstPart === catalog ? schema : firstPart,
            table,
        };
    }

    return { catalog, schema, table };
}

function cleanIdentifier(identifier: string): string {
    return identifier
        .replace(/^`|`$/g, '')
        .replace(/^"|"$/g, '')
        .trim();
}

function cleanOptional(value?: string): string | undefined {
    if (value == null) {
        return undefined;
    }

    const cleaned = cleanIdentifier(value);
    return cleaned === '' ? undefined : cleaned;
}
