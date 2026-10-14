ALTER TABLE trigger_definitions
    ADD COLUMN IF NOT EXISTS managed_by_yaml boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS trigger_definitions_yaml_idx
    ON trigger_definitions (pipeline_id, name)
    WHERE managed_by_yaml = true;
