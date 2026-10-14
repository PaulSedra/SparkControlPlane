ALTER TABLE runs
    ADD COLUMN IF NOT EXISTS cli_execution_id text,
    ADD COLUMN IF NOT EXISTS cli_state text,
    ADD COLUMN IF NOT EXISTS cli_process_id bigint,
    ADD COLUMN IF NOT EXISTS cli_run_directory text,
    ADD COLUMN IF NOT EXISTS cli_started_at timestamptz,
    ADD COLUMN IF NOT EXISTS cli_stdout_offset bigint NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS cli_stderr_offset bigint NOT NULL DEFAULT 0;

ALTER TABLE runs
    DROP CONSTRAINT IF EXISTS runs_status_check;

ALTER TABLE runs
    ADD CONSTRAINT runs_status_check
    CHECK (status IN (
        'QUEUED',
        'SUBMITTING',
        'RUNNING',
        'SUCCEEDED',
        'FAILED',
        'CANCELED',
        'TIMED_OUT',
        'UNKNOWN'
    ));

ALTER TABLE runs
    ADD CONSTRAINT runs_cli_state_check
    CHECK (
        cli_state IS NULL
        OR cli_state IN (
            'STARTING',
            'RUNNING',
            'COMPLETED',
            'FAILED',
            'CANCELED',
            'TIMED_OUT',
            'UNKNOWN'
        )
    );

ALTER TABLE runs
    ADD CONSTRAINT runs_cli_log_offsets_check
    CHECK (cli_stdout_offset >= 0 AND cli_stderr_offset >= 0);

CREATE INDEX IF NOT EXISTS runs_cli_recovery_idx
    ON runs (status, started_at, run_id)
    WHERE status IN ('SUBMITTING', 'RUNNING')
      AND cli_execution_id IS NOT NULL;
