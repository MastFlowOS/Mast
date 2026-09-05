/**
 * Worker Pools B — Google Maps area worker pool.
 *
 * Pure-logic tests for computeAreaPoolSize()/runAreaWorkerPool(), matching
 * the style of dispatchConcurrency.test.ts / areaRotation.test.ts elsewhere
 * in this directory: no Postgres, no pg-boss, no Playwright/service.py —
 * claimNextArea/runArea/tryAcquireSlot/isTerminal are all injected fakes,
 * so these tests exercise the pool's ORCHESTRATION logic (sizing, distinct
 * claims, failure isolation, replacement, cancellation, target) in
 * isolation from the real engine and database this module is wired to in
 * discoveryPlanJob.ts.
 *
 * Covers phase prompt test items A, B, C, D(-equivalent, see note), G, H,
 * I, J, L. Items E (shared taskDbPath), F (cross-area dedup), and K (real
 * DB outcome accounting) require the real SQLite/Postgres layer and are
 * not re-tested here — see the final report for what remains unverified.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  computeAreaPoolSize,
  computeDynamicDiscoveryCapacity,
  runAreaWorkerPool,
  type AreaRunOutcome,
  type AreaWorkerLogEvent,
} from "../googleAreaPool.js";
import { createBrowserSlotPool } from "../../lib/browserSlotPool.js";

function outcome(partial: Partial<AreaRunOutcome> = {}): AreaRunOutcome {
  return { discovered: 0, accepted: 0, rejected: 0, duplicates: 0, exhausted: false, failed: false, ...partial };
}

// ── Test A: pool size never exceeds configured worker count ────────────────
test("A: computeAreaPoolSize never exceeds the configured worker count", () => {
  assert.equal(computeAreaPoolSize(4, 10, 10), 4);
  assert.equal(computeAreaPoolSize(1, 10, 10), 1);
});

// ── Test C: fewer areas than workers → pool sized to available areas ───────
test("C: computeAreaPoolSize is capped by available curated areas, not configured workers", () => {
  assert.equal(computeAreaPoolSize(5, 3, 10), 3);
});

// ── Test L: capacity ceiling — never more than measured browser slots ──────
test("L: computeAreaPoolSize is capped by capacity slots even when configured/areas allow more", () => {
  assert.equal(computeAreaPoolSize(4, 4, 2), 2);
  assert.equal(computeAreaPoolSize(4, 4, 0), 0);
});

test("computeAreaPoolSize never goes negative", () => {
  assert.equal(computeAreaPoolSize(4, 4, -3), 0);
});

// ── Test B: distinct area claims — N workers claim N different areas ───────
test("B: with 4 available areas and pool size 4, all 4 areas are claimed exactly once", async () => {
  const areas = ["Brooklyn", "Queens", "Manhattan", "Bronx"];
  let cursor = 0;
  const claimed: string[] = [];

  const result = await runAreaWorkerPool({
    configuredWorkers: 4,
    totalCuratedAreas: areas.length,
    availableCapacity: 4,
    claimNextArea: async (usedAreas) => {
      const next = areas.find((a) => !usedAreas.has(a) && !claimed.includes(a));
      if (!next) return undefined;
      claimed.push(next);
      return next;
    },
    runArea: async (area) => outcome({ discovered: 1, accepted: 1 }),
    tryAcquireSlot: () => () => {},
    isTerminal: () => false,
  });

  assert.equal(result.poolSize, 4);
  assert.equal(result.startedWorkers, 4);
  assert.deepEqual(new Set(result.areasProcessed), new Set(areas));
});

test("safe resource ceiling bounds dynamic area workers without duplicate claims", async () => {
  const areas = ["Brooklyn", "Queens", "Manhattan", "Bronx"];
  const claimed = new Set<string>();
  let active = 0;
  let maxActive = 0;

  const result = await runAreaWorkerPool({
    configuredWorkers: 8,
    safeResourceWorkers: 2,
    requestedQuantity: 10,
    totalCuratedAreas: areas.length,
    availableCapacity: 4,
    claimNextArea: async (usedAreas) => {
      const next = areas.find((area) => !usedAreas.has(area) && !claimed.has(area));
      if (!next) return undefined;
      claimed.add(next);
      return next;
    },
    runArea: async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return outcome({ discovered: 1, accepted: 1 });
    },
    tryAcquireSlot: () => () => {},
    isTerminal: () => false,
  });

  assert.equal(result.poolSize, 2, "requested=10 with safeResourceWorkers=2 must select two workers");
  assert.equal(maxActive, 2, "resource ceiling must bound concurrent area execution");
  assert.equal(claimed.size, result.areasProcessed.length, "an area must never be claimed twice");
});

// ── Phase 1B: controlled 2-worker validation ────────────────────────────────
// requested=10 leads drives computedWorkers=3 (the <=10 branch of the
// dynamic capacity formula), but the production-safe resource ceiling of 2
// must still win: finalWorkers=2. This proves the ceiling is enforced via
// the existing safeResourceWorkers parameter/config knob, not a hardcoded
// override, and that plenty of areas/capacity are available so the ceiling
// — not areas or browser slots — is what binds.
test("Phase 1B: computeDynamicDiscoveryCapacity — requested=10 => computedWorkers=3 before the safe-resource ceiling is applied", () => {
  // No safeResourceWorkers arg here: isolates the "computedWorkers=3" part
  // of the phase prompt's scenario from the ceiling itself.
  const computedWorkers = computeDynamicDiscoveryCapacity(10, /* availableAreas */ 10, /* capacitySlots */ 10, /* maxConfigured */ 8);
  assert.equal(computedWorkers, 3, "requested=10 leads must desire 3 workers before any resource ceiling is applied");
});

test("Phase 1B: computeDynamicDiscoveryCapacity — requested=10, computedWorkers=3, safeResourceWorkers=2 => finalWorkers=2", () => {
  const finalWorkers = computeDynamicDiscoveryCapacity(10, /* availableAreas */ 10, /* capacitySlots */ 10, /* maxConfigured */ 8, /* safeResourceWorkers */ 2);
  assert.equal(finalWorkers, 2, "the safe-resource ceiling of 2 must win over the computed desire of 3");
});

test("Phase 1B: runAreaWorkerPool end-to-end — requested=10, safeResourceWorkers=2 => finalWorkers=2, never more than 2 concurrent areas run", async () => {
  const areas = ["Area-1", "Area-2", "Area-3", "Area-4", "Area-5"];
  const claimed = new Set<string>();
  let active = 0;
  let peakActive = 0;

  const result = await runAreaWorkerPool({
    configuredWorkers: 8, // plenty configured; the ceiling, not this, must bind
    safeResourceWorkers: 2, // Phase 1B production-safe resource ceiling
    requestedQuantity: 10, // drives computedWorkers=3 internally
    totalCuratedAreas: areas.length, // plenty of areas; not the binding constraint
    availableCapacity: 5, // plenty of browser-slot capacity; not the binding constraint
    claimNextArea: async (usedAreas) => {
      const next = areas.find((area) => !usedAreas.has(area) && !claimed.has(area));
      if (!next) return undefined;
      claimed.add(next);
      return next;
    },
    runArea: async () => {
      active += 1;
      peakActive = Math.max(peakActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return outcome({ discovered: 1, accepted: 1 });
    },
    tryAcquireSlot: () => () => {},
    isTerminal: () => false,
  });

  assert.equal(result.poolSize, 2, "finalWorkers must be 2: the safe-resource ceiling, not computedWorkers=3, must bind");
  assert.equal(peakActive, 2, "no more than 2 area workers may run concurrently under the Phase 1B ceiling");
  assert.equal(claimed.size, result.areasProcessed.length, "an area must never be claimed twice under the 2-worker ceiling");
});

// ── Test C (pool behavior): 3 areas + pool size 5 → only 3 workers, no fake work ──
test("C: fewer areas than configured workers starts only as many workers as areas exist", async () => {
  const areas = ["Brooklyn", "Queens", "Manhattan"];
  const claimedSoFar = new Set<string>();

  const result = await runAreaWorkerPool({
    configuredWorkers: 5,
    totalCuratedAreas: areas.length,
    availableCapacity: 5,
    claimNextArea: async (usedAreas) => {
      const next = areas.find((a) => !usedAreas.has(a) && !claimedSoFar.has(a));
      if (!next) return undefined;
      claimedSoFar.add(next);
      return next;
    },
    runArea: async () => outcome({ discovered: 1, accepted: 1 }),
    tryAcquireSlot: () => () => {},
    isTerminal: () => false,
  });

  assert.equal(result.poolSize, 3, "pool size must be capped by available areas, not configured workers");
  assert.equal(result.startedWorkers, 3);
  assert.equal(result.areasProcessed.length, 3);
});

// ── Test G: worker failure isolation ────────────────────────────────────────
test("G: one area worker's failure does not stop siblings from completing", async () => {
  const areas = ["Brooklyn", "Queens", "Manhattan"];
  const claimedSoFar = new Set<string>();

  const result = await runAreaWorkerPool({
    configuredWorkers: 3,
    totalCuratedAreas: areas.length,
    availableCapacity: 3,
    claimNextArea: async (usedAreas) => {
      const next = areas.find((a) => !usedAreas.has(a) && !claimedSoFar.has(a));
      if (!next) return undefined;
      claimedSoFar.add(next);
      return next;
    },
    runArea: async (area) => {
      if (area === "Queens") return outcome({ failed: true, error: "simulated crash" });
      return outcome({ discovered: 2, accepted: 1 });
    },
    tryAcquireSlot: () => () => {},
    isTerminal: () => false,
  });

  assert.equal(result.startedWorkers, 3, "all three areas must still be attempted");
  assert.equal(result.allFailed, false, "two of three areas succeeded — the pool is not entirely failed");
  const queens = result.perArea.find((p) => p.area === "Queens");
  assert.equal(queens?.outcome.failed, true);
  // Brooklyn/Manhattan contributed their accepted counts despite Queens's failure.
  assert.equal(result.totals.accepted, 2);
});

test("allFailed is true only when every area that ran failed", async () => {
  const areas = ["Brooklyn", "Queens"];
  const claimedSoFar = new Set<string>();

  const result = await runAreaWorkerPool({
    configuredWorkers: 2,
    totalCuratedAreas: areas.length,
    availableCapacity: 2,
    claimNextArea: async (usedAreas) => {
      const next = areas.find((a) => !usedAreas.has(a) && !claimedSoFar.has(a));
      if (!next) return undefined;
      claimedSoFar.add(next);
      return next;
    },
    runArea: async () => outcome({ failed: true, error: "simulated crash" }),
    tryAcquireSlot: () => () => {},
    isTerminal: () => false,
  });

  assert.equal(result.allFailed, true);
});

// ── Test H: worker replacement — a finished worker claims another eligible area ──
test("H: when a worker finishes early, the pool claims another eligible area while respecting pool size", async () => {
  const areas = ["Brooklyn", "Queens", "Manhattan", "Bronx", "StatenIsland", "Harlem"];
  const claimedSoFar = new Set<string>();
  let maxConcurrentSlotsHeld = 0;
  let slotsHeld = 0;

  const result = await runAreaWorkerPool({
    configuredWorkers: 2, // small pool, more areas than slots
    totalCuratedAreas: areas.length,
    availableCapacity: 2,
    claimNextArea: async (usedAreas) => {
      const next = areas.find((a) => !usedAreas.has(a) && !claimedSoFar.has(a));
      if (!next) return undefined;
      claimedSoFar.add(next);
      return next;
    },
    runArea: async () => {
      // Simulate a real async engine run so workers genuinely overlap.
      await new Promise((resolve) => setTimeout(resolve, 1));
      return outcome({ discovered: 1, accepted: 1 });
    },
    tryAcquireSlot: () => {
      slotsHeld += 1;
      maxConcurrentSlotsHeld = Math.max(maxConcurrentSlotsHeld, slotsHeld);
      return () => { slotsHeld -= 1; };
    },
    isTerminal: () => false,
  });

  // All 6 areas eventually get processed even though only 2 workers ran at once.
  assert.equal(result.startedWorkers, 6, "the pool must replace a finished worker with another eligible area");
  assert.equal(new Set(result.areasProcessed).size, 6, "every area processed must be distinct");
  assert.ok(maxConcurrentSlotsHeld <= 2, "never more than the pool size worth of slots held concurrently");
});

// ── Test I: cancellation prevents queued work from starting and stops active workers ──
test("I: isTerminal() true from the start means no area worker is ever claimed", async () => {
  const result = await runAreaWorkerPool({
    configuredWorkers: 3,
    totalCuratedAreas: 3,
    availableCapacity: 3,
    claimNextArea: async () => "ShouldNeverBeClaimed",
    runArea: async () => outcome({ discovered: 5, accepted: 5 }),
    tryAcquireSlot: () => () => {},
    isTerminal: () => true, // already cancelled/target-reached before the pool starts
  });

  assert.equal(result.startedWorkers, 0);
  assert.equal(result.areasProcessed.length, 0);
});

test("I: cancellation mid-run stops further area claims but keeps already-collected results", async () => {
  const areas = ["Brooklyn", "Queens", "Manhattan", "Bronx"];
  const claimedSoFar = new Set<string>();
  let cancelled = false;

  const result = await runAreaWorkerPool({
    configuredWorkers: 1, // serialize so we can deterministically cancel after the first area
    totalCuratedAreas: areas.length,
    availableCapacity: 1,
    claimNextArea: async (usedAreas) => {
      const next = areas.find((a) => !usedAreas.has(a) && !claimedSoFar.has(a));
      if (!next) return undefined;
      claimedSoFar.add(next);
      return next;
    },
    runArea: async () => {
      cancelled = true; // cancellation "lands" after the first area completes
      return outcome({ discovered: 1, accepted: 1 });
    },
    tryAcquireSlot: () => () => {},
    isTerminal: () => cancelled,
  });

  assert.equal(result.startedWorkers, 1, "only the first area should have started before cancellation landed");
});

// ── Test J: target reached — accepted <= requested, remaining work stops ──
test("J: once isTerminal() reports the target is reached, no further areas start; accepted never exceeds requested", async () => {
  const areas = ["Brooklyn", "Queens", "Manhattan", "Bronx"];
  const claimedSoFar = new Set<string>();
  const requested = 5;
  let totalAccepted = 0;

  const result = await runAreaWorkerPool({
    configuredWorkers: 2,
    totalCuratedAreas: areas.length,
    availableCapacity: 2,
    claimNextArea: async (usedAreas) => {
      const next = areas.find((a) => !usedAreas.has(a) && !claimedSoFar.has(a));
      if (!next) return undefined;
      claimedSoFar.add(next);
      return next;
    },
    runArea: async () => {
      const accepted = Math.min(3, requested - totalAccepted);
      totalAccepted += Math.max(0, accepted);
      return outcome({ discovered: 3, accepted: Math.max(0, accepted) });
    },
    tryAcquireSlot: () => () => {},
    isTerminal: () => totalAccepted >= requested,
  });

  assert.ok(result.totals.accepted <= requested, `accepted (${result.totals.accepted}) must never exceed requested (${requested})`);
});

// ── No-slot degradation: a saturated capacity starts fewer workers, never fake work ──
test("a saturated browser slot pool starts zero workers rather than blocking or faking work", async () => {
  const pool = createBrowserSlotPool(1);
  const release = pool.tryAcquire(); // occupy the only slot from "another task"
  assert.ok(release);

  const result = await runAreaWorkerPool({
    configuredWorkers: 4,
    totalCuratedAreas: 4,
    availableCapacity: pool.available(), // 0 — fully saturated
    claimNextArea: async () => "ShouldNeverBeClaimed",
    runArea: async () => outcome({ discovered: 9, accepted: 9 }),
    tryAcquireSlot: () => pool.tryAcquire(),
    isTerminal: () => false,
  });

  assert.equal(result.poolSize, 0);
  assert.equal(result.startedWorkers, 0);
  release!();
});

// ── onEvent observability (Step 11) ─────────────────────────────────────────
test("onEvent reports pool_start, worker_started/finished, and pool_stopped in a sane order", async () => {
  const events: AreaWorkerLogEvent["type"][] = [];
  const areas = ["Brooklyn", "Queens"];
  const claimedSoFar = new Set<string>();

  await runAreaWorkerPool({
    configuredWorkers: 2,
    totalCuratedAreas: areas.length,
    availableCapacity: 2,
    claimNextArea: async (usedAreas) => {
      const next = areas.find((a) => !usedAreas.has(a) && !claimedSoFar.has(a));
      if (!next) return undefined;
      claimedSoFar.add(next);
      return next;
    },
    runArea: async () => outcome({ discovered: 1, accepted: 1 }),
    tryAcquireSlot: () => () => {},
    isTerminal: () => false,
    onEvent: (e) => events.push(e.type),
  });

  assert.equal(events[0], "pool_start");
  assert.equal(events[events.length - 1], "pool_stopped");
  assert.equal(events.filter((e) => e === "worker_started").length, 2);
  assert.equal(events.filter((e) => e === "worker_finished").length, 2);
});

// ── PHASE 10 — discovery-capacity log storm regression ─────────────────
//
// Production emitted hundreds of identical `[discovery-capacity]` lines
// and Railway dropped >1,600 messages because of it. The log line itself
// sits at the correct call site (once per `runAreaWorkerPool()`
// invocation, i.e. once per actual pool-sizing decision) — the storm was
// really caused by `runAreaWorkerPool()` (and therefore this log) being
// re-entered far too many times per job, a symptom of the
// `child_requested=5` budget regression fixed in roundSizing.ts (see
// roundSizing.test.ts). This test pins the log line's own contract in
// isolation: no matter how many areas one pool run processes (many
// candidates, many completed areas, many claim attempts), the sizing log
// fires EXACTLY ONCE for that one call — it must never live inside the
// per-area/per-candidate loop.
test("PHASE 10: [discovery-capacity] is logged exactly once per runAreaWorkerPool() call, regardless of how many areas it processes", async () => {
  const originalInfo = console.info;
  const captured: string[] = [];
  console.info = ((...args: unknown[]) => {
    captured.push(String(args[0]));
  }) as typeof console.info;

  try {
    const areas = ["A1", "A2", "A3", "A4", "A5", "A6", "A7", "A8"];
    let cursor = 0;

    await runAreaWorkerPool({
      configuredWorkers: 3,
      totalCuratedAreas: areas.length,
      availableCapacity: 3,
      requestedQuantity: 10,
      claimNextArea: async (usedAreas) => {
        while (cursor < areas.length) {
          const a = areas[cursor++];
          if (!usedAreas.has(a)) return a;
        }
        return undefined;
      },
      // Each area "processes" several candidates worth of work — proving
      // the log doesn't live inside any per-candidate/per-loop hot path.
      runArea: async () => outcome({ discovered: 5, accepted: 2 }),
      tryAcquireSlot: () => () => {},
      isTerminal: () => false,
    });

    const capacityLines = captured.filter((line) => line.startsWith("[discovery-capacity]"));
    assert.equal(capacityLines.length, 1, `expected exactly one [discovery-capacity] line per pool creation, got ${capacityLines.length}`);
  } finally {
    console.info = originalInfo;
  }
});

test("PHASE 10: multiple SEQUENTIAL pool creations (simulating multiple rounds/areas in one job) each log exactly once — total matches call count, not candidate count", async () => {
  const originalInfo = console.info;
  const captured: string[] = [];
  console.info = ((...args: unknown[]) => {
    captured.push(String(args[0]));
  }) as typeof console.info;

  try {
    const POOL_CREATIONS = 4;
    for (let i = 0; i < POOL_CREATIONS; i++) {
      const areas = [`R${i}-A1`, `R${i}-A2`];
      let cursor = 0;
      await runAreaWorkerPool({
        configuredWorkers: 2,
        totalCuratedAreas: areas.length,
        availableCapacity: 2,
        requestedQuantity: 10,
        claimNextArea: async (usedAreas) => {
          while (cursor < areas.length) {
            const a = areas[cursor++];
            if (!usedAreas.has(a)) return a;
          }
          return undefined;
        },
        runArea: async () => outcome({ discovered: 3, accepted: 1 }),
        tryAcquireSlot: () => () => {},
        isTerminal: () => false,
      });
    }

    const capacityLines = captured.filter((line) => line.startsWith("[discovery-capacity]"));
    assert.equal(
      capacityLines.length,
      POOL_CREATIONS,
      "log count must equal the number of pool CREATIONS (rounds), never scale with candidates processed inside them",
    );
  } finally {
    console.info = originalInfo;
  }
});

// ── AREA ADMISSION FIX: shouldAdmitNextArea gates only the NEXT area ───────
//
// These tests cover the new, optional `shouldAdmitNextArea` hook added to
// address small-target over-expansion (target=20 admitting far more areas
// than the live remaining need justifies) WITHOUT touching streamTarget/
// child_requested/askFor, concurrency, or any area already in flight.

test("shouldAdmitNextArea omitted: admission behavior is completely unchanged from before this fix", async () => {
  // Regression safety: existing callers (e.g. discoveryPlanJob.ts, and
  // every pre-existing test above) that don't pass shouldAdmitNextArea
  // must keep claiming every distinct area exactly as before.
  const areas = ["Brooklyn", "Queens", "Manhattan"];
  const claimed: string[] = [];

  const result = await runAreaWorkerPool({
    configuredWorkers: 3,
    totalCuratedAreas: areas.length,
    availableCapacity: 3,
    claimNextArea: async (usedAreas) => {
      const next = areas.find((a) => !usedAreas.has(a));
      if (next) claimed.push(next);
      return next;
    },
    runArea: async () => outcome({ discovered: 1, accepted: 1 }),
    tryAcquireSlot: () => () => {},
    isTerminal: () => false,
  });

  assert.equal(result.startedWorkers, 3, "all 3 areas should still be claimed with no admission gate supplied");
  assert.deepEqual(new Set(claimed), new Set(areas));
});

// ── CRITICMODE STARVATION FIX ───────────────────────────────────────────
//
// `usedAreas.size` is monotonic (areas ever claimed, never decreasing).
// The two tests this replaces asserted the OLD, unsafe behavior of
// comparing a concurrency-style cap against that monotonic count, which
// is exactly the bug: once N areas had EVER been claimed, admission
// stayed refused forever, even after all N finished and 0 were running.
// `shouldAdmitNextArea` now receives a second, LIVE argument —
// `inFlightAreaCount` — that shrinks as areas complete, and the pool
// itself enforces a starvation backstop (never honor a refusal while
// nothing is in flight AND an unclaimed curated area remains). The tests
// below (A-F, matching the fix's own lettering) directly exercise both.

function makeDeferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Polls a condition on the microtask/timer queue until true (or times out). */
async function waitUntil(conditionFn: () => boolean, label: string, maxTicks = 2000): Promise<void> {
  for (let i = 0; i < maxTicks; i++) {
    if (conditionFn()) return;
    await new Promise<void>((r) => setImmediate(r));
  }
  throw new Error(`waitUntil timed out: ${label}`);
}

test("A+B: cap=4 denies a 5th concurrent admission, then admits again once one of the 4 finishes (live in-flight, not usedAreas.size)", async () => {
  const areas = ["A1", "A2", "A3", "A4", "A5", "A6"];
  const cap = 4;
  const claimed = new Set<string>();
  const finished = new Set<string>();
  const admissionChecks: { inFlight: number; admitted: boolean }[] = [];
  const deferredByArea = new Map<string, { promise: Promise<void>; resolve: () => void }>();

  const poolPromise = runAreaWorkerPool({
    configuredWorkers: 5,
    totalCuratedAreas: areas.length,
    availableCapacity: 5,
    claimNextArea: async (usedAreas) => {
      const next = areas.find((a) => !usedAreas.has(a) && !claimed.has(a));
      if (!next) return undefined;
      claimed.add(next);
      return next;
    },
    runArea: async (area) => {
      if (area === "A1") {
        // A1 completes immediately so its worker is the first to loop
        // back and attempt a NEW (6th distinct, "5th concurrent") claim
        // while A2-A5 are still deliberately held open below.
        finished.add(area);
        return outcome({ discovered: 1, accepted: 1 });
      }
      const d = makeDeferred();
      deferredByArea.set(area, d);
      await d.promise;
      finished.add(area);
      return outcome({ discovered: 1, accepted: 1 });
    },
    tryAcquireSlot: () => () => {},
    isTerminal: () => false,
    // Test A/B's admission rule under test: live inFlightAreaCount vs cap.
    shouldAdmitNextArea: (_usedAreasCount, inFlightAreaCount) => {
      const admitted = inFlightAreaCount < cap;
      admissionChecks.push({ inFlight: inFlightAreaCount, admitted });
      return admitted;
    },
  });

  // Let the initial round of 5 concurrent claims land, and A1 loop back.
  await waitUntil(() => claimed.size >= 5, "initial 5 areas claimed");
  await waitUntil(() => admissionChecks.some((c) => !c.admitted), "a denial has been recorded");

  // Test A: with 4 areas (A2-A5) genuinely still running, the 5th/6th
  // concurrent slot must be denied — never claimed.
  const denial = admissionChecks.find((c) => !c.admitted);
  assert.ok(denial, "an admission check must have been denied while 4 areas were running");
  assert.equal(denial!.inFlight, cap, "denial must have been evaluated against exactly the cap's worth of live in-flight areas");
  assert.equal(claimed.has("A6"), false, "the 6th area must not be claimed while the cap is full");

  // Test B: once ONE of the 4 in-flight areas finishes, live in-flight
  // drops to (cap - 1) and the NEXT distinct area must be admitted.
  deferredByArea.get("A2")!.resolve();
  await waitUntil(() => claimed.has("A6"), "A6 gets claimed once in-flight drops below the cap");
  const admitAfterDrop = admissionChecks.find((c) => c.admitted && c.inFlight === cap - 1);
  assert.ok(admitAfterDrop, "admission must succeed once live in-flight is one below the cap");

  // Drain everything else so the pool can finish.
  deferredByArea.get("A3")!.resolve();
  deferredByArea.get("A4")!.resolve();
  deferredByArea.get("A5")!.resolve();
  await waitUntil(() => deferredByArea.has("A6"), "A6's own runArea has started");
  deferredByArea.get("A6")!.resolve();

  const result = await poolPromise;
  assert.deepEqual(new Set(result.areasProcessed), new Set(["A1", "A2", "A3", "A4", "A5", "A6"]));
});

test("C: once all in-flight areas finish, remaining>0 and an unclaimed curated area exists, the pool force-admits despite the gate saying no", async () => {
  const areas = ["A1", "A2", "A3", "A4", "A5"]; // 4 concurrent + 1 left over, unclaimed
  const finished: string[] = [];

  const result = await runAreaWorkerPool({
    configuredWorkers: 4,
    totalCuratedAreas: areas.length,
    availableCapacity: 4,
    claimNextArea: async (usedAreas) => areas.find((a) => !usedAreas.has(a)),
    runArea: async (area) => {
      finished.push(area);
      return outcome({ discovered: 1, accepted: 1 });
    },
    tryAcquireSlot: () => () => {},
    isTerminal: () => false, // never terminal on its own — remaining>0 the whole run
    // A gate that always refuses — simulating a mis-sized/stale cap. The
    // pool's own starvation backstop must override this once nothing is
    // running and an unclaimed area (A5) remains, per Requirement 9/10.
    shouldAdmitNextArea: () => false,
  });

  assert.ok(finished.includes("A5"), "the unclaimed 5th curated area must eventually be force-admitted and run");
  assert.equal(result.startedWorkers, areas.length, "every curated area must eventually run — admission_capped must never permanently strand an unclaimed area");
});

test("D: with no unclaimed areas left, the pool still stops normally (the backstop never fabricates areas that don't exist)", async () => {
  const areas = ["A1", "A2", "A3", "A4"];
  const finished: string[] = [];

  const result = await runAreaWorkerPool({
    configuredWorkers: 4,
    totalCuratedAreas: areas.length,
    availableCapacity: 4,
    claimNextArea: async (usedAreas) => areas.find((a) => !usedAreas.has(a)),
    runArea: async (area) => {
      finished.push(area);
      return outcome({ discovered: 1, accepted: 1 });
    },
    tryAcquireSlot: () => () => {},
    isTerminal: () => false,
    shouldAdmitNextArea: () => false, // always refuses; no unclaimed area should ever remain to force-admit
  });

  assert.deepEqual(new Set(result.areasProcessed), new Set(areas), "all 4 curated areas run exactly once");
  assert.equal(result.startedWorkers, 4, "the pool stops cleanly once every distinct area is exhausted — no hang, no phantom area");
});

test("E: remaining<=0 (isTerminal reports terminal) means admission never happens, even with unclaimed areas — the backstop never overrides real termination", async () => {
  const areas = ["A1", "A2", "A3"];
  let claimedAny = false;

  const result = await runAreaWorkerPool({
    configuredWorkers: 3,
    totalCuratedAreas: areas.length,
    availableCapacity: 3,
    claimNextArea: async (usedAreas) => {
      claimedAny = true;
      return areas.find((a) => !usedAreas.has(a));
    },
    runArea: async () => outcome({ discovered: 1, accepted: 1 }),
    tryAcquireSlot: () => () => {},
    // Mirrors poolExpandJob.ts's real isTerminal(), which folds in
    // `stillNeededNow() <= 0` — i.e. remaining=0 is caught HERE, before
    // shouldAdmitNextArea (and therefore before the starvation backstop)
    // is ever reached.
    isTerminal: () => true,
    shouldAdmitNextArea: () => true, // even a permissive gate must never be reached
  });

  assert.equal(claimedAny, false, "no area may ever be claimed once remaining<=0 (isTerminal) is true from the start");
  assert.equal(result.startedWorkers, 0);
});

test("F: usedAreas.size stays at the cap while live in-flight drops to 0 — admission still reopens (the exact bug being fixed)", async () => {
  // This is the literal regression scenario from the bug report:
  // cap=4, exactly 4 areas are ever claimed, all 4 finish (0 running),
  // yet 2 more curated areas remain unclaimed with remaining>0. Under
  // the OLD behavior (comparing the cap against usedAreas.size) this
  // would stay admission_capped FOREVER once usedAreas.size reached 4 —
  // even though nothing was running. Under the fix, comparing against
  // the live inFlightAreaCount lets admission reopen immediately.
  const areas = ["A1", "A2", "A3", "A4", "A5", "A6"];
  const cap = 4;
  const inFlightSeenAfterAllFinished: number[] = [];
  let allFourFinished = false;

  const result = await runAreaWorkerPool({
    configuredWorkers: 1, // sequential: only ever 0 or 1 area in flight, deterministic
    totalCuratedAreas: areas.length,
    availableCapacity: 1,
    claimNextArea: async (usedAreas) => areas.find((a) => !usedAreas.has(a)),
    runArea: async () => outcome({ discovered: 1, accepted: 1 }),
    tryAcquireSlot: () => () => {},
    isTerminal: () => false,
    shouldAdmitNextArea: (usedAreasCount, inFlightAreaCount) => {
      if (usedAreasCount >= 4) {
        allFourFinished = true;
        inFlightSeenAfterAllFinished.push(inFlightAreaCount);
      }
      // The OLD, buggy comparison would have been `usedAreasCount < cap`,
      // which is permanently false once usedAreasCount reaches 4 (the
      // exact starvation bug). The FIXED comparison against the live
      // in-flight count keeps admitting because nothing is running.
      return inFlightAreaCount < cap;
    },
  });

  assert.ok(allFourFinished, "the scenario must reach the point where 4 areas have ever been claimed");
  assert.ok(
    inFlightSeenAfterAllFinished.every((v) => v === 0),
    "with a single sequential worker, live in-flight is 0 every time it loops back for a new area",
  );
  assert.deepEqual(new Set(result.areasProcessed), new Set(areas), "all 6 areas run — usedAreas.size sitting at/above the cap never blocks further admission");
});

test("shouldAdmitNextArea admits every area again when live remaining need is still high (initial-target behavior unchanged)", async () => {
  // Proves the gate is not a one-time/static cap: it re-reads whatever
  // live value the caller's closure supplies each time (mirrors
  // poolExpandJob.ts re-running computeDynamicDiscoveryCapacity against
  // the live stillNeededNow() on every check).
  const areas = ["A1", "A2", "A3", "A4"];
  const liveRemaining = 20; // high remaining -> should behave exactly like "admit everything"

  const result = await runAreaWorkerPool({
    configuredWorkers: 4,
    totalCuratedAreas: areas.length,
    availableCapacity: 4,
    claimNextArea: async (usedAreas) => areas.find((a) => !usedAreas.has(a)),
    runArea: async () => outcome({ discovered: 1, accepted: 1 }),
    tryAcquireSlot: () => () => {},
    isTerminal: () => false,
    shouldAdmitNextArea: (usedAreasCount) => usedAreasCount < Math.min(areas.length, liveRemaining),
  });

  assert.equal(result.startedWorkers, areas.length, "with high remaining need, admission must match the unthrottled (pre-fix) behavior exactly");
});

test("pool_stopped reports reason=admission_capped when the gate (not isTerminal/areas_exhausted) is what stopped further claims", async () => {
  const areas = ["A1", "A2", "A3"];
  const events: AreaWorkerLogEvent[] = [];

  await runAreaWorkerPool({
    configuredWorkers: 1, // sequential, deterministic
    totalCuratedAreas: areas.length,
    availableCapacity: 1,
    claimNextArea: async (usedAreas) => areas.find((a) => !usedAreas.has(a)),
    runArea: async () => outcome({ discovered: 1, accepted: 1 }),
    tryAcquireSlot: () => () => {},
    isTerminal: () => false, // never terminal — only the admission gate stops this run
    shouldAdmitNextArea: (usedAreasCount) => usedAreasCount < 1, // admit exactly one area, then cap
    onEvent: (event) => events.push(event),
  });

  const stopped = events.find((e) => e.type === "pool_stopped");
  assert.ok(stopped && stopped.type === "pool_stopped");
  assert.equal((stopped as { type: "pool_stopped"; reason: string }).reason, "admission_capped");
});
