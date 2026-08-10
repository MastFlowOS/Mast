-- Phase 3A: one durable terminal state for all workers of a discovery plan.
ALTER TABLE discovery_plans
  ADD COLUMN IF NOT EXISTS terminal_reason text;

ALTER TABLE discovery_tasks
  DROP CONSTRAINT IF EXISTS discovery_tasks_status_check;

ALTER TABLE discovery_tasks
  ADD CONSTRAINT discovery_tasks_status_check
  CHECK (status IN ('queued','running','completed','failed','rate_limited','cancelled'));

ALTER TABLE discovery_tasks
  ADD COLUMN IF NOT EXISTS last_attempt_at timestamptz,
  ADD COLUMN IF NOT EXISTS productive boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS termination_reason text;

-- Replaces the original reservation gate.  The accepted count remains the
-- sole authority.  The transition to completed happens atomically with the
-- final reservation, so every other worker immediately sees a terminal plan.
CREATE OR REPLACE FUNCTION claim_discovery_delivery(p_plan_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_job_id uuid;
  v_delivered integer;
  v_requested integer;
BEGIN
  UPDATE discovery_plans
  SET delivered_count = delivered_count + 1,
      status = CASE WHEN delivered_count + 1 >= requested_count THEN 'completed' ELSE 'running' END,
      terminal_reason = CASE WHEN delivered_count + 1 >= requested_count THEN 'TARGET_REACHED' ELSE terminal_reason END,
      completed_at = CASE WHEN delivered_count + 1 >= requested_count THEN now() ELSE completed_at END,
      started_at = coalesce(started_at, now())
  WHERE id = p_plan_id
    AND delivered_count < requested_count
    AND status IN ('queued', 'planning', 'running')
  RETURNING scrape_job_id, delivered_count, requested_count INTO v_job_id, v_delivered, v_requested;

  IF NOT FOUND THEN RETURN false; END IF;

  -- The final accepted reservation is the request-wide stop point.  Mark
  -- dormant work non-claimable in the same transaction so a queued pg-boss
  -- wake-up cannot create another browser after the target has been met.
  IF v_delivered >= v_requested THEN
    UPDATE discovery_tasks
    SET status = 'cancelled',
        termination_reason = 'TARGET_REACHED',
        completed_at = now(),
        last_heartbeat_at = null
    WHERE plan_id = p_plan_id AND status = 'queued';
  END IF;

  UPDATE scrape_jobs
  SET results_count = v_delivered,
      status = CASE WHEN v_delivered >= v_requested THEN 'completed' ELSE 'streaming' END,
      completed_at = CASE WHEN v_delivered >= v_requested THEN now() ELSE completed_at END
  WHERE id = v_job_id;
  RETURN true;
END;
$$;

-- A downstream credit/insert failure returns its reservation and reopens a
-- target-completed plan only when that final reservation was the reason it
-- became terminal.
CREATE OR REPLACE FUNCTION release_discovery_delivery(p_plan_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE v_job_id uuid; v_delivered integer; v_requested integer;
BEGIN
  UPDATE discovery_plans
  SET delivered_count = greatest(delivered_count - 1, 0),
      status = CASE WHEN status = 'completed' AND terminal_reason = 'TARGET_REACHED' THEN 'running' ELSE status END,
      terminal_reason = CASE WHEN status = 'completed' AND terminal_reason = 'TARGET_REACHED' THEN NULL ELSE terminal_reason END,
      completed_at = CASE WHEN status = 'completed' AND terminal_reason = 'TARGET_REACHED' THEN NULL ELSE completed_at END
  WHERE id = p_plan_id
  RETURNING scrape_job_id, delivered_count, requested_count INTO v_job_id, v_delivered, v_requested;
  IF FOUND THEN
    UPDATE scrape_jobs SET results_count = v_delivered,
      status = CASE WHEN v_delivered < v_requested AND status = 'completed' THEN 'streaming' ELSE status END,
      completed_at = CASE WHEN v_delivered < v_requested THEN NULL ELSE completed_at END
    WHERE id = v_job_id;
  END IF;
END;
$$;
