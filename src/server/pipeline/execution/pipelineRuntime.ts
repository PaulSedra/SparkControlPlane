/**
 * @fileoverview Resolves pipeline bundle roots and Python import paths for worker processes.
 */

import path from 'node:path';

/** Uses the parent of a resources directory as the bundle root, or the spec directory otherwise. */

export function pipelineProjectRoot(specPath: string): string {
    const specDirectory = path.dirname(path.resolve(specPath));
    return path.basename(specDirectory).toLowerCase() === 'resources'
        ? path.dirname(specDirectory)
        : specDirectory;
}

/** Resolves the shared local directory for supervisor state and run snapshots. */
export function pipelineRunStateDirectory(
    environment: NodeJS.ProcessEnv = process.env,
): string {
    return path.resolve(environment.SPARK_CLI_STATE_DIRECTORY?.trim() || '/app/run-state');
}

/**
 * Returns a copied environment with a deduplicated PYTHONPATH for pipeline imports.
 * The bundle and spec directories take precedence over the existing PYTHONPATH entries.
 */
export function pipelinePythonEnvironment(
    specPath: string,
    environment: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
    const configuredPipelinesRoot = environment.PIPELINES_DIR?.trim() ||
        path.join(process.cwd(), 'pipelines');
    const configuredPythonPath = environment.PYTHONPATH?.split(path.delimiter)
        .map((entry) => entry.trim())
        .filter(Boolean) ?? [];
    const specDirectory = path.dirname(path.resolve(specPath));
    const importRoots = [
        pipelineProjectRoot(specPath),
        specDirectory,
        path.dirname(path.resolve(configuredPipelinesRoot)),
        ...configuredPythonPath,
    ].map((entry) => path.resolve(entry));

    return {
        ...environment,
        PYTHONPATH: Array.from(new Set(importRoots)).join(path.delimiter),
    };
}
