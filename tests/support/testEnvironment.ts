/**
 * @fileoverview Small helpers for isolating environment, directory, and process
 * state during tests.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/** Captures named environment values and returns a restore callback. */
export function captureEnvironment(...names: string[]): () => void {
    const original = new Map<string, string | undefined>();
    for (const name of names) {
        original.set(name, process.env[name]);
    }
    return () => {
        for (const [name, value] of original) {
            setEnvironmentValue(name, value);
        }
    };
}

/** Runs a callback with temporary environment changes and restores them afterward. */
export async function withEnvironment<T>(
    changes: Record<string, string | undefined>,
    callback: () => T | Promise<T>,
): Promise<T> {
    const restore = captureEnvironment(...Object.keys(changes));
    for (const [name, value] of Object.entries(changes)) {
        setEnvironmentValue(name, value);
    }

    try {
        return await callback();
    } finally {
        restore();
    }
}

/** Runs a callback in a temporary directory and removes it when the callback ends. */
export async function withTemporaryDirectory<T>(
    prefix: string,
    callback: (directory: string) => T | Promise<T>,
): Promise<T> {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
    try {
        return await callback(directory);
    } finally {
        await fs.rm(directory, { force: true, maxRetries: 3, recursive: true, retryDelay: 100 });
    }
}

/** Runs a callback from a temporary working directory and restores the original path. */
export async function withWorkingDirectory<T>(
    directory: string,
    callback: () => T | Promise<T>,
): Promise<T> {
    const original = process.cwd();
    process.chdir(directory);
    try {
        return await callback();
    } finally {
        process.chdir(original);
    }
}

function setEnvironmentValue(name: string, value: string | undefined): void {
    if (value == null) {
        delete process.env[name];
    } else {
        process.env[name] = value;
    }
}
