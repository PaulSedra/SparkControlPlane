/**
 * @fileoverview Converts pipeline YAML into the normalized PipelineSpec contract.
 *
 * Pipeline trigger parsing and binding remain in yamlTriggerConfiguration.ts.
 */
import type { PipelineSpec } from '../../../shared/pipelineRegistryTypes.ts';
import { parsePipelineYamlDocument } from './yamlParser.ts';

/** Converts pipeline YAML into its normalized domain representation. */
export function parsePipelineSpec(specPath: string, yamlContent: string): PipelineSpec {
    const document = parsePipelineYamlDocument(yamlContent, specPath);
    const name = pipelineStringValue(document.name, 'name', specPath);
    const storage = pipelineStringValue(document.storage, 'storage', specPath);
    const catalog = pipelineStringValue(document.catalog, 'catalog', specPath);
    const database = pipelineStringValue(document.database, 'database', specPath) ??
        pipelineStringValue(document.schema, 'schema', specPath);
    const schema = pipelineStringValue(document.schema, 'schema', specPath) ??
        pipelineStringValue(document.database, 'database', specPath);
    const libraries = pipelineLibraryIncludes(document.libraries, specPath);
    const onSuccess = pipelineSuccessDependency(document.on_success, specPath);
    const timeoutSeconds = pipelineTimeoutSeconds(document.timeout_seconds, specPath);

    if (name == null || storage == null) {
        throw new Error(`${specPath} must declare name and storage.`);
    }

    return {
        catalog,
        database,
        libraries,
        name,
        onSuccess,
        schema,
        specPath,
        storage,
        timeoutSeconds,
    };
}

function pipelineTimeoutSeconds(value: unknown, specPath: string): number | undefined {
    if (value == null) {
        return undefined;
    }
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 604_800) {
        throw new Error(`${specPath} field timeout_seconds must be an integer from 1 to 604800.`);
    }
    return value;
}

function pipelineSuccessDependency(
    value: unknown,
    specPath: string,
): { pipeline: string } | undefined {
    if (value == null) {
        return undefined;
    }
    if (typeof value !== 'object' || Array.isArray(value)) {
        throw new TypeError(`${specPath} field on_success must be a YAML mapping.`);
    }

    const configuration = value as Record<string, unknown>;
    const unknownKeys = Object.keys(configuration).filter((key) => key !== 'pipeline');
    if (unknownKeys.length > 0) {
        throw new Error(`${specPath} field on_success has unsupported key "${unknownKeys[0]}".`);
    }
    const pipeline = pipelineStringValue(configuration.pipeline, 'on_success.pipeline', specPath);
    if (pipeline == null) {
        throw new Error(`${specPath} field on_success.pipeline is required.`);
    }
    return { pipeline };
}

function pipelineStringValue(
    value: unknown,
    key: string,
    specPath: string,
): string | undefined {
    if (value == null) {
        return undefined;
    }
    if (typeof value !== 'string' || value.trim() === '') {
        throw new Error(`${specPath} field ${key} must be a non-empty string.`);
    }
    return value.trim();
}

function pipelineLibraryIncludes(value: unknown, specPath: string): string[] {
    if (value == null) {
        return [];
    }
    if (!Array.isArray(value)) {
        throw new TypeError(`${specPath} field libraries must be a YAML sequence.`);
    }
    return value.map((entry, index) => {
        if (entry == null || typeof entry !== 'object' || Array.isArray(entry)) {
            throw new Error(`${specPath} libraries[${index}] must be a YAML mapping.`);
        }
        const glob = (entry as Record<string, unknown>).glob;
        if (glob == null || typeof glob !== 'object' || Array.isArray(glob)) {
            throw new Error(`${specPath} libraries[${index}].glob must be a YAML mapping.`);
        }
        const include = pipelineStringValue(
            (glob as Record<string, unknown>).include,
            `libraries[${index}].glob.include`,
            specPath,
        );
        if (include == null) {
            throw new Error(`${specPath} libraries[${index}].glob.include is required.`);
        }
        return include;
    });
}
