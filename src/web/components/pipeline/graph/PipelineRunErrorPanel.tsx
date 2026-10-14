/**
 * @fileoverview Expandable diagnostics for the selected pipeline run.
 */

import { ChevronDown } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { PipelineRun } from '../../../../shared/pipelineRegistryTypes.ts';
import {
    pipelineRunFailureMessage,
    pipelineRunFailureTitle,
    RunStatus,
} from '../../../../shared/status/run.ts';
import { AppIcon } from '../../ui/AppIcon';

/** Shows the selected run's failure summary and expandable captured output. */
export function PipelineRunErrorPanel({
    run,
}: Readonly<{
    run?: PipelineRun;
}>) {
    const [expanded, setExpanded] = useState(false);

    useEffect(() => {
        setExpanded(false);
    }, [run?.runId]);

    if (run == null || !isFailureStatus(run.status)) {
        return null;
    }

    const diagnostic = diagnosticText(run);
    const preview = diagnosticPreview(diagnostic);
    const detailsId = `pipeline-run-error-details-${run.runId}`;

    return (
        <section aria-label="Pipeline run error" className="pipeline-run-error" role="alert">
            <div className="pipeline-run-error-header">
                <div className="pipeline-run-error-summary">
                    <strong>{pipelineRunFailureTitle(run.status)}</strong>
                    <span title={preview}>{preview}</span>
                </div>
                <button
                    aria-controls={detailsId}
                    aria-expanded={expanded}
                    aria-label={expanded ? 'Collapse pipeline error details' : 'Expand pipeline error details'}
                    className="pipeline-run-error-toggle"
                    onClick={() => setExpanded((current) => !current)}
                    type="button"
                >
                    <span>{expanded ? 'Hide details' : 'Show details'}</span>
                    <AppIcon
                        className={expanded ? 'expanded' : undefined}
                        icon={ChevronDown}
                        size="status"
                    />
                </button>
            </div>
            {expanded && (
                <div className="pipeline-run-error-details" id={detailsId}>
                    <pre>{diagnostic}</pre>
                </div>
            )}
        </section>
    );
}

function isFailureStatus(status: PipelineRun['status']): boolean {
    return status === RunStatus.FAILED || status === RunStatus.CANCELED ||
        status === RunStatus.TIMED_OUT || status === RunStatus.UNKNOWN;
}

function diagnosticText(run: PipelineRun): string {
    const sections: string[] = [];
    const stderr = run.stderr?.trim();
    const stdout = run.stdout?.trim();

    if (stderr != null && stderr !== '') {
        sections.push(`[stderr]\n${stderr}`);
    }
    if (stdout != null && stdout !== '') {
        sections.push(`[stdout]\n${stdout}`);
    }

    return sections.length > 0
        ? sections.join('\n\n')
        : pipelineRunFailureMessage(run, 'diagnostic');
}

function diagnosticPreview(diagnostic: string): string {
    const lines = diagnostic
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line !== '' &&
            !line.startsWith('[stderr]') &&
            !line.startsWith('[stdout]') &&
            !line.startsWith('<_MultiThreadedRendezvous') &&
            !line.startsWith('status = ') &&
            !line.startsWith('debug_error_string = ') &&
            line !== '>');
    const candidate = lines[0] ?? diagnostic;
    const normalized = candidate
        .replace(/^details\s*=\s*"?/, '')
        .replace(/"$/, '')
        .replace(/\s+/g, ' ')
        .trim();

    return normalized.length > 180
        ? `${normalized.slice(0, 177)}...`
        : normalized;
}
