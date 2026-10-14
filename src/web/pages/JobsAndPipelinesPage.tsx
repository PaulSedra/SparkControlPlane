/**
 * @fileoverview Jobs and pipelines route composition with filters, tables, and
 * run actions.
 */

import { useEffect } from 'react';
import { ApplicationShell } from '../components/shell/ApplicationShell';
import { JobRunsTable } from '../components/jobs-and-pipelines/JobRunsTable';
import { JobsAndPipelinesHeader } from '../components/jobs-and-pipelines/JobsAndPipelinesHeader';
import { JobsAndPipelinesNotices } from '../components/jobs-and-pipelines/JobsAndPipelinesNotices';
import { JobsAndPipelinesTable } from '../components/jobs-and-pipelines/JobsAndPipelinesTable';
import { JobsAndPipelinesToolbar } from '../components/jobs-and-pipelines/JobsAndPipelinesToolbar';
import { useJobsAndPipelinesController } from '../components/jobs-and-pipelines/hooks/useJobsAndPipelinesController';
import { navigateTo, pipelineRunPath } from '../routes/useCurrentRoute';

/**
 * Connects the jobs-and-pipelines controller to its two local views.
 *
 * Registry filters and action feedback are shared across the tabs, while the
 * selected tab only changes presentation. Row actions become controller calls
 * and run links become URL deep links, so reload/back navigation remains
 * meaningful.
 */
export default function JobsAndPipelinesPage() {
    const controller = useJobsAndPipelinesController();
    const {
        actionStates,
        activeTab,
        filteredPipelines,
        cancelPipelineRun,
        deployPipeline,
        jobRuns,
        openMenuId,
        runningPipelineIds,
        setActiveTab,
        setOpenMenuId,
        setSortDirection,
        showInitialLoading,
        startPipelineRun,
    } = controller;

    useEffect(() => {
        if (openMenuId == null) {
            return undefined;
        }

        const closeOnPageClick = (event: MouseEvent) => {
            const target = event.target;
            if (target instanceof Element && target.closest('.jobs-pipelines-menu-wrapper') != null) {
                return;
            }
            setOpenMenuId(undefined);
        };
        document.addEventListener('click', closeOnPageClick);
        return () => document.removeEventListener('click', closeOnPageClick);
    }, [openMenuId, setOpenMenuId]);

    return (
        <ApplicationShell activeItem="pipelines" className="jobs-pipelines-app-shell">
            <div className="jobs-pipelines-page">
                <section className="jobs-pipelines-shell">
                    <JobsAndPipelinesHeader
                        activeTab={activeTab}
                        onSelectTab={(tab) => setActiveTab(tab)}
                    />
                    <JobsAndPipelinesToolbar controller={controller} />
                    <JobsAndPipelinesNotices
                        actionStates={actionStates}
                        loadState={controller.loadState}
                    />

                    {showInitialLoading ? (
                        <div aria-busy="true" className="jobs-pipelines-blank-results" />
                    ) : activeTab === 'jobs-pipelines' ? (
                        <JobsAndPipelinesTable
                            actionStates={actionStates}
                            favoriteIds={controller.favoriteIds}
                            favoritesOnly={controller.favoritesOnly}
                            onDeploy={(pipelineId) => void deployPipeline(pipelineId)}
                            onFavorite={controller.toggleFavorite}
                            onOpenMenu={(pipelineId) => setOpenMenuId(pipelineId)}
                            onRun={(pipelineId, mode) => void startPipelineRun(pipelineId, mode)}
                            onSort={() => setSortDirection((current) =>
                                current === 'ascending' ? 'descending' : 'ascending')}
                            openMenuId={openMenuId}
                            pipelines={filteredPipelines}
                            sortDirection={controller.sortDirection}
                            runningPipelineIds={runningPipelineIds}
                            triggers={controller.triggers}
                        />
                    ) : (
                        <JobRunsTable
                            cancelActionState={actionStates.cancel}
                            onCancel={(pipelineId, runId) => void cancelPipelineRun(pipelineId, runId)}
                            onOpenRun={(pipelineId, runId) => navigateTo(pipelineRunPath(pipelineId, runId))}
                            runs={jobRuns}
                        />
                    )}
                </section>
            </div>
        </ApplicationShell>
    );
}
