/**
 * @fileoverview Explicit container acceptance runner that builds the image,
 * starts an isolated test container, and executes the container suites.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Pool } from 'pg';

async function main() {

const repositoryRoot = process.cwd();
const docker = resolveDockerCli();
const options = parseOptions(process.argv.slice(2));
const requiredNames = [
    'POSTGRES_HOST',
    'POSTGRES_DATABASE',
    'POSTGRES_USER',
    'POSTGRES_PASSWORD',
    'AISTOR_WEBHOOK_TOKEN',
    'SPARK_CONNECT_URL',
];

for (const name of requiredNames) {
    if (!process.env[name]?.trim()) {
        throw new Error(`${name} is required for container acceptance.`);
    }
}
if (!fs.existsSync(options.pipelinePath)) {
    throw new Error('The managed pipeline fixture path does not exist.');
}

const image = options.image;
const containerName = `spark-control-plane-container-test-${process.pid}-${Date.now()}`;
const acceptanceSchema = `spark_control_plane_container_${process.pid}_${Date.now()}`;
const pipelineHostPath = options.pipelinePath;
const pipelineName = options.pipelineName;
const postgresCleanupHost = '127.0.0.1';
const containerPostgresHost = options.containerPostgresHost;
const containerPostgresPort = options.containerPostgresPort;
const containerSparkConnectUrl = options.containerSparkConnectUrl;
const hostPort = await availablePort();
const baseUrl = `http://127.0.0.1:${hostPort}`;
const containerEnvironment = {
    ...process.env,
    CONTROL_PLANE_HOST: '0.0.0.0',
    CONTROL_PLANE_PORT: '8080',
    PIPELINES_DIR: '/app/pipelines',
    POSTGRES_HOST: containerPostgresHost,
    POSTGRES_PORT: containerPostgresPort,
    POSTGRES_SCHEMA: acceptanceSchema,
    POSTGRES_SSLMODE: process.env.POSTGRES_SSLMODE?.trim() || 'require',
    SPARK_CONNECT_URL: containerSparkConnectUrl,
    PIPELINE_RUN_LEASE_SECONDS: '5',
};
const testContext = {
    containerName,
    controlPlaneBaseUrl: baseUrl,
    docker,
    image,
    pipelineName,
    timeoutSeconds: 300,
};

try {
    run(process.execPath, ['tests/security/audit-production-dependencies.mjs']);
    if (!options.skipBuild) {
        run(docker, ['build', '--tag', image, '.'], { env: containerEnvironment });
    }
    runManagedTests(['tests/integration/container/containerArtifact.test.mjs'], testContext, containerEnvironment);
    runDocker([
        'run',
        '--detach',
        '--name', containerName,
        '--publish', `127.0.0.1:${hostPort}:8080`,
        '--mount', `type=bind,source=${pipelineHostPath},target=/app/pipelines,readonly`,
        ...forwardedEnvironmentNames().flatMap((name) => ['--env', name]),
        image,
    ], { env: containerEnvironment, network: options.network });
    await waitForReady(baseUrl);

    runManagedTests(['tests/integration/container/containerAcceptance.test.mjs'], testContext, process.env);
    runManagedTests(
        ['tests/integration/spark/liveSpark.test.ts'],
        testContext,
        { ...process.env, POSTGRES_SCHEMA: acceptanceSchema },
    );
} finally {
    runDocker(['rm', '--force', containerName], { allowFailure: true });
    try {
        await dropAcceptanceSchema();
    } catch (error) {
        console.error(`Container acceptance PostgreSQL cleanup failed: ${error}`);
    }
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
    const options = {
        containerPostgresHost: requiredOption(args, '--container-postgres-host'),
        containerPostgresPort: requiredOption(args, '--container-postgres-port'),
        containerSparkConnectUrl: requiredOption(args, '--container-spark-connect-url'),
        image: requiredOption(args, '--image'),
        network: optionalOption(args, '--network'),
        pipelineName: requiredOption(args, '--pipeline-name'),
        pipelinePath: requiredOption(args, '--pipeline-path'),
        skipBuild: args.includes('--skip-build'),
    };
    return options;
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

function run(command, args, options = {}) {
    const result = spawnSync(command, args, {
        cwd: repositoryRoot,
        env: options.env ?? process.env,
        stdio: 'inherit',
        windowsHide: true,
    });
    if (result.error != null || result.status !== 0) {
        if (!options.allowFailure) {
            throw new Error(`${path.basename(command)} command failed.`);
        }
    }
}

function runDocker(args, options = {}) {
    const dockerArgs = args[0] === 'run' && options.network != null
        ? ['run', '--network', options.network, ...args.slice(1)]
        : args;
    run(docker, dockerArgs, { ...options, network: undefined });
}

function runManagedTests(testFiles, context, environment) {
    const contextSource = [
        `import { setManagedTestContext } from ${JSON.stringify(pathToFileURL(path.join(repositoryRoot, 'tests/support/managedTestContext.mjs')).href)};`,
        `setManagedTestContext(${JSON.stringify(context)});`,
    ].join(' ');
    run(process.execPath, [
        '--test',
        '--test-concurrency=1',
        '--experimental-strip-types',
        '--import', `data:text/javascript,${encodeURIComponent(contextSource)}`,
        ...testFiles,
    ], { env: environment });
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
        'PIPELINE_RUN_POLICIES',
        'SPARK_CLI_BINARY',
        'SPARK_CLI_PYTHON',
        'SPARK_CLI_PROPERTIES_FILE',
        'SPARK_CLI_STATE_DIRECTORY',
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
    ].filter((name) => process.env[name] != null || containerEnvironment[name] != null);
}

async function dropAcceptanceSchema() {
    const tlsMode = (process.env.POSTGRES_SSLMODE?.trim() || 'require').toLowerCase();
    const pool = new Pool({
        database: process.env.POSTGRES_DATABASE,
        host: postgresCleanupHost,
        password: process.env.POSTGRES_PASSWORD,
        port: Number.parseInt(process.env.POSTGRES_PORT ?? '5432', 10),
        ssl: tlsMode === 'disable' ? false : {
            ca: process.env.POSTGRES_SSLROOTCERT,
            cert: process.env.POSTGRES_SSLCERT,
            key: process.env.POSTGRES_SSLKEY,
            rejectUnauthorized: tlsMode !== 'require',
        },
        user: process.env.POSTGRES_USER,
    });
    try {
        await pool.query(`DROP SCHEMA IF EXISTS "${acceptanceSchema}" CASCADE`);
    } finally {
        await pool.end();
    }
}

async function availablePort() {
    return await new Promise((resolve, reject) => {
        const server = net.createServer();
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const address = server.address();
            server.close(() => {
                if (address == null || typeof address === 'string') {
                    reject(new Error('Could not allocate a container test port.'));
                    return;
                }
                resolve(address.port);
            });
        });
    });
}

async function waitForReady(baseUrl) {
    const deadline = Date.now() + 180_000;
    while (Date.now() < deadline) {
        try {
            const response = await fetch(`${baseUrl}/ready`);
            if (response.status === 200) {
                return;
            }
        } catch {
            // Container startup is still in progress.
        }
        await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
    throw new Error('Container did not become ready within 180 seconds.');
}

}

await main();
