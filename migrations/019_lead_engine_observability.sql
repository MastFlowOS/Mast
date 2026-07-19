-- Phase 7 — Lead Engine Observability & Operations Dashboard Schema

-- 1. Add internal_role to profiles for future-proof role-based access control
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS internal_role TEXT CHECK (internal_role IN ('engineer', 'admin', 'support'));

-- 2. Add discovery_plan_id to business_processing_tasks to propagate context
ALTER TABLE public.business_processing_tasks
  ADD COLUMN IF NOT EXISTS discovery_plan_id UUID REFERENCES public.discovery_plans(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_business_processing_tasks_plan_id
  ON public.business_processing_tasks (discovery_plan_id);

-- 3. Create lead_engine_job_metrics for per-job and pipeline stage logging
CREATE TABLE IF NOT EXISTS public.lead_engine_job_metrics (
  id                       UUID        PRIMARY KEY REFERENCES public.discovery_plans(id) ON DELETE CASCADE,
  scrape_job_id            UUID        NOT NULL,
  user_id                  UUID        NOT NULL,
  started_at               TIMESTAMPTZ,
  completed_at             TIMESTAMPTZ,
  runtime_ms               INTEGER,
  time_to_first_lead_ms    INTEGER,
  requested_count          INTEGER     NOT NULL,
  delivered_count          INTEGER     NOT NULL DEFAULT 0,
  completion_status        TEXT        NOT NULL, -- 'completed', 'completed_partial', 'failed', 'cancelled'
  
  -- Discovery Stage Metrics
  businesses_discovered    INTEGER     NOT NULL DEFAULT 0,
  maps_scroll_rounds       INTEGER     NOT NULL DEFAULT 0,
  duplicate_count          INTEGER     NOT NULL DEFAULT 0,
  search_exhaustion_reason TEXT,
  
  -- Enrichment Stage Metrics
  website_success_count    INTEGER     NOT NULL DEFAULT 0,
  website_failure_count    INTEGER     NOT NULL DEFAULT 0,
  website_crawl_time_total_ms BIGINT  NOT NULL DEFAULT 0,
  website_crawl_count      INTEGER     NOT NULL DEFAULT 0,
  email_extraction_success_count INTEGER NOT NULL DEFAULT 0,
  phone_extraction_success_count INTEGER NOT NULL DEFAULT 0,
  
  -- Intelligence Stage Metrics
  instagram_success_count  INTEGER     NOT NULL DEFAULT 0,
  instagram_failure_count  INTEGER     NOT NULL DEFAULT 0,
  instagram_lookup_time_total_ms BIGINT NOT NULL DEFAULT 0,
  instagram_lookup_count   INTEGER     NOT NULL DEFAULT 0,
  ai_insight_generation_time_total_ms BIGINT NOT NULL DEFAULT 0,
  ai_insight_generation_count INTEGER NOT NULL DEFAULT 0,
  
  -- Failure Analytics (counts of individual failures during tasks)
  browser_crashes          INTEGER     NOT NULL DEFAULT 0,
  navigation_timeouts      INTEGER     NOT NULL DEFAULT 0,
  unreachable_websites     INTEGER     NOT NULL DEFAULT 0,
  instagram_unavailables   INTEGER     NOT NULL DEFAULT 0,
  validation_failures      INTEGER     NOT NULL DEFAULT 0,
  user_cancellations       INTEGER     NOT NULL DEFAULT 0,
  
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Index for historical sorting and filtering
CREATE INDEX IF NOT EXISTS idx_lead_engine_job_metrics_created
  ON public.lead_engine_job_metrics (created_at DESC);

-- Enable RLS and restrict select to authenticated users who are engineers or admins
ALTER TABLE public.lead_engine_job_metrics ENABLE ROW LEVEL SECURITY;

CREATE POLICY "engineers see all job metrics" ON public.lead_engine_job_metrics
  FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.profiles
    WHERE profiles.id = auth.uid() AND profiles.internal_role IN ('engineer', 'admin')
  ));

GRANT SELECT, INSERT, UPDATE, DELETE ON public.lead_engine_job_metrics TO service_role;
GRANT SELECT ON public.lead_engine_job_metrics TO authenticated;

-- 4. Create lead_engine_snapshots for time-series analytics
CREATE TABLE IF NOT EXISTS public.lead_engine_snapshots (
  id                            BIGSERIAL   PRIMARY KEY,
  timestamp                     TIMESTAMPTZ NOT NULL DEFAULT now(),
  
  -- Active worker counts
  active_workers                INTEGER     NOT NULL DEFAULT 0,
  idle_workers                  INTEGER     NOT NULL DEFAULT 0,
  
  -- Queue depths
  queue_depth_plan              INTEGER     NOT NULL DEFAULT 0,
  queue_depth_task              INTEGER     NOT NULL DEFAULT 0,
  queue_depth_enrich            INTEGER     NOT NULL DEFAULT 0,
  queue_depth_score             INTEGER     NOT NULL DEFAULT 0,
  queue_depth_live              INTEGER     NOT NULL DEFAULT 0,
  
  -- Queue performance (last 1 hour average)
  avg_wait_time_task_ms         INTEGER     NOT NULL DEFAULT 0,
  avg_wait_time_enrich_ms       INTEGER     NOT NULL DEFAULT 0,
  avg_wait_time_score_ms        INTEGER     NOT NULL DEFAULT 0,
  
  avg_processing_time_task_ms   INTEGER     NOT NULL DEFAULT 0,
  avg_processing_time_enrich_ms INTEGER     NOT NULL DEFAULT 0,
  avg_processing_time_score_ms  INTEGER     NOT NULL DEFAULT 0,
  
  -- Cumulative counts across workers
  browser_launches              INTEGER     NOT NULL DEFAULT 0,
  active_browsers               INTEGER     NOT NULL DEFAULT 0,
  active_contexts               INTEGER     NOT NULL DEFAULT 0,
  active_pages                  INTEGER     NOT NULL DEFAULT 0,
  browser_crashes               INTEGER     NOT NULL DEFAULT 0,
  python_subprocess_restarts    INTEGER     NOT NULL DEFAULT 0,
  
  -- Resource stats
  total_free_memory_mb          INTEGER     NOT NULL DEFAULT 0,
  avg_free_memory_mb            INTEGER     NOT NULL DEFAULT 0,
  total_cpu_count               INTEGER     NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_lead_engine_snapshots_timestamp
  ON public.lead_engine_snapshots (timestamp DESC);

ALTER TABLE public.lead_engine_snapshots ENABLE ROW LEVEL SECURITY;

CREATE POLICY "engineers see all snapshots" ON public.lead_engine_snapshots
  FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.profiles
    WHERE profiles.id = auth.uid() AND profiles.internal_role IN ('engineer', 'admin')
  ));

GRANT SELECT, INSERT, UPDATE, DELETE ON public.lead_engine_snapshots TO service_role;
GRANT SELECT ON public.lead_engine_snapshots TO authenticated;


-- 5. Add custom metrics columns to worker_instances table
ALTER TABLE public.worker_instances
  ADD COLUMN IF NOT EXISTS active_tasks INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS browser_launches INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS active_browsers INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS active_contexts INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS active_pages INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS browser_crashes INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS python_subprocess_restarts INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS tasks_completed INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS tasks_failed INTEGER NOT NULL DEFAULT 0;


-- 6. Postgres function to query pg-boss queues, workers, and metrics in one RPC call
CREATE OR REPLACE FUNCTION public.get_lead_engine_stats(p_range_hours INTEGER DEFAULT 24)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_result JSON;
  v_jobs_today INTEGER;
  v_avg_runtime INTEGER;
  v_avg_time_to_first_lead INTEGER;
  v_leads_per_minute NUMERIC;
  v_worker_utilization JSON;
  v_queues JSON;
  v_failures JSON;
  v_performance JSON;
  v_live JSON;
BEGIN
  -- Verify the caller is an engineer/admin
  IF NOT EXISTS (
    SELECT 1 FROM public.profiles
    WHERE profiles.id = auth.uid() AND profiles.internal_role IN ('engineer', 'admin')
  ) AND current_setting('role', true) <> 'service_role' THEN
    RAISE EXCEPTION 'Access denied. Engineering role required.';
  END IF;

  -- 1. Overview metrics (last 24 hours / today)
  SELECT COUNT(*)::INTEGER INTO v_jobs_today
  FROM public.lead_engine_job_metrics
  WHERE started_at >= now() - INTERVAL '24 hours';

  SELECT COALESCE(AVG(runtime_ms), 0)::INTEGER INTO v_avg_runtime
  FROM public.lead_engine_job_metrics
  WHERE started_at >= now() - INTERVAL '24 hours' AND completion_status IN ('completed', 'completed_partial');

  SELECT COALESCE(AVG(time_to_first_lead_ms), 0)::INTEGER INTO v_avg_time_to_first_lead
  FROM public.lead_engine_job_metrics
  WHERE started_at >= now() - INTERVAL '24 hours' AND time_to_first_lead_ms IS NOT NULL;

  -- Leads per minute from all jobs started in the last 2 hours
  SELECT COALESCE(
    SUM(delivered_count)::NUMERIC / 
    NULLIF(EXTRACT(EPOCH FROM (SUM(COALESCE(completed_at, now()) - started_at))) / 60, 0),
    0
  )::NUMERIC(10,2) INTO v_leads_per_minute
  FROM public.lead_engine_job_metrics
  WHERE started_at >= now() - INTERVAL '2 hours';

  -- 2. Worker Utilization
  SELECT json_build_object(
    'active_workers', COUNT(*)::INTEGER,
    'total_concurrency_cap', SUM(effective_concurrency)::INTEGER,
    'total_free_memory_mb', SUM(free_memory_mb)::INTEGER,
    'browser_pool', (
      SELECT COALESCE(json_agg(w), '[]'::json) FROM (
        SELECT id, pool_type, effective_concurrency, configured_concurrency, free_memory_mb, cpu_count,
               active_tasks, browser_launches, active_browsers, active_contexts, active_pages, browser_crashes,
               python_subprocess_restarts, tasks_completed, tasks_failed,
               EXTRACT(EPOCH FROM (now() - last_heartbeat_at))::INTEGER AS seconds_since_heartbeat
        FROM public.worker_instances
        WHERE last_heartbeat_at >= now() - INTERVAL '5 minutes'
      ) w
    )
  ) INTO v_worker_utilization;

  -- 3. Queues (directly from pgboss.job if available, otherwise fallback using pg-boss standard queries)
  BEGIN
    SELECT json_agg(q) INTO v_queues FROM (
      SELECT name, state, COUNT(*)::INTEGER AS count
      FROM pgboss.job
      WHERE name IN ('discovery.plan', 'discovery.task', 'discover.live', 'pool.expand', 'pool.verify', 'business.enrich', 'business.score')
      GROUP BY name, state
    ) q;
  EXCEPTION WHEN OTHERS THEN
    v_queues := '[]'::json;
  END;

  -- 4. Failures Analytics
  SELECT json_build_object(
    'browser_crashes', COALESCE(SUM(browser_crashes), 0)::INTEGER,
    'navigation_timeouts', COALESCE(SUM(navigation_timeouts), 0)::INTEGER,
    'unreachable_websites', COALESCE(SUM(unreachable_websites), 0)::INTEGER,
    'instagram_unavailables', COALESCE(SUM(instagram_unavailables), 0)::INTEGER,
    'validation_failures', COALESCE(SUM(validation_failures), 0)::INTEGER,
    'user_cancellations', COALESCE(SUM(user_cancellations), 0)::INTEGER,
    'failed_jobs_count', (
      SELECT COUNT(*)::INTEGER FROM public.lead_engine_job_metrics
      WHERE started_at >= now() - (p_range_hours || ' hours')::INTERVAL AND completion_status = 'failed'
    ),
    'cancelled_jobs_count', (
      SELECT COUNT(*)::INTEGER FROM public.lead_engine_job_metrics
      WHERE started_at >= now() - (p_range_hours || ' hours')::INTERVAL AND completion_status = 'cancelled'
    )
  ) INTO v_failures
  FROM public.lead_engine_job_metrics
  WHERE started_at >= now() - (p_range_hours || ' hours')::INTERVAL;

  -- 5. Historical performance snapshots
  SELECT json_agg(p) INTO v_performance FROM (
    SELECT timestamp, active_workers, idle_workers,
           (queue_depth_plan + queue_depth_task + queue_depth_live) AS queue_depth_discovery,
           queue_depth_enrich, queue_depth_score,
           avg_wait_time_task_ms, avg_wait_time_enrich_ms, avg_wait_time_score_ms,
           browser_launches, active_browsers, browser_crashes, python_subprocess_restarts,
           avg_free_memory_mb
    FROM public.lead_engine_snapshots
    WHERE timestamp >= now() - (p_range_hours || ' hours')::INTERVAL
    ORDER BY timestamp ASC
  ) p;

  -- 6. Live Operations: Currently running jobs, active tasks and workers
  SELECT json_build_object(
    'running_jobs', (
      SELECT COALESCE(json_agg(j), '[]'::json) FROM (
        SELECT dp.id, dp.niche, dp.region, dp.requested_count, dp.delivered_count, dp.status,
               dp.started_at, extract(epoch from (now() - dp.started_at))::integer as elapsed_seconds,
               p.email as user_email
        FROM public.discovery_plans dp
        JOIN public.profiles p ON dp.user_id = p.id
        WHERE dp.status = 'running'
        ORDER BY dp.started_at DESC
        LIMIT 10
      ) j
    ),
    'running_tasks', (
      SELECT COALESCE(json_agg(t), '[]'::json) FROM (
        SELECT id, plan_id, niche, country_code, city, source, status, attempts,
               discovered_count, accepted_count, extract(epoch from (now() - started_at))::integer as elapsed_seconds
        FROM public.discovery_tasks
        WHERE status = 'running'
        ORDER BY started_at DESC
        LIMIT 10
      ) t
    ),
    'running_processing_tasks', (
      SELECT COALESCE(json_agg(pt), '[]'::json) FROM (
        SELECT bpt.id, bpt.business_id, bpt.kind, bpt.status, bpt.attempts, b.name as business_name,
               extract(epoch from (now() - bpt.started_at))::integer as elapsed_seconds
        FROM public.business_processing_tasks bpt
        JOIN public.businesses b ON bpt.business_id = b.id
        WHERE bpt.status = 'running'
        ORDER BY bpt.started_at DESC
        LIMIT 10
      ) pt
    )
  ) INTO v_live;

  -- Assemble final JSON payload
  v_result := json_build_object(
    'overview', json_build_object(
      'jobs_today', v_jobs_today,
      'avg_runtime_ms', v_avg_runtime,
      'avg_time_to_first_lead_ms', v_avg_time_to_first_lead,
      'leads_per_minute', v_leads_per_minute
    ),
    'worker_utilization', v_worker_utilization,
    'queues', COALESCE(v_queues, '[]'::json),
    'failures', v_failures,
    'performance', COALESCE(v_performance, '[]'::json),
    'live', v_live
  );

  RETURN v_result;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_lead_engine_stats(INTEGER) TO service_role;
GRANT EXECUTE ON FUNCTION public.get_lead_engine_stats(INTEGER) TO authenticated;
