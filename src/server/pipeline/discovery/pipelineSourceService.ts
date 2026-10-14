/**
 * @fileoverview Reads source files declared by a discovered pipeline specification.
 */

import path from 'node:path';
import { ControlPlaneApiError } from '../../errors/controlPlaneApiError.ts';
import type { PipelineSourceFile } from '../../../shared/pipelineRegistryTypes.ts';
import type { ControlPlanePersistence } from '../../types/pipelinePersistenceTypes.ts';

/** Reads a declared source file from the current persisted source snapshot. */
export async function getPipelineSourceFile(
    pipelineId: string,
    requestedSourceFile: string,
    persistence: ControlPlanePersistence,
): Promise<PipelineSourceFile> {
    const pipeline = await persistence.getPipelineSnapshot(pipelineId);
    if (pipeline == null) {
        throw new ControlPlaneApiError(404, `Unknown pipeline: ${pipelineId}`);
    }
    const requestedPath = normalizeSourcePath(requestedSourceFile);
    const declaredSourceFile = pipeline.sourceFiles.find((sourceFile) =>
        normalizeSourcePath(sourceFile) === requestedPath
    );
    if (declaredSourceFile == null) {
        throw new ControlPlaneApiError(404, `Unknown pipeline source file: ${requestedSourceFile}`);
    }

    const snapshotFile = pipeline.sourceContents?.find((source) =>
        normalizeSourcePath(source.sourceFile) === normalizeSourcePath(declaredSourceFile)
    );
    if (snapshotFile == null) {
        throw new ControlPlaneApiError(
            409,
            'This pipeline has no saved source snapshot. Refresh pipelines from source before viewing files.',
        );
    }

    return {
        content: snapshotFile.content,
        language: sourceLanguage(declaredSourceFile),
        path: normalizeSourcePath(declaredSourceFile),
    };
}

function normalizeSourcePath(sourceFile: string): string {
    return path.posix.normalize(sourceFile.replaceAll('\\', '/').trim()).replace(/^\.\//, '');
}

function sourceLanguage(sourceFile: string): PipelineSourceFile['language'] {
    const extension = path.extname(sourceFile).toLowerCase();
    if (extension === '.py') {
        return 'python';
    }
    if (extension === '.sql') {
        return 'sql';
    }
    return 'text';
}

