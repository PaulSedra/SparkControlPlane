/**
 * @fileoverview Run-history table used by the jobs and pipelines page.
 */

import { CircleHelp } from 'lucide-react';
import { EmptyState } from '../ui/EmptyState';
import { AppIcon } from '../ui/AppIcon';
import { StatusIcon } from '../ui/StatusIcon';
import { formatDate } from '../../lib/format';
import {
    statusPresentationForRunStatus,
} from '../../../shared/status/presentation.ts';
import {
    ACTIVE_PIPELINE_RUN_STATUSES,
} from '../../../shared/status/run.ts';
import {
    pipelineRunHistoryStatusLabel,
    runAsLabel,
    runModeLabel,
} from '../../utils/pipelineRunPresentation';
import type {
    PipelineRun,
    PipelineSummary,
} from '../../../shared/pipelineRegistryTypes.ts';
import type { JobsAndPipelinesActionState } from './jobsAndPipelinesRunState.ts';

/**
 * Displays cross-pipeline run history with navigation and cancellation.
 *
 * Rows link to the pipeline/run deep link; cancellation is offered only for
 * active lifecycle states and is disabled for the run currently being acted
 * on. The table reports intents to the page controller rather than polling or
 * mutating run records itself.
 */
export function JobRunsTable({
    cancelActionState,
    onCancel,
    onOpenRun,
    runs,
}: Readonly<{
    cancelActionState: JobsAndPipelinesActionState;
    onCancel: (pipelineId: string, runId: string) => void;
    onOpenRun: (pipelineId: string, runId: string) => void;
    runs: Array<{ pipeline: PipelineSummary; run: PipelineRun }>;
}>) {
    if (runs.length === 0) {
        return (
            <EmptyState
                icon={<AppIcon icon={CircleHelp} size="empty" />}
                title="No job runs found"
                detail="Run history will appear here after a discovered pipeline has run."
            />
        );
    }

    return (
        <div className="jobs-pipelines-table-wrapper">
            <table className="jobs-pipelines-table jobs-pipelines-runs-table">
                <thead>
                    <tr>
                        <th>Pipeline</th>
                        <th>Status</th>
                        <th>Started</th>
                        <th>Mode</th>
                        <th>Run as</th>
                        <th aria-label="Actions" />
                    </tr>
                </thead>
                <tbody>
                    {runs.map(({ pipeline, run }) => {
                        const busy = cancelActionState.kind === 'running' &&
                            cancelActionState.runId === run.runId;
                        const active = ACTIVE_PIPELINE_RUN_STATUSES.includes(run.status);
                        const runStatus = statusPresentationForRunStatus(run.status);
                        const runStatusText = pipelineRunHistoryStatusLabel(run);
                        return (
                            <tr key={run.runId}>
                                <td>
                                    <button
                                        className="jobs-pipelines-name-link"
                                        onClick={() => onOpenRun(pipeline.id, run.runId)}
                                        title={`Open ${pipeline.name} run ${run.runId}`}
                                        type="button"
                                    >
                                        {pipeline.name}
                                    </button>
                                    <button
                                        aria-label={`Open ${pipeline.name} run ${run.runId}`}
                                        className="jobs-pipelines-run-id-button"
                                        onClick={() => onOpenRun(pipeline.id, run.runId)}
                                        type="button"
                                    >
                                        {run.runId}
                                    </button>
                                </td>
                                <td>
                                    <span className={`jobs-pipelines-status-label ${runStatus}`}>
                                        <StatusIcon
                                            label={runStatusText}
                                            status={runStatus}
                                        />
                                        {runStatusText}
                                    </span>
                                </td>
                                <td>{formatDate(run.startedAt)}</td>
                                <td>{runModeLabel(run.mode)}</td>
                                <td>{runAsLabel()}</td>
                                <td>
                                    {active && (
                                        <button
                                            className="jobs-pipelines-cancel-button"
                                            disabled={busy}
                                            onClick={() => onCancel(pipeline.id, run.runId)}
                                            type="button"
                                        >
                                            {busy ? 'Canceling...' : 'Cancel'}
                                        </button>
                                    )}
                                </td>
                            </tr>
                        );
                    })}
                </tbody>
            </table>
        </div>
    );
}
