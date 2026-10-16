/**
 * @fileoverview Builds pipeline asset lineage from SQL and Python source metadata.
 */

import path from 'node:path';
import type {
    ExternalDatasetKind,
    NodeType,
    PipelineEdge,
    PipelineNode,
    PipelineSpec,
} from '../../../shared/pipelineRegistryTypes.ts';
import type { PythonPipelineManifest } from './pipelineDiscovery.ts';

interface SqlStatementParserState {
    buffer: string;
    line: number;
    quote: "'" | '"' | undefined;
    startLine: number;
}

interface PendingLineageInput {
    inputs: SqlInputReference[];
    outputNodeId: string;
}

interface SqlInputReference {
    externalKind: ExternalDatasetKind;
    name: string;
}

interface SqlToken {
    depth: number;
    end: number;
    kind: 'comma' | 'left-parenthesis' | 'right-parenthesis' | 'word';
    start: number;
    value: string;
}

interface SqlTokenization {
    matchingParentheses: Map<number, number>;
    tokens: SqlToken[];
}

interface LineageAccumulator {
    declaredNodes: Map<string, PipelineNode>;
    directEdges: PipelineEdge[];
    pendingInputs: PendingLineageInput[];
}

type SqlDatasetDefinition =
    | {
        flowName: string;
        nodeType: 'FLOW';
        outputName: string;
    }
    | {
        nodeType: Exclude<NodeType, 'FLOW'>;
        outputName: string;
    };

/**
 * Combines registered Python graph elements and their literal table reads with SQL lineage.
 */
export function parsePipelineLineage(
    root: string,
    spec: PipelineSpec,
    sourceContents: Array<{ content: string; sourceFile: string }>,
    pythonManifest?: PythonPipelineManifest,
): { edges: PipelineEdge[]; nodes: PipelineNode[] } {
    const state: LineageAccumulator = {
        declaredNodes: new Map(),
        directEdges: [],
        pendingInputs: [],
    };
    addPythonLineage(state, root, spec, pythonManifest);
    addSqlLineage(state, root, spec, sourceContents);
    return finalizeLineage(state);
}

function addPythonLineage(
    state: LineageAccumulator,
    root: string,
    spec: PipelineSpec,
    pythonManifest?: PythonPipelineManifest,
): void {
    for (const output of pythonManifest?.outputs ?? []) {
        const qualifiedName = qualifyName(output.name, spec);
        const node: PipelineNode = {
            id: nodeId(qualifiedName),
            name: tableName(qualifiedName),
            nodeType: output.type,
            qualifiedName,
            sourceFile: path.relative(root, output.sourceFile),
            sourceLine: output.sourceLine,
        };
        state.declaredNodes.set(node.id, node);
    }

    for (const flow of pythonManifest?.flows ?? []) {
        const qualifiedName = qualifyName(flow.name, spec);
        const targetName = qualifyName(flow.target, spec);
        const flowNodeId = `flow:${qualifiedName.toLowerCase()}`;
        const targetNodeId = nodeId(targetName);
        state.declaredNodes.set(flowNodeId, {
            id: flowNodeId,
            name: tableName(qualifiedName),
            nodeType: 'FLOW',
            qualifiedName,
            sourceFile: path.relative(root, flow.sourceFile),
            sourceLine: flow.sourceLine,
        });
        state.directEdges.push({
            confidence: 'UNKNOWN',
            evidence: 'SPARK_GRAPH_REGISTRATION',
            id: `${flowNodeId}->${targetNodeId}`,
            sourceExpression: targetName,
            sourceNodeId: flowNodeId,
            targetNodeId,
        });
        const inputEvidence = flow.inputEvidence ?? 'PYTHON_SOURCE_PATTERN';
        for (const input of flow.inputs) {
            const inputName = qualifyInputName(input, spec);
            const inputNodeId = nodeId(inputName);
            state.directEdges.push({
                confidence: inputEvidence === 'SPARK_GRAPH_REGISTRATION' ? 'UNKNOWN' : 'LOW',
                evidence: inputEvidence,
                id: `${inputNodeId}->${flowNodeId}`,
                sourceExpression: inputName,
                sourceNodeId: inputNodeId,
                targetNodeId: flowNodeId,
            });
        }
    }
}

function addSqlLineage(
    state: LineageAccumulator,
    root: string,
    spec: PipelineSpec,
    sourceContents: Array<{ content: string; sourceFile: string }>,
): void {
    for (const source of sourceContents) {
        if (path.extname(source.sourceFile).toLowerCase() === '.py') {
            continue;
        }
        for (const statement of splitSqlStatements(source.content)) {
            addSqlStatementLineage(state, root, spec, source.sourceFile, statement);
        }
    }
}

function addSqlStatementLineage(
    state: LineageAccumulator,
    root: string,
    spec: PipelineSpec,
    sourceFile: string,
    statement: { startLine: number; text: string },
): void {
    const definition = datasetDefinition(statement.text);
    if (definition == null) {
        return;
    }
    if (definition.nodeType === 'FLOW') {
        addSqlFlowLineage(state, root, spec, sourceFile, statement, definition);
        return;
    }
    const qualifiedName = qualifyName(definition.outputName, spec);
    const node = {
        id: nodeId(qualifiedName),
        name: tableName(qualifiedName),
        nodeType: definition.nodeType,
        qualifiedName,
        sourceFile: path.relative(root, sourceFile),
        sourceLine: statement.startLine,
        sqlText: statement.text.trim(),
    };
    state.declaredNodes.set(node.id, node);
    state.pendingInputs.push({
        inputs: inputTableNames(statement.text).map((input) => ({
            ...input,
            name: qualifyInputName(input.name, spec),
        })),
        outputNodeId: node.id,
    });
}

function addSqlFlowLineage(
    state: LineageAccumulator,
    root: string,
    spec: PipelineSpec,
    sourceFile: string,
    statement: { startLine: number; text: string },
    definition: Extract<SqlDatasetDefinition, { nodeType: 'FLOW' }>,
): void {
    // A flow is an operation targeting a dataset, so it needs its own identity
    // rather than replacing the target dataset node.
    const qualifiedFlowName = qualifyName(definition.flowName, spec);
    const qualifiedTargetName = qualifyName(definition.outputName, spec);
    const flowNodeId = `flow:${qualifiedFlowName.toLowerCase()}`;
    const targetNodeId = nodeId(qualifiedTargetName);
    state.declaredNodes.set(flowNodeId, {
        id: flowNodeId,
        name: tableName(qualifiedFlowName),
        nodeType: 'FLOW',
        qualifiedName: qualifiedFlowName,
        sourceFile: path.relative(root, sourceFile),
        sourceLine: statement.startLine,
        sqlText: statement.text.trim(),
    });
    state.directEdges.push({
        confidence: 'LOW',
        evidence: 'SQL_TEXT_PATTERN',
        id: `${flowNodeId}->${targetNodeId}`,
        sourceExpression: qualifiedTargetName,
        sourceNodeId: flowNodeId,
        targetNodeId,
    });
    state.pendingInputs.push({
        inputs: inputTableNames(statement.text).map((input) => ({
            ...input,
            name: qualifyInputName(input.name, spec),
        })),
        outputNodeId: flowNodeId,
    });
}

function finalizeLineage(
    state: LineageAccumulator,
): { edges: PipelineEdge[]; nodes: PipelineNode[] } {
    const nodes = new Map(state.declaredNodes);
    const edges: PipelineEdge[] = [];
    const seenEdges = new Set<string>();
    addDirectLineageEdges(state.directEdges, nodes, edges, seenEdges);
    addPendingLineageEdges(state.pendingInputs, nodes, edges, seenEdges);
    return { edges, nodes: Array.from(nodes.values()) };
}

function addDirectLineageEdges(
    directEdges: PipelineEdge[],
    nodes: Map<string, PipelineNode>,
    edges: PipelineEdge[],
    seenEdges: Set<string>,
): void {
    for (const edge of directEdges) {
        if (seenEdges.has(edge.id)) {
            continue;
        }
        if (!nodes.has(edge.sourceNodeId)) {
            const externalKind = externalDatasetKindForName(edge.sourceExpression);
            nodes.set(edge.sourceNodeId, {
                id: edge.sourceNodeId,
                name: externalDatasetLabel(edge.sourceExpression, externalKind),
                externalKind,
                nodeType: 'EXTERNAL_DATASET',
                qualifiedName: edge.sourceExpression,
            });
        }
        if (!nodes.has(edge.targetNodeId)) {
            const targetName = edge.sourceExpression;
            const externalKind = externalDatasetKindForName(targetName);
            nodes.set(edge.targetNodeId, {
                id: edge.targetNodeId,
                name: externalDatasetLabel(targetName, externalKind),
                externalKind,
                nodeType: 'EXTERNAL_DATASET',
                qualifiedName: targetName,
            });
        }
        seenEdges.add(edge.id);
        edges.push(edge);
    }
}

function addPendingLineageEdges(
    pendingInputs: PendingLineageInput[],
    nodes: Map<string, PipelineNode>,
    edges: PipelineEdge[],
    seenEdges: Set<string>,
): void {
    for (const pending of pendingInputs) {
        for (const input of pending.inputs) {
            const sourceNodeId = nodeId(input.name);
            if (!nodes.has(sourceNodeId)) {
                nodes.set(sourceNodeId, {
                    id: sourceNodeId,
                    name: externalDatasetLabel(input.name, input.externalKind),
                    externalKind: input.externalKind,
                    nodeType: 'EXTERNAL_DATASET',
                    qualifiedName: input.name,
                });
            }
            const edgeId = `${sourceNodeId}->${pending.outputNodeId}`;
            if (seenEdges.has(edgeId)) {
                continue;
            }
            seenEdges.add(edgeId);
            edges.push({
                confidence: 'LOW',
                evidence: 'SQL_TEXT_PATTERN',
                id: edgeId,
                sourceExpression: input.name,
                sourceNodeId,
                targetNodeId: pending.outputNodeId,
            });
        }
    }
}

function splitSqlStatements(sql: string): Array<{ startLine: number; text: string }> {
    const statements: Array<{ startLine: number; text: string }> = [];
    const state: SqlStatementParserState = {
        buffer: '',
        line: 1,
        quote: undefined,
        startLine: 1,
    };

    let index = 0;
    while (index < sql.length) {
        const commentEnd = skipSqlComment(sql, index, state.line, state.quote);
        if (commentEnd != null) {
            index = commentEnd.index + 1;
            state.line = commentEnd.line;
            continue;
        }

        consumeSqlCharacter(state, statements, sql[index], sql[index - 1]);
        index += 1;
    }

    appendSqlStatement(statements, state);
    return statements;
}

function consumeSqlCharacter(
    state: SqlStatementParserState,
    statements: Array<{ startLine: number; text: string }>,
    char: string | undefined,
    previousChar: string | undefined,
): void {
    if (char === '\n') {
        state.line += 1;
    }
    if (isSqlQuote(char) && previousChar !== '\\') {
        state.quote = state.quote === char ? undefined : state.quote ?? char;
    }
    if (char !== ';' || state.quote != null) {
        state.buffer += char ?? '';
        return;
    }

    appendSqlStatement(statements, state);
    state.buffer = '';
    state.startLine = state.line;
}

function appendSqlStatement(
    statements: Array<{ startLine: number; text: string }>,
    state: SqlStatementParserState,
): void {
    if (state.buffer.trim() !== '') {
        statements.push({ startLine: state.startLine, text: state.buffer });
    }
}

function skipSqlComment(
    sql: string,
    start: number,
    line: number,
    quote: string | undefined,
): { index: number; line: number } | undefined {
    if (quote != null) {
        return undefined;
    }
    if (sql[start] === '-' && sql[start + 1] === '-') {
        let index = start;
        while (index < sql.length && sql[index] !== '\n') {
            index += 1;
        }
        return { index, line: line + 1 };
    }
    if (sql[start] !== '/' || sql[start + 1] !== '*') {
        return undefined;
    }
    let index = start + 2;
    let nextLine = line;
    while (index < sql.length && !(sql[index] === '*' && sql[index + 1] === '/')) {
        if (sql[index] === '\n') {
            nextLine += 1;
        }
        index += 1;
    }
    return { index: index + 1, line: nextLine };
}

function isSqlQuote(value: string | undefined): value is "'" | '"' {
    return value === "'" || value === '"';
}

function datasetDefinition(statement: string): SqlDatasetDefinition | undefined {
    const flowMatch = statement.match(
        /\bCREATE\s+FLOW\s+([`"\w.-]+)\s+AS\s+INSERT\s+INTO\s+([`"\w.-]+)/i,
    );
    if (flowMatch?.[1] && flowMatch[2]) {
        return {
            flowName: cleanIdentifier(flowMatch[1]),
            nodeType: 'FLOW',
            outputName: cleanIdentifier(flowMatch[2]),
        };
    }

    const patterns: Array<[RegExp, Exclude<NodeType, 'FLOW'>]> = [
        [/\bCREATE\s+(?:OR\s+REFRESH\s+)?MATERIALIZED\s+VIEW\s+([`"\w.-]+)/i, 'MATERIALIZED_VIEW'],
        [/\bCREATE\s+(?:OR\s+REFRESH\s+)?STREAMING\s+TABLE\s+([`"\w.-]+)/i, 'STREAMING_TABLE'],
        [/\bCREATE\s+(?:OR\s+REPLACE\s+)?TEMP(?:ORARY)?\s+VIEW\s+([`"\w.-]+)/i, 'TEMPORARY_VIEW'],
    ];

    for (const [pattern, nodeType] of patterns) {
        const match = statement.match(pattern);
        if (match?.[1]) {
            return {
                nodeType,
                outputName: cleanIdentifier(match[1]),
            };
        }
    }

    return undefined;
}

function inputTableNames(statement: string): SqlInputReference[] {
    const ctes = cteNames(statement);
    const matches = statement.matchAll(/\b(?:FROM|JOIN)\s+/gi);
    const seen = new Set<string>();
    const inputs: SqlInputReference[] = [];

    for (const match of matches) {
        const matchIndex = match.index ?? 0;
        const inputStart = skipStreamKeyword(statement, matchIndex + match[0].length);
        const inputToken = readSqlInputToken(statement, inputStart);
        const sourceUri = sourceUriFromInputToken(inputToken);
        const externalKind = sourceUri == null ? 'TABLE' : 'SOURCE';
        const inputName = sourceUri ?? cleanIdentifier(inputToken);
        if (inputName === '' ||
            (externalKind === 'TABLE' && ctes.has(inputName.toLowerCase())) ||
            seen.has(inputName.toLowerCase())) {
            continue;
        }

        seen.add(inputName.toLowerCase());
        inputs.push({ externalKind, name: inputName });
    }

    return inputs;
}

function skipStreamKeyword(statement: string, startIndex: number): number {
    let index = startIndex;
    if (statement.slice(index, index + 6).toUpperCase() !== 'STREAM') {
        return index;
    }

    const afterKeyword = statement[index + 6];
    if (afterKeyword !== '(' && (afterKeyword != null && !/\s/.test(afterKeyword))) {
        return index;
    }

    index += 6;
    while (index < statement.length && /\s/.test(statement[index])) {
        index += 1;
    }
    if (statement[index] === '(') {
        index += 1;
        while (index < statement.length && /\s/.test(statement[index])) {
            index += 1;
        }
    }
    return index;
}

function readSqlInputToken(statement: string, startIndex: number): string {
    let index = startIndex;
    let quote: '`' | '"' | undefined;

    while (index < statement.length) {
        const character = statement[index];
        if (quote != null) {
            index += 1;
            if (character === quote) {
                if (statement[index] === quote) {
                    index += 1;
                } else {
                    quote = undefined;
                }
            }
            continue;
        }

        if (character === '`' || character === '"') {
            quote = character;
            index += 1;
            continue;
        }
        if (/\s/.test(character) || character === ',' || character === ';' || character === '(' || character === ')') {
            break;
        }
        index += 1;
    }

    return statement.slice(startIndex, index);
}

function sourceUriFromInputToken(inputToken: string): string | undefined {
    const delimiterIndex = inputToken.indexOf('://');
    if (delimiterIndex < 1) {
        return undefined;
    }

    let schemeStart = delimiterIndex - 1;
    while (schemeStart >= 0 && isUriSchemeCharacter(inputToken[schemeStart])) {
        schemeStart -= 1;
    }
    schemeStart += 1;
    if (schemeStart === delimiterIndex || !isUriSchemeLetter(inputToken[schemeStart])) {
        return undefined;
    }

    return cleanIdentifier(inputToken.slice(schemeStart));
}

function isUriSchemeLetter(character: string | undefined): boolean {
    return character != null &&
        ((character >= 'A' && character <= 'Z') || (character >= 'a' && character <= 'z'));
}

function isUriSchemeCharacter(character: string | undefined): boolean {
    return isUriSchemeLetter(character) ||
        (character != null && character >= '0' && character <= '9') ||
        character === '_' || character === '+' || character === '.' || character === '-';
}

function cteNames(statement: string): Set<string> {
    const { matchingParentheses, tokens } = tokenizeSql(statement);
    const names = new Set<string>();

    for (let index = 0; index < tokens.length; index += 1) {
        if (!isSqlWord(tokens[index], 'WITH')) {
            continue;
        }

        const baseDepth = tokens[index].depth;
        let candidateIndex = firstCteIndex(statement, tokens, index);
        while (candidateIndex != null) {
            const declaration = parseCteDeclaration(
                statement,
                tokens,
                matchingParentheses,
                candidateIndex,
                baseDepth,
            );
            if (declaration == null) {
                break;
            }
            names.add(declaration.name);
            candidateIndex = nextCteIndex(statement, tokens, declaration.bodyCloseIndex, baseDepth);
        }
    }

    return names;
}

function firstCteIndex(
    statement: string,
    tokens: SqlToken[],
    withIndex: number,
): number | undefined {
    let index = withIndex + 1;
    let previousEnd = tokens[withIndex].end;
    if (!isSqlWhitespaceOnly(statement, previousEnd, tokens[index]?.start ?? statement.length)) {
        return undefined;
    }

    if (isSqlWord(tokens[index], 'RECURSIVE')) {
        previousEnd = tokens[index].end;
        index += 1;
        if (!isSqlWhitespaceOnly(statement, previousEnd, tokens[index]?.start ?? statement.length)) {
            return undefined;
        }
    }

    return index;
}

function parseCteDeclaration(
    statement: string,
    tokens: SqlToken[],
    matchingParentheses: Map<number, number>,
    nameIndex: number,
    baseDepth: number,
): { bodyCloseIndex: number; name: string } | undefined {
    const nameToken = tokens[nameIndex];
    if (nameToken?.kind !== 'word' || nameToken.depth !== baseDepth) {
        return undefined;
    }

    let declarationEnd = nameToken.end;
    let asIndex = nameIndex + 1;
    const columnsOpen = tokens[asIndex];
    if (columnsOpen?.kind === 'left-parenthesis' &&
        columnsOpen.depth === baseDepth &&
        isSqlWhitespaceOnly(statement, nameToken.end, columnsOpen.start)) {
        const columnsCloseIndex = matchingParentheses.get(asIndex);
        if (columnsCloseIndex == null || tokens[columnsCloseIndex].depth !== baseDepth) {
            return undefined;
        }
        declarationEnd = tokens[columnsCloseIndex].end;
        asIndex = columnsCloseIndex + 1;
    }

    const asToken = tokens[asIndex];
    const bodyOpen = tokens[asIndex + 1];
    if (!isSqlWord(asToken, 'AS') ||
        asToken.depth !== baseDepth ||
        !isSqlWhitespaceOnly(statement, declarationEnd, asToken.start) ||
        bodyOpen?.kind !== 'left-parenthesis' ||
        bodyOpen.depth !== baseDepth ||
        !isSqlWhitespaceOnly(statement, asToken.end, bodyOpen.start)) {
        return undefined;
    }

    const bodyCloseIndex = matchingParentheses.get(asIndex + 1);
    return bodyCloseIndex == null
        ? undefined
        : { bodyCloseIndex, name: nameToken.value.toLowerCase() };
}

function nextCteIndex(
    statement: string,
    tokens: SqlToken[],
    bodyCloseIndex: number,
    baseDepth: number,
): number | undefined {
    const commaIndex = bodyCloseIndex + 1;
    const commaToken = tokens[commaIndex];
    if (commaToken?.kind !== 'comma' ||
        commaToken.depth !== baseDepth ||
        !isSqlWhitespaceOnly(statement, tokens[bodyCloseIndex].end, commaToken.start)) {
        return undefined;
    }

    const nextIndex = commaIndex + 1;
    return isSqlWhitespaceOnly(statement, commaToken.end, tokens[nextIndex]?.start ?? statement.length)
        ? nextIndex
        : undefined;
}

function tokenizeSql(statement: string): SqlTokenization {
    const matchingParentheses = new Map<number, number>();
    const openParentheses: number[] = [];
    const tokens: SqlToken[] = [];
    let depth = 0;

    let index = 0;
    while (index < statement.length) {
        const character = statement[index];
        if (/\s/.test(character)) {
            index += 1;
            continue;
        }

        if (character === "'" || character === '"' || character === '`') {
            index = skipSqlQuotedValue(statement, index, character);
            continue;
        }

        if (isSqlIdentifierStart(character)) {
            const start = index;
            index += 1;
            while (isSqlIdentifierPart(statement[index])) {
                index += 1;
            }
            tokens.push({
                depth,
                end: index,
                kind: 'word',
                start,
                value: statement.slice(start, index),
            });
            continue;
        }

        if (character === '(') {
            const openIndex = tokens.length;
            tokens.push({ depth, end: index + 1, kind: 'left-parenthesis', start: index, value: character });
            openParentheses.push(openIndex);
            depth += 1;
            index += 1;
            continue;
        }

        if (character === ')') {
            depth = Math.max(0, depth - 1);
            const closeIndex = tokens.length;
            tokens.push({ depth, end: index + 1, kind: 'right-parenthesis', start: index, value: character });
            const openIndex = openParentheses.pop();
            if (openIndex != null && tokens[openIndex].depth === depth) {
                matchingParentheses.set(openIndex, closeIndex);
            }
            index += 1;
            continue;
        }

        if (character === ',') {
            tokens.push({ depth, end: index + 1, kind: 'comma', start: index, value: character });
        }
        index += 1;
    }

    return { matchingParentheses, tokens };
}

function skipSqlQuotedValue(
    statement: string,
    start: number,
    quote: "'" | '"' | '`',
): number {
    let index = start + 1;
    while (index < statement.length) {
        if (statement[index] === '\\' && quote !== '`') {
            index += 2;
            continue;
        }
        if (statement[index] !== quote) {
            index += 1;
            continue;
        }
        if (statement[index + 1] === quote) {
            index += 2;
            continue;
        }
        return index + 1;
    }
    return index;
}

function isSqlWhitespaceOnly(statement: string, start: number, end: number): boolean {
    if (end < start) {
        return false;
    }
    for (let index = start; index < end; index += 1) {
        if (!/\s/.test(statement[index])) {
            return false;
        }
    }
    return true;
}

function isSqlWord(token: SqlToken | undefined, value: string): token is SqlToken {
    return token?.kind === 'word' && token.value.toUpperCase() === value;
}

function isSqlIdentifierStart(character: string | undefined): boolean {
    if (character == null) {
        return false;
    }
    const codePoint = character.codePointAt(0);
    return codePoint != null &&
        ((codePoint >= 65 && codePoint <= 90) ||
            (codePoint >= 97 && codePoint <= 122) ||
            codePoint === 95);
}

function isSqlIdentifierPart(character: string | undefined): boolean {
    return isSqlIdentifierStart(character) ||
        (character != null && character >= '0' && character <= '9');
}

function cleanIdentifier(identifier: string): string {
    return identifier.replace(/[`"]/g, '').trim();
}

function qualifyName(rawName: string, spec: PipelineSpec): string {
    const parts = rawName.split('.').filter(Boolean);
    if (parts.length >= 3) {
        return parts.join('.');
    }

    const database = spec.database ?? spec.schema;
    if (parts.length === 2 && spec.catalog != null) {
        return [spec.catalog, ...parts].join('.');
    }

    if (parts.length === 1) {
        return [spec.catalog, database, parts[0]].filter(Boolean).join('.');
    }

    return rawName;
}

function tableName(qualifiedName: string): string {
    const parts = qualifiedName.split('.');
    return parts.at(-1) ?? qualifiedName;
}

function qualifyInputName(inputName: string, spec: PipelineSpec): string {
    return externalDatasetKindForName(inputName) === 'SOURCE'
        ? inputName
        : qualifyName(inputName, spec);
}

function externalDatasetKindForName(name: string): ExternalDatasetKind {
    return /^[A-Za-z][\w+.-]*:\/\//.test(name) ? 'SOURCE' : 'TABLE';
}

function externalDatasetLabel(
    name: string,
    externalKind: ExternalDatasetKind,
): string {
    const sourceScheme = name.match(/^([A-Za-z][\w+.-]*):\/\//)?.[1];
    return externalKind === 'SOURCE' && sourceScheme != null
        ? sourceScheme
        : tableName(name);
}

function nodeId(qualifiedName: string): string {
    return `dataset:${qualifiedName.toLowerCase()}`;
}

