import { supabaseAdmin } from "../lib/supabaseAdmin.js";
import { getBoss, QUEUES } from "../lib/queue.js";
import { resolveCountriesForSelection } from "../lib/geo/regions.js";
import { splitNicheQuery } from "../lib/niches.js";

export type DiscoveryPlanRequest = {
  scrapeJobId: string;
  userId: string;
  region: string;
  niche: string;
  channels: string[];
  currencies?: string[];
  professionSlug: string | null;
  quantity: number;
  dailyLimit: number;
  monthlyLimit: number;
};

type LocationStat = { country_code: string; city: string; accepted_count: number; searches: number; last_searched_at: string | null };

const db = supabaseAdmin as any;

/** Creates a durable plan.  The plan queue performs fan-out so a gateway
 * timeout/restart cannot leave a half-created collection of city jobs. */
export async function enqueueDiscoveryPlan(request: DiscoveryPlanRequest): Promise<string> {
  const { data, error } = await db
    .from("discovery_plans")
    .upsert({
      scrape_job_id: request.scrapeJobId,
      user_id: request.userId,
      niche: request.niche,
      region: request.region,
      channels: request.channels,
      currencies: request.currencies ?? [],
      profession_slug: request.professionSlug,
      requested_count: request.quantity,
    }, { onConflict: "scrape_job_id" })
    .select("id")
    .single();
  if (error) throw error;

  const boss = await getBoss();
  await boss.send(QUEUES.discoveryPlan, { planId: data.id, ...request });
  return data.id as string;
}

function stableRank(value: string): number {
  let hash = 2166136261;
  for (const char of value) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return hash >>> 0;
}

/**
 * Expands a plan to separate city work units.  Historical acceptance rate and
 * recency decide city order, with a plan-id tie breaker to keep neighbouring
 * plans geographically distributed instead of repeatedly hammering a capital.
 */
export async function materializeDiscoveryPlan(planId: string, request: DiscoveryPlanRequest): Promise<void> {
  const countries = resolveCountriesForSelection(request.region, { currencies: request.currencies });
  const niches = splitNicheQuery(request.niche);
  if (!countries.length || !niches.length) throw new Error("Discovery plan has no searchable country or niche");

  const { data: historical } = await db
    .from("discovery_location_stats")
    .select("country_code, city, accepted_count, searches, last_searched_at")
    .eq("source", "google_maps")
    .in("niche", niches);
  const stats = new Map<string, LocationStat>();
  for (const row of (historical ?? []) as LocationStat[]) stats.set(`${row.country_code}:${row.city}`, row);

  const targets = countries.flatMap((country) => country.majorCities.map((city) => ({ country, city })))
    .sort((a, b) => {
      const sa = stats.get(`${a.country.code}:${a.city}`);
      const sb = stats.get(`${b.country.code}:${b.city}`);
      const yieldA = sa ? sa.accepted_count / Math.max(sa.searches, 1) : 1;
      const yieldB = sb ? sb.accepted_count / Math.max(sb.searches, 1) : 1;
      if (yieldA !== yieldB) return yieldB - yieldA;
      const recentA = sa?.last_searched_at ? Date.parse(sa.last_searched_at) : 0;
      const recentB = sb?.last_searched_at ? Date.parse(sb.last_searched_at) : 0;
      if (recentA !== recentB) return recentA - recentB;
      return stableRank(`${planId}:${a.country.code}:${a.city}`) - stableRank(`${planId}:${b.country.code}:${b.city}`);
    });

  const taskCount = targets.length * niches.length;
  const candidateBudget = Math.max(20, Math.ceil((request.quantity * 4) / Math.max(taskCount, 1)));
  const rows = niches.flatMap((niche) => targets.map(({ country, city }, priority) => ({
    plan_id: planId,
    niche,
    country_code: country.code,
    country_name: country.name,
    city,
    candidate_budget: candidateBudget,
    priority: taskCount - priority,
  })));

  const { error } = await db.from("discovery_tasks").upsert(rows, { onConflict: "plan_id,niche,country_code,city,source", ignoreDuplicates: true });
  if (error) throw error;
  await db.from("discovery_plans").update({ status: "running", started_at: new Date().toISOString() }).eq("id", planId);
  await dispatchQueuedDiscoveryTasks(planId, request);
}

/**
 * RELIABILITY FIX: discovery.task work is a Playwright/browser subprocess
 * (see runEngineQuery in scraperBridge/pythonBridge.ts) — browser crashes,
 * page crashes, and navigation timeouts are expected, recoverable failures
 * for this queue specifically, not a reason to give up on a city/niche.
 * pg-boss's global default (queue.ts: retryLimit 3) is shared by every
 * queue, including ones where a failure IS more likely to be permanent
 * (e.g. a malformed payload). discovery.task gets its own, much more
 * patient policy here so "restart the worker/browser and resume" (per the
 * reliability requirement) actually gets enough attempts to succeed before
 * the task is given up on. DISCOVERY_TASK_MAX_ATTEMPTS in
 * jobs/discoveryPlanJob.ts mirrors retryLimit + 1 so the DB-side attempts
 * counter and pg-boss's own retry budget agree on when a task is truly done
 * retrying (as opposed to being stuck "queued" forever with no worker ever
 * picking it up again — the bug this fixes).
 */
export const DISCOVERY_TASK_RETRY_OPTIONS = {
  retryLimit: 8,
  retryBackoff: true,
  retryDelay: 3,
};

export async function dispatchQueuedDiscoveryTasks(planId: string, request: DiscoveryPlanRequest): Promise<void> {
  const { data, error } = await db
    .from("discovery_tasks")
    .select("id")
    .eq("plan_id", planId)
    .eq("status", "queued")
    .order("priority", { ascending: false });
  if (error) throw error;
  const boss = await getBoss();
  for (const task of data ?? []) {
    await boss.send(QUEUES.discoveryTask, { taskId: task.id, planId, request }, DISCOVERY_TASK_RETRY_OPTIONS);
  }
}
