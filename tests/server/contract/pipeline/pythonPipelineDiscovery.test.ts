/**
 * @fileoverview Contract coverage for Python pipeline discovery and registration.
 */

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { createInMemoryPersistence } from '../../../support/inMemoryPersistence.ts';
import { createPipelineFixture } from '../../../support/pipelineFixture.ts';
import { captureEnvironment } from '../../../support/testEnvironment.ts';
import { createPipelineRegistryService } from '../../../../src/server/pipeline/pipelineRegistryService.ts';

const repositoryRoot = path.resolve(import.meta.dirname, '../../../..');
const pythonExecutable = process.platform === 'win32'
    ? path.join(repositoryRoot, '.venv', 'Scripts', 'python.exe')
    : path.join(repositoryRoot, '.venv', 'bin', 'python');
const pythonSourcePath = path.join('src', 'python_pipeline.py');

test('discovers Python outputs, flows, and literal and helper read lineage alongside SQL', {
    skip: !existsSync(pythonExecutable),
}, async () => {
    const originalCwd = process.cwd();
    const restore = captureEnvironment('PIPELINES_DIR', 'PYTHON_EXECUTABLE', 'PYTHONPATH');
    const fixture = await createPipelineFixture({
        files: [
            { content: 'TABLE_NAME = "python_events"\n', relativePath: 'src/python_names.py' },
            {
                content: [
                    'from pyspark import pipelines as dp',
                    'from pipelines.example.events.src import python_names',
                    '',
                    'BRONZE_TABLE = "sample_catalog.bronze.source_events"',
                    'DIMENSION_TABLE = "sample_catalog.silver.dimensions"',
                    'LONG_SQL_STRING = (',
                    '    "SELECT * FROM STREAM(sample_catalog.bronze.long_string_source) " + "\'" +',
                    '    (chr(92) + "a") * 12_000 +',
                    '    " FROM STREAM(sample_catalog.bronze.hidden_long_string_source)"',
                    ')',
                    'LONG_SQL_COMMENT = (',
                    '    "SELECT * FROM STREAM(sample_catalog.bronze.long_comment_source) /*" +',
                    '    " FROM STREAM(sample_catalog.bronze.hidden_long_comment_source) " * 12_000 +',
                    '    "*/ JOIN STREAM sample_catalog.silver.after_long_comment"',
                    ')',
                    'SQL_STREAM_QUERY = """',
                    'SELECT * FROM STREAM(sample_catalog.bronze.sql_stream_events)',
                    'JOIN STREAM sample_catalog.silver.sql_dimensions ON TRUE',
                    'WHERE note <> "FROM STREAM(sample_catalog.bronze.not_a_source)"',
                    'WHERE note <> \'FROM STREAM(sample_catalog.bronze.not_a_single_quote_source)\'',
                    'WHERE label <> \'it\'\'s FROM STREAM(sample_catalog.bronze.not_a_doubled_quote_source)\'',
                    '-- FROM STREAM(sample_catalog.bronze.not_a_line_comment_source)',
                    '/* FROM STREAM(sample_catalog.bronze.not_a_block_comment_source) */',
                    '/* outer /* FROM STREAM(sample_catalog.bronze.not_a_nested_comment_source) */',
                    '   FROM STREAM(sample_catalog.bronze.not_after_inner_comment_source) */',
                    'JOIN STREAM sample_catalog.bronze.after_nested_comment_source',
                    'SELECT * FROM STREAM(`sample_catalog`.`bronze`.`quoted``source`)',
                    '"""',
                    '',
                    'def read_events():',
                    '    read_dimensions()',
                    '    return spark.readStream.table(BRONZE_TABLE)',
                    '',
                    'def read_dimensions():',
                    '    read_events()',
                    '    return spark.read.table(DIMENSION_TABLE)',
                    '',
                    'def unused_read():',
                    '    return spark.read.table("sample_catalog.silver.unused_table")',
                    '',
                    'dp.create_streaming_table(name=python_names.TABLE_NAME)',
                    '',
                    '@dp.append_flow(target=python_names.TABLE_NAME, name="append_python")',
                    'def append_python():',
                    '    events = spark.readStream.option("maxFilesPerTrigger", 10).table(BRONZE_TABLE)',
                    '    dimensions = spark.read.table(DIMENSION_TABLE)',
                    '    return events.join(dimensions, "entity_id")',
                    '',
                    '@dp.append_flow(target=python_names.TABLE_NAME, name="append_helper")',
                    'def append_helper():',
                    '    return read_events().join(read_dimensions(), "entity_id")',
                    '',
                    '@dp.append_flow(target=python_names.TABLE_NAME, name="append_sql")',
                    'def append_sql():',
                    '    inline_events = SparkSession.active().sql("""',
                    '        SELECT * FROM STREAM(sample_catalog.bronze.inline_stream_events)',
                    '    """)',
                    '    query_events = spark.sql(SQL_STREAM_QUERY)',
                    '    long_string_events = spark.sql(LONG_SQL_STRING)',
                    '    long_comment_events = spark.sql(LONG_SQL_COMMENT)',
                    '    return (',
                    '        inline_events',
                    '        .unionByName(query_events)',
                    '        .unionByName(long_string_events)',
                    '        .unionByName(long_comment_events)',
                    '    )',
                    '',
                    'dp.create_auto_cdc_flow(',
                    '    target=python_names.TABLE_NAME,',
                    '    source=BRONZE_TABLE,',
                    '    keys=["entity_id"],',
                    '    sequence_by="update_ts",',
                    '    name="auto_cdc_python",',
                    ')',
                    '',
                ].join('\n'),
                relativePath: 'src/python_pipeline.py',
            },
            {
                content: 'CREATE MATERIALIZED VIEW sample_catalog.silver.sql_events AS SELECT 1 AS value;\n',
                relativePath: 'src/sql_pipeline.sql',
            },
        ],
        libraryInclude: '../src/**',
        name: 'Python Discovery Test',
        pipelinePath: 'example/events',
        prefix: 'spark-control-plane-python-discovery-',
        specExtras: [
            'catalog: sample_catalog',
            'database: bronze',
            'triggers:',
            '  - name: python-discovery-schedule',
            '    schedule:',
            '      cron: "0 0 1 1 *"',
            '      timezone_id: UTC',
            '      pause_status: PAUSED',
        ],
        specFilename: 'transaction.pipeline.yaml',
    });

    process.chdir(repositoryRoot);
    process.env.PIPELINES_DIR = path.join(fixture.root, 'pipelines');
    process.env.PYTHON_EXECUTABLE = pythonExecutable;
    delete process.env.PYTHONPATH;

    const service = createPipelineRegistryService({
        persistence: createInMemoryPersistence(),
    });
    try {
        await service.initialize();
        await service.refreshPipelinesFromSource();
        const pipelines = await service.listPipelines();
        assert.equal(pipelines.length, 1);
        const pipelineId = pipelines[0]?.id;
        assert.ok(pipelineId);

        const detail = await service.getPipeline(pipelineId);
        assert.deepEqual(detail.validationMessages, []);
        assert.equal(detail.nodeCount, 6);
        const triggers = await service.listTriggers();
        assert.equal(triggers.length, 1);
        assert.equal(triggers[0]?.name, 'python-discovery-schedule');
        assert.equal(triggers[0]?.enabled, false);
        assert.ok(detail.nodes.some((node) =>
            node.nodeType === 'STREAMING_TABLE' &&
            node.qualifiedName === 'sample_catalog.bronze.python_events' &&
            node.sourceFile?.endsWith(pythonSourcePath),
        ));
        assert.ok(detail.nodes.some((node) =>
            node.nodeType === 'FLOW' &&
            node.qualifiedName === 'sample_catalog.bronze.append_python' &&
            node.sourceFile?.endsWith(pythonSourcePath),
        ));
        assert.ok(detail.nodes.some((node) =>
            node.nodeType === 'FLOW' &&
            node.qualifiedName === 'sample_catalog.bronze.auto_cdc_python' &&
            node.sourceFile?.endsWith(pythonSourcePath),
        ));
        const autoCdcFlow = detail.nodes.find((node) =>
            node.qualifiedName === 'sample_catalog.bronze.auto_cdc_python'
        );
        assert.ok(autoCdcFlow);
        assert.ok(detail.edges.some((edge) =>
            edge.sourceNodeId === 'dataset:sample_catalog.bronze.source_events' &&
            edge.targetNodeId === autoCdcFlow.id &&
            edge.sourceExpression === 'sample_catalog.bronze.source_events' &&
            edge.evidence === 'SPARK_GRAPH_REGISTRATION' &&
            edge.confidence === 'UNKNOWN',
        ));
        const flow = detail.nodes.find((node) =>
            node.qualifiedName === 'sample_catalog.bronze.append_python'
        );
        assert.ok(flow);
        const flowInputs = detail.edges
            .filter((edge) => edge.targetNodeId === flow.id)
            .map((edge) => ({
                confidence: edge.confidence,
                evidence: edge.evidence,
                sourceExpression: edge.sourceExpression,
                sourceNodeId: edge.sourceNodeId,
            }))
            .sort((left, right) => left.sourceNodeId.localeCompare(right.sourceNodeId));
        assert.deepEqual(flowInputs, [
            {
                confidence: 'LOW',
                evidence: 'PYTHON_SOURCE_PATTERN',
                sourceExpression: 'sample_catalog.bronze.source_events',
                sourceNodeId: 'dataset:sample_catalog.bronze.source_events',
            },
            {
                confidence: 'LOW',
                evidence: 'PYTHON_SOURCE_PATTERN',
                sourceExpression: 'sample_catalog.silver.dimensions',
                sourceNodeId: 'dataset:sample_catalog.silver.dimensions',
            },
        ]);
        const helperFlow = detail.nodes.find((node) =>
            node.qualifiedName === 'sample_catalog.bronze.append_helper');
        assert.ok(helperFlow);
        assert.deepEqual(detail.edges
            .filter((edge) => edge.targetNodeId === helperFlow.id)
            .map((edge) => ({
                confidence: edge.confidence,
                evidence: edge.evidence,
                sourceExpression: edge.sourceExpression,
                sourceNodeId: edge.sourceNodeId,
            }))
            .sort((left, right) => left.sourceNodeId.localeCompare(right.sourceNodeId)),
        flowInputs);
        const sqlFlow = detail.nodes.find((node) =>
            node.qualifiedName === 'sample_catalog.bronze.append_sql');
        assert.ok(sqlFlow);
        assert.deepEqual(detail.edges
            .filter((edge) => edge.targetNodeId === sqlFlow.id)
            .map((edge) => edge.sourceNodeId)
            .sort(), [
            'dataset:sample_catalog.bronze.after_nested_comment_source',
            'dataset:sample_catalog.bronze.inline_stream_events',
            'dataset:sample_catalog.bronze.long_comment_source',
            'dataset:sample_catalog.bronze.long_string_source',
            'dataset:sample_catalog.bronze.quoted`source',
            'dataset:sample_catalog.bronze.sql_stream_events',
            'dataset:sample_catalog.silver.after_long_comment',
            'dataset:sample_catalog.silver.sql_dimensions',
        ]);
        assert.equal(detail.nodes.some((node) =>
            node.qualifiedName === 'sample_catalog.silver.unused_table'), false);
        assert.ok(detail.edges.some((edge) =>
            edge.sourceNodeId === flow.id &&
            edge.targetNodeId === 'dataset:sample_catalog.bronze.python_events' &&
            edge.evidence === 'SPARK_GRAPH_REGISTRATION',
        ));
        const discoveredNodeIds = new Set(detail.nodes.map((node) => node.id));
        assert.ok(detail.edges.every((edge) =>
            discoveredNodeIds.has(edge.sourceNodeId) && discoveredNodeIds.has(edge.targetNodeId),
        ));
        assert.ok(detail.nodes.some((node) =>
            node.nodeType === 'MATERIALIZED_VIEW' &&
            node.qualifiedName === 'sample_catalog.silver.sql_events',
        ));
    } finally {
        await service.shutdown(100);
        process.chdir(originalCwd);
        restore();
        await fixture.cleanup();
    }
});
