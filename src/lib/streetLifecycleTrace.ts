/**
 * CRITMODE — per-street lifecycle correlator (diagnostics only).
 *
 * Purpose: stitch together timestamps that already exist in three separate
 * places — this file's own `markClaimed()`/`markSpawnStarted()`/
 * `markFirstForwarded()`/`markFirstNewForUser()`/`markEngineDone()` calls
 * (Node-side, live), `EngineDoneInfo.bridgeTimings`/`.progressMarks`
 * (pythonBridge.ts, already populated at `__done__` time), and the
 * per-area `AreaProductivityState` counters (already maintained by
 * poolExpandJob.ts) — into ONE row per street, emitted once at street
 * completion, plus one run-level rollup.
 *
 * Explicitly NOT this module's job:
 *   - It does not gate, delay, retry, or change ANY decision (claiming,
 *     concurrency, budgets, target accounting, enrichment, qualification).
 *   - It does not add any new timers where an equivalent measurement
 *     already exists elsewhere — see the mapping table in
 *     `finalizeStreetLifecycle()`'s doc comment below for exactly which
 *     existing field feeds each output column.
 *   - It never throws — a tracer is pure bookkeeping; if a caller wires it
 *     up wrong, this fails soft (missing timestamps become `null`), not by
 *     crashing the actual discovery run.
 *
 * Correlation key: every recorder is its own independent closure (created
 * fresh per street via `createStreetLifecycleTracer()`), identified by
 * `street_key` + `run_id`. There is no shared mutable map that two
 * concurrently-running streets could collide on — each `runArea()`
 * invocation gets its own recorder instance, so one street's marks can
 * structurally never land on another street's record. The only shared
 * state is the run-level rollup list (`recordStreetSummary`/
 * `emitRunSummary`), which is strictly append-only and keyed by `run_id`.
 */

import type { EngineDoneInfo } from "../scraperBridge/pythonBridge.js";

export type StreetTimingSummary = {
  street_key: string;
  street_name: string;
  run_id: string;
  worker_id: string;
  total_ms: number | null;
  spawn_ms: number | null;
  // ── A) PRE-FIRST-CANDIDATE ──────────────────────────────────────────
  browser_ready_ms: number | null;
  maps_start_ms: number | null;
  panel_detected_ms: number | null;
  panel_retry_count: number;
  first_candidate_ms: number | null;
  search_exhausted_ms: number | null;
  first_python_yield_ms: number | null;
  first_forwarded_ms: number | null;
  first_admitted_ms: number | null;
  first_enrichment_ms: number | null;
  first_qualified_ms: number | null;
  // ── B) POST-USEFUL-WORK ─────────────────────────────────────────────
  first_new_for_user_ms: number | null;
  target_reached_ms: number | null;
  drain_begin_ms: number | null;
  pending_at_drain: number | null;
  worker_shutdown_begin_ms: number | null;
  engine_done_ms: number | null;
  raw_candidates: number;
  yielded_candidates: number;
  admitted_candidates: number;
  enrichment_attempts: number;
  qualified: number;
  new_for_user: number;
  delivered: number;
  termination_reason: string | null;
  /**
   * Gap-to-gap durations between the stages above, all `null`-safe (a
   * `null` on either endpoint yields a `null` duration, never a throw or
   * a nonsense negative). Computed from the same fields already on this
   * object — not a second measurement of anything.
   */
  durations: {
    claim_to_spawn_ms: number | null;
    spawn_to_browser_ready_ms: number | null;
    browser_ready_to_nav_submitted_ms: number | null;
    nav_submitted_to_panel_detected_ms: number | null;
    panel_detected_to_first_candidate_ms: number | null;
    first_candidate_to_search_exhausted_ms: number | null;
    first_qualified_to_first_new_for_user_ms: number | null;
    first_new_for_user_to_target_reached_ms: number | null;
    target_reached_to_drain_begin_ms: number | null;
    drain_begin_to_worker_shutdown_ms: number | null;
    worker_shutdown_to_engine_done_ms: number | null;
  };
};

export type StreetLifecycleCounts = {
  raw_candidates: number;
  yielded_candidates: number;
  admitted_candidates: number;
  enrichment_attempts: number;
  qualified: number;
  new_for_user: number;
  delivered: number;
  /**
   * CRITMODE PART 2 — count of `discovery:panel_failure_retry` progress
   * events seen for this street. Unlike every other count on this type,
   * this can't be read from `EngineDoneInfo.progressMarks` (that map is
   * first-occurrence-only, so it can tell you WHEN the first retry
   * happened but not HOW MANY there were) — the caller accumulates this
   * from the live `onProgress` callback instead, same pattern as
   * `enrichment_attempts`.
   */
  panel_retry_count: number;
};

export type StreetLifecycleFinalizeInput = {
  info: Pick<EngineDoneInfo, "bridgeTimings" | "progressMarks"> | undefined;
  counts: StreetLifecycleCounts;
  terminationReason: string | undefined | null;
  /** Injectable for tests only — defaults to Date.now. */
  now?: () => number;
};

export type StreetLifecycleTracer = {
  /** Call the instant `claim_discovery_street` resolves for this street. */
  markClaimed: () => void;
  /** Call immediately before invoking `runEngineQuery()` for this street. */
  markSpawnStarted: () => void;
  /** Call on the FIRST iteration of the `for await` loop over the engine's leads. */
  markFirstForwarded: () => void;
  /** Call the first time a lead delivered for this street has `wasNewForUser: true`. */
  markFirstNewForUser: () => void;
  /**
   * CRITMODE PART 2 — call the first time an `engine:drain_begin`
   * progress event is observed, with its `item_id` (the engine's own
   * `tracer.pending_count()` at that instant) parsed to a number. This is
   * the one POST-USEFUL-WORK field that can't come from `progressMarks`
   * (a `stage:event -> ms` map with no room for a payload), so it's
   * captured live via the same `onProgress` callback the caller already
   * has, exactly like `enrichment_attempts`/`panel_retry_count`.
   */
  markPendingAtDrain: (count: number) => void;
  /** Call the instant the engine's `onDone`/`__done__` callback fires. */
  markEngineDone: () => void;
  /**
   * Call once, at street completion (claim completed OR left recoverable).
   * Builds the summary line, logs it, records it into the run-level
   * rollup, and returns it (primarily so tests can assert on it directly
   * instead of scraping console output).
   */
  finalize: (input: StreetLifecycleFinalizeInput) => StreetTimingSummary;
};

function firstMarkMatching(
  marks: Record<string, number> | undefined,
  predicate: (key: string) => boolean,
): number | null {
  if (!marks) return null;
  let min: number | null = null;
  for (const [key, value] of Object.entries(marks)) {
    if (!predicate(key)) continue;
    if (min === null || value < min) min = value;
  }
  return min;
}

/**
 * One row per street. `streetKey`/`streetName`/`runId`/`workerId` are
 * fixed for the lifetime of this recorder — every mark below is relative
 * to `markClaimed()`'s own call time (`claimedAt`), never to any other
 * street's clock.
 */
export function createStreetLifecycleTracer(opts: {
  streetKey: string;
  streetName: string;
  runId: string;
  workerId: string;
  /** Injectable for tests only — defaults to Date.now. */
  now?: () => number;
}): StreetLifecycleTracer {
  const now = opts.now ?? Date.now;

  let claimedAt: number | null = null;
  let spawnStartedAt: number | null = null;
  let firstForwardedAt: number | null = null;
  let firstNewForUserAt: number | null = null;
  let engineDoneAt: number | null = null;
  let pendingAtDrain: number | null = null;

  // First-write-wins for every "first X" mark — a duplicate call (e.g. a
  // retried callback) must never overwrite an earlier, more accurate mark.
  const markClaimed = () => {
    if (claimedAt === null) claimedAt = now();
  };
  const markSpawnStarted = () => {
    if (spawnStartedAt === null) spawnStartedAt = now();
  };
  const markFirstForwarded = () => {
    if (firstForwardedAt === null) firstForwardedAt = now();
  };
  const markFirstNewForUser = () => {
    if (firstNewForUserAt === null) firstNewForUserAt = now();
  };
  const markPendingAtDrain = (count: number) => {
    if (pendingAtDrain === null) pendingAtDrain = count;
  };
  const markEngineDone = () => {
    if (engineDoneAt === null) engineDoneAt = now();
  };

  const relativeToClaim = (absoluteMs: number | null): number | null => {
    if (absoluteMs === null || claimedAt === null) return null;
    return absoluteMs - claimedAt;
  };

  /**
   * Field-by-field provenance (nothing here is a new timer):
   *   total_ms                 — this call's own timestamp minus markClaimed()
   *   spawn_ms                 — markSpawnStarted() + bridgeTimings.spawnMs
   *                              (spawnMs is already computed in
   *                              pythonBridge.ts: ms from its own t0, set
   *                              immediately before spawn(), to the child
   *                              process being forked)
   *   browser_ready_ms         — markSpawnStarted() + progressMarks["discovery:browser_page_ready"]
   *   maps_start_ms            — markSpawnStarted() + progressMarks["discovery:maps_navigation_start"]
   *                              ("navigation/search submitted" — the code's
   *                              actual order is browser_page_ready THEN
   *                              maps_navigation_start, not the reverse)
   *   panel_detected_ms        — markSpawnStarted() + progressMarks["discovery:panel_resolved"]
   *   panel_retry_count        — input.counts.panel_retry_count (live-accumulated
   *                              by the caller from onProgress; see that field's
   *                              own doc comment for why it can't come from progressMarks)
   *   first_candidate_ms       — markSpawnStarted() + progressMarks["discovery:candidate_discovered"]
   *   search_exhausted_ms      — markSpawnStarted() + progressMarks["discovery:search_exhausted"]
   *   first_python_yield_ms    — markSpawnStarted() + bridgeTimings.firstLeadMs
   *   first_forwarded_ms       — markFirstForwarded() (Node's own for-await loop)
   *   first_admitted_ms        — markSpawnStarted() + progressMarks["discovery:candidate_queued"]
   *   first_enrichment_ms      — markSpawnStarted() + earliest progressMarks
   *                              key on the website/instagram/contact stages
   *   first_qualified_ms       — markSpawnStarted() + earliest progressMarks
   *                              key on the qualification stage
   *   first_new_for_user_ms    — markFirstNewForUser() (Node's own processLead())
   *   target_reached_ms        — markSpawnStarted() + progressMarks["engine:target_reached"]
   *   drain_begin_ms           — markSpawnStarted() + progressMarks["engine:drain_begin"]
   *   pending_at_drain         — markPendingAtDrain() (Node's own onProgress, since
   *                              progressMarks can't carry a payload, only a timestamp)
   *   worker_shutdown_begin_ms — markSpawnStarted() + progressMarks["engine:worker_shutdown_begin"]
   *   engine_done_ms           — markEngineDone() (Node's own onDone callback)
   * `progressMarks`/`bridgeTimings` values are themselves ms-since-spawn
   * (see pythonBridge.ts's `hrElapsedMs()`), so every one of them is
   * anchored back to street-claim time via `spawnStartedAt`, never
   * re-measured. The new `engine:*` events (PART 2) travel through the
   * exact same stdout `"type":"progress"` protocol as the pre-existing
   * `discovery:*`/`website:*`/`qualification:*` ones — no second channel.
   */
  const finalize = (input: StreetLifecycleFinalizeInput): StreetTimingSummary => {
    const finalNow = (input.now ?? now)();
    const marks = input.info?.progressMarks;
    const bridge = input.info?.bridgeTimings;

    const spawnOffset = spawnStartedAt !== null ? spawnStartedAt : null;
    const sinceSpawn = (offsetMs: number | null | undefined): number | null => {
      if (offsetMs === undefined || offsetMs === null || spawnOffset === null) return null;
      return relativeToClaim(spawnOffset + offsetMs);
    };
    // Duration between two already-computed since-claim fields — null-safe:
    // either endpoint missing yields null, never a throw or a negative
    // number masquerading as a real gap.
    const gap = (from: number | null, to: number | null): number | null => {
      if (from === null || to === null) return null;
      return to - from;
    };

    const spawnStartedRel = relativeToClaim(spawnOffset);
    const browserReadyMs = sinceSpawn(firstMarkMatching(marks, (k) => k === "discovery:browser_page_ready"));
    const mapsStartMs = sinceSpawn(firstMarkMatching(marks, (k) => k === "discovery:maps_navigation_start"));
    const panelDetectedMs = sinceSpawn(firstMarkMatching(marks, (k) => k === "discovery:panel_resolved"));
    const firstCandidateMs = sinceSpawn(firstMarkMatching(marks, (k) => k === "discovery:candidate_discovered"));
    const searchExhaustedMs = sinceSpawn(firstMarkMatching(marks, (k) => k === "discovery:search_exhausted"));
    const firstQualifiedMs = sinceSpawn(firstMarkMatching(marks, (k) => k.startsWith("qualification:")));
    const firstNewForUserMs = relativeToClaim(firstNewForUserAt);
    const targetReachedMs = sinceSpawn(firstMarkMatching(marks, (k) => k === "engine:target_reached"));
    const drainBeginMs = sinceSpawn(firstMarkMatching(marks, (k) => k === "engine:drain_begin"));
    const workerShutdownBeginMs = sinceSpawn(firstMarkMatching(marks, (k) => k === "engine:worker_shutdown_begin"));
    const engineDoneMs = relativeToClaim(engineDoneAt);

    const summary: StreetTimingSummary = {
      street_key: opts.streetKey,
      street_name: opts.streetName,
      run_id: opts.runId,
      worker_id: opts.workerId,
      total_ms: relativeToClaim(finalNow),
      spawn_ms: sinceSpawn(bridge?.spawnMs ?? null),
      browser_ready_ms: browserReadyMs,
      maps_start_ms: mapsStartMs,
      panel_detected_ms: panelDetectedMs,
      panel_retry_count: input.counts.panel_retry_count,
      first_candidate_ms: firstCandidateMs,
      search_exhausted_ms: searchExhaustedMs,
      first_python_yield_ms: sinceSpawn(bridge?.firstLeadMs ?? null),
      first_forwarded_ms: relativeToClaim(firstForwardedAt),
      first_admitted_ms: sinceSpawn(firstMarkMatching(marks, (k) => k === "discovery:candidate_queued")),
      first_enrichment_ms: sinceSpawn(
        firstMarkMatching(marks, (k) => k.startsWith("website:") || k.startsWith("instagram:") || k.startsWith("contact:")),
      ),
      first_qualified_ms: firstQualifiedMs,
      first_new_for_user_ms: firstNewForUserMs,
      target_reached_ms: targetReachedMs,
      drain_begin_ms: drainBeginMs,
      pending_at_drain: pendingAtDrain,
      worker_shutdown_begin_ms: workerShutdownBeginMs,
      engine_done_ms: engineDoneMs,
      raw_candidates: input.counts.raw_candidates,
      yielded_candidates: input.counts.yielded_candidates,
      admitted_candidates: input.counts.admitted_candidates,
      enrichment_attempts: input.counts.enrichment_attempts,
      qualified: input.counts.qualified,
      new_for_user: input.counts.new_for_user,
      delivered: input.counts.delivered,
      termination_reason: input.terminationReason ?? null,
      durations: {
        claim_to_spawn_ms: gap(0, spawnStartedRel),
        spawn_to_browser_ready_ms: gap(spawnStartedRel, browserReadyMs),
        browser_ready_to_nav_submitted_ms: gap(browserReadyMs, mapsStartMs),
        nav_submitted_to_panel_detected_ms: gap(mapsStartMs, panelDetectedMs),
        panel_detected_to_first_candidate_ms: gap(panelDetectedMs, firstCandidateMs),
        first_candidate_to_search_exhausted_ms: gap(firstCandidateMs, searchExhaustedMs),
        first_qualified_to_first_new_for_user_ms: gap(firstQualifiedMs, firstNewForUserMs),
        first_new_for_user_to_target_reached_ms: gap(firstNewForUserMs, targetReachedMs),
        target_reached_to_drain_begin_ms: gap(targetReachedMs, drainBeginMs),
        drain_begin_to_worker_shutdown_ms: gap(drainBeginMs, workerShutdownBeginMs),
        worker_shutdown_to_engine_done_ms: gap(workerShutdownBeginMs, engineDoneMs),
      },
    };

    console.log(`[street-timing-summary] ${JSON.stringify(summary)}`);
    // claimedAt (this street's own absolute claim timestamp) is used only
    // as a sort key for the run-level rollup below — never emitted on the
    // per-street summary line itself (that line only ever contains the
    // exact fields specified above, all relative durations).
    recordStreetSummary(opts.runId, summary, claimedAt ?? finalNow);
    return summary;
  };

  return {
    markClaimed,
    markSpawnStarted,
    markFirstForwarded,
    markFirstNewForUser,
    markPendingAtDrain,
    markEngineDone,
    finalize,
  };
}

// ── Run-level rollup ───────────────────────────────────────────────────
//
// Append-only, keyed by run_id. A street can only ever push its OWN
// summary object (built entirely from its own closure above) — there is
// no per-key overwrite here, so no street can clobber another's row even
// if `street_key` were ever reused within a run.

type RunRow = { claimedAt: number; summary: StreetTimingSummary };

const runSummaries = new Map<string, RunRow[]>();

export function recordStreetSummary(runId: string, summary: StreetTimingSummary, claimedAt: number): void {
  const existing = runSummaries.get(runId);
  const row: RunRow = { claimedAt, summary };
  if (existing) {
    existing.push(row);
  } else {
    runSummaries.set(runId, [row]);
  }
}

/**
 * Logs `[street-timing-run-summary]` once, with every street row for this
 * run in TRUE chronological (claim) order — using each summary's own
 * absolute claim timestamp (captured internally by `finalize()`, never
 * re-measured) as the sort key, so this is correct even when streets ran
 * concurrently and finished out of claim order. Clears this run's rows
 * afterward so a long-lived Node process doesn't accumulate rows across
 * unrelated job invocations forever.
 */
export function emitRunSummary(runId: string): StreetTimingSummary[] {
  const rows = (runSummaries.get(runId) ?? []).slice().sort((a, b) => a.claimedAt - b.claimedAt);
  const summaries = rows.map((r) => r.summary);
  console.log(
    `[street-timing-run-summary] run_id=${runId} street_count=${summaries.length} ` +
      JSON.stringify(summaries),
  );
  runSummaries.delete(runId);
  return summaries;
}

/** Test-only helpers — never used by production call sites. */
export const __testing_streetLifecycleTrace = {
  reset(): void {
    runSummaries.clear();
  },
  peek(runId: string): StreetTimingSummary[] {
    return (runSummaries.get(runId) ?? []).map((r) => r.summary);
  },
};
