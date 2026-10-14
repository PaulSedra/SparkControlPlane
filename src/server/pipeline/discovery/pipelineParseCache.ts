/**
 * @fileoverview Caches parsed pipeline results using spec and source file stamps.
 *
 * Cache signatures include resolved source paths and each input file's size,
 * modification time, and change time.
 */
import fs from 'node:fs/promises';
import { pipelineProjectRoot } from '../execution/pipelineRuntime.ts';
import { parsePipelineSpec } from './pipelineSpecParser.ts';
import { resolvePipelineSources } from './pipelineSourceResolver.ts';
import { mapWithConcurrency } from '../mapWithConcurrency.ts';

/** Parsed-value cache keyed by spec path and its current input-file signature. */
export type PipelineParseCache<ParsedValue> = Map<string, {
    parsed: ParsedValue;
    signature: string;
}>;

/** Removes entries whose specification paths are no longer present. */
export function evictRemovedPipelines<ParsedValue>(
    pipelineParseCache: PipelineParseCache<ParsedValue>,
    currentSpecPaths: readonly string[],
): void {
    const currentPaths = new Set(currentSpecPaths);
    for (const cachedSpecPath of pipelineParseCache.keys()) {
        if (!currentPaths.has(cachedSpecPath)) {
            pipelineParseCache.delete(cachedSpecPath);
        }
    }
}

/** Reuses a parsed value only while the spec and each resolved source file retain their stamps. */
export async function getCachedPipeline<ParsedValue>(
    specPath: string,
    pipelineParseCache: PipelineParseCache<ParsedValue>,
    concurrency: number,
    parsePipeline: (path: string) => Promise<ParsedValue>,
): Promise<ParsedValue> {
    const signature = await pipelineInputSignature(specPath, concurrency);
    const cached = pipelineParseCache.get(specPath);
    if (cached?.signature === signature) {
        return cached.parsed;
    }

    const parsed = await parsePipeline(specPath);
    pipelineParseCache.set(specPath, { parsed, signature });
    return parsed;
}

async function pipelineInputSignature(specPath: string, concurrency: number): Promise<string> {
    const root = pipelineProjectRoot(specPath);
    const yamlContent = await fs.readFile(specPath, 'utf8');
    const spec = parsePipelineSpec(specPath, yamlContent);
    const sourceFiles = await resolvePipelineSources(root, spec, concurrency);
    const inputFiles = Array.from(new Set([
        specPath,
        ...sourceFiles,
    ])).sort((left, right) => left.localeCompare(right));
    const fileStamps = await mapWithConcurrency(inputFiles, concurrency, async (filePath) => {
        try {
            const stats = await fs.stat(filePath);
            return `${filePath}:${stats.size}:${stats.mtimeMs}:${stats.ctimeMs}`;
        } catch (error) {
            if (isNodeError(error) && error.code === 'ENOENT') {
                return `${filePath}:missing`;
            }
            throw error;
        }
    });
    return fileStamps.join('|');
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
    return error instanceof Error && 'code' in error;
}
