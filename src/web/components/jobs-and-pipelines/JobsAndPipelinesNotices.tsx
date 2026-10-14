/**
 * @fileoverview Inline action and failure notices for the jobs page.
 */

import { AlertCircle, CheckCircle2 } from 'lucide-react';
import { AppIcon } from '../ui/AppIcon';
import { StatusIcon } from '../ui/StatusIcon';
import type { JobsAndPipelinesController } from './hooks/useJobsAndPipelinesController';

/**
 * Maps controller load/action state to accessible status or alert regions.
 * Run progress and completion are shown in Recent runs; submission failures
 * remain actionable without adding routine run status messages.
 */
export function JobsAndPipelinesNotices({
    actionStates,
    loadState,
}: Readonly<Pick<JobsAndPipelinesController, 'actionStates' | 'loadState'>>) {
    const operationStates = [
        ['deploy', actionStates.deploy],
        ['cancel', actionStates.cancel],
    ] as const;
    return (
        <>
            {loadState.kind === 'error' && (
                <div className="jobs-pipelines-notice error" role="alert">
                    <AppIcon icon={AlertCircle} />
                    <span>{loadState.message}</span>
                </div>
            )}
            {operationStates.map(([operation, actionState]) => actionState.kind === 'failed' ? (
                <div className="jobs-pipelines-notice error" key={operation} role="alert">
                    <AppIcon icon={AlertCircle} />
                    <span>{actionState.message}</span>
                </div>
            ) : actionState.kind === 'running' && actionState.message != null ? (
                <output className="jobs-pipelines-notice" key={operation}>
                    <StatusIcon label={`${operation} in progress`} status="running" />
                    <span>{actionState.message}</span>
                </output>
            ) : actionState.kind === 'succeeded' && actionState.message != null ? (
                <output className="jobs-pipelines-notice success" key={operation}>
                    <AppIcon icon={CheckCircle2} />
                    <span>{actionState.message}</span>
                </output>
            ) : null)}
            {actionStates.run.kind === 'failed' && (
                <div className="jobs-pipelines-notice error" key="run" role="alert">
                    <AppIcon icon={AlertCircle} />
                    <span>{actionStates.run.message}</span>
                </div>
            )}
            {actionStates.run.kind === 'succeeded' && (
                <output className="jobs-pipelines-notice success" key="run">
                    <AppIcon icon={CheckCircle2} />
                    <span>{actionStates.run.message}</span>
                </output>
            )}
        </>
    );
}
