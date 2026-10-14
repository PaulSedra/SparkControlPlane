ALTER TABLE runs
    ADD COLUMN IF NOT EXISTS terminal_reason text,
    ADD COLUMN IF NOT EXISTS recovery_reason text,
    ADD COLUMN IF NOT EXISTS lease_lost boolean NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS terminal_event_at timestamptz;

CREATE INDEX IF NOT EXISTS runs_recovery_lookup_idx
    ON runs (status, terminal_event_at DESC)
    WHERE status IN ('SUBMITTING', 'RUNNING', 'FAILED', 'CANCELED', 'TIMED_OUT');
