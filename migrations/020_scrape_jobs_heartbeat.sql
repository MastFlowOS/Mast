-- MAST Lead Engine — scrape_jobs heartbeat (Verification Report, Finding 6)
--
-- poolExpandJob (unlike discoveryPlanJob's discovery_tasks) had no
-- heartbeat, no stale-task table, and no timeout wrapping its per-lead
-- loop. A crashed/hung invocation left scrape_jobs.status = 'streaming'
-- forever, with no code path anywhere that would ever revisit it —
-- confirmed directly against production (12/34 instant_pool_ranked rows
-- stuck in 'streaming'). This migration adds the same
-- heartbeat-based-staleness column discovery_tasks/business_processing_tasks
-- already have, so a scheduled sweep can reclaim rows a crashed
-- poolExpandJob invocation left behind (see jobs/staleScrapeJobSweep.ts).

ALTER TABLE scrape_jobs
  ADD COLUMN IF NOT EXISTS last_heartbeat_at timestamptz;

-- Index so the stale-job sweep query (status='streaming' AND heartbeat <
-- threshold) is fast even at scale.
CREATE INDEX IF NOT EXISTS idx_scrape_jobs_heartbeat
  ON scrape_jobs (status, last_heartbeat_at)
  WHERE status = 'streaming';
