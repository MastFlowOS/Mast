-- MAST Lead Engine — Stabilization Phase terminal states
--
-- 1. scrape_jobs.status: adds 'cancelled' and 'completed_partial' terminal
--    states, and a 'job_summary' jsonb column for post-run metrics.
-- 2. discovery_plans.status: same new states; 'partial' is now
--    'completed_partial' for explicitness.  Both names are accepted during
--    migration so old workers writing 'partial' do not break mid-deploy.
-- 3. discovery_tasks: adds 'last_heartbeat_at' for stale-task detection
--    and a 'task_summary' jsonb column for per-task metrics.
-- 4. business_processing_tasks: adds 'last_heartbeat_at' for stale
--    detection (heartbeat-based, so recovery is not bound to a hardcoded
--    timeout constant in application code).

-- ─── scrape_jobs ─────────────────────────────────────────────────────────────
-- Drop the existing status constraint so we can widen it.
ALTER TABLE scrape_jobs
  DROP CONSTRAINT IF EXISTS scrape_jobs_status_check;

ALTER TABLE scrape_jobs
  ADD CONSTRAINT scrape_jobs_status_check
  CHECK (status IN (
    'queued',
    'running',
    'streaming',
    'completed',
    'completed_partial',
    'failed',
    'cancelled'
  ));

-- Summary metrics emitted by the job handler at completion time.
-- { requested, delivered, rejected, duplicates, runtime_ms,
--   completion_reason: 'quantity_reached' | 'exhausted' | 'limit_reached' |
--                      'cancelled' | 'failed' }
ALTER TABLE scrape_jobs
  ADD COLUMN IF NOT EXISTS job_summary jsonb;

-- ─── discovery_plans ─────────────────────────────────────────────────────────
ALTER TABLE discovery_plans
  DROP CONSTRAINT IF EXISTS discovery_plans_status_check;

ALTER TABLE discovery_plans
  ADD CONSTRAINT discovery_plans_status_check
  CHECK (status IN (
    'queued',
    'planning',
    'running',
    'completed',
    'completed_partial',
    'failed',
    'cancelled'
  ));

-- ─── discovery_tasks ─────────────────────────────────────────────────────────
-- Heartbeat timestamp: workers UPDATE this column while the task is running.
-- A NULL or stale value (older than STALE_TASK_TIMEOUT_MS) means the worker
-- crashed without resetting the row to 'queued', and a new worker may safely
-- re-claim it.
ALTER TABLE discovery_tasks
  ADD COLUMN IF NOT EXISTS last_heartbeat_at timestamptz;

-- Per-task summary written on completion/failure.
-- { discovered, accepted, rejected, duplicates, runtime_ms,
--   completion_reason }
ALTER TABLE discovery_tasks
  ADD COLUMN IF NOT EXISTS task_summary jsonb;

-- Index so the stale-task query (status='running' AND heartbeat < threshold)
-- is fast even at scale.
CREATE INDEX IF NOT EXISTS idx_discovery_tasks_heartbeat
  ON discovery_tasks (status, last_heartbeat_at)
  WHERE status = 'running';

-- ─── business_processing_tasks ───────────────────────────────────────────────
ALTER TABLE business_processing_tasks
  ADD COLUMN IF NOT EXISTS last_heartbeat_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_bpt_heartbeat
  ON business_processing_tasks (status, last_heartbeat_at)
  WHERE status = 'running';
