-- Preserve uncertainty on node rows when a run outcome cannot be verified.
ALTER TABLE run_node_states
    DROP CONSTRAINT IF EXISTS run_node_states_status_check,
    ADD CONSTRAINT run_node_states_status_check
    CHECK (status IN (
        'QUEUED',
        'PLANNING',
        'STARTING',
        'RUNNING',
        'COMPLETED',
        'FAILED',
        'CANCELED',
        'UNKNOWN'
    ));
