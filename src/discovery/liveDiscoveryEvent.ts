/**
 * MAST — Live Discovery Event Infrastructure (Task 1 of 3).
 *
 * This module is the "one normalized live discovery event stream" the task
 * asks for: a canonical, truthful event shape plus pure builder functions,
 * and a small process-local pub/sub keyed by discovery_plans.id — the same
 * "process-local registry keyed by durable id" pattern already established
 * by requestLifecycle.ts (registerRequestAbortController /
 * registerRequestEngineProcess), reused here rather than inventing a new
 * transport.
 *
 * SCOPE / WHAT THIS DOES NOT DO (see the Task 1 final report for the full
 * audit):
 *   - No frontend. Nothing here renders anything; it is a typed event plus
 *     a subscribe() call a future (Task 3) consumer can use.
 *   - No new engine/Python events. Every builder below is fed data that
 *     ALREADY exists at its call site in discoveryPlanJob.ts — pipeline id,
 *     business name, rejection reason strings, area/street name, scout
 *     (worker-slot) index. Nothing is invented.
 *   - No change to target/delivered/credit accounting. `deliveredCount` /
 *     `target` on these events are populated FROM the existing
 *     discovery_plans.delivered_count / requested_count columns at the
 *     checkpoints discoveryPlanJob.ts already reads them — this module
 *     never increments or derives a second counter.
 *
 * SCOUT IDENTITY — see googleAreaPool.ts's `workerLoop(slotIndex)`. Each of
 * the (dynamically many, task says "3" as the common case for small
 * requests — see desiredWorkersForQuantity()) concurrent area workers for
 * one discovery task is a `workerLoop` invocation with a fixed `slotIndex`
 * assigned once, in order, before any area is claimed — never based on
 * which worker happens to emit an event first. That `slotIndex` (1-indexed
 * here as `scoutId`) is threaded through `runArea()` (see
 * RunAreaWorkerPoolParams.runArea's updated signature) into
 * runOneAreaAttempt() and back out onto every event built below. It is
 * stable for the lifetime of one discovery_plans row's execution.
 */

import { randomUUID } from "node:crypto";
import { supabaseAdmin } from "../lib/supabaseAdmin.js";

/** Every canonical live-discovery event type this module currently emits. */
export type DiscoveryLiveEventType =
  | "scout_started"
  | "area_started"
  | "candidate_discovered"
  | "candidate_rejected"
  | "lead_delivered"
  | "area_completed"
  | "discovery_completed"
  | "discovery_failed";

/**
 * One normalized live-discovery event.
 *
 * Every field below is either always present or documented as to exactly
 * when it is present — there is no "maybe filled in later" ambiguity. A
 * frontend (Task 3) can switch on `type` and know precisely which optional
 * fields to expect.
 */
export type DiscoveryLiveEvent = {
  id: string;
  timestamp: number;
  planId: string;
  type: DiscoveryLiveEventType;

  /**
   * 1-indexed worker-slot identity — see this file's module doc comment.
   * Present on every event except plan-level `discovery_completed` /
   * `discovery_failed`, which are not scoped to one scout.
   */
  scoutId?: number;

  /** discoveryPlanJob.ts's `area` (curated area) or `street` (street-pool) label — real or absent, never invented. */
  areaLabel?: string;

  /**
   * `lead._pipeline_id` — the Python engine's own `#N` PipelineTracer id
   * for this candidate (see mast-lead-engine/utils/pipeline_trace.py).
   * Present on candidate_discovered/candidate_rejected/lead_delivered.
   * NOTE (audit finding, see final report): this is a DIFFERENT id space
   * than the `item_id`/`place_key` carried on the Python "discovery"-stage
   * `"type":"progress"` stdout events (candidate_discovered/
   * candidate_queued emitted from maps_scraper.py) — the two cannot
   * currently be joined. This field always refers to the pipeline id, not
   * the place_key.
   */
  pipelineId?: string;

  /** Real business name, only ever set once discoveryPlanJob.ts has the full lead dict (never guessed earlier). */
  businessName?: string;

  /**
   * The real, existing reason string already computed at the rejection
   * call site in discoveryPlanJob.ts's runOneAreaAttempt() (e.g. the exact
   * `validateDiscoveryCandidate` reason, the maps/post-enrichment channel
   * gate description, "plan_limit_reached", "duplicate_already_owned_by_user").
   * Never a newly invented taxonomy — see this file's module doc comment.
   */
  reason?: string;

  /**
   * discovery_plans.delivered_count / requested_count, read fresh at the
   * checkpoints discoveryPlanJob.ts already queries them (area_completed /
   * discovery_completed) — never a second, independently-tracked counter.
   * Omitted on the high-frequency candidate_discovered/candidate_rejected/
   * lead_delivered events to avoid an extra DB read per candidate; a
   * consumer wanting a live running total should tally lead_delivered
   * events itself or poll the plan row, per this task's own scope limit
   * (no frontend-state reducer here).
   */
  deliveredCount?: number;
  target?: number;

  /**
   * Only on area_completed — the real per-area outcome already computed by
   * runOneAreaAttempt() / AreaRunOutcome (googleAreaPool.ts), not re-derived.
   *
   * TASK 2 (live scout state) — `failed`/`error` added here: both already
   * existed on the real AreaRunOutcome the caller has in hand (see
   * googleAreaPool.ts), just weren't previously copied onto this event.
   * Widening this type is additive/non-breaking (existing callers that omit
   * them are unaffected) and lets Task 2's reducer distinguish a genuinely
   * recoverable area-run error from an area that simply had nothing to
   * deliver, without inventing a signal that wasn't already there.
   */
  areaOutcome?: {
    discovered: number;
    accepted: number;
    rejected: number;
    duplicates: number;
    exhausted: boolean;
    failed?: boolean;
    error?: string;
  };

  /** Only on discovery_failed. */
  failureReason?: string;
};

let _seq = 0;
function nextId(): string {
  // randomUUID for global uniqueness across process restarts/log
  // correlation; _seq is purely a cheap tie-breaker for same-millisecond
  // ordering when reading raw logs — never used as the sole identity.
  _seq += 1;
  return `${randomUUID()}-${_seq}`;
}

function baseEvent(planId: string, type: DiscoveryLiveEventType): Pick<DiscoveryLiveEvent, "id" | "timestamp" | "planId" | "type"> {
  return { id: nextId(), timestamp: Date.now(), planId, type };
}

// ── Pure builders — every one takes only data the caller already has ──────

export function scoutStartedEvent(planId: string, scoutId: number, areaLabel?: string): DiscoveryLiveEvent {
  return { ...baseEvent(planId, "scout_started"), scoutId, areaLabel };
}

export function areaStartedEvent(planId: string, scoutId: number, areaLabel: string | undefined): DiscoveryLiveEvent {
  return { ...baseEvent(planId, "area_started"), scoutId, areaLabel };
}

export function candidateDiscoveredEvent(
  planId: string,
  scoutId: number,
  pipelineId: string,
  businessName: string | undefined,
  areaLabel: string | undefined,
): DiscoveryLiveEvent {
  return { ...baseEvent(planId, "candidate_discovered"), scoutId, pipelineId, businessName, areaLabel };
}

export function candidateRejectedEvent(
  planId: string,
  scoutId: number,
  pipelineId: string,
  reason: string,
  areaLabel: string | undefined,
): DiscoveryLiveEvent {
  return { ...baseEvent(planId, "candidate_rejected"), scoutId, pipelineId, reason, areaLabel };
}

export function leadDeliveredEvent(
  planId: string,
  scoutId: number,
  pipelineId: string,
  businessName: string | undefined,
  areaLabel: string | undefined,
): DiscoveryLiveEvent {
  return { ...baseEvent(planId, "lead_delivered"), scoutId, pipelineId, businessName, areaLabel };
}

export function areaCompletedEvent(
  planId: string,
  scoutId: number,
  areaLabel: string | undefined,
  areaOutcome: DiscoveryLiveEvent["areaOutcome"],
  totals?: { deliveredCount: number; target: number },
): DiscoveryLiveEvent {
  return {
    ...baseEvent(planId, "area_completed"),
    scoutId,
    areaLabel,
    areaOutcome,
    deliveredCount: totals?.deliveredCount,
    target: totals?.target,
  };
}

export function discoveryCompletedEvent(planId: string, deliveredCount: number, target: number): DiscoveryLiveEvent {
  return { ...baseEvent(planId, "discovery_completed"), deliveredCount, target };
}

export function discoveryFailedEvent(planId: string, failureReason: string): DiscoveryLiveEvent {
  return { ...baseEvent(planId, "discovery_failed"), failureReason };
}

// ── Process-local pub/sub, keyed by discovery_plans.id ─────────────────────
//
// Mirrors requestLifecycle.ts's runtimes Map exactly: process-local (a
// durable cross-worker transport, e.g. persisting these to a table an SSE
// endpoint reads, is a Task 2/3 decision — see this file's module doc
// comment), garbage-collected the moment the last listener unsubscribes so
// a long-running worker process can never accumulate dead subscriber sets
// the way requestLifecycle.ts's own doc comment describes fixing for its
// controllers/processes Sets.

type Listener = (event: DiscoveryLiveEvent) => void;

const listenersByPlan = new Map<string, Set<Listener>>();

/** Subscribes to every live event published for one discovery plan. Returns an unsubscribe function. */
export function subscribeToDiscoveryLiveEvents(planId: string, listener: Listener): () => void {
  let set = listenersByPlan.get(planId);
  if (!set) {
    set = new Set();
    listenersByPlan.set(planId, set);
  }
  set.add(listener);
  return () => {
    set!.delete(listener);
    if (set!.size === 0) listenersByPlan.delete(planId);
  };
}

/**
 * Publishes one event to every current in-process subscriber of its plan
 * (a no-op — not an error — when nobody is listening, matching PHASE 25's
 * "purely observational" contract for pythonBridge.ts's onProgress), AND
 * persists it to `discovery_live_events` for cross-process delivery to the
 * browser (Task 3 — see migrations/033_discovery_live_events.sql's doc
 * comment for why: this publisher only ever runs in the worker process,
 * which the browser can't reach directly, so persistence + Supabase
 * Realtime's existing `postgres_changes` pattern is the transport, not this
 * in-memory Map). The persistence write is fire-and-forget and can never
 * throw into or block the caller — discovery itself must never be gated on
 * it, same principle as the in-process fan-out above.
 */
export function publishDiscoveryLiveEvent(event: DiscoveryLiveEvent): void {
  const set = listenersByPlan.get(event.planId);
  if (set && set.size > 0) {
    for (const listener of set) {
      try {
        listener(event);
      } catch (err) {
        console.debug("[live-discovery-event] listener threw — ignored", err);
      }
    }
  }
  void persistDiscoveryLiveEvent(event);
}

/**
 * Fire-and-forget insert of one event into `discovery_live_events`. Not
 * exported for reuse elsewhere — this is purely publishDiscoveryLiveEvent's
 * own cross-process delivery mechanism (Task 3). Uses supabaseAdmin
 * (service-role, bypasses RLS) since this only ever runs worker-side.
 * `discovery_live_events` predates this codebase's generated `Database`
 * types (see migrations/033_discovery_live_events.sql), so `.from(...)` is
 * cast the same way discover.ts's cancel route already does for
 * `discovery_plans` / `discovery_tasks`.
 */
async function persistDiscoveryLiveEvent(event: DiscoveryLiveEvent): Promise<void> {
  try {
    const { error } = await (supabaseAdmin as any).from("discovery_live_events").insert({
      plan_id: event.planId,
      event_id: event.id,
      event_type: event.type,
      scout_id: event.scoutId ?? null,
      area_label: event.areaLabel ?? null,
      pipeline_id: event.pipelineId ?? null,
      business_name: event.businessName ?? null,
      reason: event.reason ?? null,
      delivered_count: event.deliveredCount ?? null,
      target: event.target ?? null,
      area_outcome: event.areaOutcome ?? null,
      failure_reason: event.failureReason ?? null,
      event_timestamp: new Date(event.timestamp).toISOString(),
    });
    if (error) {
      console.debug("[live-discovery-event] persistence insert failed — ignored (non-fatal)", error);
    }
  } catch (err) {
    console.debug("[live-discovery-event] persistence insert threw — ignored (non-fatal)", err);
  }
}

export const __testing = {
  reset: () => listenersByPlan.clear(),
  listenerCount: (planId: string) => listenersByPlan.get(planId)?.size ?? 0,
};
