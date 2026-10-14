/**
 * @fileoverview Unit coverage for Python executable resolution.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { withTemporaryDirectory } from '../../../support/testEnvironment.ts';
import { resolvePythonExecutable } from '../../../../src/server/runtime/pythonRuntime.ts';

test('Python executable resolution honors direct configuration on every platform', () => {
    assert.equal(
        resolvePythonExecutable({ PYTHON_EXECUTABLE: '/usr/local/bin/python' }, 'linux', 'C:\\repo'),
        '/usr/local/bin/python',
    );
});

test('Python executable resolution uses the Linux virtualenv path in a container', () =>
    withTemporaryDirectory('spark-control-plane-python-', async (root) => {
        const pythonPath = path.join(root, '.venv', 'bin', 'python');
        await fs.mkdir(path.dirname(pythonPath), { recursive: true });
        await fs.writeFile(pythonPath, '', 'utf8');
        assert.equal(resolvePythonExecutable({}, 'linux', root), pythonPath);
    }));
