/**
 * PHASE 32 — AREA SCAN-BUDGET OPTIMIZATION.
 *
 * Confirmed Phase 31 finding: `computeAskFor(streamTarget)`
 * (roundSizing.ts) was previously called ONCE PER AREA, independently, by
 * every concurrent area worker in `runGoogleAreaPoolForCity()`
 * (poolExpandJob.ts) — so a target=100 request running 3 concurrent areas
 * handed out ~400 raw `max_results` scan budget to EACH area (~1200 total),
 * massively over-scanning low-yield areas and holding scarce browser slots
 * for longer than the request actually needed.
 *
 * This module replaces "every area gets its own full multiplied budget"
 * with a single SHARED budget (`computeGlobalScanBudget`) that concurrent
 * areas draw bounded slices from (`allocateInitialAreaScanBudget`), with a
 * narrow, capped path for a demonstrably PRODUCTIVE area to draw a little
 * more once its initial slice runs out (`requestAreaScanBudgetExpansion`).
 *
 * Deliberately pure, DB-free, engine-free — same split as roundSizing.ts
 * and googleAreaPool.ts: one `AreaScanBudgetCoordinator` instance is meant
 * to live for the lifetime of ONE `runGoogleAreaPoolForCity()` call (i.e.
 * one city's area-pool run), created fresh per call so budgets never leak
 * across sibling cities/requests (STEP 5 — "sibling isolation").
 *
 * SCOPE: this module ONLY decides `max_results` (the raw Maps scan
 * ceiling). It never decides `deliver_target` (roundSizing.ts's
 * `areaStreamTarget`/`cityStreamTarget` still own that), never talks to the
 * yield classifier's STOP decision (areaProductivity.ts's
 * `evaluateAreaYieldStop` still owns "should this area stop"), and never
 * touches worker COUNT/concurrency (googleAreaPool.ts still owns pool
 * sizing) — it only asks "of the SAME total scan intent as before, how much
 * of it should THIS area get right now."
 */

import type { AreaYieldClass } from "./areaProductivity.js";
import { computeAskFor } from "./roundSizing.js";

/** Tunable budget-shaping knobs — see env.ts for defaults and rationale. */
export type AreaScanBudgetLimits = {
  /**
   * Multiplier applied to `streamTarget` to size the TOTAL shared budget
   * (`computeGlobalScanBudget`) — same numeric role `computeAskFor`'s own
   * `multiplier` played before this phase, now applied ONCE per city
   * instead of once per area.
   */
  multiplier: number;
  /**
   * A single area's initial slice is never smaller than
   * `streamTarget * minAreaBudgetFactor` — a true floor, protecting a
   * lone/slow area's realistic chance of reaching its own streamTarget
   * even when many areas are nominally "active".
   */
  minAreaBudgetFactor: number;
  /**
   * A single area's CUMULATIVE allocation (initial + every expansion) is
   * never larger than `streamTarget * maxAreaBudgetFactor` (or
   * `minExplorationCandidates` if larger) — the ceiling
   * that makes STEP 5's "one area cannot consume the entire global scan
   * budget" true regardless of how much unused headroom siblings leave
   * behind. Must be >= `minAreaBudgetFactor` (enforced at config load —
   * see env.ts).
   */
  maxAreaBudgetFactor: number;
  /**
   * Size (in `streamTarget` units) of ONE expansion grant — see
   * `requestAreaScanBudgetExpansion` below.
   */
  expansionChunkFactor: number;
  /**
   * PHASE 34 — Absolute minimum exploration candidate volume floor for an
   * active area before yield classification. Default: 50.
   */
  minExplorationCandidates: number;
  /**
   * PHASE 36 — Maximum productive-area scan budget multiplier factor.
   * Allows productive areas to expand up to `streamTarget * productiveMaxFactor`.
   * Default: 4.
   */
  productiveMaxFactor?: number;
  /**
   * PHASE 36 — Absolute per-area productive ceiling in candidate count units.
   * Matches the historical 400-candidate baseline per area. Default: 400.
   */
  maxProductiveCandidates?: number;
};

/**
 * The TOTAL shared scan budget for one city's area-pool run.
 * PHASE 34 / PHASE 36: Sized to ensure all active areas receive their initial exploration
 * runway (>= activeAreaCount * minExplorationCandidates) PLUS a shared expansion headroom
 * pool allowing productive areas to expand without unconditional flat 400 duplication to
 * every area.
 */
export function computeGlobalScanBudget(
  streamTarget: number,
  limits: Pick<AreaScanBudgetLimits, "multiplier" | "minExplorationCandidates" | "productiveMaxFactor" | "maxProductiveCandidates">,
  activeAreaCount: number = 1,
): number {
  const safeActiveAreaCount = Math.max(1, Math.floor(activeAreaCount) || 1);
  const targetScaledBudget = computeAskFor(streamTarget, limits.multiplier);
  const minExplorationTotal = safeActiveAreaCount * (limits.minExplorationCandidates ?? 0);
  const initialBaseBudget = Math.max(targetScaledBudget, minExplorationTotal);

  if (safeActiveAreaCount <= 1 || !limits.productiveMaxFactor) {
    return initialBaseBudget;
  }

  // Multi-area shared expansion headroom pool
  const maxProductiveCeiling = limits.maxProductiveCandidates ?? 400;
  const expansionHeadroom = Math.min(
    targetScaledBudget,
    Math.max(0, safeActiveAreaCount * maxProductiveCeiling - initialBaseBudget),
  );
  return initialBaseBudget + expansionHeadroom;
}

/** Per-area bookkeeping the coordinator keeps for telemetry and cap enforcement. */
export type AreaScanBudgetEntry = {
  initial: number;
  expansions: number;
  expansionGrants: number;
  final: number;
};

/**
 * Live state for ONE city's area-pool run. Create one fresh instance per
 * `runGoogleAreaPoolForCity()` call (STEP 5 — sibling isolation: a new city
 * / new request never shares a coordinator with another).
 */
export type AreaScanBudgetCoordinator = {
  readonly streamTarget: number;
  readonly globalScanBudget: number;
  readonly limits: AreaScanBudgetLimits;
  /** Sum of every allocation (initial + expansions) handed out so far, across all areas. */
  allocated: number;
  readonly perArea: Map<string, AreaScanBudgetEntry>;
};

export function createAreaScanBudgetCoordinator(
  streamTarget: number,
  limits: AreaScanBudgetLimits,
  activeAreaCount: number = 1,
): AreaScanBudgetCoordinator {
  return {
    streamTarget,
    globalScanBudget: computeGlobalScanBudget(streamTarget, limits, activeAreaCount),
    limits,
    allocated: 0,
    perArea: new Map(),
  };
}

/**
 * STEP 2/STEP 5 / PHASE 34 / PHASE 36 — one area's INITIAL scan budget slice.
 *
 * `activeAreaCount` is the number of areas expected to run concurrently
 * against this SAME shared budget.
 *
 * Initial slice is computed as the fair share of the initial exploration base budget,
 * floored at `minExplorationCandidates` (50) and capped by per-area initial cap.
 */
export function allocateInitialAreaScanBudget(
  coordinator: AreaScanBudgetCoordinator,
  area: string,
  activeAreaCount: number,
): number {
  const safeActiveAreaCount = Math.max(1, Math.floor(activeAreaCount) || 1);
  const targetScaledBudget = computeAskFor(coordinator.streamTarget, coordinator.limits.multiplier);
  const minExplorationTotal = safeActiveAreaCount * (coordinator.limits.minExplorationCandidates ?? 0);
  const initialBaseBudget = Math.max(targetScaledBudget, minExplorationTotal);

  const share = Math.ceil(initialBaseBudget / safeActiveAreaCount);
  const streamTargetFloor = Math.ceil(coordinator.streamTarget * coordinator.limits.minAreaBudgetFactor);
  const explorationFloor = coordinator.limits.minExplorationCandidates ?? 0;
  const floor = Math.max(streamTargetFloor, explorationFloor);
  const streamTargetCap = Math.ceil(coordinator.streamTarget * coordinator.limits.maxAreaBudgetFactor);
  const cap = Math.max(floor, streamTargetCap);
  const remaining = Math.max(0, coordinator.globalScanBudget - coordinator.allocated);

  // Floor always wins over a starved share (a lone/slow area must still get
  // a realistic shot); cap and remaining global headroom both still apply on top.
  const desired = Math.max(share, floor);
  const budget = Math.max(floor, Math.min(desired, cap, Math.max(floor, remaining)));

  coordinator.allocated += budget;
  coordinator.perArea.set(area, { initial: budget, expansions: 0, expansionGrants: 0, final: budget });
  return budget;
}

/**
 * STEP 3 / PHASE 36 — a demonstrably PRODUCTIVE (or still-marginal) area
 * that exhausted its current slice without reaching its own streamTarget
 * may request additional scan budget.
 *
 * A `low_yield`-classified area (areaProductivity.ts's `classifyAreaYield`)
 * ALWAYS gets 0.
 *
 * Productive areas can expand up to `productiveMaxFactor` (capped at
 * `maxProductiveCandidates` = 400).
 *
 * Returns the additional amount granted (0 if none — caller stops asking).
 * Bounded by BOTH this area's own cumulative productive cap AND the
 * remaining shared headroom (`globalScanBudget - allocated`).
 */
export function requestAreaScanBudgetExpansion(
  coordinator: AreaScanBudgetCoordinator,
  area: string,
  yieldClass: AreaYieldClass,
): number {
  if (yieldClass === "low_yield") return 0;

  const entry = coordinator.perArea.get(area);
  if (!entry) return 0;

  const maxFactor = yieldClass === "productive"
    ? (coordinator.limits.productiveMaxFactor ?? coordinator.limits.maxAreaBudgetFactor)
    : coordinator.limits.maxAreaBudgetFactor;

  const factorCap = Math.ceil(coordinator.streamTarget * maxFactor);
  const explorationFloor = coordinator.limits.minExplorationCandidates ?? 0;
  const hardCap = coordinator.limits.maxProductiveCandidates ?? 400;

  const cap = Math.min(
    hardCap,
    Math.max(explorationFloor, factorCap),
  );

  const remainingForArea = cap - entry.final;
  if (remainingForArea <= 0) return 0;

  const remainingGlobal = coordinator.globalScanBudget - coordinator.allocated;
  if (remainingGlobal <= 0) return 0;

  const chunk = Math.ceil(coordinator.streamTarget * coordinator.limits.expansionChunkFactor);
  const grant = Math.max(0, Math.min(chunk, remainingForArea, remainingGlobal));
  if (grant <= 0) return 0;

  entry.expansions += grant;
  entry.expansionGrants += 1;
  entry.final += grant;
  coordinator.allocated += grant;
  return grant;
}

/** STEP 6 telemetry — a compact per-area snapshot for a single log line. */
export function areaScanBudgetTelemetry(coordinator: AreaScanBudgetCoordinator, area: string): AreaScanBudgetEntry | undefined {
  return coordinator.perArea.get(area);
}
