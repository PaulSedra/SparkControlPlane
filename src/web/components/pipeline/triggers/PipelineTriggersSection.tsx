/**
 * @fileoverview Trigger and schedule cards embedded in the pipeline detail
 * rail.
 */

import { CalendarClock, Cloud, Webhook } from 'lucide-react';
import { AppIcon } from '../../ui/AppIcon';
import { StatusIcon } from '../../ui/StatusIcon';
import {
    statusPresentationForTriggerOutcome,
    TRIGGER_OUTCOME_PRESENTATION_LABELS,
} from '../../../../shared/status/presentation.ts';
import { formatDate } from '../../../lib/format';
import type { TriggerDefinition, TriggerScheduleStatus } from '../../../types/triggerTypes.ts';
import { usePipelineTriggers } from './usePipelineTriggers';

/**
 * Loads and renders the active trigger definitions for one pipeline.
 *
 * Schedule status is fetched independently because it is runtime state rather
 * than part of the trigger definition. A toggle is sent through the server's
 * update path and leaves the current list visible while the action is pending;
 * failures are surfaced without discarding the definitions already loaded.
 */
export function PipelineTriggersSection({ pipelineId }: Readonly<{ pipelineId: string }>) {
    const controller = usePipelineTriggers(pipelineId);
    const {
        actionState,
        togglePipelineTrigger,
        loadState,
        scheduleByTrigger,
        sortedTriggers,
    } = controller;

    if (loadState.kind === 'loading' && sortedTriggers.length === 0) {
        return <div aria-busy="true" className="pipeline-triggers-loading" />;
    }

    if (loadState.kind === 'error') {
        return (
            <div className="pipeline-triggers-message error" role="alert">
                {loadState.message}
            </div>
        );
    }

    if (sortedTriggers.length === 0) {
        return (
            <div className="pipeline-triggers-message">
                No schedules or triggers configured.
            </div>
        );
    }

    return (
        <div aria-label="Trigger definitions" className="pipeline-trigger-list">
            {actionState.kind === 'failed' && (
                <div className="pipeline-triggers-message error" role="alert">
                    {actionState.message}
                </div>
            )}
            {sortedTriggers.map((trigger) => (
                <PipelineTriggerCard
                    actionState={actionState}
                    key={trigger.id}
                    onToggle={() => void togglePipelineTrigger(trigger)}
                    schedule={scheduleByTrigger[trigger.id]}
                    trigger={trigger}
                />
            ))}
        </div>
    );
}

function PipelineTriggerCard({
    actionState,
    onToggle,
    schedule,
    trigger,
}: Readonly<{
    actionState: ReturnType<typeof usePipelineTriggers>['actionState'];
    onToggle: () => void;
    schedule?: TriggerScheduleStatus;
    trigger: TriggerDefinition;
}>) {
    const outcomeStatus = statusPresentationForTriggerOutcome(trigger.lastOutcome?.status);
    const outcomeLabel = outcomeStatus == null
        ? undefined
        : TRIGGER_OUTCOME_PRESENTATION_LABELS[outcomeStatus];
    const isRunning = actionState.kind === 'running' && actionState.triggerId === trigger.id;

    return (
        <article className="pipeline-trigger-card">
            <div className="pipeline-trigger-heading">
                <AppIcon icon={triggerIcon(trigger)} size="control" />
                <strong className="pipeline-trigger-title">
                    {triggerTypeLabel(trigger.type)}
                </strong>
            </div>

            <div className="pipeline-trigger-details">
                {triggerDetailLines(trigger).map((line, index) => (
                    <span key={`${line}-${index}`}>{line}</span>
                ))}
            </div>

            {outcomeStatus != null && outcomeLabel != null && (
                <span className={`pipeline-trigger-last-outcome ${outcomeStatus}`}>
                    <StatusIcon label={outcomeLabel} status={outcomeStatus} />
                    {outcomeLabel}
                </span>
            )}

            {trigger.type === 'SCHEDULE' && schedule?.nextOccurrenceAt != null && (
                <span className="pipeline-trigger-next-run">
                    Next run {formatDate(schedule.nextOccurrenceAt)}
            </span>
            )}

            <div className="pipeline-trigger-actions">
                <button
                    className="pipeline-trigger-action"
                    disabled={isRunning}
                    onClick={onToggle}
                    type="button"
                >
                    {isRunning ? 'Saving…' : trigger.enabled ? 'Pause' : 'Resume'}
                </button>
            </div>
        </article>
    );
}

function triggerIcon(trigger: TriggerDefinition) {
    if (trigger.type === 'FILE_ARRIVAL') {
        return Cloud;
    }
    if (trigger.type === 'SCHEDULE') {
        return CalendarClock;
    }
    return Webhook;
}

function triggerTypeLabel(type: TriggerDefinition['type']): string {
    if (type === 'FILE_ARRIVAL') {
        return 'File arrival';
    }
    if (type === 'SCHEDULE') {
        return 'Schedule';
    }
    return 'Webhook';
}

function triggerDetailLines(trigger: TriggerDefinition): string[] {
    if (trigger.type === 'FILE_ARRIVAL') {
        const locations = storageLocations(trigger.configuration);
        return locations.length > 0 ? locations : ['Storage location not reported'];
    }

    if (trigger.type === 'SCHEDULE') {
        const cron = stringValue(trigger.configuration.cron);
        const timeZone = stringValue(trigger.configuration.timeZone) ??
            stringValue(trigger.configuration.timezone_id);
        return [
            cron == null ? 'Schedule expression not reported' : `Cron ${cron}`,
            ...(timeZone == null ? [] : [`Time zone ${timeZone}`]),
        ];
    }

    const source = stringValue(trigger.configuration.source);
    const eventType = stringValue(trigger.configuration.eventType) ??
        stringValue(trigger.configuration.event_type);
    return [
        source == null ? 'Webhook source not reported' : `Source ${source}`,
        ...(eventType == null ? [] : [`Event ${eventType}`]),
    ];
}

function storageLocations(configuration: Record<string, unknown>): string[] {
    const configuredLocations = configuration.locations;
    if (Array.isArray(configuredLocations)) {
        const locations = configuredLocations
            .map(storageLocation)
            .filter((location): location is string => location != null);
        if (locations.length > 0) {
            return locations;
        }
    }

    const bucket = stringValue(configuration.bucket);
    if (bucket == null) {
        const url = stringValue(configuration.url);
        return url == null ? [] : [url];
    }

    const prefix = stringValue(configuration.prefix);
    return [`s3://${bucket}/${prefix ?? ''}`];
}

function storageLocation(value: unknown): string | undefined {
    if (typeof value === 'string') {
        return value;
    }
    if (value == null || typeof value !== 'object' || Array.isArray(value)) {
        return undefined;
    }

    const location = value as Record<string, unknown>;
    const bucket = stringValue(location.bucket);
    if (bucket == null) {
        return undefined;
    }
    return `s3://${bucket}/${stringValue(location.prefix) ?? ''}`;
}

function stringValue(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}
