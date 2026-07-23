// AUDIT FIX (Verification Report, Finding 6 — jobs permanently remaining
// in STREAMING): poolExpandJob had no heartbeat, no stale-task table, and
// no timeout wrapping its per-lead search loop. A crashed/hung invocation
// left `scrape_jobs.status = 'streaming'` with no code path anywhere that
// would ever revisit it — confirmed directly against production (12 of 34
// `instant_pool_ranked` rows stuck this way, ~35%).
//
// poolExpandJob now pulses `scrape_jobs.last_heartbeat_at` every 15s while
// it runs (see jobs/poolExpandJob.ts). This sweep runs on a schedule and
// reclaims any 'streaming' row whose heartbeat has gone stale — i.e. the
// process that was supposed to be updating it is gone — by moving it to a
// terminal 'failed' state so:
//   1. the frontend's Realtime subscription (which already handles
//      status-change events) stops waiting on a job nothing will ever
//      finish, and
//   2. the row no longer masks the underlying crash from anyone querying
//      scrape_jobs for "is anything actually still running".
//
// This intentionally does NOT try to resume or re-enqueue the search —
// unlike discovery_tasks, a poolExpandJob invocation has no serializable
// "resume point" (it's mid-loop across niches/countries/rounds), so the
// safest reclaim is a clean terminal failure the user/UI can react to.
import { supabaseAdmin } from "../lib/supabaseAdmin.js";
import { env } from "../config/env.js";

export async function sweepStaleScrapeJobs(): Promise<{ reclaimed: number }> {
  const staleBefore = new Date(Date.now() - env.STALE_SCRAPE_JOB_TIMEOUT_MS).toISOString();

  // Only reclaim rows that HAD a heartbeat and it went stale, or that have
  // been 'streaming' with no heartbeat at all for longer than the timeout
  // (covers any row created before this migration/deploy landed).
  const { data: staleRows, error: selectErr } = await supabaseAdmin
    .from("scrape_jobs")
    .select("id, last_heartbeat_at, started_at")
    .eq("status", "streaming")
    .or(`last_heartbeat_at.lt.${staleBefore},and(last_heartbeat_at.is.null,started_at.lt.${staleBefore})`);

  if (selectErr) {
    console.error("[staleScrapeJobSweep] failed to query stale streaming jobs (non-fatal):", selectErr);
    return { reclaimed: 0 };
  }

  if (!staleRows || staleRows.length === 0) {
    return { reclaimed: 0 };
  }

  const ids = staleRows.map((row) => row.id);

  const { error: updateErr } = await supabaseAdmin
    .from("scrape_jobs")
    .update({
      status: "failed",
      error: `Reclaimed by staleScrapeJobSweep: no heartbeat for over ${env.STALE_SCRAPE_JOB_TIMEOUT_MS / 1000}s — the process running this job likely crashed.`,
      completed_at: new Date().toISOString(),
    })
    .in("id", ids)
    .eq("status", "streaming"); // re-check status to avoid racing a real update that landed between select and update

  if (updateErr) {
    console.error("[staleScrapeJobSweep] failed to reclaim stale streaming jobs (non-fatal):", updateErr);
    return { reclaimed: 0 };
  }

  console.warn(`[staleScrapeJobSweep] reclaimed ${ids.length} stale 'streaming' scrape_jobs row(s): ${ids.join(", ")}`);
  return { reclaimed: ids.length };
}
