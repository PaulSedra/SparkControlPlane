CREATE TABLE IF NOT EXISTS trigger_definitions (
    trigger_id uuid PRIMARY KEY,
    name text NOT NULL UNIQUE,
    trigger_type text NOT NULL CHECK (trigger_type IN ('SCHEDULE', 'WEBHOOK', 'FILE_ARRIVAL')),
    pipeline_id uuid NOT NULL REFERENCES pipelines(id) ON DELETE RESTRICT,
    enabled boolean NOT NULL DEFAULT true,
    mode text NOT NULL CHECK (mode IN (
        'incremental',
        'full-refresh-all',
        'repair-failed',
        'dry-run',
        'refresh-selected',
        'full-refresh-selected'
    )),
    node_names jsonb,
    caller_metadata jsonb,
    configuration jsonb NOT NULL,
    last_outcome jsonb,
    last_event_at timestamptz,
    last_submission_at timestamptz,
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS trigger_definitions_pipeline_idx
    ON trigger_definitions (pipeline_id, enabled, name);

CREATE TABLE IF NOT EXISTS trigger_events (
    event_id text PRIMARY KEY,
    event_type text NOT NULL,
    source text NOT NULL,
    occurred_at timestamptz NOT NULL,
    attributes jsonb NOT NULL,
    payload jsonb NOT NULL,
    deduplication_key text NOT NULL,
    status text NOT NULL CHECK (status IN ('RECEIVED', 'ROUTED', 'IGNORED', 'FAILED', 'DUPLICATE')),
    received_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL,
    duplicate_of_event_id text REFERENCES trigger_events(event_id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS trigger_events_received_idx
    ON trigger_events (received_at DESC, event_id DESC);

CREATE TABLE IF NOT EXISTS trigger_deduplication_keys (
    deduplication_key text PRIMARY KEY,
    event_id text NOT NULL REFERENCES trigger_events(event_id) ON DELETE CASCADE,
    first_seen_at timestamptz NOT NULL,
    last_seen_at timestamptz NOT NULL,
    duplicate_count bigint NOT NULL DEFAULT 0 CHECK (duplicate_count >= 0)
);

CREATE TABLE IF NOT EXISTS trigger_routing_decisions (
    decision_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    event_id text NOT NULL REFERENCES trigger_events(event_id) ON DELETE CASCADE,
    trigger_id uuid NOT NULL REFERENCES trigger_definitions(trigger_id) ON DELETE CASCADE,
    outcome text NOT NULL CHECK (outcome IN ('MATCHED', 'NO_MATCH', 'DISABLED', 'INVALID', 'DUPLICATE')),
    reason text,
    run_id uuid REFERENCES runs(run_id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS trigger_routing_decisions_lookup_idx
    ON trigger_routing_decisions (trigger_id, created_at DESC, decision_id DESC);

CREATE TABLE IF NOT EXISTS trigger_delivery_attempts (
    attempt_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    event_id text NOT NULL REFERENCES trigger_events(event_id) ON DELETE CASCADE,
    trigger_id uuid NOT NULL REFERENCES trigger_definitions(trigger_id) ON DELETE CASCADE,
    attempt_number integer NOT NULL CHECK (attempt_number > 0),
    status text NOT NULL CHECK (status IN (
        'PENDING',
        'ACCEPTED',
        'FAILED',
        'REPLAYED',
        'DISCARDED',
        'DUPLICATE',
        'IGNORED'
    )),
    run_id uuid REFERENCES runs(run_id) ON DELETE SET NULL,
    failure_reason text,
    correlation_id text,
    started_at timestamptz,
    completed_at timestamptz,
    created_at timestamptz NOT NULL,
    UNIQUE (event_id, trigger_id, attempt_number)
);

CREATE INDEX IF NOT EXISTS trigger_delivery_attempts_lookup_idx
    ON trigger_delivery_attempts (trigger_id, created_at DESC, attempt_id DESC);
