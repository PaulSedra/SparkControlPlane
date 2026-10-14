/**
 * @fileoverview Browser client for pipeline, run, trigger, source, and
 * dead-letter API operations.
 */

import type {
    PipelineDetail,
    PipelineNodeData,
    PipelineSourceFile,
    PipelineRun,
    PipelineSummary,
    RunMode,
} from '../../shared/pipelineRegistryTypes.ts';
import {
    ACTIVE_PIPELINE_RUN_STATUSES,
    pipelineRunFailureMessage,
} from '../../shared/status/run.ts';
import {
    TriggerDeadLetterStatus,
} from '../../shared/status/trigger.ts';
import type {
    TriggerDefinition,
    TriggerDeadLetter,
    TriggerDeliveryAttempt,
    TriggerScheduleStatus,
} from '../types/triggerTypes.ts';

/** Error returned when a run submission includes a useful run payload. */
export class PipelineApiError extends Error {
    run?: PipelineRun;

    constructor(message: string, run?: PipelineRun) {
        super(message);
        this.name = 'PipelineApiError';
        this.run = run;
    }
}

/**
 * Loads the registry list used by the jobs-and-pipelines page.
 *
 * The endpoint may return pagination metadata in addition to `pipelines`; the
 * browser client intentionally exposes the compatible list shape here and
 * treats a missing list as empty. It reads the saved registry snapshot without
 * scanning the mounted source folder and remains abortable for route changes.
 */
export async function getPipelines(
    signal?: AbortSignal,
): Promise<PipelineSummary[]> {
    const response = await fetch('/api/v1/pipelines', {
        cache: 'no-store',
        signal,
    });
    if (!response.ok) {
        throw new Error(await errorMessage(response, 'Unable to load pipelines.'));
    }

    const body = await response.json() as { pipelines?: PipelineSummary[] };
    return Array.isArray(body.pipelines) ? body.pipelines : [];
}

/** Repulls the complete pipeline source folder and stores its new registry snapshot. */
export async function refreshPipelinesFromSource(): Promise<PipelineSummary[]> {
    const response = await fetch('/api/v1/pipelines/refresh-from-source', { method: 'POST' });
    if (!response.ok) {
        throw new Error(await errorMessage(response, 'Unable to refresh pipelines from source.'));
    }
    const body = await response.json() as { pipelines?: PipelineSummary[] };
    return Array.isArray(body.pipelines) ? body.pipelines : [];
}

/**
 * Loads trigger definitions without cache so enablement changes are reflected
 * on the next view load; malformed list payloads degrade to an empty result.
 */
export async function getTriggers(
    signal?: AbortSignal,
): Promise<TriggerDefinition[]> {
    const response = await fetch('/api/v1/triggers', {
        cache: 'no-store',
        signal,
    });
    if (!response.ok) {
        throw new Error(await errorMessage(response, 'Unable to load triggers.'));
    }
    const body = await response.json() as { triggers?: TriggerDefinition[] };
    return Array.isArray(body.triggers) ? body.triggers : [];
}

/**
 * Loads runtime schedule status separately from the durable trigger definition.
 * The optional signal lets a trigger list abandon status requests when the
 * pipeline route changes.
 */
export async function getTriggerScheduleStatus(
    triggerId: string,
    signal?: AbortSignal,
): Promise<TriggerScheduleStatus> {
    const response = await fetch(
        `/api/v1/triggers/${encodeURIComponent(triggerId)}/schedule`,
        { cache: 'no-store', signal },
    );
    if (!response.ok) {
        throw new Error(await errorMessage(response, 'Unable to load trigger schedule.'));
    }
    return response.json() as Promise<TriggerScheduleStatus>;
}

/**
 * Persists a trigger enable/disable patch and returns the server's canonical
 * definition. The server remains authoritative for validation and concurrent
 * updates; this client does not optimistically mutate the list.
 */
export async function updateTrigger(
    triggerId: string,
    patch: { enabled?: boolean },
): Promise<TriggerDefinition> {
    const response = await fetch(
        `/api/v1/triggers/${encodeURIComponent(triggerId)}`,
        {
            body: JSON.stringify(patch),
            headers: { 'Content-Type': 'application/json' },
            method: 'PATCH',
        },
    );
    if (!response.ok) {
        throw new Error(await errorMessage(response, 'Unable to update trigger.'));
    }
    return response.json() as Promise<TriggerDefinition>;
}

/**
 * Loads the bounded recent delivery history for one trigger. The API limit is
 * explicit so this diagnostic view cannot accidentally request an unbounded
 * audit stream.
 */
export async function getTriggerDeliveryAttempts(
    triggerId: string,
    signal?: AbortSignal,
): Promise<TriggerDeliveryAttempt[]> {
    const response = await fetch(
        `/api/v1/triggers/delivery-attempts?triggerId=${encodeURIComponent(triggerId)}&limit=20`,
        { cache: 'no-store', signal },
    );
    if (!response.ok) {
        throw new Error(await errorMessage(response, 'Unable to load trigger delivery history.'));
    }
    const body = await response.json() as { attempts?: TriggerDeliveryAttempt[] };
    return Array.isArray(body.attempts) ? body.attempts : [];
}

/**
 * Loads dead letters for one lifecycle status using the API's bounded page.
 * Replay/discard state remains server-owned; this function only reads it.
 */
export async function getTriggerDeadLetters(
    status: TriggerDeadLetterStatus = TriggerDeadLetterStatus.PENDING,
    signal?: AbortSignal,
): Promise<TriggerDeadLetter[]> {
    const response = await fetch(
        `/api/v1/triggers/dead-letters?status=${encodeURIComponent(status)}&limit=100`,
        { cache: 'no-store', signal },
    );
    if (!response.ok) {
        throw new Error(await errorMessage(response, 'Unable to load trigger dead letters.'));
    }
    const body = await response.json() as { deadLetters?: TriggerDeadLetter[] };
    return Array.isArray(body.deadLetters) ? body.deadLetters : [];
}

/**
 * Requests server-side replay of a pending dead letter through normal
 * idempotent delivery. Completion is represented by the HTTP result; callers
 * should reload the record rather than assume replay succeeded locally.
 */
export async function replayTriggerDeadLetter(
    deadLetterId: string,
): Promise<void> {
    const response = await fetch(
        `/api/v1/triggers/dead-letters/${encodeURIComponent(deadLetterId)}/replay`,
        { method: 'POST' },
    );
    if (!response.ok) {
        throw new Error(await errorMessage(response, 'Unable to replay trigger dead letter.'));
    }
}

/**
 * Records an explicit discard outcome for one dead letter and returns the
 * canonical updated record.
 */
export async function discardTriggerDeadLetter(
    deadLetterId: string,
): Promise<TriggerDeadLetter> {
    const response = await fetch(
        `/api/v1/triggers/dead-letters/${encodeURIComponent(deadLetterId)}/discard`,
        { method: 'POST' },
    );
    if (!response.ok) {
        throw new Error(await errorMessage(response, 'Unable to discard trigger dead letter.'));
    }
    return response.json() as Promise<TriggerDeadLetter>;
}

/**
 * Loads one pipeline, with structural detail and run history selectable
 * independently. Omitting runs uses the short-lived cache-friendly response
 * path so the detail controller can load graph structure before best-effort
 * history enrichment.
 */
export async function getPipelineDetail(
    pipelineId: string,
    signal?: AbortSignal,
    options: { includeRuns?: boolean } = {},
): Promise<PipelineDetail> {
    const includeRuns = options.includeRuns !== false;
    const response = await fetch(
        `/api/v1/pipelines/${encodeURIComponent(pipelineId)}` +
            (includeRuns ? '' : '?includeRuns=false'),
        {
            cache: includeRuns ? 'no-store' : 'default',
            signal,
        },
    );
    if (!response.ok) {
        throw new Error(await errorMessage(response, 'Unable to load pipeline.'));
    }

    return response.json() as Promise<PipelineDetail>;
}

/**
 * Loads the first bounded run-history page for one pipeline. A separate page
 * request keeps structural detail available when history is slow or fails.
 */
export async function getPipelineRuns(
    pipelineId: string,
    signal?: AbortSignal,
): Promise<PipelineRun[]> {
    const response = await fetch(
        `/api/v1/pipelines/${encodeURIComponent(pipelineId)}/runs?limit=100&offset=0`,
        {
            cache: 'no-store',
            signal,
        },
    );
    if (!response.ok) {
        throw new Error(await errorMessage(response, 'Unable to load pipeline runs.'));
    }

    const body = await response.json() as { items?: PipelineRun[] };
    return Array.isArray(body.items) ? body.items : [];
}

/**
 * Asks the server to validate and persist the currently discovered source as
 * the deployable version. The returned detail is the server's canonical graph
 * and deployment state; this request does not start a Spark run.
 */
export async function deployPipeline(
    pipelineId: string,
): Promise<PipelineDetail> {
    const response = await fetch(
        `/api/v1/pipelines/${encodeURIComponent(pipelineId)}/deploy`,
        { method: 'POST' },
    );
    if (!response.ok) {
        throw new Error(await errorMessage(response, 'Unable to deploy pipeline.'));
    }

    return response.json() as Promise<PipelineDetail>;
}

/**
 * Submits a pipeline run and validates the server's run-shaped response.
 *
 * The request is asynchronous: a successful response may still be queued, and
 * a rejected response can include the persisted failed run in
 * `PipelineApiError.run` for the UI to display. The optional node list is sent
 * only as the selected execution scope; server-side admission and idempotency
 * remain authoritative.
 */
export async function runPipeline(
    pipelineId: string,
    mode: RunMode = 'incremental',
    nodeNames?: string[],
): Promise<PipelineRun> {
    const response = await fetch(
        `/api/v1/pipelines/${encodeURIComponent(pipelineId)}/runs`,
        {
            body: JSON.stringify({ mode, nodeNames }),
            headers: { 'Content-Type': 'application/json' },
            method: 'POST',
        },
    );
    const body = await response.json() as Partial<PipelineRun> & { message?: string };
    if (!response.ok) {
        const run = isPipelineRun(body) ? body : undefined;
        throw new PipelineApiError(
            body.message ?? (run == null
                ? undefined
                : pipelineRunFailureMessage(run, 'registry')) ?? 'Unable to run pipeline.',
            run,
        );
    }

    if (!isPipelineRun(body)) {
        throw new PipelineApiError('Run submission did not return a pipeline run.');
    }

    return body;
}

/**
 * Loads the full persisted state for a run, including bounded diagnostics and
 * lifecycle metadata. It is used for selected terminal runs; live monitoring
 * uses the lighter status endpoint instead.
 */
export async function getPipelineRun(
    runId: string,
    signal?: AbortSignal,
): Promise<PipelineRun> {
    const response = await fetch(
        `/api/v1/runs/${encodeURIComponent(runId)}`,
        {
            cache: 'no-store',
            signal,
        },
    );
    if (!response.ok) {
        throw new Error(
            await errorMessage(response, 'Unable to load pipeline run.'),
        );
    }
    return response.json() as Promise<PipelineRun>;
}

/**
 * Requests cancellation and returns the server's current run state. The
 * request is not a local kill signal: workers and lifecycle persistence decide
 * when the run reaches its terminal canceled state.
 */
export async function cancelPipelineRun(
    runId: string,
    reason?: string,
): Promise<PipelineRun> {
    const response = await fetch(
        `/api/v1/runs/${encodeURIComponent(runId)}/cancel`,
        {
            body: JSON.stringify(reason == null ? {} : { reason }),
            headers: { 'Content-Type': 'application/json' },
            method: 'POST',
        },
    );
    const body = await response.json() as Partial<PipelineRun> & { message?: string };
    if (!response.ok) {
        throw new Error(body.message ?? 'Unable to cancel pipeline run.');
    }
    return body as PipelineRun;
}

/**
 * Polls a run once per second until a terminal status is returned.
 *
 * The callback receives the initial status and every subsequent snapshot, so a
 * caller can update live UI state without starting its own timer. Temporary
 * request failures are retried twice with backoff; persistent monitoring
 * failures are left to the caller to recover without classifying the run as
 * failed. Aborting the supplied signal stops both retries and polling.
 */
export async function monitorPipelineRun(
    runId: string,
    signal: AbortSignal,
    onUpdate?: (run: PipelineRun) => void,
): Promise<PipelineRun> {
    let run = await getPipelineRunStatusWithRetry(runId, signal);
    onUpdate?.(run);
    while (ACTIVE_PIPELINE_RUN_STATUSES.includes(run.status)) {
        await delay(1000, signal);
        run = await getPipelineRunStatusWithRetry(runId, signal);
        onUpdate?.(run);
    }

    return run;
}

/**
 * Loads one registered source file for the read-only workspace. The file name
 * is encoded as a query value and the signal lets selection changes abandon a
 * stale source response.
 */
export async function getPipelineSourceFile(
    pipelineId: string,
    sourceFile: string,
    signal?: AbortSignal,
): Promise<PipelineSourceFile> {
    const response = await fetch(
        `/api/v1/pipelines/${encodeURIComponent(pipelineId)}/source` +
            `?file=${encodeURIComponent(sourceFile)}`,
        { signal },
    );
    if (!response.ok) {
        throw new Error(await errorMessage(response, 'Unable to load pipeline source.'));
    }

    return response.json() as Promise<PipelineSourceFile>;
}

/**
 * Loads the server-limited sample for one declared non-external pipeline node.
 * The Spark adapter caps this response at 100 rows; aborting the supplied
 * signal abandons the request when the preview selection changes.
 */
export async function getPipelineNodeData(
    pipelineId: string,
    nodeId: string,
    signal?: AbortSignal,
): Promise<PipelineNodeData> {
    const response = await fetch(
        `/api/v1/pipelines/${encodeURIComponent(pipelineId)}/nodes/` +
            `${encodeURIComponent(nodeId)}/data`,
        { cache: 'no-store', signal },
    );
    if (!response.ok) {
        throw new Error(await errorMessage(response, 'Unable to load sample data.'));
    }

    return response.json() as Promise<PipelineNodeData>;
}

async function getPipelineRunStatus(
    runId: string,
    signal?: AbortSignal,
): Promise<PipelineRun> {
    const response = await fetch(
        `/api/v1/runs/${encodeURIComponent(runId)}/status`,
        {
            cache: 'no-store',
            signal,
        },
    );
    if (!response.ok) {
        throw new PipelineRunStatusRequestError(
            await errorMessage(response, 'Unable to load pipeline run status.'),
            response.status,
        );
    }
    return response.json() as Promise<PipelineRun>;
}

const PIPELINE_RUN_STATUS_RETRY_DELAYS_MS = [250, 500] as const;

async function getPipelineRunStatusWithRetry(
    runId: string,
    signal: AbortSignal,
): Promise<PipelineRun> {
    for (let retry = 0; ; retry += 1) {
        try {
            return await getPipelineRunStatus(runId, signal);
        } catch (error) {
            if (signal?.aborted || !isRetryableMonitoringError(error) ||
                retry >= PIPELINE_RUN_STATUS_RETRY_DELAYS_MS.length) {
                throw error;
            }
            await delay(PIPELINE_RUN_STATUS_RETRY_DELAYS_MS[retry]!, signal);
        }
    }
}

class PipelineRunStatusRequestError extends Error {
    readonly statusCode: number;

    constructor(message: string, statusCode: number) {
        super(message);
        this.name = 'PipelineRunStatusRequestError';
        this.statusCode = statusCode;
    }
}

function isRetryableMonitoringError(error: unknown): boolean {
    if (error instanceof PipelineRunStatusRequestError) {
        return error.statusCode === 408 || error.statusCode === 429 || error.statusCode >= 500;
    }
    return !(error instanceof DOMException && error.name === 'AbortError');
}

async function errorMessage(
    response: Response,
    fallback: string,
): Promise<string> {
    try {
        const body = await response.json() as { message?: string };
        return body.message ?? fallback;
    } catch {
        return fallback;
    }
}

function isPipelineRun(value: unknown): value is PipelineRun {
    return value != null &&
        typeof value === 'object' &&
        'runId' in value &&
        'status' in value &&
        'startedAt' in value;
}

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
        if (signal.aborted) {
            reject(new DOMException('The operation was aborted.', 'AbortError'));
            return;
        }

        const timeoutId = setTimeout(() => {
            signal.removeEventListener('abort', onAbort);
            resolve();
        }, milliseconds);
        const onAbort = () => {
            clearTimeout(timeoutId);
            reject(new DOMException('The operation was aborted.', 'AbortError'));
        };
        signal.addEventListener('abort', onAbort, { once: true });
    });
}
