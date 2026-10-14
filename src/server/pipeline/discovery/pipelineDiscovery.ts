/**
 * @fileoverview Orchestrates cached discovery of source-backed pipeline details.
 *
 * It coordinates spec lookup, YAML parsing, source loading, optional Python
 * manifest discovery, validation, and SQL/Python lineage. The resulting models
 * have no persisted registry identity; pipelineRegistryDiscovery.ts adds
 * identity and reconciles YAML-owned triggers.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { ControlPlaneApiError } from '../../errors/controlPlaneApiError.ts';
import type {
    PipelineDetail,
    PipelineSpec,
} from '../../../shared/pipelineRegistryTypes.ts';
import {
    DeploymentStatus,
} from '../../../shared/status/deployment.ts';
import {
    parsePipelineYamlTriggers,
    type YamlTriggerDefinition,
} from './yamlTriggerConfiguration.ts';
import { pipelineProjectRoot } from '../execution/pipelineRuntime.ts';
import { hashPipelineSource } from './pipelineVersion.ts';
import { parsePipelineLineage } from './pipelineLineageParser.ts';
import { discoverPythonPipelineManifest } from '../spark/pipelineManifestProcess.ts';
import {
    evictRemovedPipelines,
    getCachedPipeline,
    type PipelineParseCache as PipelineParseCacheEntries,
} from './pipelineParseCache.ts';
import {
    discoverPipelineSpecPaths,
    resolvePipelineSources,
} from './pipelineSourceResolver.ts';
import { parsePipelineSpec } from './pipelineSpecParser.ts';
import { mapWithConcurrency } from '../mapWithConcurrency.ts';

const DEFAULT_DISCOVERY_CONCURRENCY = 4;
const MAX_DISCOVERY_CONCURRENCY = 8;

/** Parsed graph, stable source hash, and YAML-owned trigger definitions. */
export interface ParsedPipeline {
    detail: PipelineDetail;
    sourceContents: Array<{ content: string; sourceFile: string }>;
    sourceHash: string;
    specContent?: string;
    yamlTriggerDefinitions: YamlTriggerDefinition[];
}

/** Pipeline metadata emitted by the PySpark graph registration helper. */
export interface PythonPipelineManifest {
    flows: Array<{
        inputEvidence?: 'PYTHON_SOURCE_PATTERN' | 'SPARK_GRAPH_REGISTRATION';
        inputs: string[];
        name: string;
        sourceFile: string;
        sourceLine: number;
        target: string;
    }>;
    outputs: Array<{
        name: string;
        sourceFile: string;
        sourceLine: number;
        type: 'MATERIALIZED_VIEW' | 'STREAMING_TABLE' | 'TEMPORARY_VIEW' | 'SINK';
    }>;
}

/** Per-spec cache shared by discovery and registry lookups. */
export type PipelineParseCache = PipelineParseCacheEntries<ParsedPipeline>;

interface LoadedPipelineSource {
    root: string;
    spec: PipelineSpec;
    sourceContents: Array<{ content: string; sourceFile: string }>;
    sourceFiles: string[];
    yamlContent: string;
    yamlTriggerDefinitions: YamlTriggerDefinition[];
}

interface OptionalPythonManifest {
    error?: string;
    manifest?: PythonPipelineManifest;
}

/** Discovers and parses every current spec, removes stale cache entries, and rejects duplicate names. */
export async function discoverAllPipelines(
    pipelineParseCache: PipelineParseCache,
): Promise<ParsedPipeline[]> {
    const concurrency = configuredDiscoveryConcurrency();
    const specPaths = await discoverPipelineSpecPaths(concurrency);
    evictRemovedPipelines(pipelineParseCache, specPaths);
    const pipelines = await mapWithConcurrency(specPaths, concurrency, (specPath) =>
        getCachedPipeline(specPath, pipelineParseCache, concurrency, parsePipelineSpecPath));
    const names = new Map<string, string>();
    for (const pipeline of pipelines) {
        const normalizedName = normalizePipelineName(pipeline.detail.name);
        const existingPath = names.get(normalizedName);
        if (existingPath != null) {
            throw new ControlPlaneApiError(
                409,
                `Duplicate pipeline name "${pipeline.detail.name}" in ${existingPath} and ${pipeline.detail.specPath}.`,
            );
        }
        names.set(normalizedName, pipeline.detail.specPath);
    }
    return pipelines;
}

/** Parses a known spec path through the shared source-signature cache. */
export async function discoverPipelineAtPath(
    specPath: string,
    pipelineParseCache: PipelineParseCache,
): Promise<ParsedPipeline> {
    return getCachedPipeline(
        specPath,
        pipelineParseCache,
        configuredDiscoveryConcurrency(),
        parsePipelineSpecPath,
    );
}

async function parsePipelineSpecPath(specPath: string): Promise<ParsedPipeline> {
    const source = await loadPipelineSource(specPath);
    const pythonManifest = await discoverOptionalPythonManifest(source);
    const validationMessages = validatePipelineSource(source, pythonManifest.error);
    const graph = parsePipelineLineage(
        source.root,
        source.spec,
        source.sourceContents,
        pythonManifest.manifest,
    );
    return buildParsedPipeline(source, graph, validationMessages);
}

async function loadPipelineSource(specPath: string): Promise<LoadedPipelineSource> {
    const root = pipelineProjectRoot(specPath);
    const yamlContent = await fs.readFile(specPath, 'utf8');
    const spec = parsePipelineSpec(specPath, yamlContent);
    const yamlTriggerDefinitions = parsePipelineYamlTriggers(yamlContent, specPath);
    const concurrency = configuredDiscoveryConcurrency();
    const sourceFiles = await resolvePipelineSources(root, spec, concurrency);
    const sourceContents = await mapWithConcurrency(
        sourceFiles,
        concurrency,
        async (sourceFile) => ({
            content: await fs.readFile(sourceFile, 'utf8'),
            sourceFile,
        }),
    );
    return {
        root,
        spec,
        sourceContents,
        sourceFiles,
        yamlContent,
        yamlTriggerDefinitions,
    };
}

async function discoverOptionalPythonManifest(
    source: LoadedPipelineSource,
): Promise<OptionalPythonManifest> {
    const hasPythonSources = source.sourceFiles.some((sourceFile) =>
        path.extname(sourceFile).toLowerCase() === '.py');
    if (!hasPythonSources) {
        return {};
    }

    try {
        return { manifest: await discoverPythonPipelineManifest(source.spec.specPath) };
    } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) };
    }
}

function validatePipelineSource(
    source: LoadedPipelineSource,
    pythonManifestError: string | undefined,
): string[] {
    const validationMessages = validateSpec(source.spec, source.sourceFiles);
    if (pythonManifestError != null) {
        validationMessages.push(`Python graph discovery failed: ${pythonManifestError}`);
    }
    return validationMessages;
}

function buildParsedPipeline(
    source: LoadedPipelineSource,
    graph: ReturnType<typeof parsePipelineLineage>,
    validationMessages: string[],
): ParsedPipeline {
    const sourceHash = hashPipelineSource(source.root, source.yamlContent, source.sourceContents);
    const detail: PipelineDetail = {
        currentVersionId: undefined,
        edges: graph.edges,
        id: '',
        lastRun: undefined,
        name: source.spec.name,
        nodeCount: graph.nodes.filter((node) => node.nodeType !== 'EXTERNAL_DATASET').length,
        nodes: graph.nodes,
        recentRuns: [],
        runs: [],
        sourceFiles: source.sourceFiles.map((sourceFile) => path.relative(source.root, sourceFile)),
        sourceHash,
        spec: source.spec,
        specPath: source.spec.specPath,
        status: DeploymentStatus.DRAFT,
        updatedAt: undefined,
        validationMessages,
    };

    return {
        detail,
        sourceContents: source.sourceContents.map(({ content, sourceFile }) => ({
            content,
            sourceFile: path.relative(source.root, sourceFile).replaceAll('\\', '/'),
        })),
        sourceHash,
        specContent: source.yamlContent,
        yamlTriggerDefinitions: source.yamlTriggerDefinitions,
    };
}

function validateSpec(spec: PipelineSpec, sourceFiles: string[]): string[] {
    const messages: string[] = [];
    if (spec.libraries.length === 0) {
        messages.push('No library includes were declared.');
    }

    if (sourceFiles.length === 0) {
        messages.push('No supported SQL or Python files matched the declared libraries.');
    }

    return messages;
}

function configuredDiscoveryConcurrency(): number {
    const configured = Number(process.env.PIPELINE_DISCOVERY_CONCURRENCY?.trim() ?? '');
    return Number.isSafeInteger(configured) && configured > 0
        ? Math.min(MAX_DISCOVERY_CONCURRENCY, configured)
        : DEFAULT_DISCOVERY_CONCURRENCY;
}

function normalizePipelineName(name: string): string {
    return name.trim().toLowerCase();
}
