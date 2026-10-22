/**
 * @fileoverview Contract checks against the assembled container application.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '../../..');

test('Compose forwards direct runtime, policy, TLS, and port configuration', async () => {
    const compose = await fs.readFile(path.join(root, 'compose.yaml'), 'utf8');
    for (const required of [
        'CONTROL_PLANE_PORT: ${CONTROL_PLANE_PORT:-8080}',
        'CONTROL_PLANE_HOST_PORT:-8080',
        'CONTROL_PLANE_DRAIN_SECONDS',
        'AISTOR_WEBHOOK_TOKEN: ${AISTOR_WEBHOOK_TOKEN:?Set AISTOR_WEBHOOK_TOKEN in the caller environment}',
        'PIPELINE_RUN_LEASE_SECONDS',
        'PIPELINE_RUN_POLICIES',
        'PYSPARK_PYTHON: /usr/local/bin/python',
        'PYSPARK_DRIVER_PYTHON: /usr/local/bin/python',
        'POSTGRES_SSLROOTCERT',
        'POSTGRES_SSLCERT',
        'POSTGRES_SSLKEY',
    'SPARK_CONNECT_URL: ${SPARK_CONNECT_URL:?Set SPARK_CONNECT_URL in the caller environment}',
    'SPARK_HISTORY_URL: ${SPARK_HISTORY_URL:-}',
        'SPARK_CLI_BINARY: ${SPARK_CLI_BINARY:-spark-pipelines}',
        'SPARK_CLI_PYTHON: ${SPARK_CLI_PYTHON:-/usr/local/bin/python}',
        'SPARK_CLI_PROPERTIES_FILE: ${SPARK_CLI_PROPERTIES_FILE:-}',
        'SPARK_CLI_STATE_DIRECTORY: ${SPARK_CLI_STATE_DIRECTORY:-/app/run-state}',
        'target: /app/pipelines',
    ]) {
        assert.ok(compose.includes(required), `compose.yaml must contain ${required}`);
    }
    assert.doesNotMatch(compose, /env_file:|secrets:/);
  assert.doesNotMatch(compose, /SPARK_REMOTE|SPARK_CONNECT_REMOTE|SPARK_API_PROXY_TARGET|SPARK_CLI_SSH/);
});

test('local demo starts PostgreSQL, Spark, and SCP with checked-in default-catalog pipelines', async () => {
    const compose = await fs.readFile(path.join(root, 'compose.dev.yaml'), 'utf8');
    const packageJson = JSON.parse(
        await fs.readFile(path.join(root, 'package.json'), 'utf8'),
    ) as { scripts?: Record<string, string> };
    const sqlSpec = await fs.readFile(
        path.join(root, 'examples', 'pipelines', 'getting-started-sql-pipeline', 'resources', 'getting-started.pipeline.yaml'),
        'utf8',
    );
    const pythonSpec = await fs.readFile(
        path.join(root, 'examples', 'pipelines', 'getting-started-python-pipeline', 'resources', 'python-example.pipeline.yaml'),
        'utf8',
    );

    for (const required of [
        'name: spark-control-plane-demo',
        '  postgres:',
        '  spark-connect:',
        '  control-plane:',
        'image: apache/spark:4.2.0-python3',
        'CATALOG_BACKEND: spark',
        'AISTOR_WEBHOOK_TOKEN: local-development-only',
        'POSTGRES_HOST: postgres',
        'SPARK_CONNECT_URL: sc://spark-connect:15002',
        'source: ./examples/pipelines',
        '127.0.0.1::8080',
        'spark.sql.catalogImplementation=in-memory',
        'spark.sql.defaultCatalog=spark_catalog',
    ]) {
        assert.ok(compose.includes(required), `compose.dev.yaml must contain ${required}`);
    }
    assert.doesNotMatch(compose, /\$\{[^}]+:\?/);
    assert.equal(
        packageJson.scripts?.['demo:up'],
        'docker compose --file compose.dev.yaml up --detach --build --wait && docker compose --file compose.dev.yaml port control-plane 8080',
    );
    assert.equal(
        packageJson.scripts?.['demo:down'],
        'docker compose --file compose.dev.yaml down',
    );
    assert.match(sqlSpec, /catalog: spark_catalog/);
    assert.match(sqlSpec, /database: default/);
    assert.match(pythonSpec, /catalog: spark_catalog/);
    assert.match(pythonSpec, /database: default/);
});

test('CI and runtime image install Spark from shared pinned requirements', async () => {
    const dockerfile = await fs.readFile(path.join(root, 'Dockerfile'), 'utf8');
    const compose = await fs.readFile(path.join(root, 'compose.yaml'), 'utf8');
    const devCompose = await fs.readFile(path.join(root, 'compose.dev.yaml'), 'utf8');
    const requirements = await fs.readFile(path.join(root, 'requirements.txt'), 'utf8');
    const workflow = await fs.readFile(
        path.join(root, '.github', 'workflows', 'ci.yml'),
        'utf8',
    );
    assert.match(dockerfile, /COPY requirements\.txt \/tmp\/requirements\.txt/);
    assert.match(
        dockerfile,
        /pip install --no-cache-dir --disable-pip-version-check -r \/tmp\/requirements\.txt/,
    );
    assert.match(
        workflow,
        /python -m pip install --disable-pip-version-check --no-cache-dir -r requirements\.txt/,
    );
    for (const required of [
        'pyspark[pipelines]==4.2.0',
        'pandas==2.3.3',
        'pyarrow==20.0.0',
        'grpcio==1.76.0',
        'grpcio-status==1.76.0',
        'googleapis-common-protos==1.72.0',
        'zstandard==0.25.0',
    ]) {
        assert.ok(requirements.split(/\r?\n/).includes(required));
    }
    assert.doesNotMatch(dockerfile, /PYSPARK_VERSION/);
    assert.doesNotMatch(compose, /PYSPARK_VERSION/);
    assert.doesNotMatch(devCompose, /PYSPARK_VERSION/);
    assert.doesNotMatch(dockerfile, /openssh-client|spark_pipeline_run\.py|spark_pipeline_cli\.py/);
});

test('integration Compose owns pinned PostgreSQL, Polaris, Spark, and control-plane services', async () => {
    const compose = await fs.readFile(path.join(root, 'compose.integration.yaml'), 'utf8');
    const sparkDockerfile = await fs.readFile(
        path.join(root, 'docker', 'integration', 'spark', 'Dockerfile'),
        'utf8',
    );
    const sparkStartupScript = await fs.readFile(
        path.join(root, 'docker', 'integration', 'spark', 'start-connect-server.sh'),
        'utf8',
    );
    for (const required of [
        'postgres:16.4-bookworm@sha256:',
        'apache/polaris:1.7.0@sha256:',
        'apache/polaris-admin-tool:1.7.0@sha256:',
        'INTEGRATION_SPARK_IMAGE',
        'polaris-bootstrap:',
        'spark-connect:',
        'SPARK_CONNECT_URL: sc://spark-connect:15002',
        'POSTGRES_SSLMODE: disable',
        'condition: service_completed_successfully',
        'INTEGRATION_PIPELINES_PATH',
        'name: ${INTEGRATION_NETWORK_NAME:',
    ]) {
        assert.ok(compose.includes(required), `compose.integration.yaml must contain ${required}`);
    }
    assert.doesNotMatch(compose, /PYSPARK_VERSION/);
    assert.match(sparkDockerfile, /^ARG SPARK_BASE_IMAGE$/m);
    assert.match(sparkDockerfile, /^FROM \$\{SPARK_BASE_IMAGE\}$/m);
    assert.doesNotMatch(sparkDockerfile, /^ARG SPARK_BASE_IMAGE=/m);
    assert.match(sparkStartupScript, /iceberg-spark-runtime-4\.1_2\.13:1\.11\.0/);
    assert.match(sparkStartupScript, /spark\.sql\.catalogImplementation=in-memory/);
    assert.match(sparkStartupScript, /spark\.sql\.defaultCatalog=spark_catalog/);
    assert.match(sparkDockerfile, /pandas==2\.3\.3/);
    assert.match(sparkDockerfile, /pyarrow==20\.0\.0/);
    assert.match(sparkDockerfile, /grpcio==1\.76\.0/);
    assert.match(sparkDockerfile, /grpcio-status==1\.76\.0/);
    const polarisSeed = await fs.readFile(
        path.join(root, 'tests', 'integration', 'support', 'seed-polaris-integration.mjs'),
        'utf8',
    );
    assert.match(polarisSeed, /CATALOG_MANAGE_CONTENT/);
    assert.match(polarisSeed, /principal-roles\/service_admin\/catalog-roles/);
    const integrationRunner = await fs.readFile(
        path.join(root, 'tests', 'integration', 'run-integration-stack.mjs'),
        'utf8',
    );
    assert.match(integrationRunner, /storage: file:\/\/\/tmp\/spark-control-plane-integration-checkpoints/);
    assert.doesNotMatch(compose, /:latest(?:\s|$)/);
    assert.doesNotMatch(compose, /env_file:|secrets:/);
});

test('managed test entry points do not load dotenv files', async () => {
    const packageJson = await fs.readFile(path.join(root, 'package.json'), 'utf8');
    const scripts = await Promise.all([
        fs.readFile(path.join(root, 'tests', 'integration', 'run-integration-stack.mjs'), 'utf8'),
        fs.readFile(path.join(root, 'tests', 'integration', 'run-container-tests.mjs'), 'utf8'),
        fs.readFile(path.join(root, 'tests', 'integration', 'run-image-upgrade-check.mjs'), 'utf8'),
    ]);
    assert.doesNotMatch(packageJson, /env-file-if-exists|env-file=/);
    for (const script of scripts) {
        assert.doesNotMatch(script, /env-file-if-exists|env-file=/);
    }
});

test('Docker healthcheck follows the configured internal port without credential files', async () => {
    const dockerfile = await fs.readFile(path.join(root, 'Dockerfile'), 'utf8');
    const healthcheck = await fs.readFile(
        path.join(root, 'docker', 'control-plane-healthcheck.mjs'),
        'utf8',
    );
    assert.match(dockerfile, /docker\/control-plane-healthcheck\.mjs/);
    assert.match(dockerfile, /COPY docker\/control-plane-healthcheck\.mjs/);
    assert.match(healthcheck, /CONTROL_PLANE_PORT/);
    assert.match(dockerfile, /org\.opencontainers\.image\.title/);
    assert.match(dockerfile, /org\.opencontainers\.image\.source/);
    assert.match(dockerfile, /PYSPARK_PYTHON=\/usr\/local\/bin\/python/);
    assert.match(dockerfile, /PYSPARK_DRIVER_PYTHON=\/usr\/local\/bin\/python/);
    assert.doesNotMatch(dockerfile, /POSTGRES_PASSWORD|_FILE|secret/i);
});

test('container runner passes its forced internal port environment to docker run', async () => {
    const runner = await fs.readFile(
        path.join(root, 'tests', 'integration', 'run-container-tests.mjs'),
        'utf8',
    );
    assert.match(runner, /CONTROL_PLANE_PORT:\s*'8080'/);
    assert.match(runner, /'AISTOR_WEBHOOK_TOKEN'/);
    assert.match(runner, /'POSTGRES_PORT'/);
    assert.match(runner, /'POSTGRES_SSLMODE'/);
    assert.match(runner, /'SPARK_CONNECT_URL'/);
    assert.match(runner, /'SPARK_CLI_BINARY'/);
    assert.match(runner, /'SPARK_CLI_PYTHON'/);
    assert.match(runner, /'SPARK_CLI_PROPERTIES_FILE'/);
    assert.match(runner, /'SPARK_CLI_STATE_DIRECTORY'/);
    assert.match(runner, /PIPELINE_RUN_LEASE_SECONDS:\s*'5'/);
    assert.match(runner, /'SPARK_HISTORY_URL'/);
    assert.doesNotMatch(runner, /SPARK_REMOTE|SPARK_CONNECT_REMOTE|SPARK_API_PROXY_TARGET/);
    assert.doesNotMatch(runner, /PIPELINE_EXECUTION_WORKER_SCRIPT|FAKE_SPARK_STATE_DIRECTORY|SPARK_CLI_SSH/);
    assert.match(runner, /runDocker\(\[\s*'run'/);
    assert.match(runner, /network: options\.network/);
});

test('container acceptance isolates PostgreSQL state in a temporary schema', async () => {
    const runner = await fs.readFile(
        path.join(root, 'tests', 'integration', 'run-container-tests.mjs'),
        'utf8',
    );
    assert.match(runner, /POSTGRES_SCHEMA:\s*acceptanceSchema/);
    assert.match(runner, /'--container-postgres-host'/);
    assert.match(runner, /'--container-postgres-port'/);
    assert.match(runner, /'--container-spark-connect-url'/);
    assert.match(runner, /await dropAcceptanceSchema\(\)/);
    assert.match(runner, /DROP SCHEMA IF EXISTS/);
});

test('managed integration tests do not expose test-only environment switches', async () => {
    const sourcePaths = [
        'tests/integration/run-container-tests.mjs',
        'tests/integration/run-image-upgrade-check.mjs',
        'tests/integration/run-integration-stack.mjs',
        'tests/integration/container/containerAcceptance.test.mjs',
        'tests/integration/container/containerArtifact.test.mjs',
        'tests/integration/container/containerLifecycle.test.mjs',
        'tests/integration/polaris/polarisCatalog.test.ts',
        'tests/integration/spark/liveSpark.test.ts',
        'tests/support/postgresTestSupport.ts',
    ];
    const sources = await Promise.all(sourcePaths.map((sourcePath) =>
        fs.readFile(path.join(root, sourcePath), 'utf8')));
    const forbiddenNames = [
        ['CONTAINER', 'ACCEPTANCE', 'FIXTURE'],
        ['POSTGRES', 'TEST', 'MODE'],
        ['SPARK', 'ACCEPTANCE'],
        ['SPARK', 'ACCEPTANCE', 'BASE', 'URL'],
        ['SPARK', 'ACCEPTANCE', 'PIPELINE', 'NAME'],
        ['SPARK', 'ACCEPTANCE', 'EXPECTED', 'NODE'],
        ['SPARK', 'ACCEPTANCE', 'TIMEOUT', 'SECONDS'],
        ['CONTAINER', 'ACCEPTANCE', 'IMAGE'],
        ['CONTAINER', 'ACCEPTANCE', 'PREVIOUS', 'IMAGE'],
        ['DOCKER', 'CLI'],
        ['POSTGRES', 'CLEANUP', 'HOST'],
        ['CONTAINER', 'POSTGRES', 'HOST'],
        ['CONTAINER', 'POSTGRES', 'PORT'],
        ['CONTAINER', 'SPARK', 'CONNECT', 'URL'],
        ['POLARIS', 'ACCEPTANCE'],
        ['POLARIS', 'ACCEPTANCE', 'BASE', 'URL'],
    ].map((parts) => parts.join('_'));
    for (const source of sources) {
        for (const forbiddenName of forbiddenNames) {
            assert.doesNotMatch(source, new RegExp(forbiddenName), forbiddenName);
        }
    }
});
