/**
 * @fileoverview Checks that the built container contains the expected artifacts.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { getManagedTestContext } from '../../support/managedTestContext.mjs';

const context = getManagedTestContext();
const docker = context?.docker || 'docker';
const image = context?.image || 'spark-control-plane:acceptance';

test('final image has runtime metadata, default root execution, and no local credentials/state', () => {
    assert.ok(docker === 'docker' || fs.existsSync(docker), 'Docker CLI is required.');

    const metadata = runDocker([
        'image',
        'inspect',
        '--format',
        '{{json .Config.User}}|{{json .Config.Labels}}|{{range .Config.Env}}{{println .}}{{end}}',
        image,
    ]);
    assert.match(metadata, /^""\|/);
    assert.match(metadata, /org\.opencontainers\.image\.title/);
    assert.match(metadata, /org\.opencontainers\.image\.version/);
    assert.match(metadata, /org\.opencontainers\.image\.source/);
    assert.match(metadata, /org\.opencontainers\.image\.licenses/);
    assert.doesNotMatch(metadata, /POSTGRES_(?:PASSWORD|SSLROOTCERT|SSLCERT|SSLKEY)(?:_FILE)?=/i);
    assert.doesNotMatch(metadata, /(?:PASSWORD|CERT|KEY)_FILE=/i);

    runDocker([
        'run',
        '--rm',
        '--entrypoint',
        'sh',
        image,
        '-c',
        'test "$(id -u)" = 0 && test -d /app/dist && test -d /app/src/server && test -d /app/src/shared && ' +
            'test ! -e /app/.env && test ! -e /app/.env.example && ' +
            'test ! -e /app/.env.container.example && test ! -e /app/.spark-control-plane && ' +
            'test ! -e /app/pipelines',
    ]);
});

function runDocker(args) {
    const result = spawnSync(docker, args, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
    });
    if (result.error != null || result.status !== 0) {
        throw new Error(`Docker artifact command failed: ${args[0]}.`);
    }
    return result.stdout;
}
