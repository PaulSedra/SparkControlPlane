ALTER TABLE runs
    ADD COLUMN IF NOT EXISTS remote_execution_id uuid,
    ADD COLUMN IF NOT EXISTS remote_host text,
    ADD COLUMN IF NOT EXISTS remote_ssh_port integer,
    ADD COLUMN IF NOT EXISTS remote_container_id text,
    ADD COLUMN IF NOT EXISTS remote_container_name text,
    ADD COLUMN IF NOT EXISTS remote_process_id bigint,
    ADD COLUMN IF NOT EXISTS remote_run_directory text,
    ADD COLUMN IF NOT EXISTS remote_started_at timestamptz,
    ADD COLUMN IF NOT EXISTS remote_execution_state text,
    ADD COLUMN IF NOT EXISTS remote_stdout_offset bigint NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS remote_stderr_offset bigint NOT NULL DEFAULT 0;

ALTER TABLE runs
    DROP CONSTRAINT IF EXISTS runs_remote_execution_state_check;

ALTER TABLE runs
    ADD CONSTRAINT runs_remote_execution_state_check
    CHECK (
        remote_execution_state IS NULL
        OR remote_execution_state IN (
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
    DROP CONSTRAINT IF EXISTS runs_remote_log_offsets_check;

ALTER TABLE runs
    ADD CONSTRAINT runs_remote_log_offsets_check
    CHECK (remote_stdout_offset >= 0 AND remote_stderr_offset >= 0);

ALTER TABLE runs
    DROP CONSTRAINT IF EXISTS runs_remote_ssh_port_check;

ALTER TABLE runs
    ADD CONSTRAINT runs_remote_ssh_port_check
    CHECK (remote_ssh_port IS NULL OR remote_ssh_port BETWEEN 1 AND 65535);

CREATE INDEX IF NOT EXISTS runs_remote_recovery_idx
    ON runs (status, started_at, run_id)
    WHERE status IN ('SUBMITTING', 'RUNNING')
      AND remote_execution_id IS NOT NULL;
