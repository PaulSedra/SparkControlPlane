/**
 * @fileoverview Resolves eligible pipeline nodes and reads their Spark Connect previews.
 */

import type { PipelineNodeData } from '../../shared/pipelineRegistryTypes.ts';
import type { ControlPlanePersistence } from '../types/pipelinePersistenceTypes.ts';
import { runNodeDataQuery } from './spark/sparkNodePreview.ts';

/** Reads a selected pipeline node's bounded sample, rejecting missing and external datasets. */
export async function getPipelineNodeData(
    pipelineId: string,
    nodeId: string,
    sparkConnectUrl?: string,
    persistence?: ControlPlanePersistence,
): Promise<PipelineNodeData> {
    if (!sparkConnectUrl) {
        throw new Error('No Spark Connect target is configured for data samples.');
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

    return runNodeDataQuery(node.qualifiedName, sparkConnectUrl);
}
