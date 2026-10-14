CREATE TABLE IF NOT EXISTS trigger_dead_letters (
    dead_letter_id uuid PRIMARY KEY,
    event_id text NOT NULL REFERENCES trigger_events(event_id) ON DELETE CASCADE,
    trigger_id uuid NOT NULL REFERENCES trigger_definitions(trigger_id) ON DELETE CASCADE,
    event jsonb NOT NULL,
    failure_reason text NOT NULL,
    status text NOT NULL CHECK (status IN ('PENDING', 'REPLAYED', 'DISCARDED')),
    replay_count integer NOT NULL DEFAULT 0 CHECK (replay_count >= 0),
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL,
    UNIQUE (event_id, trigger_id)
);

CREATE INDEX IF NOT EXISTS trigger_dead_letters_status_idx
    ON trigger_dead_letters (status, updated_at DESC, dead_letter_id DESC);
