ALTER TABLE runs
    ADD COLUMN IF NOT EXISTS spark_session_id uuid,
    ADD COLUMN IF NOT EXISTS spark_operation_id uuid,
    ADD COLUMN IF NOT EXISTS spark_last_response_id text,
    ADD COLUMN IF NOT EXISTS spark_execution_state text NOT NULL DEFAULT 'NOT_STARTED';

ALTER TABLE runs
    DROP CONSTRAINT IF EXISTS runs_spark_execution_state_check;

ALTER TABLE runs
    ADD CONSTRAINT runs_spark_execution_state_check
    CHECK (spark_execution_state IN (
        'COMPLETED',
        'DETACHED',
        'MONITORING',
        'NOT_STARTED',
        'OPERATION_LOST',
        'REATTACHING',
        'SUBMITTING'
    ));

CREATE INDEX IF NOT EXISTS runs_reattach_lookup_idx
    ON runs (status, started_at, run_id)
    WHERE status IN ('SUBMITTING', 'RUNNING')
      AND spark_operation_id IS NOT NULL;
