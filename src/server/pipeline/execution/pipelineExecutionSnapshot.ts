/**
 * @fileoverview Materializes verified, run-specific copies of submitted pipeline sources.
 */

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { ParsedPipeline } from '../discovery/pipelineDiscovery.ts';
import { mapWithConcurrency } from '../mapWithConcurrency.ts';
import { pipelineProjectRoot, pipelineRunStateDirectory } from './pipelineRuntime.ts';
import { hashPipelineSourceSnapshot } from '../discovery/pipelineVersion.ts';

const SNAPSHOT_FILE_CONCURRENCY = 8;

/**
 * Copies the persisted pipeline version into a run-owned directory and
 * verifies the staged bytes before returning a spec that points into the copy.
 */
export async function createVerifiedPipelineExecutionSnapshot(
    parsed: ParsedPipeline,
    submittedSourceHash: string | undefined,
    runId: string,
    stateDirectory = pipelineRunStateDirectory(),
): Promise<ParsedPipeline> {
    if (!/^[0-9a-f-]+$/i.test(runId)) {
        throw new Error('Pipeline run identity contains unsupported characters.');
    }

    const sourceRoot = pipelineProjectRoot(parsed.detail.specPath);
    const yamlContent = parsed.specContent;
    if (yamlContent == null) {
        throw new Error('This pipeline has no saved source snapshot. Refresh pipelines from source before running it.');
    }
    const sourceFiles = parsed.sourceContents.map(({ content, sourceFile: relativePath }) => ({
        content,
        relativePath,
    }));
    const sourcePaths = new Set(sourceFiles.map((source) => normalizeSourcePath(source.relativePath)));
    if (parsed.detail.sourceFiles.some((sourceFile) =>
        !sourcePaths.has(normalizeSourcePath(sourceFile)))) {
        throw new Error('This pipeline has an incomplete source snapshot. Refresh pipelines from source before running it.');
    }
    const currentHash = hashPipelineSourceSnapshot(yamlContent, sourceFiles.map((source) => ({
        content: source.content,
        sourceFile: source.relativePath,
    })));
    const requiredHash = submittedSourceHash ?? parsed.sourceHash;
    if (currentHash !== requiredHash || currentHash !== parsed.sourceHash) {
        throw new Error(
            'Pipeline source changed while this run was being prepared. Deploy and submit a new run.',
        );
    }

    const absoluteStateDirectory = path.resolve(stateDirectory);
    const runDirectory = path.join(absoluteStateDirectory, 'runs', runId);
    const stagingDirectory = path.join(runDirectory, `.source-${crypto.randomUUID()}`);
    const snapshotDirectory = path.join(runDirectory, 'source');
    const specRelativePath = path.relative(sourceRoot, parsed.detail.specPath);
    resolveInsideRoot(sourceRoot, specRelativePath);
    const filesToStage = [
        { content: yamlContent, relativePath: specRelativePath },
        ...sourceFiles.map(({ content, relativePath }) => ({ content, relativePath })),
    ];

    await fs.mkdir(runDirectory, { recursive: true });
    if (await pathExists(snapshotDirectory)) {
        throw new Error('A source snapshot already exists for this pipeline run.');
    }

    try {
        await fs.mkdir(stagingDirectory);
        await mapWithConcurrency(filesToStage, SNAPSHOT_FILE_CONCURRENCY, async (file) => {
            const destination = resolveInsideRoot(stagingDirectory, file.relativePath);
            await fs.mkdir(path.dirname(destination), { recursive: true });
            await fs.writeFile(destination, file.content, {
                encoding: 'utf8',
                mode: process.platform === 'win32' ? 0o666 : 0o444,
            });
        });

        const stagedYamlContent = await fs.readFile(
            resolveInsideRoot(stagingDirectory, specRelativePath),
            'utf8',
        );
        const stagedSourceContents = await mapWithConcurrency(
            sourceFiles,
            SNAPSHOT_FILE_CONCURRENCY,
            async (source) => {
                const stagedPath = resolveInsideRoot(stagingDirectory, source.relativePath);
                return {
                    content: await fs.readFile(stagedPath, 'utf8'),
                    sourceFile: source.relativePath,
                };
            },
        );
        if (hashPipelineSourceSnapshot(stagedYamlContent, stagedSourceContents) !== requiredHash) {
            throw new Error('The staged pipeline source did not match its submitted deployment hash.');
        }

        await fs.rename(stagingDirectory, snapshotDirectory);
        const snapshotSpecPath = resolveInsideRoot(snapshotDirectory, specRelativePath);
        return {
            ...parsed,
            detail: {
                ...parsed.detail,
                spec: { ...parsed.detail.spec, specPath: snapshotSpecPath },
                specPath: snapshotSpecPath,
            },
        };
    } catch (error) {
        await fs.rm(stagingDirectory, { force: true, recursive: true });
        throw error;
    }
}

function resolveInsideRoot(root: string, relativePath: string): string {
    const resolvedRoot = path.resolve(root);
    const resolvedPath = path.resolve(resolvedRoot, relativePath);
    const relative = path.relative(resolvedRoot, resolvedPath);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        throw new Error(`Pipeline source path escapes its project root: ${relativePath}`);
    }
    return resolvedPath;
}

function normalizeSourcePath(sourcePath: string): string {
    return path.posix.normalize(sourcePath.replaceAll('\\', '/'));
}

async function pathExists(filePath: string): Promise<boolean> {
    try {
        await fs.access(filePath);
        return true;
    } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
            return false;
        }
        throw error;
    }
}
