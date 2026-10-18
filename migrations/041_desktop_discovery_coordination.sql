-- MAST Desktop — Phase 2: Cloud Coordination Foundation
--
-- Note: This migration is provided for future schema promotion and indexing optimization.
-- The coordination foundation in Phase 2 is fully backward-compatible with the existing
-- production database schema by storing lease tokens, worker identity, and desktop execution
-- targets within the existing discovery_tasks.task_summary jsonb column and discovery_tasks.last_heartbeat_at.
--
-- Apply this migration when promoting explicit columns and dedicated partial indexes to production.

-- 1. Explicit execution target column for discovery_tasks
ALTER TABLE discovery_tasks
  ADD COLUMN IF NOT EXISTS execution_target text NOT NULL DEFAULT 'cloud'
  CHECK (execution_target IN ('cloud', 'desktop'));

-- 2. Partial index for desktop task claiming
-- Speeds up queries like:
--   SELECT * FROM discovery_tasks
--   WHERE user_id = $1 AND execution_target = 'desktop' AND status IN ('queued', 'running')
--   ORDER BY priority DESC, created_at ASC
CREATE INDEX IF NOT EXISTS idx_discovery_tasks_desktop_claim
  ON discovery_tasks (user_id, status, priority DESC, created_at)
  WHERE execution_target = 'desktop';

-- 3. Explicit execution target on scrape_jobs for quick visibility and filtering
ALTER TABLE scrape_jobs
  ADD COLUMN IF NOT EXISTS execution_target text NOT NULL DEFAULT 'cloud'
  CHECK (execution_target IN ('cloud', 'desktop'));
