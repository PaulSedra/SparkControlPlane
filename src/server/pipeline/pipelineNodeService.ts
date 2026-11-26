/**
 * @fileoverview Resolves eligible pipeline nodes and reads bounded Spark previews.
 */

import type { PipelineNodeData } from '../../shared/pipelineRegistryTypes.ts';
import type { ControlPlanePersistence } from '../types/pipelinePersistenceTypes.ts';
import type { SparkQueryService } from '../types/sparkQueryServiceTypes.ts';

/** Reads at most 100 rows for a selected node, rejecting missing and external datasets. */
export async function getPipelineNodeData(
    pipelineId: string,
    nodeId: string,
    sparkQueryService?: SparkQueryService,
    persistence?: ControlPlanePersistence,
): Promise<PipelineNodeData> {
    if (sparkQueryService == null) {
        throw new Error('Spark Standalone is not configured for data samples.');
    }
    if (persistence == null) {
        throw new Error('Pipeline persistence is not configured.');
    }

    const pipeline = await persistence.getPipelineSnapshot(pipelineId);
    if (pipeline == null) {
        throw new Error('Unknown pipeline.');
    }
    const node = pipeline.nodes.find((item) =>
        item.id === nodeId && item.nodeType !== 'EXTERNAL_DATASET'
    );
    if (node == null) {
        throw new Error('Unknown pipeline dataset.');
    }

    const value = await sparkQueryService.query({
        command: 'preview',
        limit: 100,
        qualifiedName: node.qualifiedName,
    });
    if (!isRecord(value) || !Array.isArray(value.columns) || !Array.isArray(value.rows)) {
        throw new Error('Spark returned an invalid data sample.');
    }
    return value as unknown as PipelineNodeData;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value != null && !Array.isArray(value);
}
