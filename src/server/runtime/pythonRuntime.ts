/**
 * @fileoverview Selects the configured or repository-local Python executable
 * used by Spark adapters and workers.
 */

import { existsSync } from 'node:fs';
import path from 'node:path';

/**
 * Selects the Python executable for repository-backed Spark helpers.
 *
 * An explicit `PYTHON_EXECUTABLE` always wins so deployments can provide a
 * managed runtime. Otherwise, the repository virtualenv is preferred when it
 * exists, followed by the platform's conventional command; relative command
 * names are retained because they are resolved by the child-process PATH.
 * This function only chooses a command—it does not verify that Python can
 * import the required Spark libraries or start a Spark Connect session.
 */
export function resolvePythonExecutable(
    environment: NodeJS.ProcessEnv = process.env,
    platform: NodeJS.Platform = process.platform,
    workingDirectory: string = process.cwd(),
): string {
    const configured = environment.PYTHON_EXECUTABLE?.trim();
    if (configured) {
        return configured;
    }

    const candidates = platform === 'win32'
        ? [
            path.join(workingDirectory, '.venv', 'Scripts', 'python.exe'),
            'python.exe',
        ]
        : [
            path.join(workingDirectory, '.venv', 'bin', 'python'),
            'python3',
        ];
    return candidates.find((candidate) =>
        !path.isAbsolute(candidate) || existsSync(candidate)
    ) ?? candidates.at(-1)!;
}
