/**
 * @fileoverview Shared Docker-backed HTTP and process helpers for container tests.
 */

import { spawnSync } from 'node:child_process';

const terminalRunStatuses = new Set(['CANCELED', 'FAILED', 'SUCCEEDED', 'TIMED_OUT', 'UNKNOWN']);

/**
 * Creates bounded helpers for exercising one running control-plane container.
 *
 * Requests are normalized to JSON without assuming success, readiness polling
 * tolerates container restarts, and run waits include selected terminal
 * diagnostics when the deadline expires. The returned Docker helper is kept
 * explicit so tests can verify container state without hiding process errors;
 * all waits are bounded by the configured timeouts.
 */
export function createContainerTestSupport({
    baseUrl,
    docker = 'docker',
    readyMessage = 'Container did not become ready.',
    readyTimeoutMs = 30_000,
    runTimeoutMs = 20_000,
} = {}) {
    async function requestJson(urlOrPath, options = {}) {
        const response = await fetch(resolveUrl(urlOrPath), {
            body: options.body == null ? undefined :
                typeof options.body === 'string' ? options.body : JSON.stringify(options.body),
            headers: {
                accept: 'application/json',
                ...(options.body == null ? {} : { 'Content-Type': 'application/json' }),
                ...options.headers,
            },
            method: options.method ?? 'GET',
        });
        const text = await response.text();
        let body = {};
        try {
            body = text === '' ? {} : JSON.parse(text);
        } catch {
            body = { raw: text };
        }
        return { body, headers: response.headers, status: response.status };
    }

    async function waitForRun(runId, statuses) {
        const deadline = Date.now() + runTimeoutMs;
        let lastBody = {};
        while (Date.now() < deadline) {
            const response = await requestJson('/api/v1/runs/' + encodeURIComponent(runId));
            lastBody = response.body;
            if (response.status === 200 && statuses.includes(response.body.status)) {
                return response.body;
            }
            if (response.status === 200 && terminalRunStatuses.has(response.body.status)) {
                const events = await requestJson(
                    '/api/v1/runs/' + encodeURIComponent(runId) + '/events?limit=100&offset=0',
                );
                throw new Error(
                    'Run ' + runId + ' reached unexpected terminal state; last state: ' +
                    formatRunDiagnostics(lastBody, events.body.items) + '.',
                );
            }
            await delay(200);
        }
        const events = await requestJson(
            '/api/v1/runs/' + encodeURIComponent(runId) + '/events?limit=100&offset=0',
        );
        throw new Error(
            'Run ' + runId + ' did not reach ' + statuses.join(', ') + '; last state: ' +
            formatRunDiagnostics(lastBody, events.body.items) + '.',
        );
    }

    async function waitForRunPredicate(runId, predicate) {
        const deadline = Date.now() + runTimeoutMs;
        let lastBody = {};
        while (Date.now() < deadline) {
            const response = await requestJson('/api/v1/runs/' + encodeURIComponent(runId));
            lastBody = response.body;
            if (response.status === 200 && predicate(response.body)) {
                return response.body;
            }
            if (response.status === 200 && terminalRunStatuses.has(response.body.status)) {
                const events = await requestJson(
                    '/api/v1/runs/' + encodeURIComponent(runId) + '/events?limit=100&offset=0',
                );
                throw new Error(
                    'Run ' + runId + ' reached an unexpected terminal state before the expected ' +
                    'active state; last state: ' +
                    formatRunDiagnostics(lastBody, events.body.items) + '.',
                );
            }
            await delay(200);
        }
        const events = await requestJson(
            '/api/v1/runs/' + encodeURIComponent(runId) + '/events?limit=100&offset=0',
        );
        throw new Error(
            'Run ' + runId + ' did not reach the expected active execution state; last state: ' +
            formatRunDiagnostics(lastBody, events.body.items) + '.',
        );
    }

    async function waitForReady() {
        const deadline = Date.now() + readyTimeoutMs;
        while (Date.now() < deadline) {
            try {
                const response = await fetch(resolveUrl('/ready'));
                if (response.status === 200) {
                    return;
                }
            } catch {
                // The container may be restarting.
            }
            await delay(250);
        }
        throw new Error(readyMessage);
    }

    function dockerCommand(args) {
        const result = spawnSync(docker, args, {
            encoding: 'utf8',
            stdio: 'pipe',
            windowsHide: true,
        });
        if (result.error != null || result.status !== 0) {
            throw new Error('Docker ' + args[0] + ' failed during acceptance.');
        }
    }

    function resolveUrl(urlOrPath) {
        return urlOrPath.startsWith('http') ? urlOrPath : baseUrl + urlOrPath;
    }

    return {
        dockerCommand,
        requestJson,
        waitForReady,
        waitForRun,
        waitForRunPredicate,
    };
}

function formatRunDiagnostics(run, events) {
    return JSON.stringify({
        endedAt: run.endedAt,
        events: events?.map((event) => event.eventType),
        exitCode: run.exitCode,
        cliExecutionId: run.cliExecutionId,
        cliProcessId: run.cliProcessId,
        cliRunDirectory: run.cliRunDirectory,
        cliState: run.cliState,
        recoveryReason: run.recoveryReason,
        status: run.status,
        terminalReason: run.terminalReason,
        stdout: run.stdout,
        stderr: run.stderr,
    });
}

function delay(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
