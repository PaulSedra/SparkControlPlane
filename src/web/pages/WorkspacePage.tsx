/**
 * @fileoverview Read-only workspace route for a selected pipeline source file.
 */

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { AlertCircle, CheckCircle2, ChevronLeft, Code2, RefreshCw } from 'lucide-react';
import { ApplicationShell } from '../components/shell/ApplicationShell';
import { AppIcon } from '../components/ui/AppIcon';
import { PipelineWorkspaceView } from '../components/workspace/PipelineWorkspaceView';
import { useWorkspaceController } from '../components/workspace/hooks/useWorkspaceController';
import type { WorkspaceController } from '../components/workspace/hooks/useWorkspaceController';
import { refreshPipelinesFromSourceMutationOptions } from '../query/pipelineMutations.ts';
import { navigateTo, useCurrentRoute } from '../routes/useCurrentRoute';

/**
 * Resolves the read-only workspace query and renders it inside the shell.
 *
 * The controller owns which pipeline/node/file is valid and which requests are
 * stale; this route only forwards the current browser pathname/search and
 * keeps the back link inside SPA navigation.
 */
export default function WorkspacePage() {
    const { pathname, search } = useCurrentRoute();
    const controller = useWorkspaceController(pathname, search);

    return (
        <ApplicationShell
            activeItem="workspace"
            className="workspace-app-shell"
            contentAriaLabel="Workspace"
        >
            <WorkspacePageContent controller={controller} />
        </ApplicationShell>
    );
}

/**
 * Composes workspace navigation with the selected source panel, preserving
 * the controller's loading and error states instead of replacing them with
 * route-level assumptions.
 */
function WorkspacePageContent({
    controller,
}: Readonly<{
    controller: WorkspaceController;
}>) {
    const queryClient = useQueryClient();
    const refreshMutation = useMutation(
        refreshPipelinesFromSourceMutationOptions(queryClient),
    );
    const {
        detail,
        loadError,
        loading,
        pipelineHref,
        sourceFile,
        sourceNode,
    } = controller;

    return (
        <section className="workspace-route">
            <header className="workspace-route-header">
                <a
                    className="workspace-back-link"
                    href={pipelineHref}
                    onClick={(event) => {
                        event.preventDefault();
                        navigateTo(pipelineHref);
                    }}
                >
                    <AppIcon icon={ChevronLeft} size="status" />
                    Jobs &amp; Pipelines
                </a>
                <div className="workspace-route-heading">
                    <div className="workspace-route-title">
                        <span className="workspace-route-icon"><AppIcon icon={Code2} size="control" /></span>
                        <div>
                            <h1>Workspace</h1>
                            <p>{detail?.name ?? 'Read-only source browser'}</p>
                        </div>
                    </div>
                    <div className="workspace-route-actions">
                        <button
                            aria-label="Refresh all pipelines from source"
                            className="workspace-refresh-button"
                            disabled={refreshMutation.isPending}
                            onClick={() => refreshMutation.mutate()}
                            title="Repull the entire pipeline folder and apply its YAML definitions"
                            type="button"
                        >
                            <AppIcon icon={RefreshCw} size="status" />
                            {refreshMutation.isPending ? 'Refreshing pipelines…' : 'Refresh all pipelines'}
                        </button>
                        {refreshMutation.isError && (
                            <span className="workspace-refresh-message error" role="alert">
                                <AppIcon icon={AlertCircle} size="status" />
                                {refreshMutation.error instanceof Error
                                    ? refreshMutation.error.message
                                    : 'Unable to refresh pipelines from source.'}
                            </span>
                        )}
                        {refreshMutation.isSuccess && (
                            <output className="workspace-refresh-message success">
                                <AppIcon icon={CheckCircle2} size="status" />
                                All pipelines refreshed from source.
                            </output>
                        )}
                    </div>
                </div>
            </header>
            <PipelineWorkspaceView
                error={loadError}
                loading={loading}
                node={sourceNode}
                sourceFile={sourceFile}
            />
        </section>
    );
}
