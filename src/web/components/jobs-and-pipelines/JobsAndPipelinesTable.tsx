/**
 * @fileoverview Filtered pipeline table with favorites, sort, deploy, and run
 * actions.
 */

import {
    ArrowUpDown,
    FileCode2,
    ListFilter,
    MoreVertical,
    Play,
    Rocket,
    Route,
    Star,
    UserRound,
} from 'lucide-react';
import { EmptyState } from '../ui/EmptyState';
import { AppIcon } from '../ui/AppIcon';
import { StatusIcon } from '../ui/StatusIcon';
import { formatDate } from '../../lib/format';
import { navigateTo } from '../../routes/useCurrentRoute';
import {
    PIPELINE_RUN_STATUS_LABELS,
    statusPresentationForRunStatus,
} from '../../../shared/status/presentation.ts';
import {
    pipelineTags,
    runAsLabel,
} from '../../utils/pipelineRunPresentation';
import type {
    PipelineRun,
    PipelineSummary,
    RunMode,
} from '../../../shared/pipelineRegistryTypes.ts';
import type { TriggerDefinition } from '../../types/triggerTypes.ts';
import { pipelineTriggerLabel } from './pipelineTriggerPresentation.ts';
import type { JobsAndPipelinesActionStates } from './jobsAndPipelinesRunState.ts';
import type { JobsAndPipelinesSortDirection } from './hooks/useJobsAndPipelinesController';

/**
 * Displays the controller-filtered pipeline registry and row actions.
 *
 * This component does not own discovery or filtering; it reports favorite,
 * sort, deploy, menu, and run intents upward. Pending submissions and active
 * runs are supplied by pipeline ID so simultaneous runs keep their own rows
 * busy. Empty results are distinguished from loading by the caller.
 */
export function JobsAndPipelinesTable({
    actionStates,
    favoriteIds,
    favoritesOnly,
    onDeploy,
    onFavorite,
    onOpenMenu,
    onRun,
    onSort,
    openMenuId,
    pipelines,
    runningPipelineIds,
    sortDirection,
    triggers,
}: Readonly<{
    actionStates: JobsAndPipelinesActionStates;
    favoriteIds: Set<string>;
    favoritesOnly: boolean;
    onDeploy: (pipelineId: string) => void;
    onFavorite: (pipelineId: string) => void;
    onOpenMenu: (pipelineId: string | undefined) => void;
    onRun: (pipelineId: string, mode?: RunMode) => void;
    onSort: () => void;
    openMenuId?: string;
    pipelines: PipelineSummary[];
    runningPipelineIds: string[];
    sortDirection: JobsAndPipelinesSortDirection;
    triggers: TriggerDefinition[];
}>) {
    if (pipelines.length === 0) {
        return (
            <EmptyState
                icon={<AppIcon icon={favoritesOnly ? Star : FileCode2} size="empty" />}
                title={favoritesOnly ? 'No favorite pipelines' : 'No pipelines found'}
                detail={favoritesOnly
                    ? 'Star a pipeline to keep it in your favorites.'
                    : 'No pipeline definitions match the current filters.'}
            />
        );
    }

    return (
        <div className="jobs-pipelines-table-wrapper">
            <table className="jobs-pipelines-table">
                <colgroup>
                    <col className="jobs-pipelines-star-column" />
                    <col className="jobs-pipelines-name-column" />
                    <col className="jobs-pipelines-type-column" />
                    <col className="jobs-pipelines-tags-column" />
                    <col className="jobs-pipelines-run-as-column" />
                    <col className="jobs-pipelines-trigger-column" />
                    <col className="jobs-pipelines-runs-column" />
                    <col className="jobs-pipelines-actions-column" />
                </colgroup>
                <thead>
                    <tr>
                        <th aria-label="Favorite" />
                        <th>
                            <button
                                aria-label={`Sort by name ${sortDirection === 'ascending' ? 'descending' : 'ascending'}`}
                                className="jobs-pipelines-sort-button"
                                onClick={onSort}
                                type="button"
                            >
                                Name
                                <AppIcon icon={ArrowUpDown} size="status" />
                            </button>
                        </th>
                        <th>Type</th>
                        <th>Tags</th>
                        <th>Run as</th>
                        <th>Trigger</th>
                        <th>Recent runs</th>
                        <th aria-label="Actions">
                            <AppIcon icon={ListFilter} size="status" />
                        </th>
                    </tr>
                </thead>
                <tbody>
                    {pipelines.map((pipeline) => {
                        const favorite = favoriteIds.has(pipeline.id);
                        const menuOpen = openMenuId === pipeline.id;
                        const canRun = pipeline.currentVersionId != null;
                        const deployBusy = actionStates.deploy.kind === 'running' &&
                            actionStates.deploy.pipelineId === pipeline.id;
                        const runBusy = runningPipelineIds.includes(pipeline.id);

                        return (
                            <tr key={pipeline.id}>
                                <td className="jobs-pipelines-star-cell">
                                    <button
                                        aria-label={favorite
                                            ? `Remove ${pipeline.name} from favorites`
                                            : `Add ${pipeline.name} to favorites`}
                                        aria-pressed={favorite}
                                        className={`jobs-pipelines-star-button ${favorite ? 'active' : ''}`}
                                        onClick={() => onFavorite(pipeline.id)}
                                        type="button"
                                    >
                                        <AppIcon icon={Star} size="status" />
                                    </button>
                                </td>
                                <td>
                                    <button
                                        className="jobs-pipelines-name-link"
                                        onClick={() => navigateTo(`/pipelines/${pipeline.id}`)}
                                        title={`Open ${pipeline.name}`}
                                        type="button"
                                    >
                                        {pipeline.name}
                                    </button>
                                </td>
                                <td>
                                    <span className="jobs-pipelines-type-label">
                                        <AppIcon icon={Route} size="status" />
                                        Pipeline
                                    </span>
                                </td>
                                <td>
                                    <PipelineTags pipeline={pipeline} />
                                </td>
                                <td>
                                    <span className="jobs-pipelines-run-as-label" title={runAsLabel()}>
                                        <AppIcon icon={UserRound} size="status" />
                                        {runAsLabel()}
                                    </span>
                                </td>
                                <td>{pipelineTriggerLabel(pipeline.id, triggers)}</td>
                                <td>
                                    <RecentRuns runs={pipeline.recentRuns} />
                                </td>
                                <td>
                                    <div className="jobs-pipelines-row-actions">
                                        <button
                                            aria-label={canRun
                                                ? `Run ${pipeline.name}`
                                                : `Deploy ${pipeline.name}`}
                                            className="jobs-pipelines-row-action jobs-pipelines-row-action--primary"
                                            disabled={canRun ? runBusy : deployBusy}
                                            onClick={() => canRun
                                                ? onRun(pipeline.id)
                                                : onDeploy(pipeline.id)}
                                            title={canRun ? 'Run pipeline' : 'Deploy pipeline'}
                                            type="button"
                                        >
                                            <AppIcon icon={canRun ? Play : Rocket} size="status" />
                                        </button>
                                        <div className="jobs-pipelines-menu-wrapper">
                                            <button
                                                aria-expanded={menuOpen}
                                                aria-label={`More actions for ${pipeline.name}`}
                                                className="jobs-pipelines-row-action"
                                                onClick={(event) => {
                                                    event.stopPropagation();
                                                    onOpenMenu(menuOpen ? undefined : pipeline.id);
                                                }}
                                                type="button"
                                            >
                                                <AppIcon icon={MoreVertical} size="status" />
                                            </button>
                                            {menuOpen && (
                                                <div
                                                    className="jobs-pipelines-action-menu"
                                                    role="menu"
                                                    tabIndex={-1}
                                                >
                                                    <button onClick={() => {
                                                        onOpenMenu(undefined);
                                                        navigateTo(`/pipelines/${pipeline.id}`);
                                                    }} role="menuitem" type="button">
                                                        View details
                                                    </button>
                                                    <button
                                                        disabled={deployBusy}
                                                        onClick={() => onDeploy(pipeline.id)}
                                                        role="menuitem"
                                                        type="button"
                                                    >
                                                        Deploy current source
                                                    </button>
                                                    <button
                                                        disabled={runBusy || !canRun}
                                                        onClick={() => onRun(pipeline.id, 'full-refresh-all')}
                                                        role="menuitem"
                                                        type="button"
                                                    >
                                                        Run full refresh
                                                    </button>
                                                    <button
                                                        onClick={() => {
                                                            onFavorite(pipeline.id);
                                                            onOpenMenu(undefined);
                                                        }}
                                                        role="menuitem"
                                                        type="button"
                                                    >
                                                        {favorite ? 'Remove favorite' : 'Add favorite'}
                                                    </button>
                                                </div>
                                            )}
                                        </div>
                                    </div>
                                </td>
                            </tr>
                        );
                    })}
                </tbody>
            </table>
        </div>
    );
}

function PipelineTags({ pipeline }: Readonly<{ pipeline: PipelineSummary }>) {
    const tags = pipelineTags(pipeline);
    if (tags.length === 0) {
        return <span className="jobs-pipelines-no-tags">—</span>;
    }

    return (
        <span className="jobs-pipelines-tags" title={`Source folder: ${pipeline.specPath}`}>
            {tags.map((tag) => <span className="jobs-pipelines-tag" key={tag}>{tag}</span>)}
        </span>
    );
}

function RecentRuns({ runs }: Readonly<{ runs: PipelineRun[] }>) {
    const displayedRuns = runs.slice(0, 5).reverse();
    const emptySlots = Math.max(0, 5 - displayedRuns.length);
    const slots: Array<PipelineRun | undefined> = [
        ...Array.from({ length: emptySlots }, () => undefined),
        ...displayedRuns,
    ];

    return (
        <span aria-label="Recent pipeline runs" className="jobs-pipelines-recent-runs">
            {slots.map((run, index) => run == null ? (
                <span aria-hidden="true" className="jobs-pipelines-run-slot" key={`empty-${index}`} />
            ) : (
                <span
                    className="jobs-pipelines-run-status"
                    key={run.runId}
                    title={`${PIPELINE_RUN_STATUS_LABELS[run.status]} — ${formatDate(run.startedAt)}`}
                >
                    <StatusIcon
                        label={`${PIPELINE_RUN_STATUS_LABELS[run.status]} ${formatDate(run.startedAt)}`}
                        status={statusPresentationForRunStatus(run.status)}
                    />
                </span>
            ))}
        </span>
    );
}
