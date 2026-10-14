# PostgreSQL persistence

PostgreSQL is the authoritative store for control-plane identity, deployment,
queue, run, cancellation, lease, and audit state. Spark-managed storage and
streaming checkpoints remain owned by Spark and the pipeline definitions.

## Runtime configuration

The standalone server reads connection settings directly from the process
environment. It does not load dotenv files, read password files, or read
certificate files. The supported settings are:

- `POSTGRES_HOST`, `POSTGRES_PORT`, `POSTGRES_DATABASE`, and
  `POSTGRES_USER`.
- `POSTGRES_PASSWORD`.
- `POSTGRES_SCHEMA`, defaulting to `public`.
- `POSTGRES_SSLMODE`: `disable`, `require`, `verify-ca`, or `verify-full`.
- `POSTGRES_SSLROOTCERT` when verification is enabled, plus the optional
  `POSTGRES_SSLCERT` and `POSTGRES_SSLKEY`. These variables contain direct PEM
  values, not paths.

`POSTGRES_PASSWORD_FILE`, `POSTGRES_*_FILE`, and other file-based credential
settings are rejected at startup so a deployment cannot silently switch to a
different secret source.

The schema name is restricted to a lowercase PostgreSQL identifier. By
default, the application creates its migration ledger and tables in PostgreSQL's
`public` schema. Set `POSTGRES_SCHEMA` to a dedicated schema when deployments
need to isolate control-plane objects. The application needs database
`CONNECT` and schema `CREATE`/`USAGE` privileges; it does not create databases,
roles, extensions, or objects outside the configured schema. A deployment
should use `require`, `verify-ca`, or
`verify-full`; `disable` is intended only for an explicitly trusted test
network.

## Migration ownership

Migrations live in `src/server/persistence/migrations/` and run during controlled application
startup. `schema_migrations` records the version and SHA-256 checksum. An
already applied version is skipped only when its checksum matches; a changed
applied migration fails startup. New migrations are applied in filename order,
one transaction per version. There are no destructive down migrations: use a
PostgreSQL backup and a forward migration for production rollback/recovery.

Migration `001_initial.sql` owns the base tables and indexes in the configured
schema. Migration `002_run-cancellation-status.sql` extends the `runs` status
constraint for cancellation and timeout states. Migration
`003-run-policy-metadata.sql` adds per-pipeline run-policy metadata and timeout
values, plus request, correlation, and event metadata. Its `allow_overlap`
column captures the admission policy used by each submitted run. A run with
`allow_overlap = false` waits while another run for its pipeline is active; a
run with `allow_overlap = true` may be claimed alongside active runs. The
default is `false`. Migration `004-run-queue-sequence.sql` adds the monotonic FIFO queue sequence and updates
the queue index. Migration `005-run-lifecycle-diagnostics.sql` adds durable
lease-loss, recovery-reason, and terminal-event diagnostics. Migration
`006-run-spark-reattach.sql` records the former Spark Connect worker's session
and operation fields for schema-history compatibility; the current runtime
does not use Spark operation reattachment. Migration `007-run-refresh-modes.sql` adds selected refresh target
names and extends the run-mode constraint for dry runs and selected refreshes.
Migrations `008-trigger-foundation.sql` through
`010-trigger-dead-letters.sql` add trigger definitions, normalized events,
routing and delivery outcomes, and recoverable dead letters. Migration
`011-yaml-trigger-ownership.sql` adds the `managed_by_yaml` ownership marker
and index used by direct pipeline-YAML trigger reconciliation. YAML removal
disables an owned trigger; it does not delete its event, delivery, or
dead-letter history. Migration `013-run-remote-cli.sql` is retained as an
already-versioned migration and is not used by the current execution path.
Migration `014-run-local-cli.sql` adds local CLI identity, process state, run
directory, start time, log offsets, the `UNKNOWN` run status, and its recovery
index. Migration `015-run-recovery-index.sql` adds an index for active runs
without a local CLI identity, including rows whose lease record was lost.
Migration `016-unknown-run-node-outcome.sql` allows `UNKNOWN` node states so
active node projections on an unverified run are not persisted as confirmed
failures. Migration `017-run-success-dependencies.sql` adds durable successful-run
handoffs. Migration `018-optional-pipeline-run-timeouts.sql` makes the legacy
pipeline and run timeout columns nullable with no default. It clears the former
global default from pipeline rows and queued or active runs; terminal run values are
retained as historical records. Current pipeline timeout values come only from
the optional YAML `timeout_seconds` setting.
Together, these migrations define the complete
application-owned object set for the current release:

| Object                      | Purpose                                                                                                                                          |
|-----------------------------|--------------------------------------------------------------------------------------------------------------------------------------------------|
| `schema_migrations`         | Applied migration versions and checksums.                                                                                                        |
| `pipelines`                 | Immutable UUID identity, normalized-name uniqueness, current source pointer, and discovery metadata.                                             |
| `source_versions`           | Immutable source hash, version, parsed specification, graph, files, and validation snapshot.                                                     |
| `pipeline_deployments`      | Deployment status and validation messages for a source version.                                                                                  |
| `runs`                      | Queryable current run projection, queue state, refresh targets, local CLI identity, command result, sanitized output, and lifecycle diagnostics. |
| `run_events`                | Append-only lifecycle events for each run.                                                                                                       |
| `run_node_states`           | Current per-node status projection for each run.                                                                                                 |
| `idempotency_keys`          | Database-enforced caller key and request-fingerprint mapping.                                                                                    |
| `run_cancellations`         | Transactional cancellation requests and effective timestamps.                                                                                    |
| `run_leases`                | Worker owner, token, heartbeat, and expiry for claimed runs.                                                                                     |
| `audit_events`              | Append-only control-plane audit records.                                                                                                         |
| `trigger_definitions`       | API-owned and YAML-owned schedule, webhook, and file-arrival definitions.                                                                        |
| `trigger_events`            | Canonical event identity, payload, deduplication, and processing status.                                                                         |
| `trigger_routing_decisions` | Per-trigger match, ignore, and debounce decisions.                                                                                               |
| `trigger_delivery_attempts` | Submission, replay, discard, and failure outcomes.                                                                                               |
| `trigger_dead_letters`      | Failed delivery records retained for operator replay or discard.                                                                                 |

The migration also creates these indexes and constraints:

- `pipelines_pkey`, the unique normalized-name constraint, and the deferred
  current-source foreign key.
- `source_versions_pkey` and its per-pipeline source-hash uniqueness.
- `pipeline_deployments_pkey` and its source-version foreign key.
- `runs_pkey`, source-version/pipeline foreign key, and the partial unique
  `runs_idempotency_key_unique` index.
- `runs_queue_order_idx` (including the `runs.queue_sequence` column) and
  `runs_pipeline_history_idx`.
- `run_events_pkey` and `run_events_run_order_idx`.
- `run_node_states_pkey`.
- `idempotency_keys_pkey` and its unique run reference.
- `run_cancellations_pkey`.
- `run_leases_pkey`, its unique lease-token constraint, and
  `run_leases_expiry_idx`.
- `runs_unidentified_recovery_idx` for bounded recovery scans of active runs
  without a local CLI identity.
- `audit_events_pkey` and `audit_events_time_idx`.

Migration 003 also owns the legacy `allow_overlap` and optional `timeout_seconds`
columns on `pipelines` and `runs`. It adds `caller_metadata`, `request_source`,
and `correlation_id` on `runs`,
the event correlation column, the audit request/correlation columns, and the
`runs_active_pipeline_idx` and `run_events_run_cursor_idx` indexes.

Run history pages use the `runs_pipeline_history_idx` ordering in PostgreSQL
and retrieve node projections for the selected page in one batch. The complete
`listRuns` persistence operation remains available for callers that need all
history. Node status writes use one JSONB recordset per update and skip rows
whose persisted values are unchanged.

When an `UNKNOWN` run is finalized, active node rows are finalized as
`UNKNOWN`; node rows already completed, failed, or canceled by Spark retain
those observed outcomes.

The service does not delete migration-owned tables or unrelated user data.
Test cleanup may remove rows belonging to an explicitly named application test
pipeline, but leaves the migration and schema in place.

## Data transition and recovery

The earlier single-process JSON registry was pre-production state. It is not
automatically imported. The JSON file is no longer an authoritative input and
pre-production registry data is explicitly discarded when PostgreSQL becomes
available. A fresh database initializes all objects above without manual table
creation; a previously initialized database is safe to start repeatedly and
fails closed on migration checksum drift.

The service reconciles expired worker leases continuously in bounded batches.
An active run with a persisted local CLI identity is claimed under a new lease;
the worker inspects the supervisor's run record and never invokes CLI `start`
again. CLI state, process ID, directory, offsets, stdout/stderr, command
preview, and node projections are lease-fenced in PostgreSQL. A full SCP
container restart kills the local CLI and supervisor. If the saved supervisor
state has no terminal result, the run becomes terminal `UNKNOWN` with
`recovery_reason` and `terminal_reason` set and no exit code; the last output
tail is retained. The run is not submitted again because Spark Connect may
have continued or stopped after its client disappeared. A run left by the old
Spark Connect worker without a local CLI identity is likewise marked
`UNKNOWN` when its lease expires. A run whose lease expires before any
execution identity was recorded becomes `FAILED` with `LEASE_EXPIRED` and one
`ABANDONED` event. If shutdown releases a claimed run before the local CLI
identity has been recorded, its lease is retained until expiry so
reconciliation can close the run instead of leaving it active without a
recovery path. Reconciliation also handles active rows whose lease record is
missing. Graceful server shutdown detaches the local monitor and releases an
identified CLI lease; it does not cancel the CLI. Idempotency fingerprints are
deterministic SHA-256 hashes of canonical submission settings, including the
captured overlap policy and Spark application name, so raw caller metadata is
not stored in the fingerprint. Caller metadata, command arguments, output,
diagnostics, recovery reasons, and event payloads are sanitized before
persistence. Run events and audit records are retained; operators should
monitor table, index, and output-field growth and use normal PostgreSQL backup,
retention, and archival procedures.

## Verification

Fast local checks:

```powershell
npm run lint
npx tsc -b --pretty false
npm run test:server
```

The managed live PostgreSQL integration test starts its own disposable
PostgreSQL service and injects connection values directly:

```powershell
npm run test:integration:postgres
```

It does not require `.env.local`, a caller-owned database, or
any test-mode switch. The managed runner supplies the ordinary PostgreSQL
runtime values directly to the test process.

The test creates uniquely named application rows, verifies migration,
identity, idempotency, transaction, lease, restart, event, and audit behavior,
and removes only its own rows. It does not print or persist credentials.
