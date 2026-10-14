# Spark Control Plane operations

This runbook covers the standalone server and its external PostgreSQL and
Spark services. PostgreSQL is authoritative for control-plane state; mounted
pipeline files and Spark-managed storage remain external.

## Startup and readiness

Inject PostgreSQL and Spark settings directly into the process environment:

```powershell
$env:PIPELINES_DIR = 'C:\path\to\pipelines'
$env:SPARK_CONNECT_URL = 'sc://spark-connect.example:15002'
$env:POSTGRES_HOST = 'postgres.example'
$env:POSTGRES_PORT = '5432'
$env:POSTGRES_DATABASE = 'spark_control_plane'
$env:POSTGRES_USER = 'spark_control_plane'
$env:POSTGRES_PASSWORD = '<provided by the runtime>'
$env:POSTGRES_SSLMODE = 'verify-full'
# If Polaris is a separate database on the same host and role:
$env:POLARIS_POSTGRES_DATABASE = 'polaris'
$env:POLARIS_POSTGRES_SCHEMA = 'polaris_schema'
npm run start:server
```

The application does not load dotenv files or read credential/certificate
files. Certificates, when required, are direct PEM-valued environment
variables. Startup creates or upgrades only the configured application schema,
then reconciles expired worker leases.

Catalog discovery reads `polaris_schema.entities` with the configured
`POLARIS_REALM` (default `POLARIS`). `POLARIS_POSTGRES_HOST`, `PORT`, `USER`,
`PASSWORD`, and TLS values override the corresponding `POSTGRES_*` connection
values when Polaris is on a separate PostgreSQL server. The catalog adapter is
read-only; it does not run Polaris migrations or write metastore state.

Check liveness and readiness separately:

```powershell
curl.exe http://127.0.0.1:8080/health
curl.exe http://127.0.0.1:8080/ready
curl.exe http://127.0.0.1:8080/metrics
```

`/health` reports process liveness. `/ready` is HTTP 503 when PostgreSQL is
not ready, discovery fails, shutdown has started, the worker is stopping, or
stuck active runs are detected. The response includes queue depth, active run
count, and stuck-run count.

## Queue, concurrency, and resources

Runs for a pipeline are FIFO and only one run may be `SUBMITTING` or `RUNNING`
at a time. Runs for different pipelines are claimed and launched concurrently;
the Control Plane has no global run-concurrency limit, so Spark handles cluster
resource scheduling. The legacy `allowOverlap` setting is accepted for
configuration compatibility but ignored; all runs are serialized per pipeline.
`PIPELINE_RUN_LEASE_SECONDS` defaults to 30 seconds and controls PostgreSQL
worker ownership heartbeats. Expired leases are reconciled continuously; the
interval defaults to one-third of the lease and can be overridden with
`PIPELINE_RUN_RECOVERY_INTERVAL_SECONDS` (1 second through 24 hours).
`PIPELINE_RUN_RECOVERY_BATCH_SIZE` bounds one recovery pass and defaults to 100.
The service does not retry failed or recovered runs automatically.

Set an optional per-pipeline timeout in the top-level `timeout_seconds` YAML
field:

```yaml
name: example_pipeline
storage: s3a://example-bucket/checkpoints/example_pipeline
timeout_seconds: 7200
```

The value must be an integer from 1 through 604800. If omitted, SCP does not
apply a run timeout or cancel the CLI automatically. A configured deadline is
captured on each submitted run and enforced by its local CLI supervisor. This
control-plane field is stripped before PySpark validation and does not change
the executable source hash, so editing it does not require redeploying the
Spark source. Timeout settings in `PIPELINE_RUN_POLICIES` and the former global
`PIPELINE_RUN_TIMEOUT_SECONDS` environment setting are no longer supported.

## Success dependencies

A pipeline spec can name one successor to submit after a successful run:

```yaml
on_success:
  pipeline: downstream_pipeline
```

The value must match a discovered pipeline name. The API exposes this setting
as `spec.onSuccess.pipeline`. This control-plane metadata is excluded from the
executable source hash, so changing the successor does not require redeploying
the Spark source. PySpark's CLI adapter removes `on_success` before loading the
spec.

SCP stores the handoff with the parent run. Only a terminal `SUCCEEDED` run can
make it ready; failed, canceled, timed-out, unknown, and dry-run outcomes skip
it. A durable dispatcher retries ready handoffs after restarts and uses a
stable parent-run/target-pipeline idempotency key, so it creates at most one
child run. The child uses the target pipeline's normal run policy, including
its `allowOverlap` setting. This schedules a run only; it does not alter
pipeline storage or checkpoint locations.

The container distinguishes `CONTROL_PLANE_PORT` (the internal listener) from
Compose's `CONTROL_PLANE_HOST_PORT` (the host-published port). `PIPELINES_DIR`
is the container path; `PIPELINES_HOST_PATH` is only the Compose bind source.

Starting recommendations for one control-plane instance are:

| Resource                 |          Starting point | Operational constraint                                               |
|--------------------------|------------------------:|----------------------------------------------------------------------|
| CPU                      |                  2 vCPU | Reserve one execution slot's orchestration overhead.                 |
| Memory                   |                   2 GiB | The control plane does not own Spark executor memory.                |
| Local process count      | One per active pipeline | Size the host for the number of pipelines that may run concurrently. |
| File descriptors/handles |                    1024 | Raise before increasing concurrency or concurrent monitoring calls.  |
| Pipeline mount           |               Read-only | Discovery imports trusted Python definitions.                        |

Measure queue age, active runs, completion counters, timeout/cancellation
counters, Spark start failures, run duration, and queue wait duration from
`/metrics`. Because there is no global admission cap, size and monitor Spark,
PostgreSQL, host process, memory, and file-descriptor capacity explicitly.
The metric catalog, process-local lifecycle, and exact Prometheus text format
are documented in [`src/server/observability/README.md`](../src/server/observability/README.md).

## Cancellation and shutdown

`POST /api/v1/runs/{runId}/cancel` records queued cancellation transactionally
or requests cancellation for an active run. The local supervisor receives the
request and sends `SIGINT` to the official CLI process group. The CLI uses the
configured `SPARK_CONNECT_URL` to communicate with Spark Connect. The process
receives `SPARK_CONTROL_PLANE_RUN_ID` for log correlation.

`SIGTERM` and `SIGINT` stop new submissions and drain local monitors for
`CONTROL_PLANE_DRAIN_SECONDS`. A monitor detaches without canceling the CLI;
the supervisor and CLI remain in SCP's existing container. If a replacement
server process starts while that container remains alive, it reads the saved
CLI state and resumes monitoring without another submission. A full SCP
container restart kills both processes. A Docker restart keeps that container's
writable layer, including `/app/run-state`; replacing the container does not
keep that directory unless it is mounted or otherwise persisted. After the
lease expires, SCP reads the last saved terminal state if one exists. If the
CLI had still been active, or its local record is missing, SCP writes terminal
status `UNKNOWN`, records the reason and any available output tail, and does
not submit the pipeline again. Spark may or may not have continued the
operation after the CLI was killed.

Queued PostgreSQL rows remain available to the next healthy server process.
An expired active row without a saved local CLI identity is failed as an
abandoned run before execution. Rows left by the former Spark Connect worker
without a local CLI record are marked `UNKNOWN` once their lease expires
because the current CLI cannot inspect those operations. Each receives one
matching `UNKNOWN` diagnostic event and `RUN_OUTCOME_UNKNOWN` audit row.
Investigate any nonzero `stuckRuns` before declaring readiness. During a
mixed-version rollout, drain old workers before starting workers that depend
on the new lifecycle-diagnostic columns.

## Trigger operations and recovery

### Trigger configuration in pipeline YAML

Keep trigger definitions directly in each pipeline spec:
`resources/<name>.pipeline.yaml`. The control plane parses the top-level
`triggers` sequence and reconciles it into PostgreSQL. Before invoking PySpark,
the control-plane adapters remove `triggers` and `on_success` from the
in-memory spec because the installed loader rejects unknown top-level fields.

```yaml
triggers:
  - name: nightly-orders
    mode: incremental
    schedule:
      cron: "0 2 * * *"
      timezone_id: America/New_York
      pause_status: UNPAUSED

  - name: incoming-orders
    trigger:
      pause_status: UNPAUSED
      file_arrival:
        url: s3://lake/incoming/orders/
        wait_after_last_change_seconds: 5
        event_names:
          - s3:ObjectCreated:Put

  - name: warehouse-orders
    trigger:
      webhook:
        source: warehouse
        event_type: order.created
        attributes:
          tenant: north
```

Each entry needs a stable `name` and exactly one trigger shape. Optional
`mode`, `node_names`, and `caller_metadata` map to ordinary run-submission
parameters. `pause_status: PAUSED` disables the trigger; `UNPAUSED` enables it.
The YAML schedule uses the control plane's five-field cron grammar and
`timezone_id` must be an IANA time-zone name. File-arrival `url` values must be
`s3://` or `aistor://` URLs; `urls` accepts a non-empty list of those locations.
Each bucket and decoded path becomes an AIStor bucket/prefix rule, and all
locations under one trigger share its debounce window. `wait_after_last_change_seconds`
becomes the debounce window. Quartz expressions and unsupported cooldown fields
are rejected.

Use `urls` when several file or directory prefixes should wake the same run:

```yaml
file_arrival:
  urls:
    - s3://lake/incoming/orders/
    - s3://lake/incoming/customers/
  wait_after_last_change_seconds: 60
```

YAML changes are picked up at startup and before scheduler, event-ingestion,
and trigger-administration operations. A YAML-owned trigger keeps its ID when
edited. Removing it disables the record but retains delivery and dead-letter
history. API-created triggers are not managed by YAML. Trigger YAML changes do
not change the executable pipeline source hash and therefore do not require a
pipeline redeploy.

Trigger definitions are additive to normal pipeline runs. A schedule uses the
five-field cron form `minute hour day-of-month month day-of-week` and an IANA
time-zone name. Numeric values, `*`, lists, ranges, and steps are supported;
unsupported expressions are rejected. If both calendar fields are restricted,
the conventional cron OR rule applies. A local time skipped by a daylight-saving
transition produces no occurrence. After downtime, the `CATCH_UP_ONCE` policy
submits only the latest missed occurrence and then resumes the current schedule.

Generic webhook events use one canonical JSON object with these required fields:
`eventId`, `eventType`, `source`, `occurredAt`, `attributes`, `payload`, and
`deduplicationKey`. `attributes` is a string-valued object used by exact routing
selectors. The event and delivery records are deduplicated by
`deduplicationKey`; a retry does not create a second run.

AIStor notifications are accepted at `POST /api/v1/triggers/aistor/events` as
an S3-compatible `Records[]` body and require
`Authorization: Bearer <AISTOR_WEBHOOK_TOKEN>`. Each record reads `eventName`,
`s3.bucket.name`, and `s3.object.key`; the object key is decoded once using
`unquote_plus` semantics before exact bucket/prefix matching. Optional provider
identity fields improve deduplication, and the original record remains in the
canonical payload. This adapter is owned by the control plane and has no runtime
dependency on the sibling reference receiver.

Routing records exact source/event selectors and file bucket/prefix selectors.
File-arrival debounce defaults to five seconds and is bounded at five minutes;
the latest event for each trigger's configured location group is delivered and
earlier events are recorded as debounced. Separate trigger definitions retain
separate debounce groups. Routing decisions, delivery attempts, and event
status are retained in PostgreSQL for diagnosis.

A dead letter is a durable record created only when a matched trigger delivery
cannot submit its ordinary pipeline run. It contains the original normalized
event, trigger ID, failure reason, status, and replay count. Operators can use
`GET /api/v1/triggers/dead-letters?status=PENDING` to inspect it. `POST
/api/v1/triggers/dead-letters/{id}/replay` increments the replay count and sends
the unchanged event through the normal run-submission path with the same
idempotency key. A successful replay marks the record `REPLAYED`; a retry that
fails leaves it `PENDING`. `POST
/api/v1/triggers/dead-letters/{id}/discard` records a `DISCARDED` delivery
attempt and creates no run. Replay and discard are only valid for pending
records.

## History export

`GET /api/v1/history/export` returns bounded batches from PostgreSQL's
`run_events` and `audit_events` tables. Run rows are exposed as
`pipelineRunHistory`; audit rows are exposed as `auditHistory`. Each row carries
its source event ID, identity, event type, payload, correlation/request source,
and occurrence timestamp. The response's independent `nextCursor.runEventId`
and `nextCursor.auditEventId` values are sent back as `runEventId` and
`auditEventId` on the next request.

Downstream Delta or Iceberg writers should upsert by the source event ID and
commit the cursor only after the corresponding batch is durable. Repeating a
request after interruption is therefore safe, while PostgreSQL remains the
authority for execution, trigger recovery, and audit decisions. The export API
does not delete source history or make downstream storage authoritative.

## PostgreSQL backup, growth, and manual archival

Back up the configured schema with the organization's normal PostgreSQL backup
policy. Verify restore into an isolated database before upgrades. Migrations
are checksummed and forward-only; never edit an applied migration or drop the
application schema as a rollback shortcut.

Monitor these application-owned tables and indexes for growth:

- `runs`, `run_events`, `run_node_states`, and `audit_events`;
- `trigger_definitions`, `trigger_events`, `trigger_delivery_attempts`, and
  `trigger_dead_letters`;
- `source_versions`, `pipeline_deployments`, and `idempotency_keys`;
- `runs_queue_order_idx`, `runs_pipeline_history_idx`,
  `run_events_run_order_idx`, and `audit_events_time_idx`.

History is retained by default. Automatic deletion is not enabled. If policy
requires archival, take a verified backup, define a retention cutoff, export
the selected rows to operator-owned archival storage, obtain change approval,
and delete only rows owned by the configured control-plane schema in a reviewed
transaction. Preserve referential order and migration metadata. There is no
application command that silently archives or deletes history.

## Diagnostics

Structured JSON logs contain event, correlation, request-source, run, and
pipeline identifiers. Output, commands, environment-derived secrets, bearer
tokens, and PEM blocks are sanitized before logs or API responses. Search logs
by `correlationId` first, then inspect the corresponding run events and audit
rows in PostgreSQL.

For a failed run, retain the status distinction (`FAILED`, `CANCELED`, or
`TIMED_OUT`), exit code, sanitized stderr/stdout, source hash, and event order.
Do not paste PostgreSQL passwords, certificate keys, full environment dumps, or
untrusted pipeline source into issue reports.

## Verification boundaries

See the [test guide](../tests/README.md) for local checks and the
[managed integration guide](../tests/integration/README.md) for Docker-backed
suite commands and boundaries. Follow the mandatory
[development workflow](../.codex/skills/development-workflow/SKILL.md) for the
required validation sequence and application-container refresh.
