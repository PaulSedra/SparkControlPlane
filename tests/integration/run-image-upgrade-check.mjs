/**
 * @fileoverview Compares migration and runtime compatibility between two
 * control-plane images using isolated containers.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import { Pool } from 'pg';

async function main() {

const repositoryRoot = process.cwd();
const docker = resolveDockerCli();
const options = parseOptions(process.argv.slice(2));
const previousImage = options.previousImage;
const currentImage = options.currentImage;
const pipelineHostPath = options.pipelinePath;
const postgresCleanupHost = '127.0.0.1';
const containerPostgresHost = options.containerPostgresHost;
const containerPostgresPort = options.containerPostgresPort;
const containerSparkConnectUrl = options.containerSparkConnectUrl;
const requiredNames = [
    'POSTGRES_HOST',
    'POSTGRES_PORT',
    'POSTGRES_DATABASE',
    'POSTGRES_USER',
    'POSTGRES_PASSWORD',
    'POSTGRES_SSLMODE',
    'SPARK_CONNECT_URL',
];
for (const name of requiredNames) {
    if (!process.env[name]?.trim()) {
        throw new Error(`${name} is required for an image upgrade check.`);
    }
}
if (!fs.existsSync(pipelineHostPath)) {
    throw new Error('The managed pipeline fixture path does not exist.');
}

const suffix = `${process.pid}_${Date.now()}`;
const schema = `spark_control_plane_upgrade_${suffix}`;
const previousContainer = `spark-control-plane-upgrade-old-${suffix}`;
const currentContainer = `spark-control-plane-upgrade-current-${suffix}`;
const hostPort = await availablePort();
const baseUrl = `http://127.0.0.1:${hostPort}`;
const containerEnvironment = {
    ...process.env,
    CONTROL_PLANE_HOST: '0.0.0.0',
    CONTROL_PLANE_PORT: '8080',
    PIPELINES_DIR: '/app/pipelines',
    POSTGRES_HOST: containerPostgresHost,
    POSTGRES_PORT: containerPostgresPort,
    POSTGRES_SCHEMA: schema,
    SPARK_CONNECT_URL: containerSparkConnectUrl,
};

try {
    const previousVersions = await startReadMigrations(previousImage, previousContainer);
    removeContainer(previousContainer);
    const currentVersions = await startReadMigrations(currentImage, currentContainer);
    removeContainer(currentContainer);
    if (currentVersions.length < previousVersions.length) {
        throw new Error('Current image has fewer migrations than the previous image.');
    }
    if (currentVersions.length === previousVersions.length) {
        console.log(`UPGRADE_IDEMPOTENT_ONLY previous=${previousVersions.join(',')} current=${currentVersions.join(',')}`);
        process.exitCode = 2;
    } else {
        console.log(`UPGRADE_PASS previous=${previousVersions.join(',')} current=${currentVersions.join(',')}`);
    }
} finally {
    removeContainer(previousContainer);
    removeContainer(currentContainer);
    await dropSchema();
}

async function startReadMigrations(image, containerName) {
    runDocker([
        'run',
        '--detach',
        '--name', containerName,
        '--publish', `127.0.0.1:${hostPort}:8080`,
        '--mount', `type=bind,source=${pipelineHostPath},target=/app/pipelines,readonly`,
        ...forwardedEnvironmentNames().flatMap((name) => ['--env', name]),
        image,
    ], { network: options.network });
    await waitForReady(baseUrl);
    return migrationVersions();
}

function resolveDockerCli() {
    const candidates = [
        'C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe',
        'docker',
    ].filter(Boolean);
    const existing = candidates.find((candidate) => candidate === 'docker' || fs.existsSync(candidate));
    if (!existing) {
        throw new Error('Docker CLI was not found.');
    }
    return existing;
}

function parseOptions(args) {
    return {
        containerPostgresHost: requiredOption(args, '--container-postgres-host'),
        containerPostgresPort: requiredOption(args, '--container-postgres-port'),
        containerSparkConnectUrl: requiredOption(args, '--container-spark-connect-url'),
        currentImage: requiredOption(args, '--current-image'),
        network: optionalOption(args, '--network'),
        pipelinePath: requiredOption(args, '--pipeline-path'),
        previousImage: optionalOption(args, '--previous-image') || 'spark-control-plane:local',
    };
}

function requiredOption(args, name) {
    const value = optionalOption(args, name);
    if (value == null || value === '') {
        throw new Error(`${name} is required.`);
    }
    return value;
}

function optionalOption(args, name) {
    const index = args.indexOf(name);
    return index === -1 ? undefined : args[index + 1];
}

function runDocker(args, options = {}) {
    const dockerArgs = args[0] === 'run' && options.network != null
        ? ['run', '--network', options.network, ...args.slice(1)]
        : args;
    const result = spawnSync(docker, dockerArgs, {
        cwd: repositoryRoot,
        env: containerEnvironment,
        encoding: 'utf8',
        stdio: 'pipe',
        windowsHide: true,
    });
    if (result.error != null || result.status !== 0) {
        throw new Error(`Docker ${dockerArgs[0]} failed for image upgrade check.`);
    }
}

function removeContainer(name) {
    spawnSync(docker, ['rm', '--force', name], {
        cwd: repositoryRoot,
        env: containerEnvironment,
        stdio: 'ignore',
        windowsHide: true,
    });
}

function forwardedEnvironmentNames() {
    return [
        'CONTROL_PLANE_HOST',
        'CONTROL_PLANE_PORT',
        'CONTROL_PLANE_DRAIN_SECONDS',
        'AISTOR_WEBHOOK_TOKEN',
        'PIPELINES_DIR',
        'PIPELINE_RUN_LEASE_SECONDS',
        'PIPELINE_RUN_RECOVERY_INTERVAL_SECONDS',
        'PIPELINE_RUN_RECOVERY_BATCH_SIZE',
        'PIPELINE_CHILD_TERMINATION_GRACE_SECONDS',
        'PIPELINE_RUN_POLICIES',
        'PYTHON_EXECUTABLE',
        'PYTHONPATH',
        'POSTGRES_HOST',
        'POSTGRES_PORT',
        'POSTGRES_DATABASE',
        'POSTGRES_USER',
        'POSTGRES_PASSWORD',
        'POSTGRES_SCHEMA',
        'POSTGRES_SSLMODE',
        'POSTGRES_SSLROOTCERT',
        'POSTGRES_SSLCERT',
        'POSTGRES_SSLKEY',
        'SPARK_CONNECT_URL',
        'SPARK_HISTORY_URL',
    ].filter((name) => containerEnvironment[name] != null);
}

async function migrationVersions() {
    const pool = new Pool({
        database: process.env.POSTGRES_DATABASE,
        host: postgresCleanupHost,
        password: process.env.POSTGRES_PASSWORD,
        port: Number.parseInt(process.env.POSTGRES_PORT, 10),
        ssl: process.env.POSTGRES_SSLMODE.trim().toLowerCase() === 'disable' ? false : undefined,
        user: process.env.POSTGRES_USER,
    });
    try {
        const identifier = quoteIdentifier(schema);
        const result = await pool.query(
            `SELECT version FROM ${identifier}.schema_migrations ORDER BY version`,
        );
        return result.rows.map((row) => row.version);
    } finally {
        await pool.end();
    }
}

async function dropSchema() {
    const pool = new Pool({
        database: process.env.POSTGRES_DATABASE,
        host: postgresCleanupHost,
        password: process.env.POSTGRES_PASSWORD,
        port: Number.parseInt(process.env.POSTGRES_PORT, 10),
        ssl: process.env.POSTGRES_SSLMODE.trim().toLowerCase() === 'disable' ? false : undefined,
        user: process.env.POSTGRES_USER,
    });
    try {
        await pool.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`);
    } finally {
        await pool.end();
    }
}

function quoteIdentifier(value) {
    return `"${value.replaceAll('"', '""')}"`;
}

async function availablePort() {
    return await new Promise((resolve, reject) => {
        const server = net.createServer();
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const address = server.address();
            server.close(() => {
                if (address == null || typeof address === 'string') {
                    reject(new Error('Could not allocate a port for image upgrade check.'));
                    return;
                }
                resolve(address.port);
            });
        });
    });
}

async function waitForReady(url) {
    const deadline = Date.now() + 180_000;
    while (Date.now() < deadline) {
        try {
            const response = await fetch(`${url}/ready`);
            if (response.status === 200) {
                return;
            }
        } catch {
            // The image is still starting.
        }
        await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
    throw new Error('Image did not become ready during upgrade check.');
}

}

await main();
