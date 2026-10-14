ALTER TABLE pipelines
    ADD COLUMN IF NOT EXISTS active boolean NOT NULL DEFAULT true;

ALTER TABLE source_versions
    ADD COLUMN IF NOT EXISTS spec_content text,
    ADD COLUMN IF NOT EXISTS source_contents jsonb NOT NULL DEFAULT '[]'::jsonb,
    ADD COLUMN IF NOT EXISTS yaml_trigger_definitions jsonb NOT NULL DEFAULT '[]'::jsonb,
    ADD COLUMN IF NOT EXISTS policy_json jsonb;
