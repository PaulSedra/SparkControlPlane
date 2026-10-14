/**
 * @fileoverview Reusable pipeline, asset, and Spark monitoring fixtures for UI tests.
 */

import type {
    PipelineDetail,
    PipelineNode,
    PipelineSpec,
} from '../../src/shared/pipelineRegistryTypes.ts';
import type {
    PipelineAssetNode,
    PipelineAssetOperation,
} from '../../src/web/types/pipelineAssetTypes.ts';
import type {
    SparkSnapshot,
} from '../../src/web/types/sparkMonitoringTypes.ts';
import { createTestDataLoader } from './testData.ts';

interface WebFixtureData {
    pipelineDetail: Omit<PipelineDetail, 'nodeCount' | 'nodes' | 'spec'>;
    pipelineSpec: PipelineSpec;
    sparkSnapshot: SparkSnapshot;
}

const webTestData = createTestDataLoader('web/unit');
const webFixtureData = webTestData.loadYaml<WebFixtureData>('fixtures/web.yaml');

/** Stable pipeline specification data shared by web tests. */
export const pipelineSpecFixture = webFixtureData.pipelineSpec;

/** Stable empty Spark monitoring snapshot shared by web tests. */
export const sparkSnapshotFixture = webFixtureData.sparkSnapshot;

/** Builds a materialized-view pipeline node fixture. */
export function pipelineNode(
    qualifiedName: string,
    name = qualifiedName.split('.').at(-1) ?? qualifiedName,
): PipelineNode {
    return { id: qualifiedName, name, nodeType: 'MATERIALIZED_VIEW', qualifiedName };
}

/** Builds pipeline detail data around the supplied nodes. */
export function pipelineDetail(
    nodes: PipelineNode[],
    overrides: Partial<PipelineDetail> = {},
): PipelineDetail {
    return { ...webFixtureData.pipelineDetail, nodeCount: nodes.length, nodes, spec: pipelineSpecFixture, ...overrides };
}

/** Builds a pipeline asset node fixture. */
export function asset(id: string, label = id): PipelineAssetNode {
    return { id, kind: 'view', label, qualifiedName: label };
}

/** Builds a pipeline operation fixture with the supplied output and inputs. */
export function operation(
    output: PipelineAssetNode,
    inputs: PipelineAssetNode[] = [],
): PipelineAssetOperation {
    return { id: 'operation-' + output.id, inputs, output, status: 'succeeded' };
}

/** Runs a callback with a fetch implementation and restores the global afterward. */
export async function withMockFetch<T>(
    fetchImpl: typeof fetch,
    callback: () => T | Promise<T>,
): Promise<T> {
    const original = globalThis.fetch;
    globalThis.fetch = fetchImpl;
    try {
        return await callback();
    } finally {
        globalThis.fetch = original;
    }
}
