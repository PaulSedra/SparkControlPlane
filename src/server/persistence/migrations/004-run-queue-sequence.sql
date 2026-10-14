ALTER TABLE runs
    ADD COLUMN IF NOT EXISTS queue_sequence bigint GENERATED ALWAYS AS IDENTITY;

DROP INDEX IF EXISTS runs_queue_order_idx;

CREATE INDEX IF NOT EXISTS runs_queue_order_idx
    ON runs (status, queue_sequence);
