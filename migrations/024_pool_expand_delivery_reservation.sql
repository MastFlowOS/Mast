-- Phase 3A: close the pool.expand overshoot bug.
--
-- ROOT CAUSE (confirmed by audit): discoveryTask (`discovery.task`, "live"
-- mode) always calls deliverLead()/insertLeadForUser() with a
-- `discoveryPlanId`, which routes every delivery through the atomic
-- `claim_discovery_delivery()` reservation from migration 023 — durable,
-- row-locked, safe under concurrent/duplicate workers.
--
-- `poolExpandJob.ts` (the Instant Discovery pool.expand follow-up path)
-- never had a `discoveryPlanId` to give it. It tracked its own remaining
-- amount in a local JS variable (`newForUser` vs `payload.shortfall`)
-- instead. Because pg-boss can redeliver a long-running pool.expand job
-- after its expiration window, a second worker can start the same logical
-- work with its own fresh local counter while the first worker is still
-- delivering — each one independently believing it still needs to deliver
-- up to `shortfall` more, so the two together can exceed the user's
-- requested amount.
--
-- FIX: reuse the exact `discovery_plans` / `claim_discovery_delivery`
-- architecture pool.expand was missing, instead of inventing a second,
-- competing target counter. `get_or_create_pool_expand_plan()` below is the
-- only new primitive needed — it gives pool.expand a durable plan row,
-- keyed by `scrape_job_id` (already unique on discovery_plans), whose
-- `requested_count` is this follow-up run's own target (the shortfall). A
-- redelivered/duplicate invocation of the same logical job calls this with
-- the same `scrape_job_id` and gets back the SAME row (its `delivered_count`
-- already reflects whatever the first worker has claimed so far) instead of
-- a fresh one — so `claim_discovery_delivery()` enforces the cap across
-- both workers, not just within one.
CREATE OR REPLACE FUNCTION get_or_create_pool_expand_plan(
  p_scrape_job_id uuid,
  p_user_id uuid,
  p_niche text,
  p_region text,
  p_channels jsonb,
  p_currencies jsonb,
  p_profession_slug text,
  p_requested_count integer
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_id uuid;
BEGIN
  -- ON CONFLICT DO UPDATE (rather than DO NOTHING) is required here so this
  -- statement always has a RETURNING row to hand back, whether this call
  -- created the plan or found one an earlier/concurrent invocation already
  -- created. The update touches nothing durable (`requested_count` and
  -- `delivered_count` are left exactly as they were) — it only re-affirms
  -- `scrape_job_id`, a no-op write, so a race between two callers creating
  -- the row "at the same time" resolves to one row with its real
  -- `delivered_count` intact, never a reset counter.
  INSERT INTO discovery_plans (
    scrape_job_id, user_id, niche, region, channels, currencies,
    profession_slug, requested_count, status, started_at
  )
  VALUES (
    p_scrape_job_id, p_user_id, p_niche, p_region, p_channels, p_currencies,
    p_profession_slug, p_requested_count, 'running', now()
  )
  ON CONFLICT (scrape_job_id) DO UPDATE
    SET scrape_job_id = discovery_plans.scrape_job_id
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

COMMENT ON FUNCTION get_or_create_pool_expand_plan IS
  'Phase 3A: gives pool.expand followUp runs a durable discovery_plans row '
  'to reserve deliveries against via claim_discovery_delivery(), so '
  'overlapping/redelivered pool.expand workers cannot jointly overshoot the '
  'requested amount. Idempotent per scrape_job_id — a second call for the '
  'same job returns the existing row untouched, never resets it.';
