/**
 * @fileoverview Owns the disposable Docker integration stack and its live
 * test suites without loading dotenv files or relying on external services.
 */

import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const repositoryRoot = process.cwd();
const composeFile = path.join(repositoryRoot, 'compose.integration.yaml');
const temporaryParent = path.join(repositoryRoot, 'tmp');
const supportedSuites = new Set(['all', 'container', 'polaris', 'postgres', 'spark', 'upgrade']);
const supportedSparkImageDigests = new Map([
    ['4.1.0', 'b76109d3d702e0c66687051565d896a79341d1aca927d4da19c29d6da1e76e76'],
    ['4.1.1', '0b8f5befe00d258df03b252158b3894b8654390f1958741accf98155539a662a'],
    ['4.1.2', 'ac7efd6404ef99d6a28ea54ea74fc8ac69c420a7af83a4718b59fecad856e447'],
    ['4.1.3', '7cdb42ed55b5e02c279e838e38da3336dae74dca6aef07defae93f3c197d8ed6'],
    ['4.2.0', '786b96ed0058a0f1411475b218105f556ae4dabb2849c8dd23f4a701e94dd2ca'],
]);

const { suite, sparkVersion } = parseOptions(process.argv.slice(2));
const usesPolaris = suite !== 'postgres' && suite !== 'spark';
const docker = resolveDockerCli();
const runId = `${process.pid}-${Date.now()}`;
const projectName = `spark-control-plane-integration-${runId}`.toLowerCase();
const networkName = `${projectName}-network`;
const controlPlaneImage = `spark-control-plane:integration-${runId}`;
const sparkImage = `spark-control-plane:spark-integration-${runId}`;
const credentials = createCredentials();
const integrationCatalogName = suite === 'spark' ? 'spark_catalog' : credentials.catalog;
const integrationNamespace = suite === 'spark' ? 'default' : credentials.namespace;
const ports = await allocatePorts();
const fixture = await createIntegrationFixture(runId);
const composeEnvironment = createComposeEnvironment();
const testEnvironment = createTestEnvironment();
const managedTestContext = createManagedTestContext();

let stackStarted = false;
let phase = 'initializing';
let exitCode = 0;

try {
    phase = 'validating Docker and Compose configuration';
    runDocker(['version'], { allowFailure: false });
    runCompose(['config', '--quiet']);

    phase = 'starting PostgreSQL';
    stackStarted = true;
    await composeUp(['postgres']);
    await waitForHealthy('postgres', 120_000);

    if (suite !== 'postgres') {
        if (usesPolaris) {
            phase = 'bootstrapping Polaris';
            await composeUp(['polaris']);
            await waitForExited('polaris-bootstrap', 180_000);
            await waitForHealthy('polaris', 180_000);
            await seedPolaris();
        }

        phase = 'starting Spark Connect';
        await composeUp(['spark-connect'], { build: true });
        await waitForHealthy('spark-connect', 240_000);
        await seedSparkTable();
    }

    if (suite === 'all' || suite === 'polaris' || suite === 'spark') {
        // Keep Spark Connect's seeded `/tmp` warehouse in its existing container.
        phase = 'building the control-plane target';
        composeBuild();

        phase = 'starting the control-plane target';
        await composeUp(['control-plane'], { noDependencies: true });
        await waitForHealthy('control-plane', 180_000);
        await waitForHttp(`${managedTestContext.controlPlaneBaseUrl}/ready`, 180_000);
    } else if (suite === 'container' || suite === 'upgrade') {
        phase = 'building the acceptance image';
        await composeBuild();
    }

    phase = suite === 'spark'
        ? `running Spark ${sparkVersion} integration suite`
        : `running ${suite} integration suite`;
    await runSuite();
} catch (error) {
    exitCode = 1;
    console.error(`Managed integration stack failed during ${phase}.`);
    console.error(redact(error instanceof Error ? error.message : String(error)));
    if (stackStarted) {
        printDiagnostics();
    }
} finally {
    phase = 'cleaning up the managed integration stack';
    await cleanupStack();
    await cleanupFixture();
}

process.exitCode = exitCode;

async function runSuite() {
    if (suite === 'postgres') {
        await runManagedTests(['tests/integration/postgres/*.test.ts'], managedTestContext);
        return;
    }

    if (suite === 'polaris') {
        await runManagedTests(['tests/integration/polaris/*.test.ts'], managedTestContext);
        return;
    }

    if (suite === 'spark') {
        await runManagedTests(['tests/integration/spark/liveSpark.test.ts'], managedTestContext);
        return;
    }

    if (suite === 'container') {
        runContainerSuite();
        return;
    }

    if (suite === 'upgrade') {
        runUpgradeSuite();
        return;
    }

    // Keep these tests outside the schema used by the running control-plane worker.
    const postgresTestEnvironment = {
        ...testEnvironment,
        POSTGRES_SCHEMA: `spark_control_plane_tests_${runId.replaceAll('-', '_')}`,
    };
    await runManagedTests(
        ['tests/integration/postgres/*.test.ts'],
        managedTestContext,
        postgresTestEnvironment,
    );
    await runManagedTests(['tests/integration/polaris/*.test.ts'], managedTestContext);
    await runManagedTests(['tests/integration/spark/liveSpark.test.ts'], managedTestContext);
    runContainerSuite();
}

function runContainerSuite() {
    runNode([
        'tests/integration/run-container-tests.mjs',
        '--image', controlPlaneImage,
        '--network', networkName,
        '--pipeline-path', fixture.root,
        '--pipeline-name', fixture.pipelineName,
        '--container-postgres-host', 'postgres',
        '--container-postgres-port', '5432',
        '--container-spark-connect-url', 'sc://spark-connect:15002',
        '--skip-build',
    ], testEnvironment);
}

function runUpgradeSuite() {
    runNode([
        'tests/integration/run-image-upgrade-check.mjs',
        '--current-image', controlPlaneImage,
        '--network', networkName,
        '--pipeline-path', fixture.root,
        '--container-postgres-host', 'postgres',
        '--container-postgres-port', '5432',
        '--container-spark-connect-url', 'sc://spark-connect:15002',
    ], testEnvironment);
}

function createComposeEnvironment() {
    return {
        ...runtimeEnvironment(),
        AISTOR_WEBHOOK_TOKEN: credentials.webhookToken,
        CATALOG_BACKEND: suite === 'spark' ? 'spark' : 'polaris',
        CONTROL_PLANE_HOST_PORT: String(ports.controlPlane),
        INTEGRATION_CONTROL_PLANE_IMAGE: controlPlaneImage,
        INTEGRATION_NETWORK_NAME: networkName,
        INTEGRATION_PIPELINES_PATH: fixture.root,
        INTEGRATION_SPARK_BASE_IMAGE: `apache/spark:${sparkVersion}-python3@sha256:${supportedSparkImageDigests.get(sparkVersion)}`,
        INTEGRATION_SPARK_IMAGE: sparkImage,
        POLARIS_CATALOG_NAME: credentials.catalog,
        POLARIS_CLIENT_ID: credentials.clientId,
        POLARIS_CLIENT_SECRET: credentials.clientSecret,
        POLARIS_POSTGRES_DATABASE: 'polaris',
        POLARIS_POSTGRES_SCHEMA: 'polaris_schema',
        POLARIS_REALM: 'POLARIS',
        POLARIS_HOST_PORT: String(ports.polaris),
        POSTGRES_DATABASE: 'control_plane',
        POSTGRES_HOST_PORT: String(ports.postgres),
        POSTGRES_PASSWORD: credentials.databasePassword,
        POSTGRES_USER: 'control_plane_test',
        SPARK_CONNECT_HOST_PORT: String(ports.sparkConnect),
    };
}

function createTestEnvironment() {
    return {
        ...runtimeEnvironment(),
        AISTOR_WEBHOOK_TOKEN: credentials.webhookToken,
        CATALOG_BACKEND: suite === 'spark' ? 'spark' : 'polaris',
        PIPELINES_DIR: fixture.root,
        POSTGRES_DATABASE: 'control_plane',
        POSTGRES_HOST: '127.0.0.1',
        POSTGRES_PASSWORD: credentials.databasePassword,
        POSTGRES_PORT: String(ports.postgres),
        POSTGRES_SCHEMA: 'spark_control_plane',
        POSTGRES_SSLMODE: 'disable',
        POSTGRES_USER: 'control_plane_test',
        SPARK_CONNECT_URL: `sc://127.0.0.1:${ports.sparkConnect}`,
        SPARK_HISTORY_URL: '',
    };
}

function createManagedTestContext() {
    return {
        catalogName: integrationCatalogName,
        controlPlaneBaseUrl: `http://127.0.0.1:${ports.controlPlane}`,
        demoPipelineName: fixture.demoPipelineName,
        expectedDemoNodeName: 'spark_catalog.default.demo_orders',
        expectedNodeName: `${integrationCatalogName}.${integrationNamespace}.pipeline_output`,
        namespace: integrationNamespace,
        pipelineName: fixture.pipelineName,
        suite,
        tableName: credentials.table,
        timeoutSeconds: 300,
    };
}

async function seedPolaris() {
    runNode(['tests/integration/support/seed-polaris-integration.mjs'], {
        ...testEnvironment,
        POLARIS_BASE_URL: `http://127.0.0.1:${ports.polaris}`,
        POLARIS_CATALOG_NAME: credentials.catalog,
        POLARIS_CLIENT_ID: credentials.clientId,
        POLARIS_CLIENT_SECRET: credentials.clientSecret,
        POLARIS_NAMESPACE: credentials.namespace,
        POLARIS_REALM: 'POLARIS',
    });
}

async function seedSparkTable() {
    runCompose([
        'exec',
        '--no-TTY',
        '--env', `INTEGRATION_CATALOG_NAME=${integrationCatalogName}`,
        '--env', `INTEGRATION_NAMESPACE=${integrationNamespace}`,
        '--env', `INTEGRATION_TABLE_PROVIDER=${suite === 'spark' ? 'parquet' : 'iceberg'}`,
        '--env', `INTEGRATION_TABLE_NAME=${credentials.table}`,
        '--env', 'SPARK_CONNECT_URL=sc://spark-connect:15002',
        'spark-connect',
        'python3',
        '/opt/integration/seed-integration-catalog.py',
    ]);
}

async function composeUp(services, { build = false, noDependencies = false } = {}) {
    const args = ['up', '--detach'];
    if (build) {
        args.push('--build');
    }
    if (noDependencies) {
        args.push('--no-deps');
    }
    args.push(...services);
    runCompose(args);
}

async function composeBuild() {
    runCompose(['build', 'control-plane']);
}

async function waitForHealthy(service, timeoutMilliseconds) {
    const deadline = Date.now() + timeoutMilliseconds;
    while (Date.now() < deadline) {
        const containerId = composeContainerId(service);
        if (containerId != null) {
            const state = inspectContainer(containerId);
            if (state.status === 'exited' || state.status === 'dead') {
                throw new Error(`${service} exited with code ${state.exitCode}.`);
            }
            if (state.health === 'healthy') {
                return;
            }
        }
        await delay(1000);
    }
    throw new Error(`${service} did not become healthy within ${timeoutMilliseconds} ms.`);
}

async function waitForExited(service, timeoutMilliseconds) {
    const deadline = Date.now() + timeoutMilliseconds;
    while (Date.now() < deadline) {
        const containerId = composeContainerId(service);
        if (containerId != null) {
            const state = inspectContainer(containerId);
            if (state.status === 'exited' || state.status === 'dead') {
                if (state.exitCode !== '0') {
                    throw new Error(`${service} exited with code ${state.exitCode}.`);
                }
                return;
            }
        }
        await delay(1000);
    }
    throw new Error(`${service} did not complete within ${timeoutMilliseconds} ms.`);
}

async function waitForHttp(url, timeoutMilliseconds) {
    const deadline = Date.now() + timeoutMilliseconds;
    while (Date.now() < deadline) {
        try {
            const response = await fetch(url, { signal: AbortSignal.timeout(3000) });
            if (response.ok) {
                return;
            }
        } catch {
            // The service is still starting or restarting.
        }
        await delay(1000);
    }
    throw new Error(`HTTP readiness endpoint did not become available: ${url}.`);
}

function composeContainerId(service) {
    const result = runComposeCapture(['ps', '--all', '--quiet', service], { allowFailure: true });
    const id = result.stdout.trim().split(/\s+/)[0];
    return id || undefined;
}

function inspectContainer(containerId) {
    const result = runDockerCapture([
        'inspect',
        '--format',
        '{{.State.Status}}|{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}|{{.State.ExitCode}}',
        containerId,
    ]);
    const [status = '', health = '', exitCode = ''] = result.stdout.trim().split('|');
    return { exitCode, health, status };
}

async function runManagedTests(patterns, context, environment = testEnvironment) {
    const files = await expandTestFiles(patterns);
    const contextSource = [
        `import { setManagedTestContext } from ${JSON.stringify(pathToFileURL(path.join(repositoryRoot, 'tests/support/managedTestContext.mjs')).href)};`,
        `setManagedTestContext(${JSON.stringify(context)});`,
    ].join(' ');
    runNode([
        '--test',
        '--test-concurrency=1',
        '--experimental-strip-types',
        '--import', `data:text/javascript,${encodeURIComponent(contextSource)}`,
        ...files,
    ], environment);
}

async function expandTestFiles(patterns) {
    const files = [];
    for (const pattern of patterns) {
        if (!pattern.includes('*')) {
            files.push(path.resolve(repositoryRoot, pattern));
            continue;
        }
        const directory = path.resolve(repositoryRoot, path.dirname(pattern));
        const basename = path.basename(pattern);
        const escaped = basename.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const expression = new RegExp(`^${escaped.replace('\\*', '.*')}$`);
        const entries = await fs.readdir(directory, { withFileTypes: true });
        for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
            if (entry.isFile() && expression.test(entry.name)) {
                files.push(path.join(directory, entry.name));
            }
        }
    }
    return files;
}

function runNode(args, environment) {
    execute(process.execPath, args, { env: environment });
}

function runCompose(args, options = {}) {
    return execute(
        docker,
        ['compose', '--project-name', projectName, '--file', composeFile, ...args],
        { env: composeEnvironment, ...options },
    );
}

function runComposeCapture(args, options = {}) {
    return executeCapture(
        docker,
        ['compose', '--project-name', projectName, '--file', composeFile, ...args],
        { env: composeEnvironment, ...options },
    );
}

function runDocker(args, options = {}) {
    return execute(docker, args, { env: composeEnvironment, ...options });
}

function runDockerCapture(args, options = {}) {
    return executeCapture(docker, args, { env: composeEnvironment, ...options });
}

function execute(command, args, options = {}) {
    const result = spawnSync(command, args, {
        cwd: repositoryRoot,
        env: options.env ?? process.env,
        encoding: 'utf8',
        stdio: options.stdio ?? 'inherit',
        windowsHide: true,
    });
    if (!options.allowFailure && (result.error != null || result.status !== 0)) {
        throw new Error(`${path.basename(command)} ${args[0] ?? 'command'} failed.`);
    }
    return result;
}

function executeCapture(command, args, options = {}) {
    const result = spawnSync(command, args, {
        cwd: repositoryRoot,
        env: options.env ?? process.env,
        encoding: 'utf8',
        stdio: 'pipe',
        windowsHide: true,
    });
    if (!options.allowFailure && (result.error != null || result.status !== 0)) {
        throw new Error(redact(result.stderr || `${path.basename(command)} failed.`));
    }
    return {
        status: result.status,
        stderr: result.stderr ?? '',
        stdout: result.stdout ?? '',
    };
}

function printDiagnostics() {
    const result = runComposeCapture(
        ['logs', '--no-color', '--tail', '200', 'postgres', 'polaris-bootstrap', 'polaris', 'spark-connect', 'control-plane'],
        { allowFailure: true },
    );
    const output = redact(`${result.stdout}\n${result.stderr}`).trim();
    if (output) {
        console.error('Managed integration diagnostics:');
        console.error(output);
    }
}

async function cleanupStack() {
    if (!stackStarted) {
        return;
    }
    try {
        runCompose(['down', '--volumes', '--remove-orphans'], { allowFailure: true });
    } catch (error) {
        console.error(`Managed integration cleanup failed: ${redact(String(error))}`);
    }
}

async function cleanupFixture() {
    const resolved = path.resolve(fixture.root);
    const expectedParent = path.resolve(temporaryParent) + path.sep;
    if (!resolved.startsWith(expectedParent) || !path.basename(resolved).startsWith('integration-stack-')) {
        throw new Error('Refusing to remove an unexpected integration fixture path.');
    }
    await fs.rm(resolved, { force: true, maxRetries: 3, recursive: true, retryDelay: 100 });
}

async function createIntegrationFixture(identifier) {
    await fs.mkdir(temporaryParent, { recursive: true });
    const root = await fs.mkdtemp(path.join(temporaryParent, 'integration-stack-'));
    const pipelineRoot = path.join(root, 'pipelines', 'integration');
    const pipelineName = `Managed Integration Pipeline ${identifier}`;
    await fs.mkdir(path.join(pipelineRoot, 'resources'), { recursive: true });
    await fs.mkdir(path.join(pipelineRoot, 'sql'), { recursive: true });
    await fs.writeFile(
        path.join(pipelineRoot, 'resources', 'integration.pipeline.yaml'),
        [
            `name: ${pipelineName}`,
            'storage: file:///tmp/spark-control-plane-integration-checkpoints',
            `catalog: ${integrationCatalogName}`,
            `database: ${integrationNamespace}`,
            'libraries:',
            '  - glob:',
            '      include: ../sql/**',
            '',
        ].join('\n'),
        'utf8',
    );
    await fs.writeFile(
        path.join(pipelineRoot, 'sql', 'integration.sql'),
        'CREATE MATERIALIZED VIEW pipeline_output AS SELECT id, label FROM seed_events;\n',
        'utf8',
    );

    const demoPipelineName = suite === 'spark'
        ? `Default Spark Catalog Demo ${identifier}`
        : undefined;
    if (demoPipelineName != null) {
        const demoPipelineRoot = path.join(root, 'pipelines', 'default-catalog-demo');
        await fs.mkdir(path.join(demoPipelineRoot, 'resources'), { recursive: true });
        await fs.mkdir(path.join(demoPipelineRoot, 'sql'), { recursive: true });
        await fs.writeFile(
            path.join(demoPipelineRoot, 'resources', 'demo.pipeline.yaml'),
            [
                `name: ${demoPipelineName}`,
                'storage: file:///tmp/spark-control-plane-integration-default-catalog-checkpoints',
                'catalog: spark_catalog',
                'database: default',
                'libraries:',
                '  - glob:',
                '      include: ../sql/**',
                '',
            ].join('\n'),
            'utf8',
        );
        await fs.writeFile(
            path.join(demoPipelineRoot, 'sql', 'demo.sql'),
            [
                'CREATE MATERIALIZED VIEW demo_orders AS',
                'SELECT * FROM VALUES',
                "    (1, 'Ada', 125.50),",
                "    (2, 'Grace', 89.00)",
                'AS orders(order_id, customer, amount);',
                '',
            ].join('\n'),
            'utf8',
        );
    }
    return { demoPipelineName, pipelineName, root };
}

function createCredentials() {
    const suffix = crypto.randomBytes(12).toString('hex');
    return {
        catalog: 'integration_catalog',
        clientId: 'root',
        clientSecret: `integration-client-${suffix}`,
        databasePassword: `integration-db-${suffix}`,
        namespace: 'integration',
        table: 'seed_events',
        webhookToken: `integration-webhook-${suffix}`,
    };
}

async function allocatePorts() {
    const [controlPlane, postgres, polaris, sparkConnect] = await Promise.all([
        availablePort(),
        availablePort(),
        availablePort(),
        availablePort(),
    ]);
    return { controlPlane, polaris, postgres, sparkConnect };
}

async function availablePort() {
    return await new Promise((resolve, reject) => {
        const server = net.createServer();
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const address = server.address();
            server.close(() => {
                if (address == null || typeof address === 'string') {
                    reject(new Error('Could not allocate an integration host port.'));
                    return;
                }
                resolve(address.port);
            });
        });
    });
}

function resolveDockerCli() {
    const candidates = [
        'C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe',
        'docker',
    ].filter(Boolean);
    const existing = candidates.find((candidate) => candidate === 'docker' || fsSync.existsSync(candidate));
    return existing ?? 'docker';
}

function runtimeEnvironment() {
    const names = new Set([
        'APPDATA',
        'ComSpec',
        'COMSPEC',
        'DOCKER_CONFIG',
        'DOCKER_DEFAULT_PLATFORM',
        'DOCKER_HOST',
        'HOME',
        'LOCALAPPDATA',
        'PATH',
        'Path',
        'PATHEXT',
        'ProgramFiles',
        'ProgramFiles(x86)',
        'SystemRoot',
        'TEMP',
        'TMP',
        'USERPROFILE',
        'WINDIR',
    ]);
    return Object.fromEntries(
        Object.entries(process.env).filter(([name]) => names.has(name)),
    );
}

function parseOptions(args) {
    const suiteIndex = args.indexOf('--suite');
    const suite = suiteIndex === -1 ? 'all' : args[suiteIndex + 1]?.trim();
    if (suite == null || !supportedSuites.has(suite)) {
        throw new Error(`--suite must be one of: ${[...supportedSuites].join(', ')}.`);
    }

    const sparkVersionIndex = args.indexOf('--spark-version');
    const sparkVersion = sparkVersionIndex === -1
        ? '4.1.2'
        : args[sparkVersionIndex + 1]?.trim();
    if (sparkVersion == null || !supportedSparkImageDigests.has(sparkVersion)) {
        throw new Error(`--spark-version must be one of: ${[...supportedSparkImageDigests.keys()].join(', ')}.`);
    }
    if (sparkVersionIndex !== -1 && !['all', 'polaris', 'spark'].includes(suite)) {
        throw new Error('--spark-version can only be used with all, polaris, or spark suites.');
    }
    return { sparkVersion, suite };
}

function redact(value) {
    return [
        credentials.clientSecret,
        credentials.databasePassword,
        credentials.webhookToken,
    ].filter(Boolean).reduce(
        (result, secret) => result.replaceAll(secret, '[REDACTED]'),
        value,
    );
}

function delay(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
