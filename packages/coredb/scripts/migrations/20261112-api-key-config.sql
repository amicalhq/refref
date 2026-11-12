-- Apply before starting the upgraded webapp/API. Existing keys and owners are preserved.
BEGIN;
ALTER TABLE apikey ADD COLUMN IF NOT EXISTS config_id text NOT NULL DEFAULT 'default';
COMMIT;
