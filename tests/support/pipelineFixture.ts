/**
 * @fileoverview Temporary pipeline fixture creation for discovery and runtime tests.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/** A file written below a temporary pipeline root. */
export interface PipelineFixtureFile {
    content: string;
    relativePath: string;
}

/** Options controlling the generated pipeline directory and YAML content. */
export interface PipelineFixtureOptions {
    files?: PipelineFixtureFile[];
    libraryInclude?: string | null;
    name: string;
    pipelinePath?: string;
    prefix: string;
    root?: string;
    specExtras?: string[];
    specFilename: string;
    storage?: string;
}

/** Paths and cleanup behavior for a generated pipeline fixture. */
export interface PipelineFixture {
    cleanup: () => Promise<void>;
    pipelineRoot: string;
    resourcesRoot: string;
    root: string;
    specPath: string;
    writeFile: (relativePath: string, content: string) => Promise<string>;
}

/** Creates a temporary pipeline tree and returns its paths plus cleanup. */
export async function createPipelineFixture(
    options: PipelineFixtureOptions,
): Promise<PipelineFixture> {
    const root = options.root ?? await fs.mkdtemp(path.join(os.tmpdir(), options.prefix));
    const pipelineRoot = path.join(
        root,
        'pipelines',
        options.pipelinePath ?? 'fixture',
    );
    const resourcesRoot = path.join(pipelineRoot, 'resources');
    const specPath = path.join(resourcesRoot, options.specFilename);
    const writeFile = async (relativePath: string, content: string): Promise<string> => {
        const filePath = path.join(pipelineRoot, relativePath);
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        await fs.writeFile(filePath, content, 'utf8');
        return filePath;
    };
    const storage = options.storage ??
        path.join(root, 'checkpoints').replaceAll('\\', '/');

    const spec = [
        'name: ' + options.name,
        'storage: ' + storage,
        ...(options.libraryInclude === null ? [] : [
            'libraries:',
            '  - glob:',
            '      include: ' + (options.libraryInclude ?? '../sql/**'),
        ]),
        ...(options.specExtras ?? []),
        '',
    ];

    await fs.mkdir(resourcesRoot, { recursive: true });
    await writeFile(
        path.relative(pipelineRoot, specPath),
        spec.join('\n'),
    );
    for (const file of options.files ?? []) {
        await writeFile(file.relativePath, file.content);
    }

    return {
        cleanup: async () => options.root == null
            ? fs.rm(root, { force: true, maxRetries: 3, recursive: true, retryDelay: 100 })
            : Promise.resolve(),
        pipelineRoot,
        resourcesRoot,
        root,
        specPath,
        writeFile,
    };
}
