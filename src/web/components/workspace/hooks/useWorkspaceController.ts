/**
 * @fileoverview Workspace controller that resolves a deep-linked pipeline node
 * and loads its read-only source content.
 */

import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { PipelineDetail } from '../../../../shared/pipelineRegistryTypes.ts';
import { declaredPipelineOperations } from '../../../utils/pipelineAssets.ts';
import type { PipelineAssetNode } from '../../../types/pipelineAssetTypes.ts';
import {
    normalizePipelineSourcePath,
    pipelineDetailQueryOptions,
    pipelineSourceFileQueryOptions,
} from '../../../query/pipelineQueries.ts';

/** Public state returned by the workspace controller hook. */
export type WorkspaceController = ReturnType<typeof useWorkspaceController>;

/** Loading state for workspace pipeline and source requests. */
export type WorkspaceLoadState =
    | { kind: 'idle' | 'loading' | 'ready' }
    | { kind: 'error'; message: string };

/**
 * Resolves a workspace deep link and loads read-only pipeline source.
 *
 * Query parameters are honored only on `/workspace`; the pipeline definition
 * is loaded before the node's source path is resolved, then source text is
 * fetched separately so a source failure does not erase the pipeline context.
 * Both requests are abortable on navigation, and the returned link falls back
 * to the pipeline list when no pipeline is selected.
 */
export function useWorkspaceController(pathname: string, search: string) {
    const query = useMemo(
        () => pathname === '/workspace'
            ? new URLSearchParams(search)
            : new URLSearchParams(),
        [pathname, search],
    );
    const pipelineId = query.get('pipelineId')?.trim() || undefined;
    const nodeId = query.get('nodeId')?.trim() || undefined;
    const requestedSourceFile = query.get('file')?.trim() || undefined;
    const detailQuery = useQuery({
        ...pipelineDetailQueryOptions(pipelineId ?? ''),
        enabled: pipelineId != null,
    });
    const detail = detailQuery.data;

    const sourceNode = useMemo(
        () => workspaceNode(detail, nodeId, requestedSourceFile),
        [detail, nodeId, requestedSourceFile],
    );
    const sourcePath = requestedSourceFile ?? sourceNode?.sourceFile;
    const normalizedSourcePath = sourcePath == null
        ? undefined
        : normalizePipelineSourcePath(sourcePath);
    const sourceQuery = useQuery({
        ...pipelineSourceFileQueryOptions(pipelineId ?? '', sourcePath ?? ''),
        enabled: pipelineId != null && detailQuery.isSuccess &&
            normalizedSourcePath != null && sourceNode != null,
    });

    const loadError = detailQuery.isError
        ? workspaceErrorMessage(detailQuery.error, 'Unable to load pipeline definition.')
        : sourceQuery.isError
            ? workspaceErrorMessage(sourceQuery.error, 'Unable to load source code.')
            : undefined;
    const loading = (pipelineId != null && detailQuery.isPending) || sourceQuery.isLoading;
    const pipelineHref = pipelineId == null ? '/pipelines' : `/pipelines/${encodeURIComponent(pipelineId)}`;


    return {
        detail,
        loadError,
        loading,
        pipelineHref,
        sourceFile: sourceQuery.data,
        sourceNode,
    };
}

function workspaceNode(
    detail: PipelineDetail | undefined,
    nodeId: string | undefined,
    sourceFile: string | undefined,
): PipelineAssetNode | undefined {
    if (detail == null) {
        return undefined;
    }

    const nodes = new Map<string, PipelineAssetNode>();
    for (const operation of declaredPipelineOperations(detail)) {
        nodes.set(operation.output.id, operation.output);
        for (const input of operation.inputs) {
            nodes.set(input.id, input);
        }
    }

    if (nodeId != null && nodes.has(nodeId)) {
        return nodes.get(nodeId);
    }

    const normalizedSourceFile = sourceFile == null
        ? undefined
        : normalizePipelineSourcePath(sourceFile);
    return Array.from(nodes.values()).find((node) =>
        normalizedSourceFile != null && node.sourceFile != null &&
        normalizePipelineSourcePath(node.sourceFile) === normalizedSourceFile
    );
}

function workspaceErrorMessage(error: unknown, fallback: string): string {
    return error instanceof Error ? error.message : fallback;
}
