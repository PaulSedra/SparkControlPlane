CREATE TABLE IF NOT EXISTS pipeline_run_success_dependencies (
    source_run_id uuid PRIMARY KEY REFERENCES runs(run_id) ON DELETE CASCADE,
    source_pipeline_id uuid NOT NULL REFERENCES pipelines(id) ON DELETE RESTRICT,
    target_pipeline_id uuid NOT NULL REFERENCES pipelines(id) ON DELETE RESTRICT,
    status text NOT NULL CHECK (status IN ('WAITING', 'READY', 'SUBMITTED', 'SKIPPED')),
    target_run_id uuid REFERENCES runs(run_id) ON DELETE RESTRICT,
    attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    next_attempt_at timestamptz NOT NULL,
    last_error text,
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL,
    CHECK (source_pipeline_id <> target_pipeline_id),
    CHECK ((status = 'SUBMITTED') = (target_run_id IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS pipeline_run_success_dependencies_ready_idx
    ON pipeline_run_success_dependencies (next_attempt_at, created_at, source_run_id)
    WHERE status = 'READY';
