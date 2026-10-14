/**
 * @fileoverview Computes source identity and its stable display version label.
 */

import crypto from 'node:crypto';
import path from 'node:path';

/** Hashes executable spec text and normalized project source files. */
export function hashPipelineSource(
    root: string,
    yamlContent: string,
    sourceContents: Array<{ content: string; sourceFile: string }>,
): string {
    return hashPipelineSourceSnapshot(yamlContent, sourceContents.map((source) => ({
        content: source.content,
        sourceFile: path.relative(root, source.sourceFile).replaceAll('\\', '/'),
    })));
}

/** Hashes a persisted snapshot whose source file names are project-relative paths. */
export function hashPipelineSourceSnapshot(
    yamlContent: string,
    sourceContents: Array<{ content: string; sourceFile: string }>,
): string {
    const hash = crypto.createHash('sha256');
    hash.update(stripTopLevelYamlFields(yamlContent, [
        'on_success',
        'timeout_seconds',
        'triggers',
    ]));
    const normalizedSources = sourceContents.map((source) => ({
        ...source,
        relativePath: path.posix.normalize(source.sourceFile.replaceAll('\\', '/')),
    })).sort((left, right) => left.relativePath.localeCompare(right.relativePath));
    for (const source of normalizedSources) {
        hash.update(source.relativePath);
        hash.update(source.content);
    }

    return hash.digest('hex');
}

/** Derives the stable display version label from a source content hash. */
export function versionId(sourceHash: string): string {
    return `v-${sourceHash.slice(0, 12)}`;
}

function stripTopLevelYamlFields(yamlContent: string, fieldNames: readonly string[]): string {
    return fieldNames.reduce(
        (content, fieldName) => stripTopLevelYamlField(content, fieldName),
        yamlContent,
    );
}

function stripTopLevelYamlField(content: string, fieldName: string): string {
    const lineSeparator = content.includes('\r\n') ? '\r\n' : '\n';
    const lines = content.split(/\r?\n/);
    const start = findTopLevelYamlField(lines, fieldName);
    if (start < 0) {
        return content;
    }

    const fieldValue = lines[start].trim().slice(fieldName.length).trimStart().slice(1).trim();
    const end = fieldValue !== '' && !fieldValue.startsWith('#')
        ? start + 1
        : findYamlFieldBlockEnd(lines, start);
    const stripped = [...lines.slice(0, start), ...lines.slice(end)].join(lineSeparator);
    return start > 0 && content.endsWith(lineSeparator) && !stripped.endsWith(lineSeparator)
        ? `${stripped}${lineSeparator}`
        : stripped;
}

function findTopLevelYamlField(lines: string[], fieldName: string): number {
    const fieldPattern = new RegExp(`^${fieldName}\\s*:`);
    return lines.findIndex((line) =>
        isSignificantYamlLine(line) && yamlIndentation(line) === 0 &&
        fieldPattern.test(line.trim()));
}

function findYamlFieldBlockEnd(lines: string[], start: number): number {
    let end = start + 1;
    while (end < lines.length) {
        const line = lines[end];
        if (isSignificantYamlLine(line) && yamlIndentation(line) === 0) {
            break;
        }
        end += 1;
    }
    return end;
}

function isSignificantYamlLine(line: string): boolean {
    const trimmed = line.trim();
    return trimmed !== '' && !trimmed.startsWith('#');
}

function yamlIndentation(line: string): number {
    return line.length - line.trimStart().length;
}
