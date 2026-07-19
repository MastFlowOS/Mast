-- MAST Lead Engine \u2014 Phase 5 Refinements (Refinements 2 & 4)
--
-- 1. discovery_tasks.user_id (Refinement 2)
--    Denormalises the owning user onto each task row so the concurrency-cap
--    claim predicate (COUNT running tasks WHERE user_id = ?) can hit the
--    new (user_id, status) index rather than joining through discovery_plans.
--
-- 2. (user_id, status) index on discovery_tasks (Refinement 2)
--    Required for the claim predicate's COUNT(*) subquery to remain a fast
--    index scan rather than a table scan at higher job volumes (see §11).
--
-- 3. worker_instances table (Refinement 4)
--    Workers advertise their measured capacity (browser slots, free memory,
--    CPU count) at startup and refresh it on a heartbeat.  Used by the ops
--    dashboard and, in future, by a central dispatcher.  Stale rows (no
--    heartbeat for > 5 min) are excluded from live views by the index filter.

-- ─── 1. discovery_tasks.user_id ──────────────────────────────────────────────
ALTER TABLE discovery_tasks
  ADD COLUMN IF NOT EXISTS user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE;

-- Back-fill from the parent discovery_plans row so existing rows are coherent.
-- This is a one-time scan; after this migration every INSERT comes from the
-- updated planner.ts which sets user_id directly.
UPDATE discovery_tasks dt
SET    user_id = dp.user_id
FROM   discovery_plans dp
WHERE  dt.plan_id = dp.id
  AND  dt.user_id IS NULL;

-- ─── 2. Concurrency-cap claim index ──────────────────────────────────────────
-- Supports: SELECT COUNT(*) FROM discovery_tasks WHERE user_id = ? AND status = 'running'
CREATE INDEX IF NOT EXISTS idx_discovery_tasks_user_status
  ON discovery_tasks (user_id, status);

-- Existing claim index already covers (status, priority DESC, created_at).
-- The new index is complementary, not a replacement.

-- ─── 3. worker_instances table ───────────────────────────────────────────────
-- One row per worker process (id = hostname:pid).  Workers upsert on startup
-- and update on a 30-second heartbeat.  Stale workers are not automatically
-- deleted so their last-known capacity remains visible for post-mortem
-- inspection; the ops view/dashboard should filter on last_heartbeat_at.
CREATE TABLE IF NOT EXISTS worker_instances (
  id                     TEXT        PRIMARY KEY,           -- '<hostname>:<pid>'
  pool_type              TEXT        NOT NULL
                           CHECK (pool_type IN ('browser','light_compute','ai')),
  effective_concurrency  INTEGER     NOT NULL CHECK (effective_concurrency >= 1),
  configured_concurrency INTEGER     NOT NULL CHECK (configured_concurrency >= 1),
  free_memory_mb         INTEGER     NOT NULL CHECK (free_memory_mb >= 0),
  cpu_count              INTEGER     NOT NULL CHECK (cpu_count >= 1),
  last_heartbeat_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Ops dashboard query: live workers in the last 5 minutes.
CREATE INDEX IF NOT EXISTS idx_worker_instances_heartbeat
  ON worker_instances (last_heartbeat_at DESC);

-- Service-role access only — no user-facing RLS needed.
-- The table is not exposed via the public schema to authenticated users.
GRANT SELECT, INSERT, UPDATE ON worker_instances TO service_role;

-- ─── 4. Priority-aging function (Refinement 2) ───────────────────────────────
-- Called by the "priority-aging" pg-boss scheduled job every 5 minutes.
-- Raises the priority of queued discovery tasks that have been waiting longer
-- than p_aging_threshold_minutes toward their tier ceiling, preventing starvation
-- of lower tiers when a higher-tier user has sustained throughput.
--
-- The LEAST() clamp ensures aging never crosses into a higher tier's band:
-- a free-tier task (ceiling=9) can age to 9 but never reach 10 (starter base).
-- The per-tier ceilings mirror PLANS.priorityBand.ceiling in plans.ts exactly.
--
-- p_aging_threshold_minutes : tasks older than this (in queued state) are eligible
-- p_boost_per_interval      : priority points added per invocation (default 1)
CREATE OR REPLACE FUNCTION age_discovery_task_priorities(
  p_aging_threshold_minutes INTEGER DEFAULT 10,
  p_boost_per_interval      INTEGER DEFAULT 1
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  -- Free tier: ceiling=9
  UPDATE discovery_tasks
  SET    priority = LEAST(priority + p_boost_per_interval, 9)
  WHERE  status     = 'queued'
    AND  priority   < 9
    AND  created_at < NOW() - (p_aging_threshold_minutes || ' minutes')::INTERVAL
    AND  priority   BETWEEN 0 AND 9;

  -- Starter tier: ceiling=19
  UPDATE discovery_tasks
  SET    priority = LEAST(priority + p_boost_per_interval, 19)
  WHERE  status     = 'queued'
    AND  priority   < 19
    AND  created_at < NOW() - (p_aging_threshold_minutes || ' minutes')::INTERVAL
    AND  priority   BETWEEN 10 AND 19;

  -- Pro tier: ceiling=29
  UPDATE discovery_tasks
  SET    priority = LEAST(priority + p_boost_per_interval, 29)
  WHERE  status     = 'queued'
    AND  priority   < 29
    AND  created_at < NOW() - (p_aging_threshold_minutes || ' minutes')::INTERVAL
    AND  priority   BETWEEN 20 AND 29;

  -- Premium tier: ceiling=39
  UPDATE discovery_tasks
  SET    priority = LEAST(priority + p_boost_per_interval, 39)
  WHERE  status     = 'queued'
    AND  priority   < 39
    AND  created_at < NOW() - (p_aging_threshold_minutes || ' minutes')::INTERVAL
    AND  priority   BETWEEN 30 AND 39;
END;
$$;

GRANT EXECUTE ON FUNCTION age_discovery_task_priorities(INTEGER, INTEGER) TO service_role;
