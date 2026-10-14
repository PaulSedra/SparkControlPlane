/**
 * @fileoverview Finds pipeline specifications and resolves project source files.
 *
 * Library include expansion supports SQL and Python sources and enforces the
 * project-root boundary before accessing referenced paths.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import type { PipelineSpec } from '../../../shared/pipelineRegistryTypes.ts';
import { mapWithConcurrency } from '../mapWithConcurrency.ts';

/** Finds pipeline specifications below PIPELINES_DIR in stable path order. */
export async function discoverPipelineSpecPaths(concurrency: number): Promise<string[]> {
    const root = pipelinesRoot();
    try {
        return (await findPipelineSpecsUnder(root, concurrency))
            .sort((left, right) => left.localeCompare(right));
    } catch (error) {
        if (isNodeError(error) && error.code === 'ENOENT') {
            return [];
        }
        throw error;
    }
}

/** Resolves declared SQL and Python library includes without allowing root escapes. */
export async function resolvePipelineSources(
    root: string,
    spec: PipelineSpec,
    concurrency: number,
): Promise<string[]> {
    const files = new Set<string>();
    const expandedIncludes = await mapWithConcurrency(
        spec.libraries,
        concurrency,
        (include) => expandInclude(path.dirname(spec.specPath), root, include, concurrency),
    );
    for (const matches of expandedIncludes) {
        for (const file of matches) {
            files.add(file);
        }
    }

    return Array.from(files).sort((left, right) => left.localeCompare(right));
}

async function findPipelineSpecsUnder(directory: string, concurrency: number): Promise<string[]> {
    const specs: string[] = [];
    let directories = [directory];
    while (directories.length > 0) {
        const entriesByDirectory = await mapWithConcurrency(
            directories,
            concurrency,
            async (currentDirectory) => ({
                entries: await fs.readdir(currentDirectory, { withFileTypes: true }),
                path: currentDirectory,
            }),
        );
        const nestedDirectories: string[] = [];
        for (const { entries, path: currentDirectory } of entriesByDirectory) {
            for (const entry of entries) {
                const entryPath = path.join(currentDirectory, entry.name);
                if (entry.isFile() && isPipelineSpecFile(currentDirectory, entry.name)) {
                    specs.push(entryPath);
                } else if (entry.isDirectory()) {
                    nestedDirectories.push(entryPath);
                }
            }
        }
        directories = nestedDirectories;
    }
    return specs;
}

function isPipelineSpecFile(directory: string, fileName: string): boolean {
    return path.basename(directory).toLowerCase() === 'resources' &&
        /^.+\.pipeline\.yaml$/i.test(fileName);
}

async function expandInclude(
    baseDir: string,
    root: string,
    include: string,
    concurrency: number,
): Promise<string[]> {
    const normalized = include.replaceAll('\\', '/');
    if (normalized.endsWith('/**')) {
        return sourceFilesUnder(
            assertInsideRoot(root, path.join(baseDir, normalized.slice(0, -3))),
            undefined,
            concurrency,
        );
    }

    if (normalized.endsWith('/**/*.sql')) {
        return sourceFilesUnder(
            assertInsideRoot(root, path.join(baseDir, normalized.slice(0, -8))),
            '.sql',
            concurrency,
        );
    }

    if (normalized.endsWith('/**/*.py')) {
        return sourceFilesUnder(
            assertInsideRoot(root, path.join(baseDir, normalized.slice(0, -7))),
            '.py',
            concurrency,
        );
    }

    if (normalized.endsWith('/*.sql')) {
        const dir = assertInsideRoot(root, path.join(baseDir, normalized.slice(0, -6)));
        return sourceFilesInDirectory(dir, '.sql');
    }

    if (normalized.endsWith('/*.py')) {
        const dir = assertInsideRoot(root, path.join(baseDir, normalized.slice(0, -5)));
        return sourceFilesInDirectory(dir, '.py');
    }

    if (normalized.endsWith('.sql') || normalized.endsWith('.py')) {
        return [assertInsideRoot(root, path.join(baseDir, normalized))];
    }

    throw new Error(`Unsupported library include: ${include}`);
}

async function sourceFilesUnder(
    dir: string,
    extension: '.py' | '.sql' | undefined,
    concurrency: number,
): Promise<string[]> {
    const files: string[] = [];
    let directories = [dir];
    while (directories.length > 0) {
        const entriesByDirectory = await mapWithConcurrency(
            directories,
            concurrency,
            async (currentDirectory) => ({
                entries: await fs.readdir(currentDirectory, { withFileTypes: true }),
                path: currentDirectory,
            }),
        );
        const nestedDirectories: string[] = [];
        for (const { entries, path: currentDirectory } of entriesByDirectory) {
            for (const entry of entries) {
                const child = path.join(currentDirectory, entry.name);
                if (entry.isDirectory()) {
                    nestedDirectories.push(child);
                } else if (entry.isFile() && isSupportedSourceFile(entry.name, extension)) {
                    files.push(child);
                }
            }
        }
        directories = nestedDirectories;
    }
    return files;
}

async function sourceFilesInDirectory(
    dir: string,
    extension: '.py' | '.sql',
): Promise<string[]> {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries
        .filter((entry) => entry.isFile() && isSupportedSourceFile(entry.name, extension))
        .map((entry) => path.join(dir, entry.name));
}

function isSupportedSourceFile(
    fileName: string,
    extension: '.py' | '.sql' | undefined,
): boolean {
    const lowerName = fileName.toLowerCase();
    return extension == null
        ? lowerName.endsWith('.py') || lowerName.endsWith('.sql')
        : lowerName.endsWith(extension);
}

function assertInsideRoot(root: string, candidate: string): string {
    const resolvedRoot = path.resolve(root);
    const resolvedCandidate = path.resolve(candidate);
    const relative = path.relative(resolvedRoot, resolvedCandidate);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
        throw new Error(`Library path escapes pipeline root: ${candidate}`);
    }

    return resolvedCandidate;
}

function pipelinesRoot(): string {
    return process.env.PIPELINES_DIR?.trim() || path.join(process.cwd(), 'pipelines');
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
    return error instanceof Error && 'code' in error;
}
