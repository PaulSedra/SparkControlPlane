ALTER TABLE runs
    ADD COLUMN IF NOT EXISTS target_node_names jsonb;

ALTER TABLE runs
    DROP CONSTRAINT IF EXISTS runs_mode_check;

ALTER TABLE runs
    ADD CONSTRAINT runs_mode_check
    CHECK (mode IN (
        'incremental',
        'full-refresh-all',
        'repair-failed',
        'dry-run',
        'refresh-selected',
        'full-refresh-selected'
    ));
