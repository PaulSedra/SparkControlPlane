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

/** Resolves a pipeline source path and rejects paths outside its root. */
export function resolveInsideRoot(root: string, relativePath: string): string {
    const resolvedRoot = path.resolve(root);
    const resolvedPath = path.resolve(resolvedRoot, relativePath);
    const relative = path.relative(resolvedRoot, resolvedPath);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        throw new Error(`Pipeline source path escapes its project root: ${relativePath}`);
    }
    return resolvedPath;
}

/** Resolves the local directory for durable run source snapshots and results. */
export function pipelineRunStateDirectory(
    environment: NodeJS.ProcessEnv = process.env,
): string {
    return path.resolve(environment.PIPELINE_RUN_STATE_DIRECTORY?.trim() || '/app/run-state');
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
