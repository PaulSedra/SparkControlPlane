# Pipeline discovery and execution

The pipeline module discovers mounted pipeline projects, builds registry
graphs, coordinates durable run requests, and adapts Spark CLI and preview
processes. PostgreSQL owns pipeline identity and run state; Spark Connect
executes workloads and provides bounded data previews.

## Module structure

| Area                          | Responsibility                                                                             |
|-------------------------------|--------------------------------------------------------------------------------------------|
| `pipelineRegistryService.ts`  | Composition root for registry services                                                     |
| `pipelineReadinessService.ts` | Discovery readiness, cached operational snapshots, refresh timer, and queue metrics        |
| `triggerRegistryService.ts`   | Registry-facing trigger CRUD, ingestion, schedule status, and queries                      |
| `discovery/`                  | Explicit source refresh, source resolution, YAML parsing, lineage, validation, and registry identity |
| `execution/`                  | Run policy, queue coordination, per-run execution, and successful-run handoff              |
| `spark/`                      | PySpark manifest, official CLI, local supervisor, logs, and dataset previews               |
| `pipelineNodeService.ts`      | Declared source reads and selected-node previews                                           |
| `mapWithConcurrency.ts`       | Ordered bounded mapping used by pipeline discovery, parsing, and snapshot staging          |

Within `execution/`, `pipelineRuntime.ts` owns pipeline-root path handling,
`runSubmission.ts` resolves successor pipelines, and
`runCoordinatorConfig.ts` loads queue, lease, and recovery settings.
`spark/pipelineManifestProcess.ts` owns the bounded Python manifest
subprocess.

Trigger delivery and event runtime behavior live in `src/server/triggers/`.
Catalog metadata and sampling adapters live in `src/server/catalog/`.

## Discovery and identity

Discovery recursively finds `resources/<name>.pipeline.yaml` below
`PIPELINES_DIR`. The project root is the parent of each specification's
`resources/` directory, so sibling source and resources directories belong to
one project. A resources directory can contain multiple specifications;
normalized YAML names are unique.

Source versions hash the executable YAML plus project-root-relative source
paths and contents. Control-plane fields `on_success`, `timeout_seconds`, and
`triggers` do not change the executable source hash. PostgreSQL owns immutable
UUID identity and normalized-name uniqueness, so rediscovery preserves a
pipeline UUID across folder moves.
`PIPELINE_DISCOVERY_CONCURRENCY` defaults to four and is capped at eight.

The pipeline folder is read only when the operator uses **Refresh all pipelines
from source** or calls `POST /api/v1/pipelines/refresh-from-source`. That action
parses the complete folder, stores the pipeline and source-file snapshots in
PostgreSQL, and retires definitions removed from the folder. Startup, registry
polling, source viewing, deployment, run submission, and execution use those
saved snapshots. File changes do not affect the active registry until the
operator refreshes from source.

`discovery/pipelineDiscovery.ts` orchestrates source loading, optional Python
manifest discovery, validation, lineage, and detail construction.
`pipelineSourceResolver.ts` locates specifications and resolves SQL/Python
library includes within the project root. `pipelineSpecParser.ts` converts
pipeline YAML into `PipelineSpec`; `yamlParser.ts` handles generic YAML syntax
and source-qualified root mappings. `yamlTriggerConfiguration.ts` handles
pipeline trigger shapes, mappings, and bindings. `pipelineSourceRefreshService.ts`
owns the explicit folder refresh, including retirement of missing pipelines.
`pipelineRegistryDiscovery.ts` combines parsed models with PostgreSQL identity
and YAML-trigger reconciliation. `pipelineParseCache.ts` owns input signatures,
lookups, and removed-spec eviction. `pipelineVersion.ts` owns source hashes and
display version labels.

YAML trigger `enabled` values provide the configured state when the source
folder is refreshed. Pause and Resume actions persist directly to the active
trigger definition in PostgreSQL and remain effective during normal reads and
polling. The next explicit source refresh replaces that state with the YAML
`enabled` value. Removing a YAML trigger marks its history inactive.

## Graph discovery

SQL library globs resolve to SQL and Python files. The local SQL parser
recognizes materialized views, streaming tables, temporary views, flows, and
`FROM`/`JOIN` dependencies. Its text-pattern lineage has low confidence. The
installed Spark Connect pipeline protocol defines SQL graph elements but does
not expose a compiled graph read-back command, so local SQL parsing supplies
pre-run UI lineage. URI inputs such as s3a locations are labeled external
sources, while external table references are labeled external tables.

Python discovery runs `spark/spark_pipeline_manifest.py` in the repository
`.venv`. It imports pipeline definitions under a recording PySpark
`GraphElementRegistry`, expanding dynamic registrations without a Spark
session. Importing mounted Python definitions executes their module code.

Append-flow registrations expose functions, names, targets, and source
locations, but not resolved inputs. The manifest extracts
`.read.table(...)` and `.readStream[...].table(...)` calls from registered
function source without invoking the functions, following directly called
helpers that share the flow module's globals. Extracted append-flow edges use
`PYTHON_SOURCE_PATTERN` evidence with low confidence. Auto CDC registrations
provide declared source and target datasets; their lineage uses
`SPARK_GRAPH_REGISTRATION` evidence. Literal table names and uppercase module
string constants are resolved; uncalled helpers, imported functions, methods,
and computed names are not.

`pipelineLineageParser.ts` combines SQL text-pattern lineage and Python
manifest registrations into the shared graph. `triggerValidation.ts` owns
pipeline-trigger validation. Python spec validation and control-plane metadata
stripping are shared through `spark/spark_pipeline_spec.py`.

## Run lifecycle

Run requests are persisted as `QUEUED` and claimed independently of HTTP. The
coordinator uses PostgreSQL leases, recovery, and a per-process
`PIPELINE_RUN_CONCURRENCY` limit (default one). Each submission captures its
`allowOverlap` policy: the default waits for active runs of the same pipeline;
`true` allows overlap subject to the process concurrency limit.

Before a CLI submission, execution loads the queued source version from
PostgreSQL, stages a run-specific copy under
`SPARK_CLI_STATE_DIRECTORY/runs/<runId>/source`, and verifies it against the
queued source hash. The official `spark-pipelines` CLI receives the copied
specification and configured `SPARK_CONNECT_URL`. The installed
`pyspark[pipelines]==4.2.0` runtime provides the CLI. Spark Connect is deployed
separately; features requiring server-side Spark 4.2 use a 4.2 Spark Connect
server. Full refresh uses `--full-refresh-all`; selected nodes and repairs
resolve graph selections to qualified output datasets before using `--refresh`
or `--full-refresh`. A selected flow expands through outgoing edges and shared
datasets are deduplicated. The local supervisor owns one CLI process per run ID
and stores process state and output in the same container.

A pipeline may set the top-level YAML field `timeout_seconds` to an integer
from 1 through 604800. The local supervisor enforces that deadline for the
submitted run. When the field is omitted, it waits for the CLI without a
deadline; there is no default run timeout. The field is SCP metadata and is
stripped before PySpark validates the specification.

The server records the local CLI execution ID before starting the CLI. After a
TypeScript server-process restart within the same container, the replacement
process inspects that supervisor record by run ID instead of submitting a
second CLI run. A full container restart stops the supervisor and CLI. If no
terminal result can be verified, the persisted run becomes `UNKNOWN`; confirmed
node outcomes and recovered output are retained, and the run is not resubmitted
automatically. Queued runs remain eligible.

Expired leases with a local CLI identity are inspected by run ID without a
second submission. Expired or missing leases without an execution identity are
failed as abandoned before execution.

`runStatusParser.ts` projects lifecycle events from appended log lines. The
publisher drains remaining supervisor output and persists the final node
projection before the terminal run state. Confirmed node outcomes are kept;
unfinished nodes become `CANCELED` for canceled runs and `FAILED` for failed or
timed-out runs. Quoted flow names are correlated after removing a matching
pair of outer quotes. A retry after a terminal event starts a new attempt.

## Successful-run handoff

`on_success.pipeline` names a successor pipeline and resolves to a stable ID at
submission. The parent run and dependency row are persisted in one
transaction. A successful non-dry-run transition makes the dependency `READY`
in the terminal-state transaction; failure, cancellation, timeout, unknown
outcome, and lease recovery make it `SKIPPED`. The dispatcher retries ready
rows after startup, submits through the normal managed-run path with an
idempotency key derived from parent run and target IDs, and records the child
run ID for recovery across dispatcher restarts.

## Preview and history behavior

Spark Connect previews quote multipart identifiers and return at most 100
rows. `SPARK_HISTORY_URL` configures the historical Spark application proxy; it
does not provide pipeline run records or replace `SPARK_CONNECT_URL`.
`spark/sparkNodePreview.ts` owns execution of selected-node previews.

## Adapter contracts

| Adapter                        | Input and runtime                                                      | Output and purpose                                                                          |
|--------------------------------|------------------------------------------------------------------------|---------------------------------------------------------------------------------------------|
| `spark_pipeline_spec.py`       | PySpark spec path, installed PyYAML and PySpark                        | Removes control-plane-owned `on_success`, `timeout_seconds`, and `triggers` before delegating validation and decoding to PySpark |
| `spark_pipeline_cli.py`        | Spark Pipelines CLI arguments and installed PySpark                    | Installs trigger handling on the official CLI module and invokes its entry point            |
| `spark_pipeline_manifest.py`   | Spec path, repository `.venv`, local PySpark, no Spark session         | One JSON document describing registered Python outputs and flows                            |
| `spark_connect_sample_data.py` | Qualified dataset and optional limit, configured Spark Connect session | One JSON document with columns and rows, capped at 100 rows                                 |
| `sparkCliProcess.ts`           | Spec, mode, Connect URL, and selected targets                          | Builds the official CLI invocation and resumes monitoring through the local supervisor      |
| `spark_cli_supervisor.py`      | CLI arguments, run ID, state directory, and working directory          | Owns the local CLI child and persists atomic state, stdout, and stderr                      |

The manifest helper has a configurable timeout and output limit. The supervisor
stores logs and state under `SPARK_CLI_STATE_DIRECTORY`; source snapshots
remain available while the supervisor may still use them.
