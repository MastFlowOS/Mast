-- MAST Lead Engine — Phase 3B discovery concurrency audit
--
-- AUDIT FINDING: handleDiscoveryTask (discoveryPlanJob.ts) has always read
-- `task.plan_tier_id` to resolve the per-user worker-concurrency cap
-- (getPlanConcurrency), but no migration ever added that column and no
-- INSERT ever populated it. Every task's `plan_tier_id` was therefore
-- always `undefined`, so `getPlanConcurrency((planTierId as PlanId) ??
-- "free", ...)` silently fell back to the "free" tier's cap (2) for every
-- user on every plan, including pro/premium users whose configured cap is
-- 8/16. Combined with dispatchQueuedDiscoveryTasks previously only ever
-- queuing one task at a time (fixed in this same phase, planner.ts), the
-- effective production concurrency for discovery was 1 regardless of plan.
--
-- This migration adds the missing column. planner.ts's materializeDiscoveryPlan
-- now populates it from the billing plan tier on every new plan.

ALTER TABLE discovery_tasks
  ADD COLUMN IF NOT EXISTS plan_tier_id text NOT NULL DEFAULT 'free'
    CHECK (plan_tier_id IN ('free', 'starter', 'pro', 'premium'));

-- Back-fill existing rows explicitly (they were already behaving as "free"
-- in practice, so this changes no observed behavior for already-created
-- tasks — only new tasks benefit from the corrected cap).
UPDATE discovery_tasks SET plan_tier_id = 'free' WHERE plan_tier_id IS NULL;

COMMENT ON COLUMN discovery_tasks.plan_tier_id IS
  'Billing plan tier at plan-creation time, denormalised from discovery_plans -> scrape_jobs -> profiles so the concurrency-cap check (handleDiscoveryTask, dispatchQueuedDiscoveryTasks) does not need a join per task/poll.';
