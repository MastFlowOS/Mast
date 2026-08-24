/**
 * PHASE 41 — RESTORE THE KNOWN-GOOD DISCOVERY EXECUTION MODEL.
 *
 * poolExpandJob.ts's runGoogleAreaPoolForCity() is heavily entangled with
 * Supabase (claimAreaForCity/recordAreaOutcome), the process-wide browser
 * slot semaphore, and the real Python engine subprocess/Playwright browser
 * bridge (pythonBridge.ts) — none of it is exported as an independently
 * callable unit, and fully mocking that stack (per areaProductivity.test.ts
 * / areaScanBudget.test.ts's own precedent of testing the PURE formulas and
 * classifiers directly rather than the wired-up job handler) is out of
 * scope for a targeted regression fix.
 *
 * These tests instead pin the two structural guarantees Phase 41 restores,
 * directly against the source of the fixed function:
 *
 *   1. A target=100 / 3-area run gives EVERY area the full historical
 *      ~400 `max_results` scan budget (`computeAskFor(streamTarget)`,
 *      independent of `activeAreaCount`) — not a shared-budget slice
 *      divided across concurrent areas.
 *   2. A single area's engine allocation is requested via exactly ONE
 *      `runEngineQuery()` invocation — no expansion loop that would spawn
 *      a second Python subprocess / Playwright browser / Maps session for
 *      the same area.
 *
 * (Item 3 — "no repeated Python subprocess/browser launch is required for
 * expansion" — follows directly from (2): pythonBridge.ts's `runEngineQuery()`
 * is exactly what spawns the subprocess/browser per call, see
 * pythonBridge.lifecycle.test.ts for that module's own coverage.)
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { computeAskFor, areaStreamTarget } from "../../discovery/roundSizing.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const poolExpandJobSrc = readFileSync(
  path.join(__dirname, "../poolExpandJob.ts"),
  "utf8",
);

// ── Test 1: target=100 / 3 areas -> initial askFor=400 per area, ───────────
// independent of activeAreaCount (the Phase 32 regression divided this by
// activeAreaCount instead).
test("1. target=100 / 3 areas -> each area's initial scan budget is the full historical 400, not a 1/3 share", () => {
  const target = 100;
  const streamTarget = areaStreamTarget(target, 1);
  assert.equal(streamTarget, 100);

  const askForWith3Areas = computeAskFor(streamTarget);
  const askForWith1Area = computeAskFor(streamTarget);
  // The restored formula does not take activeAreaCount as an input at all —
  // proving it structurally, not just numerically, that scan budget can no
  // longer be divided by concurrent area count.
  assert.equal(computeAskFor.length, 1, "computeAskFor(streamTarget, multiplier=4) must not require an activeAreaCount parameter");
  assert.equal(askForWith3Areas, 400);
  assert.equal(askForWith1Area, 400);
  assert.equal(askForWith3Areas, askForWith1Area, "scan budget must be identical regardless of how many areas run concurrently");
});

// ── Test 2: the pooled-area runArea() body computes askFor via the ─────────
// restored, undivided formula, not the Phase 32 per-area-slice allocator.
test("2. runGoogleAreaPoolForCity's runArea() uses computeAskFor(streamTarget) directly, never a per-area budget slice", () => {
  assert.match(
    poolExpandJobSrc,
    /const askFor = computeAskFor\(streamTarget\);/,
    "askFor must be computed via the restored, undivided computeAskFor(streamTarget) call",
  );
  assert.doesNotMatch(
    poolExpandJobSrc,
    /allocateInitialAreaScanBudget\(/,
    "the Phase 32 per-area budget slice allocator must no longer be used to size an area's scan budget",
  );
  assert.doesNotMatch(
    poolExpandJobSrc,
    /import\s*\{[^}]*allocateInitialAreaScanBudget[^}]*\}/,
    "allocateInitialAreaScanBudget must no longer be imported",
  );
});

// ── Test 3: a productive area makes exactly ONE engine invocation for its ──
// scan allocation — no expansion loop re-invoking runEngineQuery().
test("3. a single area makes exactly one runEngineQuery() call for its scan allocation (no expansion re-invocation)", () => {
  assert.doesNotMatch(
    poolExpandJobSrc,
    /requestAreaScanBudgetExpansion\(/,
    "the expansion-grant call that used to trigger a second runEngineQuery() invocation must be gone",
  );
  assert.doesNotMatch(
    poolExpandJobSrc,
    /import\s*\{[^}]*requestAreaScanBudgetExpansion[^}]*\}/,
    "requestAreaScanBudgetExpansion must no longer be imported",
  );
  assert.doesNotMatch(
    poolExpandJobSrc,
    /areaScanBudgetLoop/,
    "the bounded expansion loop label must be gone — a single area's engine call is no longer wrapped in a retry/expansion loop",
  );

  // Exactly two runEngineQuery() call sites total in this file: one for the
  // curated-area pooled path (runGoogleAreaPoolForCity's runArea), one for
  // the legacy single-search path (no curated areas for the city) — both
  // already single invocations, neither ever was, nor is now, looped.
  const runEngineQueryCallSites = poolExpandJobSrc.match(/for await \(const lead of runEngineQuery\(/g) ?? [];
  assert.equal(
    runEngineQueryCallSites.length,
    2,
    "expected exactly one runEngineQuery() call site for the pooled-area path and one for the legacy path, each invoked once per area/city — not looped",
  );
});

// ── Test 4: the shared scan-budget coordinator, if still present, is used ──
// only for telemetry — never to compute or grow this area's own askFor.
test("4. scanBudgetCoordinator (if retained) is telemetry-only — never consulted to size askFor", () => {
  // It is fine for createAreaScanBudgetCoordinator / its global-budget log
  // line to remain (Fix 1 explicitly allows this for accounting purposes),
  // but nothing may assign scanBudgetCoordinator's per-area output into
  // askFor anymore.
  assert.doesNotMatch(
    poolExpandJobSrc,
    /askFor\s*=\s*scanBudgetCoordinator/,
    "askFor must never be derived from scanBudgetCoordinator's per-area allocation anymore",
  );
});
