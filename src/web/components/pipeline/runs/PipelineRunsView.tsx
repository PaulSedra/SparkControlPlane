/**
 * @fileoverview Selectable run-history table used by the pipeline detail view.
 */

import { ListChecks } from 'lucide-react';
import { EmptyState } from '../../ui/EmptyState';
import { AppIcon } from '../../ui/AppIcon';
import { StatusIcon } from '../../ui/StatusIcon';
import { formatDate, formatDuration } from '../../../lib/format';
import type { PipelineRun } from '../../../../shared/pipelineRegistryTypes.ts';
import {
    PIPELINE_RUN_STATUS_LABELS,
    statusPresentationForRunStatus,
} from '../../../../shared/status/presentation.ts';
import { RunStatus } from '../../../../shared/status/run.ts';
import {
    runAsLabel,
} from '../../../utils/pipelineRunPresentation';

/**
 * Presents pipeline run history in newest-first order and reports selection.
 *
 * Sorting is performed on a copy so the parent-owned history is not mutated.
 * Selecting a row changes the diagnostic context in the parent; this view
 * does not fetch or alter runs, and an empty history is an expected state
 * before the first submission.
 */
export function PipelineRunsView({
    onSelectRun,
    runs,
    selectedRunId,
}: Readonly<{
    onSelectRun: (runId: string) => void;
    runs: PipelineRun[];
    selectedRunId?: string;
}>) {
    const orderedRuns = [...runs].sort((left, right) => {
        return right.startedAt.localeCompare(left.startedAt);
    });

    if (orderedRuns.length === 0) {
        return (
            <div className="pipeline-runs-view">
                <EmptyState
                    icon={<AppIcon icon={ListChecks} size="empty" />}
                    title="No runs"
                    detail="Run history will appear here after this pipeline has run."
                />
            </div>
        );
    }

    return (
        <section aria-label="Pipeline runs" className="pipeline-runs-view">
            <header className="pipeline-runs-toolbar">
                <div>
                    <h2>Runs</h2>
                    <span>Run history for this pipeline.</span>
                </div>
            </header>
            <div className="pipeline-runs-table-wrap">
                <table className="pipeline-runs-table">
                    <thead>
                        <tr>
                            <th>Run</th>
                            <th>Status</th>
                            <th>Started</th>
                            <th>Duration</th>
                            <th>Mode</th>
                            <th>Run as</th>
                        </tr>
                    </thead>
                    <tbody>
                        {orderedRuns.map((run) => (
                            <tr
                                className={run.runId === selectedRunId ? 'selected' : undefined}
                                key={run.runId}
                                onClick={() => onSelectRun(run.runId)}
                            >
                                <td>
                                    <strong>{run.runId}</strong>
                                    <span>{run.sparkAppName}</span>
                                </td>
                                <td>
                                    <span className={`pipeline-run-status ${statusPresentationForRunStatus(run.status)}`}>
                                        <StatusIcon
                                            label={PIPELINE_RUN_STATUS_LABELS[run.status]}
                                            status={statusPresentationForRunStatus(run.status)}
                                        />
                                        {PIPELINE_RUN_STATUS_LABELS[run.status]}
                                    </span>
                                </td>
                                <td>{formatDate(run.startedAt)}</td>
                                <td>{runDuration(run)}</td>
                                <td>{runModeLabel(run.mode)}</td>
                                <td>{runAsLabel()}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
        </section>
    );
}

function runModeLabel(mode: PipelineRun['mode']): string {
    switch (mode) {
        case 'full-refresh-all':
            return 'Full refresh';
        case 'full-refresh-selected':
            return 'Selected full refresh';
        case 'refresh-selected':
            return 'Selected tables';
        case 'repair-failed':
            return 'Repair failed';
        case 'dry-run':
            return 'Dry run';
        default:
            return 'Incremental';
    }
}

function runDuration(run: PipelineRun): string {
    if (run.startedAt == null || run.endedAt == null) {
        return run.status === RunStatus.RUNNING ? 'Running' : 'Not reported';
    }

    return formatDuration(Math.max(0, Date.parse(run.endedAt) - Date.parse(run.startedAt)));
}
