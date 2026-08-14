-- Migration 027: Durable Single-Flight Execution Claim for Pool Expansion
--
-- Replaces/augments process-local checks with a durable, atomic, row-locked
-- execution claim in Postgres. Ensures that multiple Railway worker processes
-- receiving duplicate pg-boss jobs for the same scrape_job_id cannot run
-- concurrent Python subprocesses.

CREATE OR REPLACE FUNCTION claim_pool_expand_execution(
  p_scrape_job_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_status text;
  v_heartbeat timestamptz;
BEGIN
  -- Lock the scrape_jobs row for update to prevent concurrent worker races
  SELECT status, last_heartbeat_at INTO v_status, v_heartbeat
  FROM scrape_jobs
  WHERE id = p_scrape_job_id
  FOR UPDATE;

  IF NOT FOUND THEN
    -- If no scrape_jobs row exists yet, allow execution
    RETURN true;
  END IF;

  -- Terminal statuses cannot be re-claimed
  IF v_status IN ('completed', 'cancelled', 'failed', 'completed_partial') THEN
    RETURN false;
  END IF;

  -- If another worker process is actively streaming AND its heartbeat is fresh (< 45s), deny claim
  IF v_status = 'streaming' AND v_heartbeat IS NOT NULL AND v_heartbeat > (now() - interval '45 seconds') THEN
    RETURN false;
  END IF;

  -- Claim execution: update status and last_heartbeat_at atomically
  UPDATE scrape_jobs
  SET status = 'streaming',
      last_heartbeat_at = now()
  WHERE id = p_scrape_job_id;

  RETURN true;
END;
$$;

COMMENT ON FUNCTION claim_pool_expand_execution IS
  'Durable single-flight claim for pool expansion jobs across separate worker processes. '
  'Uses row-level lock and heartbeat staleness to prevent duplicate worker execution.';
