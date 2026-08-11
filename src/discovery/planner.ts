import { supabaseAdmin } from "../lib/supabaseAdmin.js";
import { getBoss, QUEUES } from "../lib/queue.js";
import { resolveCountriesForSelection } from "../lib/geo/regions.js";
import { splitNicheQuery } from "../lib/niches.js";
import { getPlan, getPlanConcurrency, type PlanId } from "../config/plans.js";
import { env } from "../config/env.js";
import { computeDispatchSlots } from "./cityScheduling.js";


export type DiscoveryPlanRequest = {
  scrapeJobId: string;
  userId: string;
  planId?: string;       // resolved plan tier id (e.g. "pro") — optional, used for priority banding
  region: string;
  niche: string;
  channels: string[];
  currencies?: string[];
  professionSlug: string | null;
  quantity: number;
  dailyLimit: number;
  monthlyLimit: number;
};


export type LocationStat = { country_code: string; city: string; accepted_count: number; searches: number; last_searched_at: string | null };

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
 * PHASE 3C-1 STEP 3 — candidate-budget audit.
 *
 * `Math.max(20, quantity * 4)` (the pre-3C-1 formula) is the RAW scan budget
 * handed to the discovery provider for a single city/niche task — i.e. how
 * many Maps places `MapsScraper.search()` may look at before giving up on
 * that city, entirely independent of `deliver_target` (which Node never
 * even sets today — `discoveryProvider.ts`'s `DiscoverySearchOptions` has
 * no `deliverTarget` field, and `googleMapsProvider.ts` never passes one
 * through to `runEngineQuery`). It exists per-city, not per-request: it is
 * stamped onto every `discovery_tasks` row at materialization time
 * (`candidate_budget` column), so every city in a plan got the exact same
 * raw scan allowance regardless of that city's known track record. The `*
 * 4` multiplier is a fixed buffer over the requested lead count to absorb
 * enrichment/filter/dedup losses (see this file's own comment above where
 * it's computed); `20` is a floor so a small request (e.g. quantity=1)
 * still gets one meaningful qualification round instead of stopping after
 * a handful of candidates.
 *
 * Audit finding: a uniform budget wastes time in exactly the way this
 * phase's objective describes — a city with a strong historical
 * acceptance rate does not need the FULL raw-scan allowance to fill its
 * share of the target (it converts candidates to accepted leads fast, so
 * `deliverLead`'s plan-level target check and `dispatchQueuedDiscoveryTasks`
 * top-up already move on before the budget is exhausted MOST of the time —
 * but on the runs where a productive city's supply of qualifying
 * candidates thins out, it still scans the full, unreduced budget before
 * conceding, which is exactly the "productive city keeps scanning after
 * it's already done its job" waste this phase is meant to eliminate). A
 * city with a poor or unknown track record must NOT receive a reduced
 * budget — shrinking it would be indistinguishable from giving up early,
 * which risks a city that would have converted with more looking never
 * getting the chance (this is the "still gets a fair opportunity"
 * requirement). `materializeDiscoveryPlan` already computes exactly the
 * historical accepted/searches ratio needed for this decision (for city
 * ordering) — reusing it here for budget sizing needs no new query.
 *
 * This is intentionally a bounded EFFICIENCY nudge, not a new arbitrary
 * constant: the floor (`DEFAULT_CANDIDATE_BUDGET_FLOOR`) and base formula
 * are unchanged, only high-confidence-productive cities get a smaller
 * (still floored) budget. `CityYieldSample` requires a minimum sample size
 * (`MIN_YIELD_SAMPLE_SEARCHES`) before a city's yield is trusted at all —
 * one lucky/unlucky search must not swing a budget decision.
 */
export const DEFAULT_CANDIDATE_BUDGET_FLOOR = 20;
export const CANDIDATE_BUDGET_MULTIPLIER = 4;
/** A city needs at least this many historical searches before its yield is trusted for budget sizing. */
export const MIN_YIELD_SAMPLE_SEARCHES = 3;
/** Accepted/searches ratio at or above which a city is treated as reliably productive. */
export const HIGH_YIELD_THRESHOLD = 0.5;
/** How much smaller a reliably-productive city's raw scan budget is allowed to shrink to. */
export const PRODUCTIVE_CITY_BUDGET_FACTOR = 0.6;

/**
 * Historical accepted/searches ratio for one city, or `undefined` when
 * there isn't yet a trustworthy sample (no history at all, or fewer than
 * `MIN_YIELD_SAMPLE_SEARCHES` prior searches) — `undefined` always keeps
 * the unreduced base budget, the same behavior as before this phase.
 */
export function cityYieldFor(
  stats: Map<string, LocationStat>,
  countryCode: string,
  city: string,
): number | undefined {
  const s = stats.get(`${countryCode}:${city}`);
  if (!s || s.searches < MIN_YIELD_SAMPLE_SEARCHES) return undefined;
  return s.accepted_count / s.searches;
}

/**
 * Smallest safe adaptation of the candidate budget: a reliably-productive
 * city (enough history AND a high accepted/searches ratio) gets a smaller
 * — never below the floor — raw scan budget, since it converts candidates
 * quickly and doesn't need the full buffer to make a meaningful
 * qualification decision. Every other case (no history, too little
 * history, or a poor/mediocre ratio) gets the exact unreduced base budget
 * — a poor city's opportunity is never shrunk, only a proven-productive
 * one's excess is trimmed.
 */
export function computeCandidateBudget(quantity: number, cityYield: number | undefined): number {
  const base = Math.max(DEFAULT_CANDIDATE_BUDGET_FLOOR, quantity * CANDIDATE_BUDGET_MULTIPLIER);
  if (cityYield === undefined || cityYield < HIGH_YIELD_THRESHOLD) return base;
  return Math.max(DEFAULT_CANDIDATE_BUDGET_FLOOR, Math.round(base * PRODUCTIVE_CITY_BUDGET_FACTOR));
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
  // A city gets enough raw scan budget to make a meaningful qualification
  // decision on that city. Splitting the request-wide budget across every
  // queued city was the reason a city with a healthy result set could be
  // abandoned after only a handful of accepted leads.
  //
  // PHASE 3C-1 STEP 3: per-target budget, not one constant — see
  // computeCandidateBudget()'s own doc comment above for the full audit.

  // Scale intra-plan yield-based rank into the plan tier’s priority band so
  // cross-tier ordering (premium > pro > starter > free) and within-tier
  // ordering (high-yield cities first) compose without collision.
  // request.planId is the billing plan tier id ("free"|"starter"|"pro"|"premium").
  const tierConfig = getPlan(request.planId ?? null);
  const { base: bandBase, ceiling: bandCeiling } = tierConfig.priorityBand;
  const bandWidth = bandCeiling - bandBase; // e.g. 9 for a 10-point band

  const rows = niches.flatMap((niche) =>
    targets.map(({ country, city }, rankIndex) => {
      // rankIndex 0 = highest yield city (should get highest priority within band)
      // Scale: best city → bandCeiling, worst city → bandBase
      const intraRank = taskCount > 1
        ? Math.round(bandBase + bandWidth * (1 - rankIndex / (taskCount - 1)))
        : bandCeiling;
      const priority = Math.max(bandBase, Math.min(bandCeiling, intraRank));
      const candidateBudget = computeCandidateBudget(
        request.quantity,
        cityYieldFor(stats, country.code, city),
      );

      return {
        plan_id: planId,
        user_id: request.userId,   // denormalised for the concurrency-cap claim index
        // AUDIT FIX (Phase 3B): denormalised so handleDiscoveryTask's and
        // dispatchQueuedDiscoveryTasks' concurrency-cap lookups resolve the
        // user's REAL billing tier instead of silently defaulting to
        // "free" (workerConcurrency: 2) for every task, every plan, always
        // — see discover.ts's now-fixed enqueueDiscoveryPlan call for the
        // other half of this. tierConfig.id (not raw request.planId) so an
        // unrecognised/missing tier normalises to "free" the same way
        // getPlan() already does, instead of storing an invalid id.
        plan_tier_id: tierConfig.id,
        niche,
        country_code: country.code,
        country_name: country.name,
        city,
        candidate_budget: candidateBudget,
        priority,
      };
    }),
  );

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

/**
 * PHASE 3B — bounded discovery concurrency.
 *
 * AUDIT FINDING (root cause of one-city-at-a-time discovery): this used to
 * `.limit(1)` unconditionally, so a plan never had more than one
 * discovery_tasks row "queued"/dispatched at once — regardless of the
 * worker pool's batchSize (workers/index.ts already fetches and runs up to
 * `browserCapacity.effectiveConcurrency` jobs concurrently via
 * `processBatchConcurrently`/`Promise.all`) and regardless of the per-user
 * `workerConcurrency` cap already defined per plan tier (config/plans.ts)
 * and already enforced by handleDiscoveryTask's pre-claim check
 * (discoveryPlanJob.ts). Every piece of infrastructure needed for genuine
 * city/provider parallelism already existed — cross-worker cancellation
 * (requestLifecycle.ts's `runtimes` map is already a Set per request, i.e.
 * already multi-worker-safe), a unique per-task SQLite dedup path
 * (discoveryProvider.ts), and the atomic `claim_discovery_delivery()`
 * reservation (Phase 3A, migrations/015) that caps `accepted <= requested`
 * regardless of how many workers race it. Only the dispatch step itself was
 * serialized.
 *
 * The fix: dispatch up to the user's remaining concurrency headroom
 * (tier cap minus that user's currently-running task count) each time this
 * is called — once from materializeDiscoveryPlan (initial fan-out) and
 * again from handleDiscoveryTask after every task completes (top-up), so
 * the plan sustains up to `concurrencyCap` overlapping city/provider
 * workers until it drains or is satisfied. This mirrors, rather than
 * duplicates, the same cap handleDiscoveryTask already checks — dispatching
 * within the cap here just avoids needlessly round-tripping pg-boss
 * messages that would otherwise be immediately re-queued by that check.
 */
export async function dispatchQueuedDiscoveryTasks(planId: string, request: DiscoveryPlanRequest): Promise<void> {
  const { data: plan } = await db.from("discovery_plans")
    .select("status, delivered_count, requested_count, user_id").eq("id", planId).maybeSingle();
  if (!plan || plan.status === "cancelled" || plan.status === "completed" || plan.delivered_count >= plan.requested_count) return;

  const concurrencyCap = getPlanConcurrency((request.planId as PlanId) ?? "free", env.PLAN_CONCURRENCY_OVERRIDES);

  const { count: runningCount } = await db
    .from("discovery_tasks")
    .select("id", { count: "exact", head: true })
    .eq("user_id", plan.user_id)
    .eq("status", "running");

  // queuedCount is left uncapped here (Number.MAX_SAFE_INTEGER) — the final
  // query's own `.eq("status", "queued")` + `.limit()` already bounds the
  // result to however many queued rows actually exist, so a second COUNT
  // query just to feed that same bound into computeDispatchSlots would be
  // a redundant round trip. computeDispatchSlots still takes queuedCount
  // as a parameter so its cap-bounding arithmetic is independently
  // unit-testable against a finite queue depth.
  const availableSlots = computeDispatchSlots(concurrencyCap, runningCount ?? 0, Number.MAX_SAFE_INTEGER);
  if (availableSlots === 0) return;

  const { data, error } = await db
    .from("discovery_tasks")
    .select("id")
    .eq("plan_id", planId)
    .eq("status", "queued")
    .order("priority", { ascending: false })
    .limit(availableSlots);
  if (error) throw error;
  const dispatchable = data ?? [];
  if (!dispatchable.length) return;

  const boss = await getBoss();
  for (const task of dispatchable) {
    await boss.send(QUEUES.discoveryTask, { taskId: task.id, planId, request }, DISCOVERY_TASK_RETRY_OPTIONS);
  }
  console.info(
    `[discovery] plan=${planId} dispatched=${dispatchable.length} running_before=${runningCount ?? 0} ` +
      `concurrency_cap=${concurrencyCap} active_workers=${(runningCount ?? 0) + dispatchable.length}`,
  );
}
