/**
 * @fileoverview Starts or monitors the official Spark Pipelines CLI in SCP's
 * own runtime while keeping process supervision separate from Spark internals.
 */

import type {
    PipelineDetail,
    PipelineNode,
    PipelineRun,
} from '../../../shared/pipelineRegistryTypes.ts';
import {
    CliExecutionState,
} from '../../../shared/status/execution.ts';
import type { ParsedPipeline } from '../discovery/pipelineDiscovery.ts';
import type { CliLogUpdate } from './sparkCliLogCollector.ts';
import { incrementMetric } from '../../observability/observability.ts';
import { logStructured } from '../../utils/structuredLogging.ts';
import {
    runSparkCliProcess,
    type LocalCliCommandResult,
    type LocalCliRunController,
    type LocalCliRunSnapshot,
} from './sparkCliProcess.ts';

/** Runs a new CLI submission or reconnects its local monitor after server restart. */
export async function runSparkProcess(
    run: PipelineRun,
    parsed: ParsedPipeline | undefined,
    executionMode: 'monitor' | 'submit',
    sparkConnectUrl: string | undefined,
    shouldCancel: () => Promise<boolean>,
    onSnapshot: (
        snapshot: LocalCliRunSnapshot,
        output: CliLogUpdate,
    ) => Promise<void>,
    onLocalProcess: (controller: LocalCliRunController, command: string[]) => void,
): Promise<LocalCliCommandResult> {
    try {
        if (executionMode === 'submit' && parsed == null) {
            throw new Error('Pipeline metadata is required before starting a local CLI run.');
        }
        if (executionMode === 'submit' && (sparkConnectUrl == null || sparkConnectUrl.trim() === '')) {
            throw new Error('SPARK_CONNECT_URL is required for Spark Pipelines CLI execution.');
        }
        logStructured('spark_process_started', {
            correlationId: run.correlationId,
            executionMode,
            mode: run.mode,
            pipelineId: run.pipelineId,
            requestSource: run.requestSource,
            runId: run.runId,
        });
        return await runSparkCliProcess({
            executionMode,
            onController: onLocalProcess,
            onSnapshot,
            run,
            shouldCancel,
            spec: parsed?.detail.spec,
            sparkConnectUrl,
            targetNodeNames: sparkRefreshDatasetNames(
                run.targetNodeNames ?? run.repairedNodeNames,
                parsed?.detail,
            ),
        });
    } catch (error) {
        incrementMetric('control_plane_spark_start_failures_total');
        const reason = error instanceof Error ? error.message : String(error);
        logStructured('spark_process_start_failed', {
            correlationId: run.correlationId,
            error: reason,
            requestSource: run.requestSource,
            runId: run.runId,
        });
        return {
            canceled: false,
            command: run.command ?? ['spark-pipelines', run.mode === 'dry-run' ? 'dry-run' : 'run'],
            detached: false,
            exitCode: 1,
            cliState: executionMode === 'monitor'
                ? CliExecutionState.UNKNOWN
                : CliExecutionState.FAILED,
            reason,
            stderr: `${run.stderr ?? ''}${run.stderr == null || run.stderr === '' ? '' : '\n'}${reason}`,
            stdout: run.stdout ?? '',
            timedOut: false,
        };
    }
}

/** Resolves selected graph nodes to the qualified datasets accepted by Spark refresh options. */
export function sparkRefreshDatasetNames(
    nodeNames: readonly string[] | undefined,
    pipeline: Pick<PipelineDetail, 'edges' | 'nodes'> | undefined,
): string[] | undefined {
    if (nodeNames == null) {
        return undefined;
    }
    if (pipeline == null) {
        return [...nodeNames];
    }

    const nodesById = new Map(pipeline.nodes.map((node) => [node.id, node]));
    const nodesByQualifiedName = new Map(
        pipeline.nodes.map((node) => [node.qualifiedName, node]),
    );
    const datasetNames = new Set<string>();

    for (const nodeName of nodeNames) {
        const selectedNode = nodesByQualifiedName.get(nodeName);
        if (selectedNode == null) {
            throw new Error(`Selected pipeline node "${nodeName}" is not in the parsed graph.`);
        }

        const outputNodes = selectedNode.nodeType === 'FLOW'
            ? pipeline.edges
                .filter((edge) => edge.sourceNodeId === selectedNode.id)
                .map((edge) => nodesById.get(edge.targetNodeId))
                .filter((target): target is PipelineNode =>
                    target != null &&
                    target.nodeType !== 'FLOW' &&
                    target.nodeType !== 'EXTERNAL_DATASET'
                )
            : selectedNode.nodeType === 'EXTERNAL_DATASET'
                ? []
                : [selectedNode];

        if (outputNodes.length === 0) {
            throw new Error(
                `Selected pipeline node "${nodeName}" does not resolve to a refreshable dataset.`,
            );
        }

        for (const outputNode of outputNodes) {
            datasetNames.add(outputNode.qualifiedName);
        }
    }

    return [...datasetNames];
}
