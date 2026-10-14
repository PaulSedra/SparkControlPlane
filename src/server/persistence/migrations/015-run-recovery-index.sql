CREATE INDEX IF NOT EXISTS runs_unidentified_recovery_idx
    ON runs (updated_at, run_id)
    WHERE status IN ('SUBMITTING', 'RUNNING')
      AND cli_execution_id IS NULL;
