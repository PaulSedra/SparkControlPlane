/**
 * @fileoverview Unit coverage for Spark catalog metadata subprocess output.
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import { resolvePythonExecutable } from '../../../../src/server/runtime/pythonRuntime.ts';

test('Spark catalog detail expands and omits the aggregate Table Properties entry', async () => {
    const result = await runPython(resolvePythonExecutable(), [
        path.join(
            process.cwd(),
            'src',
            'server',
            'catalog',
            'spark_connect_catalog.py',
        ),
    ]);
    assert.equal(result.exitCode, 0, result.stderr || result.stdout);
});

test('Spark catalog metadata, serialization, limits, and failures are covered', async () => {
    const result = await runPythonFile(resolvePythonExecutable(), [
        path.join(
            process.cwd(),
            'tests',
            'server',
            'unit',
            'catalog',
            'spark_connect_catalog_test.py',
        ),
        path.join(
            process.cwd(),
            'src',
            'server',
            'catalog',
            'spark_connect_catalog.py',
        ),
    ]);
    assert.equal(result.exitCode, 0, result.stderr || result.stdout);
    assert.match(result.stderr, /OK/);
});

async function runPython(python: string, args: string[]): Promise<{
    exitCode: number | null;
    stderr: string;
    stdout: string;
}> {
    const script = String.raw`
import importlib.util
import os
import sys
import types

spark_module = types.ModuleType("pyspark")
sql_module = types.ModuleType("pyspark.sql")
sql_module.Row = object
sql_module.SparkSession = object
sys.modules["pyspark"] = spark_module
sys.modules["pyspark.sql"] = sql_module

script_path = sys.argv[1]
sys.path.insert(0, os.path.dirname(os.path.abspath(script_path)))
module_spec = importlib.util.spec_from_file_location("spark_connect_catalog", script_path)
catalog = importlib.util.module_from_spec(module_spec)
module_spec.loader.exec_module(catalog)
metadata = sys.modules["catalog_metadata"]

class FakeRow:
    def __init__(self, *values):
        self.values = values

    def __iter__(self):
        return iter(self.values)

class FakeResult:
    def __init__(self, rows):
        self.rows = rows

    def toLocalIterator(self):
        return iter(self.rows)

class FakeSpark:
    def sql(self, query):
        expected_query = "DESCRIBE TABLE EXTENDED " + chr(96) + "example" + chr(96) + "." + chr(96) + "silver" + chr(96) + "." + chr(96) + "events" + chr(96)
        assert query == expected_query
        return FakeResult([
            FakeRow("# col_name", "data_type", "comment"),
            FakeRow("event_id", "bigint", ""),
            FakeRow("# Detailed Table Information", "", ""),
            FakeRow(
                "Table Properties",
                "[created-at=2026-09-01T00:37:48.330685024Z,current-snapshot-id=7520825462103227677,format=iceberg/parquet,format-version=2,write.parquet.compression-codec=zstd]",
                "",
            ),
        ])

detail = metadata.describe_table(FakeSpark(), "example", "silver", "events")
properties = detail["properties"]
assert properties["created-at"] == "2026-09-01T00:37:48.330685024Z"
assert properties["current-snapshot-id"] == "7520825462103227677"
assert properties["format"] == "iceberg/parquet"
assert properties["format-version"] == "2"
assert properties["write.parquet.compression-codec"] == "zstd"
assert "Table Properties" not in properties
`;

    return new Promise((resolve, reject) => {
        const child = spawn(python, ['-c', script, ...args], {
            cwd: process.cwd(),
            env: process.env,
            windowsHide: true,
        });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (chunk: Buffer) => {
            stdout += chunk.toString();
        });
        child.stderr.on('data', (chunk: Buffer) => {
            stderr += chunk.toString();
        });
        child.on('error', reject);
        child.on('close', (exitCode) => resolve({ exitCode, stderr, stdout }));
    });
}

async function runPythonFile(python: string, args: string[]): Promise<{
    exitCode: number | null;
    stderr: string;
    stdout: string;
}> {
    return new Promise((resolve, reject) => {
        const child = spawn(python, args, {
            cwd: process.cwd(),
            env: process.env,
            windowsHide: true,
        });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (chunk: Buffer) => {
            stdout += chunk.toString();
        });
        child.stderr.on('data', (chunk: Buffer) => {
            stderr += chunk.toString();
        });
        child.on('error', reject);
        child.on('close', (exitCode) => resolve({ exitCode, stderr, stdout }));
    });
}
