/**
 * @fileoverview Loads suite-local JSON, YAML, and text payloads from testdata.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const testsRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
);

/** Loader for serialized data owned by one test suite. */
export interface TestDataLoader {
    loadData<T>(relativePath: string): T;
    loadText(relativePath: string): string;
    loadYaml<T>(relativePath: string): T;
}

/** Creates a loader rooted at `tests/<testDirectory>/testdata`. */
export function createTestDataLoader(testDirectory: string): TestDataLoader {
    const suiteRoot = path.resolve(testsRoot, testDirectory);
    if (!suiteRoot.startsWith(`${testsRoot}${path.sep}`)) {
        throw new Error(`Testdata directory escapes the tests root: ${testDirectory}`);
    }

    const testdataRoot = path.join(suiteRoot, 'testdata');
    const resolveTestDataPath = (relativePath: string): string => {
        const filePath = path.resolve(testdataRoot, relativePath);
        if (!filePath.startsWith(`${testdataRoot}${path.sep}`)) {
            throw new Error(`Testdata path escapes the testdata root: ${relativePath}`);
        }
        return filePath;
    };
    const loadText = (relativePath: string): string =>
        fs.readFileSync(resolveTestDataPath(relativePath), 'utf8');
    const loadData = <T>(relativePath: string): T =>
        JSON.parse(loadText(relativePath)) as T;
    const loadYaml = <T>(relativePath: string): T => {
        const value = yaml.load(loadText(relativePath));
        if (value == null) {
            throw new Error(`YAML test fixture is empty: ${relativePath}`);
        }
        return value as T;
    };

    return { loadData, loadText, loadYaml };
}
