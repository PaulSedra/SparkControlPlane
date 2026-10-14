/**
 * @fileoverview Pipeline detail header, run actions, and selected-node action
 * controls.
 */

import { useEffect, useRef, useState } from 'react';
import {
    ChevronDown,
    MoreVertical,
    Pencil,
    Play,
    RefreshCw,
    Rocket,
    Settings2,
    Star,
    Table2,
    X,
} from 'lucide-react';
import type {
    PipelineDetail,
    PipelineRun,
    RunMode,
} from '../../../shared/pipelineRegistryTypes.ts';
import {
    ACTIVE_PIPELINE_RUN_STATUSES,
} from '../../../shared/status/run.ts';
import { formatDate } from '../../lib/format';
import { navigateTo } from '../../routes/useCurrentRoute';
import { AppIcon } from '../ui/AppIcon';
import type { PipelineActionStates } from './hooks/pipelineControllerTypes.ts';
import { RunStatus } from './PipelineDetailsRail';

/**
 * Coordinates the pipeline header actions and their visible state.
 *
 * Deployment is kept separate from execution: a pipeline must be deployable
 * before a run can be submitted, while an active run replaces the run action
 * with cancellation. The menu exposes the supported run modes and selected
 * node scope, and the component closes that menu on outside pointer or Escape
 * input so an open menu does not survive navigation or an action.
 */
type PipelineHeaderProps = Readonly<{
    actionStates: PipelineActionStates;
    canRunPipeline: boolean;
    detail?: PipelineDetail;
    onCancel: () => Promise<void>;
    onDeploy: () => Promise<void>;
    onRun: (mode?: RunMode, nodeNames?: string[]) => Promise<void>;
}>;

/**
 * Renders pipeline identity and composes its deploy, run, and cancel controls.
 *
 * The page controller owns operation state and callbacks; the child action
 * panel owns its menu and closes it on outside pointer or Escape.
 */
export function PipelineHeader({
    actionStates,
    canRunPipeline,
    detail,
    onCancel,
    onDeploy,
    onRun,
}: PipelineHeaderProps) {
    return (
        <header className="pipeline-header">
            <div className="pipeline-title-group">
                <div className="pipeline-breadcrumb">
                    <a
                        className="pipeline-breadcrumb-link"
                        href="/pipelines"
                        onClick={(event) => {
                            event.preventDefault();
                            navigateTo('/pipelines');
                        }}
                    >
                        Jobs &amp; Pipelines
                    </a>
                    <span aria-hidden="true">›</span>
                </div>
                <div className="pipeline-title-row">
                    <h1>{detail?.name ?? 'Pipeline'}</h1>
                    <button aria-label="Add pipeline to favorites" className="pipeline-header-icon" title="Add to favorites" type="button">
                        <AppIcon icon={Star} size="status" />
                    </button>
                </div>
            </div>
            <PipelineHeaderActions
                actionStates={actionStates}
                canRunPipeline={canRunPipeline}
                detail={detail}
                onCancel={onCancel}
                onDeploy={onDeploy}
                onRun={onRun}
            />
        </header>
    );
}

function PipelineHeaderActions({
    actionStates,
    canRunPipeline,
    detail,
    onCancel,
    onDeploy,
    onRun,
}: PipelineHeaderProps) {
    const activeRunId = detail?.runs.find((run) =>
        ACTIVE_PIPELINE_RUN_STATUSES.includes(run.status))?.runId;
    return (
        <div className="pipeline-header-actions">
            <button aria-label="More pipeline actions" className="pipeline-header-icon" title="More pipeline actions" type="button">
                <AppIcon icon={MoreVertical} size="status" />
            </button>
            <button className="dark-secondary-button" type="button">
                <AppIcon icon={Pencil} size="status" />
                Edit pipeline
            </button>
            <button className="dark-secondary-button" type="button">
                <AppIcon icon={Settings2} size="status" />
                Settings
            </button>
            <PipelineStopButton
                actionStates={actionStates}
                activeRunId={activeRunId}
                onCancel={onCancel}
            />
            <PipelineRunAction
                actionStates={actionStates}
                activeRunId={activeRunId}
                canRunPipeline={canRunPipeline}
                detail={detail}
                onDeploy={onDeploy}
                onRun={onRun}
            />
        </div>
    );
}

function PipelineStopButton({
    actionStates,
    activeRunId,
    onCancel,
}: Readonly<{
    actionStates: PipelineActionStates;
    activeRunId?: string;
    onCancel: () => Promise<void>;
}>) {
    const { cancel, run } = actionStates;
    const pipelineIsExecuting = activeRunId != null ||
        run.kind === 'running' || cancel.kind === 'running';
    const canStopPipeline = activeRunId != null ||
        (run.kind === 'running' && run.runId != null);
    const cancellationPending = cancel.kind === 'running';
    return (
        <button
            aria-label={pipelineIsExecuting ? 'Stop pipeline' : 'Dry run'}
            className="dark-secondary-button"
            disabled={pipelineIsExecuting && (cancellationPending || !canStopPipeline)}
            onClick={pipelineIsExecuting && canStopPipeline && !cancellationPending
                ? () => void onCancel()
                : undefined}
            type="button"
        >
            {pipelineIsExecuting ? 'Stop' : 'Dry run'}
        </button>
    );
}

function PipelineRunAction({
    actionStates,
    activeRunId,
    canRunPipeline,
    detail,
    onDeploy,
    onRun,
}: Readonly<{
    actionStates: PipelineActionStates;
    activeRunId?: string;
    canRunPipeline: boolean;
    detail?: PipelineDetail;
    onDeploy: () => Promise<void>;
    onRun: (mode?: RunMode, nodeNames?: string[]) => Promise<void>;
}>) {
    const [runActionMenuOpen, setRunActionMenuOpen] = useState(false);
    const runActionMenuRef = useRunActionMenu(runActionMenuOpen, setRunActionMenuOpen);
    const { cancel: cancelState, deploy: deployState, run: runState } = actionStates;
    const runPipelineDisabled = runState.kind === 'running' ||
        cancelState.kind === 'running' || activeRunId != null;

    function handleRun(mode?: RunMode, nodeNames?: string[]): Promise<void> {
        setRunActionMenuOpen(false);
        return onRun(mode, nodeNames);
    }

    function handleDeploy(): Promise<void> {
        setRunActionMenuOpen(false);
        return onDeploy();
    }

    return (
        <div className="pipeline-run-action" ref={runActionMenuRef}>
            {canRunPipeline ? (
                <>
                    <div className="pipeline-run-split">
                        <button
                            aria-label="Run pipeline"
                            className="dark-primary-button pipeline-run-main-button"
                            disabled={runPipelineDisabled}
                            onClick={() => void handleRun()}
                            type="button"
                        >
                            <AppIcon icon={Play} size="status" />
                            {runState.kind === 'running' ? 'Running...' : 'Run pipeline'}
                        </button>
                        <button
                            aria-expanded={runActionMenuOpen}
                            aria-haspopup="menu"
                            aria-label="More pipeline run options"
                            className="dark-primary-button pipeline-run-menu-toggle"
                            disabled={runPipelineDisabled}
                            onClick={(event) => {
                                event.stopPropagation();
                                setRunActionMenuOpen((current) => !current);
                            }}
                            onPointerDown={(event) => event.stopPropagation()}
                            type="button"
                        >
                            <AppIcon icon={ChevronDown} size="status" />
                        </button>
                    </div>
                    {runActionMenuOpen && (
                        <div className="pipeline-run-menu" role="menu">
                            <button
                                disabled={runPipelineDisabled}
                                onClick={() => void handleRun('full-refresh-all')}
                                role="menuitem"
                                type="button"
                            >
                                <AppIcon icon={RefreshCw} size="status" />
                                Run pipeline with full table refresh
                            </button>
                            <button
                                disabled={runPipelineDisabled}
                                onClick={() => void handleRun('dry-run')}
                                role="menuitem"
                                type="button"
                            >
                                <AppIcon icon={Play} size="status" />
                                Dry run
                            </button>
                        </div>
                    )}
                </>
            ) : (
                <button
                    aria-label={deployState.kind === 'running'
                        ? 'Deploying pipeline'
                        : 'Deploy pipeline'}
                    className="dark-primary-button pipeline-deploy-button"
                    disabled={detail == null || deployState.kind === 'running' || activeRunId != null}
                    onClick={() => void handleDeploy()}
                    type="button"
                >
                    <AppIcon icon={Rocket} size="status" />
                    {deployState.kind === 'running' ? 'Deploying...' : 'Deploy'}
                </button>
            )}
        </div>
    );
}

function useRunActionMenu(
    runActionMenuOpen: boolean,
    setRunActionMenuOpen: (open: boolean) => void,
): React.RefObject<HTMLDivElement | null> {
    const runActionMenuRef = useRef<HTMLDivElement>(null);
    useEffect(() => {
        if (!runActionMenuOpen) {
            return undefined;
        }

        const closeOnOutsidePointer = (event: PointerEvent) => {
            if (runActionMenuRef.current?.contains(event.target as Node)) {
                return;
            }
            setRunActionMenuOpen(false);
        };
        const closeOnEscape = (event: KeyboardEvent) => {
            if (event.key === 'Escape') {
                setRunActionMenuOpen(false);
            }
        };
        document.addEventListener('pointerdown', closeOnOutsidePointer);
        document.addEventListener('keydown', closeOnEscape);
        return () => {
            document.removeEventListener('pointerdown', closeOnOutsidePointer);
            document.removeEventListener('keydown', closeOnEscape);
        };
    }, [runActionMenuOpen, setRunActionMenuOpen]);
    return runActionMenuRef;
}

/**
 * Lets the user choose historical run context and the next refresh scope.
 *
 * The run picker changes which persisted run supplies diagnostics; it does
 * not start a run. Table-selection mode is gated by a deployed pipeline and
 * remains mutually exclusive with an in-flight action. The details rail shows
 * the selected run's lifecycle status.
 */
export function PipelineRunToolbar({
    actionStates,
    canRunPipeline,
    detail,
    onSelectRun,
    onToggleTableSelection,
    selectedRun,
    tableSelectionMode,
}: Readonly<{
    actionStates: PipelineActionStates;
    canRunPipeline: boolean;
    detail?: PipelineDetail;
    onSelectRun: (runId: string) => void;
    onToggleTableSelection: () => void;
    selectedRun?: PipelineRun;
    tableSelectionMode: boolean;
}>) {
    const hasActiveRun = detail?.runs.some((run) =>
        ACTIVE_PIPELINE_RUN_STATUSES.includes(run.status)) ?? false;
    const [runMenuOpen, setRunMenuOpen] = useState(false);

    return (
        <div className="pipeline-run-toolbar">
            <span className="run-toolbar-label">Run:</span>
            <div className="run-picker">
                <button
                    aria-expanded={runMenuOpen}
                    aria-haspopup="listbox"
                    className="run-picker-button"
                    disabled={detail == null}
                    onClick={() => setRunMenuOpen((current) => !current)}
                    type="button"
                >
                    <span>{selectedRun == null
                        ? detail == null ? 'Loading runs...' : 'No runs yet'
                        : formatDate(selectedRun.startedAt)}</span>
                    {selectedRun != null && <RunStatus status={selectedRun.status} />}
                    <AppIcon icon={ChevronDown} size="status" />
                </button>
                {runMenuOpen && detail != null && (
                    <div className="run-picker-menu" role="listbox">
                        {detail.runs.length === 0 ? (
                            <div className="run-picker-empty">No pipeline runs</div>
                        ) : detail.runs.map((run) => (
                            <button
                                aria-selected={run.runId === selectedRun?.runId}
                                className={run.runId === selectedRun?.runId ? 'selected' : undefined}
                                key={run.runId}
                                onClick={() => {
                                    onSelectRun(run.runId);
                                    setRunMenuOpen(false);
                                }}
                                role="option"
                                type="button"
                            >
                                <span>{formatDate(run.startedAt)}</span>
                                <RunStatus status={run.status} />
                            </button>
                        ))}
                    </div>
                )}
            </div>
            <button
                aria-pressed={tableSelectionMode}
                className={`refresh-tables-button${tableSelectionMode ? ' active' : ''}`}
                disabled={!canRunPipeline || actionStates.run.kind === 'running' ||
                    actionStates.cancel.kind === 'running' || hasActiveRun}
                onClick={onToggleTableSelection}
                type="button"
            >
                <AppIcon icon={Table2} size="status" />
                Select tables for refresh
            </button>
        </div>
    );
}

/**
 * Turns the selected graph nodes into a scoped refresh action.
 *
 * The bar reports the current selection and sends qualified node names to the
 * controller, which performs deployment checks and server-side run admission.
 * Clearing the bar is a local selection change; submitting it is still an
 * asynchronous run action and stays disabled while a run is being submitted.
 */
export function PipelineSelectionBar({
    activeRunId,
    runPending,
    canRunPipeline,
    onClear,
    onRun,
    selectedNodeNames,
}: Readonly<{
    activeRunId?: string;
    runPending: boolean;
    canRunPipeline: boolean;
    onClear: () => void;
    onRun: (mode: RunMode, nodeNames?: string[]) => Promise<void>;
    selectedNodeNames: string[];
}>) {
    return (
        <div
            aria-label="Selected tables for refresh"
            className="pipeline-selection-bar"
            role="toolbar"
        >
            <span className="pipeline-selection-count">
                <AppIcon icon={ChevronDown} size="status" />
                {selectedNodeNames.length} selected
            </span>
            <button
                className="pipeline-selection-action"
                disabled={!canRunPipeline || runPending || activeRunId != null}
                onClick={() => void onRun('refresh-selected', selectedNodeNames)}
                type="button"
            >
                <AppIcon icon={Play} size="status" />
                Run
            </button>
            <button
                className="pipeline-selection-action"
                disabled={!canRunPipeline || runPending || activeRunId != null}
                onClick={() => void onRun('full-refresh-selected', selectedNodeNames)}
                type="button"
            >
                <AppIcon icon={RefreshCw} size="status" />
                Run with full refresh
            </button>
            <button
                aria-label="Clear table selection"
                className="pipeline-selection-clear"
                onClick={onClear}
                title="Clear table selection"
                type="button"
            >
                <AppIcon icon={X} size="status" />
            </button>
        </div>
    );
}
