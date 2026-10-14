ALTER TABLE trigger_definitions
    ADD COLUMN IF NOT EXISTS active boolean NOT NULL DEFAULT true;
