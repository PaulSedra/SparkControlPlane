ALTER TABLE pipelines
    ADD COLUMN IF NOT EXISTS allow_overlap boolean NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS timeout_seconds integer NOT NULL DEFAULT 14400,
    ADD CONSTRAINT pipelines_timeout_seconds_check
        CHECK (timeout_seconds BETWEEN 1 AND 604800);

ALTER TABLE runs
    ADD COLUMN IF NOT EXISTS allow_overlap boolean NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS timeout_seconds integer NOT NULL DEFAULT 14400,
    ADD COLUMN IF NOT EXISTS caller_metadata jsonb,
    ADD COLUMN IF NOT EXISTS request_source text,
    ADD COLUMN IF NOT EXISTS correlation_id text,
    ADD CONSTRAINT runs_timeout_seconds_check
        CHECK (timeout_seconds BETWEEN 1 AND 604800);

ALTER TABLE run_events
    ADD COLUMN IF NOT EXISTS correlation_id text;

ALTER TABLE audit_events
    ADD COLUMN IF NOT EXISTS request_source text,
    ADD COLUMN IF NOT EXISTS correlation_id text;

CREATE INDEX IF NOT EXISTS runs_active_pipeline_idx
    ON runs (pipeline_id, status)
    WHERE status IN ('SUBMITTING', 'RUNNING');

CREATE INDEX IF NOT EXISTS run_events_run_cursor_idx
    ON run_events (run_id, event_id DESC);
