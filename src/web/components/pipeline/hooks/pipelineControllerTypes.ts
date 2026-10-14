/** Load state mapped to the existing pipeline detail page contract. */
export type PipelineLoadState =
    | { kind: 'idle' | 'loading' | 'ready' }
    | { kind: 'error'; message: string };

type PipelineActionOperation = 'cancel' | 'deploy' | 'run';

/** Command lifecycle used to gate controls and track the active run action. */
export type PipelineActionState =
    | {
        kind: 'idle' | 'running' | 'succeeded';
        operation?: PipelineActionOperation;
        runId?: string;
    }
    | {
        kind: 'failed';
        operation?: PipelineActionOperation;
        runId?: string;
    };

/** Independent lifecycle state for deploy, run, and cancel controls. */
export interface PipelineActionStates {
    cancel: PipelineActionState;
    deploy: PipelineActionState;
    run: PipelineActionState;
}
