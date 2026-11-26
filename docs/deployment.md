# Spark Control Plane deployment

This release runs one Spark Control Plane container on a private network. The
container serves the built React UI and the standalone Node API. PostgreSQL,
the Spark Standalone cluster, the optional Spark History Server, and pipeline
storage remain external services. Pipeline runs and catalog or preview queries
submit their Spark applications to the existing Standalone master. The AIStor
notification endpoint requires the configured `AISTOR_WEBHOOK_TOKEN` as a
Bearer token; other API routes remain governed by
the deployment's existing network controls.

## Supported runtime pins

The production image pins these build inputs in `Dockerfile` and
`compose.yaml`:

- Node `24.19.0` on Debian Bookworm slim.
- Python `3.10.12` on Debian Bookworm slim, matching the Python minor version
  configured for the Control Plane driver and Spark executor workers.
- PySpark `4.2.0` with the official `pipelines` extra, which provides the
  `spark-pipelines` executable used by the control plane.
- Java runtime image selected by `JAVA_RUNTIME_IMAGE`; it defaults to Eclipse
  Temurin 21 JRE. Choose a version supported by the deployed Spark release.
- PostgreSQL `16.4` is the disposable local-development example; production
  PostgreSQL is user-managed and should be supported by the organization's
  backup and patch policy.

The [root README's compatibility matrix](../README.md#apache-spark-compatibility)
is the source for known-working Spark versions. This guide owns deployment
runtime pins and setup.

The image carries OCI title, description, version, source, and license labels.
Override `APP_VERSION`, `IMAGE_SOURCE`, and `IMAGE_LICENSES` at build time when
publishing from a release system with authoritative values; the default source
and license labels intentionally say `not-specified` and `UNLICENSED` rather
than inventing project metadata.

Docker Engine 24+ and Docker Compose v2.20+ are deployment prerequisites,
along with direct environment-injected TLS certificate values and the external
Spark distribution.

The Control Plane driver and Spark executor Python runtimes must use compatible
Python minor versions. `SPARK_EXECUTOR_PYTHON` selects the Python executable
on executor workers (default `python3`). The PySpark pin installs the CLI and
driver-side Spark runtime; Standalone workers must provide Spark 4.2 and the
dependencies required by pipeline code. See the
[pipeline execution contract](../src/server/pipeline/README.md#run-lifecycle).

## Prepare external services

1. Create a PostgreSQL database and least-privilege application role. Grant
   database `CONNECT` and schema `CREATE`/`USAGE` for the configured
   `POSTGRES_SCHEMA`; do not grant ownership of unrelated schemas or data.
2. Inject `POSTGRES_PASSWORD` directly into the application container
   environment. The application creates only its configured schema and
   migration-owned objects; it does not read secret or certificate files.
3. Inject `AISTOR_WEBHOOK_TOKEN` directly into the application container
   environment. Configure AIStor's webhook Auth Token field as
   `Bearer <same-token>`.
4. Set `SPARK_MASTER_URL` to the existing Standalone master (for example,
   `spark://spark-master.example:7077`) and `SPARK_DRIVER_HOST` to an address
   that all workers can reach. Each run starts its own Spark Connect server
   application through that master; the local `spark-pipelines` client connects
   to the server over loopback. Allow worker-to-driver Spark RPC and file-server
   traffic through the network firewall. Verify the Control Plane can reach
   the master and all nodes can access required distributed storage. With
   Docker, workers need a network route to the Control Plane container and its
   Spark ports; publishing the HTTP API port alone is not sufficient. Set
   `spark.driver.port` and `spark.blockManager.port`
   in a Spark properties file when the network requires a fixed port range.
5. Confirm that pipeline `storage` and checkpoint locations use a URI
   reachable by the Spark cluster, not a local path on the Control Plane container.
6. Mount the pipeline root read-only and ensure the mounted definitions are
   trusted code. Python discovery imports pipeline modules. The image leaves
   its runtime user unset, so Docker defaults to root inside the container.
   Ensure the host-path dataset ACL lets the container read and traverse the
   mounted path. Leave Compose `user` unset unless you intentionally need to
   override the default.

The PostgreSQL and Spark routes must be allowed by the private-network
firewall. When certificate verification is enabled, inject the PEM values
directly through `POSTGRES_SSLROOTCERT`, `POSTGRES_SSLCERT`, and
`POSTGRES_SSLKEY`. DNS names used by the container must resolve from inside
the container network.

## First startup

```powershell
$env:PIPELINES_HOST_PATH = 'C:\path\to\pipelines'
$env:SPARK_MASTER_URL = 'spark://spark-master.example:7077'
$env:SPARK_DRIVER_HOST = 'spark-control-plane.example'
# CONTROL_PLANE_PORT is the internal container listen port.
# CONTROL_PLANE_HOST_PORT is the host-published port.
# Add top-level timeout_seconds to a pipeline YAML file to set that pipeline's run limit.
# Omitting timeout_seconds leaves the run without an automatic time limit.
# The worker accepts one active run by default. See the operations guide for run policy.
# Set POSTGRES_HOST, POSTGRES_DATABASE, POSTGRES_USER, POSTGRES_PASSWORD,
# AISTOR_WEBHOOK_TOKEN and POSTGRES_SSLMODE; SPARK_HISTORY_URL is optional.
# Set SPARK_CLI_PROPERTIES_FILE when Spark applications need shared catalog or
# connector settings. Keep control-plane credentials in their environment
# variables.
docker compose -f compose.yaml build
docker compose -f compose.yaml up -d
docker compose -f compose.yaml ps
```

Startup applies ordered, checksummed PostgreSQL migrations. Verify the
application from outside the container:

```powershell
curl.exe http://127.0.0.1:8080/health
curl.exe http://127.0.0.1:8080/ready
curl.exe http://127.0.0.1:8080/api/v1/pipelines
curl.exe http://127.0.0.1:8080/openapi.json
```

Open [`http://127.0.0.1:8080/docs`](http://127.0.0.1:8080/docs) for the interactive Swagger UI. Its presentation
assets are loaded from the jsDelivr CDN; use `/openapi.json` directly when the deployment has no outbound browser
access.

Discover a pipeline UUID, deploy it, submit a run with an idempotency key, and
poll the `Location` run URL. The run remains bound to the deployed source hash.
Cancellation uses `POST /api/v1/runs/{runId}/cancel`.

## Upgrades, rollback, and shutdown

Build and tag each image from a clean checkout, then roll forward one image at
a time. A migration checksum mismatch stops startup. There are no destructive
down migrations; restore PostgreSQL from the organization's backup and recover
with a forward migration or a previously known-good image according to the
database change policy. Do not delete the application schema as a rollback
shortcut.

```powershell
docker build --tag registry.example/spark-control-plane:2026.08.13 .
docker compose -f compose.yaml pull
docker compose -f compose.yaml up -d
docker compose -f compose.yaml logs --tail=200 control-plane
docker compose -f compose.yaml stop
```

Push the immutable tag to the organization's registry only after the image
scan and acceptance checks pass; the compose file does not require a specific
registry.

`SIGTERM` and `SIGINT` enter the server's drain path. New submissions stop,
the in-container supervisor retains each pipeline client and its per-run Spark
Connect server while the local server monitor detaches, and queued work remains
in PostgreSQL. A replacement server process in the same live container inspects
the saved execution by run ID without submitting it again. A full SCP container
restart kills the client, server, and supervisor, so the Standalone application
stops or fails. If no terminal result was saved, SCP records `UNKNOWN`, includes
the recovered output tail, and does not resubmit. Inspect the Standalone master
UI for the application named `spark-control-plane-<runId>` before retrying an
unknown run. Monitor readiness,
queue age/depth, active runs, database growth, Spark connectivity, and lease
expiry. Collect stdout/stderr from the container runtime;
credentials and certificate private keys must never be passed as command-line
arguments or written into image layers.

## Local demo stack

`npm run demo:up` starts PostgreSQL, Spark Standalone, and the Control Plane
with the local settings in `compose.dev.yaml`. Compose supplies
`SPARK_MASTER_URL` and `SPARK_DRIVER_HOST` and mounts the checked-in
`examples/pipelines/` projects read-only. The command prints the dynamically
assigned loopback URLs for the Control Plane and Spark Master UI.
`npm run demo:down` removes the containers and preserves the named volumes
for PostgreSQL, local run state, and Spark data.

`CATALOG_BACKEND` selects the catalog hierarchy source for a standalone
deployment. It defaults to `polaris`; set it to `spark` when the catalog
configured for Spark applications owns the hierarchy and no Polaris metastore
is available.
