ALTER TABLE pipelines
    ALTER COLUMN timeout_seconds DROP DEFAULT,
    ALTER COLUMN timeout_seconds DROP NOT NULL;

ALTER TABLE runs
    ALTER COLUMN timeout_seconds DROP DEFAULT,
    ALTER COLUMN timeout_seconds DROP NOT NULL;

UPDATE pipelines
SET timeout_seconds = NULL;

UPDATE runs
SET timeout_seconds = NULL
WHERE status IN ('QUEUED', 'SUBMITTING', 'RUNNING');
