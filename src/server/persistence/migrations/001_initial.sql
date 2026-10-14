CREATE TABLE IF NOT EXISTS pipelines (
    id uuid PRIMARY KEY,
    normalized_name text NOT NULL UNIQUE,
    display_name text NOT NULL,
    spec_path text NOT NULL,
    current_source_hash text NOT NULL,
    current_version_id text NOT NULL,
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS source_versions (
    pipeline_id uuid NOT NULL REFERENCES pipelines(id) ON DELETE CASCADE,
    version_id text NOT NULL,
    source_hash text NOT NULL,
    spec_path text NOT NULL,
    spec_json jsonb NOT NULL,
    source_files jsonb NOT NULL,
    nodes_json jsonb NOT NULL,
    edges_json jsonb NOT NULL,
    validation_messages jsonb NOT NULL,
    created_at timestamptz NOT NULL,
    PRIMARY KEY (pipeline_id, version_id),
    UNIQUE (pipeline_id, source_hash)
);

ALTER TABLE pipelines
    ADD CONSTRAINT pipelines_current_version_fk
    FOREIGN KEY (id, current_version_id)
    REFERENCES source_versions (pipeline_id, version_id)
    DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE IF NOT EXISTS pipeline_deployments (
    pipeline_id uuid NOT NULL,
    version_id text NOT NULL,
    deployed_at timestamptz NOT NULL,
    status text NOT NULL CHECK (status IN ('DRAFT', 'DEPLOYED', 'DEPLOYED_WITH_WARNINGS', 'INVALID')),
    validation_messages jsonb NOT NULL,
    PRIMARY KEY (pipeline_id, version_id),
    FOREIGN KEY (pipeline_id, version_id)
        REFERENCES source_versions (pipeline_id, version_id)
        ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS runs (
    run_id uuid PRIMARY KEY,
    pipeline_id uuid NOT NULL REFERENCES pipelines(id) ON DELETE RESTRICT,
    version_id text NOT NULL,
    source_hash text NOT NULL,
    idempotency_key text,
    mode text NOT NULL CHECK (mode IN ('incremental', 'full-refresh-all', 'repair-failed')),
    repaired_node_names jsonb,
    spark_app_name text NOT NULL,
    status text NOT NULL CHECK (status IN ('QUEUED', 'SUBMITTING', 'RUNNING', 'SUCCEEDED', 'FAILED')),
    command jsonb,
    exit_code integer,
    started_at timestamptz NOT NULL,
    ended_at timestamptz,
    stdout text,
    stderr text,
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL,
    FOREIGN KEY (pipeline_id, version_id)
        REFERENCES source_versions (pipeline_id, version_id)
        ON DELETE RESTRICT
);

CREATE UNIQUE INDEX IF NOT EXISTS runs_idempotency_key_unique
    ON runs (idempotency_key)
    WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS runs_queue_order_idx
    ON runs (status, started_at, created_at, run_id);

CREATE INDEX IF NOT EXISTS runs_pipeline_history_idx
    ON runs (pipeline_id, started_at DESC, run_id DESC);

CREATE TABLE IF NOT EXISTS run_events (
    event_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    run_id uuid NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
    event_type text NOT NULL,
    status text,
    payload jsonb NOT NULL,
    occurred_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS run_events_run_order_idx
    ON run_events (run_id, event_id);

CREATE TABLE IF NOT EXISTS run_node_states (
    run_id uuid NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
    qualified_name text NOT NULL,
    status text NOT NULL CHECK (status IN ('QUEUED', 'PLANNING', 'STARTING', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELED')),
    started_at timestamptz,
    completed_at timestamptz,
    duration_ms integer,
    last_updated_at timestamptz NOT NULL,
    PRIMARY KEY (run_id, qualified_name)
);

CREATE TABLE IF NOT EXISTS idempotency_keys (
    idempotency_key text PRIMARY KEY,
    pipeline_id uuid NOT NULL REFERENCES pipelines(id) ON DELETE CASCADE,
    request_fingerprint text NOT NULL,
    run_id uuid NOT NULL UNIQUE REFERENCES runs(run_id) ON DELETE CASCADE,
    created_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS run_cancellations (
    run_id uuid PRIMARY KEY REFERENCES runs(run_id) ON DELETE CASCADE,
    requested_at timestamptz NOT NULL,
    requested_by text,
    reason text,
    effective_at timestamptz
);

CREATE TABLE IF NOT EXISTS run_leases (
    run_id uuid PRIMARY KEY REFERENCES runs(run_id) ON DELETE CASCADE,
    owner_id text NOT NULL,
    lease_token uuid NOT NULL UNIQUE,
    acquired_at timestamptz NOT NULL,
    heartbeat_at timestamptz NOT NULL,
    expires_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS run_leases_expiry_idx
    ON run_leases (expires_at);

CREATE TABLE IF NOT EXISTS audit_events (
    event_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    event_type text NOT NULL,
    pipeline_id uuid REFERENCES pipelines(id) ON DELETE SET NULL,
    run_id uuid REFERENCES runs(run_id) ON DELETE SET NULL,
    actor text,
    payload jsonb NOT NULL,
    occurred_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS audit_events_time_idx
    ON audit_events (occurred_at, event_id);
