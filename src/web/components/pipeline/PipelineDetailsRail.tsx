/**
 * @fileoverview Pipeline identity, run diagnostics, timing, and trigger detail
 * rail.
 */

import { ChevronDown } from 'lucide-react';
import { useState } from 'react';
import type { ReactNode } from 'react';
import type {
    PipelineDetail,
    PipelineRun,
} from '../../../shared/pipelineRegistryTypes.ts';
import {
    PIPELINE_RUN_STATUS_LABELS,
    StatusPresentationState,
    statusPresentationForRunStatus,
} from '../../../shared/status/presentation.ts';
import {
    SPARK_EXECUTION_STATE_LABELS,
} from '../../../shared/status/execution.ts';
import { formatDate } from '../../lib/format';
import { AppIcon } from '../ui/AppIcon';
import { StatusIcon } from '../ui/StatusIcon';
import { runModeLabel } from '../../utils/pipelineRunPresentation';
import { formatPipelineRunDuration } from './pipelineTiming.ts';
import { PipelineTriggersSection } from './triggers/PipelineTriggersSection';

/**
 * Presents stable pipeline identity beside the selected run's lifecycle data.
 *
 * Pipeline metadata remains visible even when no run is selected. Run fields
 * intentionally use placeholders for unavailable timestamps/identity and
 * expose recovery, lease, and terminal reasons when the persisted lifecycle
 * contains them. Run status is represented by its icon and state label only;
 * captured run diagnostics are presented with the graph.
 * The caller supplies the route's timing clock so live run duration advances
 * while the selected run has active timing.
 * Trigger cards are nested here because they belong to the pipeline's
 * operational context rather than one run.
 */
export function PipelineDetailsRail({
    detail,
    nowMs,
    run,
}: Readonly<{
    detail: PipelineDetail;
    nowMs: number;
    run?: PipelineRun;
}>) {
    const runStatus = run == null
        ? StatusPresentationState.UNKNOWN
        : statusPresentationForRunStatus(run.status);
    return (
        <aside aria-label="Pipeline details" className="pipeline-details-rail">
            <DetailSection sectionId="pipeline-details" title="Pipeline details">
                <dl className="pipeline-detail-list">
                    <DetailRow label="Pipeline ID" value={detail.id} copy />
                    <DetailRow label="Pipeline type" value="Declarative pipeline" />
                    <DetailRow label="Creator" value="-" />
                    <DetailRow label="Owner" value="-" />
                    <DetailRow label="Run as" value="-" />
                    <DetailRow label="Source code" value={`${detail.sourceFiles.length} files`} link />
                </dl>
            </DetailSection>

            <DetailSection sectionId="run-details" title="Run details">
                <dl className="pipeline-detail-list">
                    <DetailRow label="Pipeline run ID" value={run?.runId ?? '—'} copy={run != null} />
                    <DetailRow
                        label="Run status"
                        status={runStatus}
                        value={run == null ? '—' : PIPELINE_RUN_STATUS_LABELS[run.status]}
                    />
                    <DetailRow label="Run type" value={run == null ? '—' : runModeLabel(run.mode)} />
                    <DetailRow
                        label="Spark execution"
                        value={run == null
                            ? '—'
                            : run.sparkExecutionState == null
                                ? 'Not reported'
                                : SPARK_EXECUTION_STATE_LABELS[run.sparkExecutionState]}
                    />
                    <DetailRow label="Start time" value={formatDate(run?.startedAt)} />
                    <DetailRow label="End time" value={formatDate(run?.endedAt)} />
                    <DetailRow label="Total duration" value={formatPipelineRunDuration(run, nowMs)} />
                    {run?.recoveryReason != null && (
                        <DetailRow
                            label="Recovery"
                            value={humanizeLifecycleReason(run.recoveryReason)}
                        />
                    )}
                    {run?.leaseLost === true && (
                        <DetailRow label="Lease" value="Worker lease lost" />
                    )}
                    {run?.terminalReason != null && (
                        <DetailRow
                            label="Terminal reason"
                            value={humanizeLifecycleReason(run.terminalReason)}
                        />
                    )}
                </dl>
            </DetailSection>

            <DetailSection sectionId="schedules-triggers" title="Schedules & Triggers">
                <PipelineTriggersSection pipelineId={detail.id} />
            </DetailSection>
        </aside>
    );
}

/**
 * Maps a persisted run lifecycle value to the compact icon/label pair used by
 * the run picker and related controls.
 */
export function RunStatus({ status }: Readonly<{ status: PipelineRun['status'] }>) {
    const kind = statusPresentationForRunStatus(status);
    return (
        <span className={`run-status ${kind}`}>
            <StatusIcon label={PIPELINE_RUN_STATUS_LABELS[status]} status={kind} />
            {PIPELINE_RUN_STATUS_LABELS[status]}
        </span>
    );
}

function DetailSection({
    children,
    sectionId,
    title,
}: Readonly<{
    children: ReactNode;
    sectionId: string;
    title: string;
}>) {
    const [expanded, setExpanded] = useState(true);
    const contentId = `${sectionId}-content`;

    return (
        <section className="pipeline-detail-section">
            <h2 className="pipeline-detail-section-heading">
                <button
                    aria-controls={contentId}
                    aria-expanded={expanded}
                    className="pipeline-detail-section-toggle"
                    onClick={() => setExpanded((current) => !current)}
                    type="button"
                >
                    <AppIcon
                        className={expanded ? undefined : 'pipeline-detail-section-chevron-collapsed'}
                        icon={ChevronDown}
                        size="status"
                    />
                    <span>{title}</span>
                </button>
            </h2>
            <div className="pipeline-detail-section-content" id={contentId} hidden={!expanded}>
                {children}
            </div>
        </section>
    );
}

function DetailRow({
    copy = false,
    label,
    link = false,
    status,
    value,
}: Readonly<{
    copy?: boolean;
    label: string;
    link?: boolean;
    status?: StatusPresentationState;
    value: string;
}>) {
    const className = link ? 'detail-link' : undefined;

    return (
        <div className="pipeline-detail-row">
            <dt>{label}</dt>
            <dd className={className} title={value}>
                {status == null ? (
                    <span>{value}</span>
                ) : (
                    <span className={`run-status ${status}`}>
                        <StatusIcon label={value} status={status} />
                        <span>{value}</span>
                    </span>
                )}
                {copy && <button aria-label={`Copy ${label}`} className="detail-copy-button" title={`Copy ${label}`} type="button">⧉</button>}
                {link && <span className="external-link-mark">↗</span>}
            </dd>
        </div>
    );
}

function humanizeLifecycleReason(reason: string): string {
    return reason
        .toLowerCase()
        .split('_')
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join(' ');
}
