/**
 * MAST — Live Discovery State (Task 2 of 3).
 *
 * A pure, dependency-free reducer that turns the REAL `DiscoveryLiveEvent`
 * stream Task 1 built (liveDiscoveryEvent.ts, wired up in
 * discoveryPlanJob.ts / googleAreaPool.ts) into the fixed "3 Scouts + one
 * current sentence each + global counters" shape a future Task 3 UI will
 * render.
 *
 * SOURCE OF TRUTH: everything in this file was written by first reading
 * the real Task 1 implementation (not the original conceptual brief) —
 * see the per-mapping comments below for exactly which real event/reason
 * each sentence corresponds to, and where the real event stream turned out
 * to be narrower than the original brief assumed. Nothing here fabricates
 * an event, a count, a reason, or a stage that the real code doesn't
 * actually produce.
 *
 * WHAT THIS FILE DOES NOT DO:
 *   - No timers, no animation loops, no rotating placeholder text.
 *   - No new engine/Node behavior — this only READS `DiscoveryLiveEvent`s
 *     (plus two small, additive, non-behavioral field exposures made
 *     alongside this file — see liveDiscoveryEvent.ts's `areaOutcome`
 *     doc comment and googleAreaPool.ts's `worker_finished` doc comment —
 *     both just copy through data the caller already had in hand).
 *   - No frontend. Task 3 owns rendering; this module owns truth.
 */

import type { DiscoveryLiveEvent } from "./liveDiscoveryEvent.js";

// ── Public shape ────────────────────────────────────────────────────────

export type ScoutId = 1 | 2 | 3;

export type ScoutStatus = "idle" | "active" | "waiting" | "finished" | "error";

export type ScoutLiveState = {
  scoutId: ScoutId;
  status: ScoutStatus;
  sentence: string;
  areaName?: string;
  businessName?: string;
};

export type DiscoveryStatus = "starting" | "discovering" | "completed" | "exhausted" | "failed";

export type DiscoveryLiveState = {
  scouts: Record<ScoutId, ScoutLiveState>;
  delivered: number;
  rejected: number;
  target: number;
  progressPercent: number;
  status: DiscoveryStatus;
  latestEventAt?: number;

  /**
   * Internal de-dup bookkeeping (SPEC #25: "the reducer/state layer should
   * be safe against duplicate event delivery where practical... use the
   * event ID"). Not part of the "3 scouts + counters" display contract —
   * Task 3 has no reason to read this — but exposed (not `#private`) so a
   * caller can persist/rehydrate a reducer instance across process
   * boundaries without losing the guard.
   */
  _internal: {
    /** ids of every lead_delivered/candidate_rejected/discovery_completed/discovery_failed event already applied to a counter or terminal status. */
    processedEventIds: string[];
  };
};

const SCOUT_IDS: ScoutId[] = [1, 2, 3];

function idleScout(scoutId: ScoutId): ScoutLiveState {
  return { scoutId, status: "idle", sentence: "Waiting to start..." };
}

/**
 * Fresh state for a brand-new discovery plan. `target` is
 * `discovery_plans.requested_count`.
 *
 * `initialDelivered` (default 0) seeds the running delivered count for a
 * plan that starts life already partway to its target — e.g. a paid-tier
 * Instant Discovery request whose pool lookup already delivered some
 * results synchronously, before the live pool-expand backfill (and its
 * plan/event stream) even existed. Every subsequent `lead_delivered` event
 * still increments from here by exactly 1 (reduceLiveDiscoveryEvent is
 * unchanged) — this only fixes the starting point, never the increment
 * logic, so a mid-flight paid backfill correctly shows e.g. 5/100 instead
 * of resetting to 0/100.
 */
export function createInitialLiveDiscoveryState(target: number, initialDelivered = 0): DiscoveryLiveState {
  return {
    scouts: { 1: idleScout(1), 2: idleScout(2), 3: idleScout(3) },
    delivered: initialDelivered,
    rejected: 0,
    target,
    progressPercent: computeProgressPercent(initialDelivered, target),
    status: "starting",
    _internal: { processedEventIds: [] },
  };
}

// ── Progress / status arithmetic (SPEC #23/#26) ─────────────────────────

function computeProgressPercent(delivered: number, target: number): number {
  // MOST IMPORTANT (spec #23): rejected NEVER factors into this. Progress
  // is delivered/target ONLY.
  if (target <= 0) return 0;
  return Math.min(100, Math.floor((delivered / target) * 100));
}

function isValidScoutId(scoutId: number | undefined): scoutId is ScoutId {
  return scoutId === 1 || scoutId === 2 || scoutId === 3;
}

function hasProcessed(state: DiscoveryLiveState, eventId: string): boolean {
  return state._internal.processedEventIds.includes(eventId);
}

/** Mutates `next._internal` in place — only ever called on a freshly-cloned draft, never on the input state. */
function markProcessed(next: DiscoveryLiveState, eventId: string): void {
  next._internal.processedEventIds = [...next._internal.processedEventIds, eventId];
}

// ── Sentence mapping ──────────────────────────────────────────────────────
//
// Every function below is fed ONLY data a real DiscoveryLiveEvent carries.
// Where the real reason-string taxonomy (see discoveryPlanJob.ts) is
// narrower than the original conceptual brief assumed — no "chain",
// "restricted category", "closed" (distinct from generic disqualification),
// "instagram_followers_over_limit", or "niche mismatch" reason string is
// EVER actually produced in discovery_only=true live mode; grep against
// discoveryPlanJob.ts / leadValidation.ts confirms this — the specific
// brief-provided sentence for that unreachable case is simply never wired
// to anything. Real reasons fall through to the closest honest generic
// bucket instead of a guessed specific one. See the Task 2 final report
// for the full reason-by-reason audit.

const AREA_SNAG = "This area hit a snag. Trying another one...";
const DISCOVERY_PROBLEM = "Discovery ran into a problem.";
const FINISHED_SEARCHING = "Finished searching.";
const OPPORTUNITY_SECURED = "Opportunity secured 🎯";
const GENERIC_NOT_A_FIT = "Not a fit for this search. Skipping it.";
const GENERIC_NO_CONTACT = "No usable contact details here. Skipping it.";
const NO_WEBSITE = "No usable website here. Skipping it.";
const COULDNT_FIND_CONTACT = "Couldn't find the required contact details. Moving on.";
const ALREADY_GOT_THIS_ONE = "You've already got this one. Skipping it.";
const TARGET_REACHED_WRAPPING_UP = "Target reached. Wrapping up.";

function areaStartSentence(areaLabel: string | undefined): string {
  return areaLabel ? `Exploring ${areaLabel}...` : "Exploring the next area...";
}

function processingSentence(businessName: string | undefined): string {
  return businessName ? `Checking ${businessName}...` : "Checking a promising business...";
}

function extractRequestedChannels(reason: string): string[] | undefined {
  const match = reason.match(/requested=(\[.*\])/);
  if (!match) return undefined;
  try {
    const parsed = JSON.parse(match[1]);
    return Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Real reason strings this can receive, verbatim from discoveryPlanJob.ts
 * (grep-confirmed — see this file's header comment):
 *   validateDiscoveryCandidate:<missing_name|missing_address|
 *     missing_maps_provenance|disqualified|invalid_email_format|
 *     placeholder_email|invalid_phone_format|invalid_website_format|
 *     invalid_instagram_format|no_usable_channel>
 *   maps_channel_gate:requested=[...]        (phone/website only, pre-enrichment)
 *   ensureEnriched_threw
 *   post_enrichment_channel_gate:requested=[...]  (full requested-channel list)
 *   plan_limit_reached
 *   duplicate_already_owned_by_user
 */
function rejectionSentence(reason: string | undefined): string {
  if (!reason) return GENERIC_NOT_A_FIT;

  if (reason === "duplicate_already_owned_by_user") return ALREADY_GOT_THIS_ONE;
  if (reason === "plan_limit_reached") return TARGET_REACHED_WRAPPING_UP;
  // Real cause is a thrown website/Instagram crawl inside ensureEnriched()/
  // ensureIntelligence(); "unreachable website" is the closest honest
  // generic bucket the brief provides. We do NOT know for certain it was
  // specifically the website crawl that threw — this is a best-fit
  // generic, not a guessed specific.
  if (reason === "ensureEnriched_threw") return "Couldn't reach its website. Moving on.";

  if (reason.startsWith("validateDiscoveryCandidate:")) {
    const sub = reason.slice("validateDiscoveryCandidate:".length);
    if (sub === "no_usable_channel") return GENERIC_NO_CONTACT;
    // missing_name / missing_address / missing_maps_provenance /
    // disqualified / invalid_*_format: none of these map to a
    // brief-specific sentence without guessing — e.g. "disqualified"
    // covers BOTH lead.closed AND lead.is_disqualified, and the real
    // reason string does not expose which. Generic fallback.
    return GENERIC_NOT_A_FIT;
  }

  if (reason.startsWith("maps_channel_gate:") || reason.startsWith("post_enrichment_channel_gate:")) {
    const requested = extractRequestedChannels(reason);
    if (requested && requested.length === 1 && requested[0] === "website") return NO_WEBSITE;
    return reason.startsWith("maps_channel_gate:") ? COULDNT_FIND_CONTACT : GENERIC_NO_CONTACT;
  }

  // Unrecognized reason string this reducer has never seen before — stay
  // truthful rather than guess a more specific-sounding sentence.
  return GENERIC_NOT_A_FIT;
}

/**
 * A `plan_limit_reached` rejection is deliberately NOT counted toward the
 * global `rejected` total — discoveryPlanJob.ts's own local `rejected`
 * tally agrees (its `if (delivery.limitReached)` branch never increments
 * its local `rejected` counter either): the candidate was never actually
 * evaluated on quality, the plan simply already hit its target.
 *
 * Every OTHER candidate_rejected reason — including
 * `duplicate_already_owned_by_user`, which discoveryPlanJob.ts tracks in
 * its own separate local `duplicates` counter rather than `rejected` — IS
 * counted here, because from this reducer's vantage point the wire event
 * type is `candidate_rejected` either way, and the DiscoveryLiveState
 * contract (spec #23/#24) defines no separate "duplicates" bucket.
 */
function countsAsRejection(reason: string | undefined): boolean {
  return reason !== "plan_limit_reached";
}

// ── Single-event reducer ────────────────────────────────────────────────

/**
 * Applies exactly one real DiscoveryLiveEvent to state. Pure — same
 * (state, event) always yields the same result; no clock/timer reads.
 *
 * For `candidate_discovered` specifically: on its own this always renders
 * as the SECTION 6 "processing" sentence ("Checking X...") — the real,
 * observed Task 1 flow processes one candidate fully (through
 * validate → channel-gate → enrich → deliver) before the next `lead` is
 * even pulled off the provider stream within one scout (see
 * discoveryPlanJob.ts's `for await` loop), so a lone candidate_discovered
 * is the overwhelmingly common case. The SECTION 5 "Found N businesses..."
 * aggregate sentence is a batch-level behavior — see
 * `reduceLiveDiscoveryEvents` below — reserved for when 2+ consecutive
 * candidate_discovered events for the SAME scout genuinely land together
 * in one processed batch.
 */
export function reduceLiveDiscoveryEvent(state: DiscoveryLiveState, event: DiscoveryLiveEvent): DiscoveryLiveState {
  const next: DiscoveryLiveState = {
    ...state,
    scouts: { ...state.scouts },
    _internal: { processedEventIds: state._internal.processedEventIds },
    latestEventAt: event.timestamp,
  };

  const scoutId = event.scoutId;

  switch (event.type) {
    case "scout_started": {
      if (!isValidScoutId(scoutId)) return next;
      // area_started is always published immediately after this for the
      // exact same worker_started log line (see discoveryPlanJob.ts's
      // publishAreaPoolLifecycleEvent), so this only sets a reasonable
      // starting point — area_started (below) supplies the real content.
      next.scouts[scoutId] = { ...next.scouts[scoutId], status: "active", sentence: areaStartSentence(event.areaLabel), areaName: event.areaLabel, businessName: undefined };
      if (next.status === "starting") next.status = "discovering";
      return next;
    }

    case "area_started": {
      if (!isValidScoutId(scoutId)) return next;
      next.scouts[scoutId] = { ...next.scouts[scoutId], status: "active", sentence: areaStartSentence(event.areaLabel), areaName: event.areaLabel, businessName: undefined };
      if (next.status === "starting") next.status = "discovering";
      return next;
    }

    case "candidate_discovered": {
      if (!isValidScoutId(scoutId)) return next;
      next.scouts[scoutId] = { ...next.scouts[scoutId], status: "active", sentence: processingSentence(event.businessName), businessName: event.businessName };
      return next;
    }

    case "candidate_rejected": {
      if (isValidScoutId(scoutId)) {
        next.scouts[scoutId] = { ...next.scouts[scoutId], status: "active", sentence: rejectionSentence(event.reason), businessName: undefined };
      }
      if (countsAsRejection(event.reason) && !hasProcessed(next, event.id)) {
        next.rejected += 1;
        markProcessed(next, event.id);
      }
      return next;
    }

    case "lead_delivered": {
      if (isValidScoutId(scoutId)) {
        next.scouts[scoutId] = { ...next.scouts[scoutId], status: "active", sentence: OPPORTUNITY_SECURED, businessName: undefined };
      }
      if (!hasProcessed(next, event.id)) {
        next.delivered += 1;
        next.progressPercent = computeProgressPercent(next.delivered, next.target);
        markProcessed(next, event.id);
      }
      return next;
    }

    case "area_completed": {
      if (!isValidScoutId(scoutId)) return next;
      const outcome = event.areaOutcome;
      if (outcome?.failed) {
        next.scouts[scoutId] = { ...next.scouts[scoutId], status: "active", sentence: AREA_SNAG, businessName: undefined };
      } else if (outcome && outcome.accepted === 0) {
        const sentence = outcome.discovered === 0 ? "Quiet street. Moving on..." : "Nothing promising here. Moving on...";
        next.scouts[scoutId] = { ...next.scouts[scoutId], status: "active", sentence, businessName: undefined };
      }
      // else: at least one delivery came out of this area — the most
      // recent lead_delivered sentence already told the real story; leave
      // the scout's current sentence as-is rather than overwrite good news
      // with a bookkeeping line.
      return next;
    }

    case "discovery_completed": {
      if (hasProcessed(next, event.id)) return next;
      markProcessed(next, event.id);
      if (typeof event.deliveredCount === "number") next.delivered = event.deliveredCount;
      if (typeof event.target === "number") next.target = event.target;
      next.progressPercent = computeProgressPercent(next.delivered, next.target);
      // SPEC #26: completed only when delivered >= target; otherwise this
      // is a genuine exhaustion (discoveryPlanJob.ts's own
      // completePlanIfDrained() draws the identical line — see
      // planFinalStatus's "completed" vs "completed_partial").
      next.status = next.delivered >= next.target ? "completed" : "exhausted";
      for (const id of SCOUT_IDS) {
        next.scouts[id] = { ...next.scouts[id], status: "finished", sentence: FINISHED_SEARCHING, businessName: undefined };
      }
      return next;
    }

    case "discovery_failed": {
      if (hasProcessed(next, event.id)) return next;
      markProcessed(next, event.id);
      next.status = "failed";
      for (const id of SCOUT_IDS) {
        next.scouts[id] = { ...next.scouts[id], status: "error", sentence: DISCOVERY_PROBLEM, businessName: undefined };
      }
      return next;
    }

    default:
      return next;
  }
}

// ── Batch reducer — candidate_discovered aggregation (SPEC #5/#22) ──────

/**
 * Applies a batch of events in order, EVENT-DRIVEN (not timer-driven):
 * when 2+ consecutive events for the SAME scout in this one batch are all
 * `candidate_discovered`, they collapse into a single sentence update
 * ("Found N businesses. Checking them now...") instead of replaying each
 * one individually — avoiding the wasted intermediate state transitions
 * the spec explicitly calls out as bad ("Found 1... Found 2... Found 3...").
 *
 * A run of exactly 1 candidate_discovered (the common case — see
 * `reduceLiveDiscoveryEvent`'s doc comment) is NOT treated as a batch; it
 * falls through to the normal per-candidate "Checking X..." sentence.
 */
export function reduceLiveDiscoveryEvents(state: DiscoveryLiveState, events: readonly DiscoveryLiveEvent[]): DiscoveryLiveState {
  let acc = state;
  let i = 0;
  while (i < events.length) {
    const event = events[i];
    if (event.type === "candidate_discovered" && isValidScoutId(event.scoutId)) {
      const scoutId = event.scoutId;
      let runEnd = i + 1;
      while (runEnd < events.length && events[runEnd].type === "candidate_discovered" && events[runEnd].scoutId === scoutId) {
        runEnd += 1;
      }
      const runLength = runEnd - i;
      if (runLength >= 2) {
        const latest = events[runEnd - 1];
        acc = {
          ...acc,
          scouts: {
            ...acc.scouts,
            [scoutId]: { ...acc.scouts[scoutId], status: "active", sentence: `Found ${runLength} businesses. Checking them now...`, businessName: undefined },
          },
          latestEventAt: latest.timestamp,
        };
        i = runEnd;
        continue;
      }
      // runLength === 1: no aggregation — fall through to the normal path.
    }
    acc = reduceLiveDiscoveryEvent(acc, event);
    i += 1;
  }
  return acc;
}
