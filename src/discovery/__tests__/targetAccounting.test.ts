/**
 * CRITMODE — user-scoped target accounting regression suite.
 *
 * Production incident: a followUp run requesting 10 Coffee Shop leads in
 * North America stopped with `parent_delivered=10 newForUser=9` — the
 * frontend correctly showed 9 new opportunities, but the backend had
 * already terminated the run as successful, one genuinely-new lead short
 * of what the user actually requested.
 *
 * ROOT CAUSE: poolExpandJob.ts's stop condition and remaining-need
 * calculation both accepted the pool-wide `delivered` counter (every
 * business newly added to the Global Lead Pool, regardless of who it's
 * new for) as sufficient to satisfy a followUp run's target — either via
 * `newForUser >= target || delivered >= target` (the stop condition) or a
 * `newForUser > 0 ? ...newForUser : ...delivered` ternary (the live
 * remaining-need calc) that fell back to the pool-wide counter for every
 * lead up to and including the run's first genuinely-new delivery.
 *
 * THE FIX: targetAccounting.ts's remainingTarget()/isTargetReached()/
 * reportedDelivered() are the single source of truth poolExpandJob.ts now
 * calls into for every stop/remaining-need/reporting decision. These tests
 * pin the exact required invariant directly against those pure functions,
 * plus source-pattern checks confirming poolExpandJob.ts actually uses
 * them (not a raw `delivered >=`/`newForUser >=` comparison reintroduced
 * later), and that the non-user-scoped counters they replace (`delivered`,
 * area/child delivery counters) can never again single-handedly decide the
 * run is done.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { remainingTarget, isTargetReached, reportedDelivered, type TargetAccountingState } from "../targetAccounting.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const poolExpandJobSrc = readFileSync(path.join(__dirname, "../../jobs/poolExpandJob.ts"), "utf8");

function state(overrides: Partial<TargetAccountingState>): TargetAccountingState {
  return { shortfall: 10, delivered: 0, newForUser: 0, hasFollowUp: true, ...overrides };
}

// ── 1. target=10, 10 delivered, 9 new → must continue ──────────────────
test("1. target=10, parent_delivered=10, newForUser=9 -> run must NOT be considered complete (the exact production incident)", () => {
  const s = state({ shortfall: 10, delivered: 10, newForUser: 9 });
  assert.equal(isTargetReached(s), false, "10 pool-wide deliveries must never satisfy a followUp target when only 9 are genuinely new for the user");
  assert.equal(remainingTarget(s), 1, "exactly 1 more genuinely-new lead is still needed");
});

// ── 2. target=10, 10 delivered, 10 new → may stop ───────────────────────
test("2. target=10, parent_delivered=10, newForUser=10 -> run may stop", () => {
  const s = state({ shortfall: 10, delivered: 10, newForUser: 10 });
  assert.equal(isTargetReached(s), true);
  assert.equal(remainingTarget(s), 0);
});

// ── 3. duplicate discovered after 9 new → must continue discovery ──────
test("3. after 9 new deliveries, a duplicate-for-this-user delivery (delivered increments, newForUser does not) -> must continue", () => {
  // 9 genuinely new + 1 duplicate-for-this-user (still counted in the
  // pool-wide `delivered` counter, per deliverLead.ts's own semantics —
  // see that file's doc comment) must NOT be mistaken for target=10 reached.
  const beforeDuplicate = state({ shortfall: 10, delivered: 9, newForUser: 9 });
  assert.equal(isTargetReached(beforeDuplicate), false);

  const afterDuplicate = state({ shortfall: 10, delivered: 10, newForUser: 9 });
  assert.equal(isTargetReached(afterDuplicate), false, "a duplicate must not be able to push the run over its target");
  assert.equal(remainingTarget(afterDuplicate), 1);
});

// ── 4. duplicate-only candidates must not increment newForUser ─────────
// (asserted against deliverLead.ts's insertLeadForUser(), the actual
// producer of wasNewForUser — targetAccounting.ts only consumes the
// result, so this pins the upstream contract the whole fix depends on.)
test("4. insertLeadForUser returns wasNewForUser=false (no credit charged, no target slot consumed) for a business the user already owns", () => {
  const deliverLeadSrc = readFileSync(path.join(__dirname, "../../scraperBridge/deliverLead.ts"), "utf8");

  // The "user already has this business" existence check happens BEFORE
  // any reservation (claim_discovery_delivery) is attempted, and returns
  // wasNewForUser:false without reserving a plan slot.
  assert.match(
    deliverLeadSrc,
    /if \(existing\) \{\s*\n\s*return \{ businessId: business\.id, wasNewForUser: false \};/,
    "a business the requesting user already owns must short-circuit to wasNewForUser:false before any target-slot reservation is attempted",
  );

  // The existence check textually precedes the claim_discovery_delivery
  // reservation call, confirming a duplicate-for-this-user can never reach
  // (and therefore never consume) a target slot.
  const existingCheckIdx = deliverLeadSrc.indexOf("eq(\"business_id\", business.id)");
  const reservationIdx = deliverLeadSrc.indexOf("claim_discovery_delivery");
  assert.ok(existingCheckIdx !== -1 && reservationIdx !== -1, "expected both the existence check and the reservation call to be present");
  assert.ok(existingCheckIdx < reservationIdx, "the already-owns-this-business check must run before the target-slot reservation, not after");
});

test("4b. a candidate that IS a duplicate for the requesting user never advances remainingTarget()/isTargetReached() on its own", () => {
  // Simulates processLead(): delivered += 1 always happens (pool grew),
  // newForUser += 1 only if result.wasNewForUser (false for a duplicate).
  let delivered = 9;
  let newForUser = 9;
  const shortfall = 10;

  // Duplicate-for-this-user candidate arrives: deliverLead() resolves
  // without throwing (delivered increments) but wasNewForUser is false.
  delivered += 1;
  const wasNewForUser = false;
  if (wasNewForUser) newForUser += 1;

  const s = state({ shortfall, delivered, newForUser });
  assert.equal(newForUser, 9, "a duplicate-for-this-user candidate must never increment newForUser");
  assert.equal(isTargetReached(s), false, "the run must still need exactly 1 more genuinely-new lead");
});

// ── 5. child/area delivery counters must not prematurely trigger ───────
//        global target completion
test("5. only newForUser (via isTargetReached/remainingTarget) drives global stop-outer — never a child/area-scoped counter", () => {
  // Every place in poolExpandJob.ts that can return "stop_outer" (the
  // signal that tears down ALL concurrent areas/cities, not just one) must
  // route through isTargetReached() — never a bare `delivered >=`/
  // `newForUser >=` comparison, and never an area-local counter like
  // `productivity.deliveredCount` or a child's own `info.delivered`.
  const stopOuterBlockMatches = [...poolExpandJobSrc.matchAll(/return "stop_outer";/g)];
  assert.ok(stopOuterBlockMatches.length >= 3, "expected at least 3 stop_outer return points (cancelled / plan-limit / target-reached)");

  // The ONLY target-completion stop_outer sites must be gated by
  // isTargetReached(...), not a raw counter comparison.
  assert.match(
    poolExpandJobSrc,
    /if \(isTargetReached\(\{ shortfall: payload\.shortfall, delivered, newForUser, hasFollowUp: true \}\)\) \{/,
    "the followUp stop condition must call isTargetReached(), not a raw newForUser/delivered comparison",
  );
  assert.match(
    poolExpandJobSrc,
    /else if \(isTargetReached\(\{ shortfall: payload\.shortfall, delivered, newForUser, hasFollowUp: false \}\)\) \{/,
    "the bare pool-growth stop condition must also call isTargetReached()",
  );

  // The exact regression pattern (an OR'd/bare non-user-scoped comparison
  // deciding TARGET_REACHED on its own) must never reappear.
  assert.doesNotMatch(
    poolExpandJobSrc,
    /newForUser >= payload\.shortfall \|\| delivered >= payload\.shortfall/,
    "the fixed OR-with-pool-wide-counter regression must not reappear",
  );

  // Area/child-scoped counters (productivity.deliveredCount, a child's own
  // info.delivered from logChildTelemetry) must never appear anywhere near
  // an abortController.abort(\"TARGET_REACHED\") / terminateRequest(...,
  // \"TARGET_REACHED\") call — those are area-local telemetry/productivity
  // signals only, and must never be able to trigger GLOBAL completion.
  const targetReachedAbortSites = [...poolExpandJobSrc.matchAll(/terminateRequest\(reqId, "TARGET_REACHED"\);\s*\n\s*abortController\.abort\("TARGET_REACHED"\);/g)];
  assert.ok(targetReachedAbortSites.length >= 2, "expected both the followUp and bare-pool-growth TARGET_REACHED abort sites");
  for (const m of targetReachedAbortSites) {
    const windowStart = Math.max(0, (m.index ?? 0) - 400);
    const surrounding = poolExpandJobSrc.slice(windowStart, m.index ?? 0);
    assert.doesNotMatch(
      surrounding,
      /productivity\.deliveredCount|info\.delivered|childDelivered/,
      "a TARGET_REACHED global abort must never be gated by an area/child-scoped delivery counter",
    );
  }
});

test("5b. area-local recordDeliveredLead()/productivity.deliveredCount is observational only, never fed into isTargetReached/remainingTarget", () => {
  // recordDeliveredLead / productivity.deliveredCount must be used only
  // for area-local yield/idle classification (evaluateAreaProductivity /
  // evaluateAreaYieldStop), never passed as the `delivered` or `newForUser`
  // argument to remainingTarget()/isTargetReached().
  assert.doesNotMatch(
    poolExpandJobSrc,
    /isTargetReached\(\{[^}]*productivity\.deliveredCount/,
    "isTargetReached() must never be called with an area-scoped productivity counter",
  );
  assert.doesNotMatch(
    poolExpandJobSrc,
    /remainingTarget\(\{[^}]*productivity\.deliveredCount/,
    "remainingTarget() must never be called with an area-scoped productivity counter",
  );
});

// ── Additional coverage: remainingTarget()/reportedDelivered() invariant ──
// across the whole state space the ternary bug regressed on.

test("remainingTarget/isTargetReached use newForUser for the ENTIRE followUp run, even while newForUser is still 0", () => {
  // This is the second, more subtle half of the original bug: the old
  // `newForUser > 0 ? ...newForUser : ...delivered` ternary fell back to
  // the pool-wide counter for every lead up to and including the first
  // genuinely-new delivery — so a run whose first several candidates were
  // all duplicates-for-this-user could see `delivered` alone reach the
  // target while newForUser was still 0.
  const allDuplicatesSoFar = state({ shortfall: 5, delivered: 5, newForUser: 0 });
  assert.equal(isTargetReached(allDuplicatesSoFar), false, "5 pool-wide deliveries that are ALL duplicates for this user must not satisfy a 5-lead target");
  assert.equal(remainingTarget(allDuplicatesSoFar), 5, "still need all 5 — none of them were new for this user");
});

test("bare pool-growth run (no followUp) correctly keeps using the pool-wide delivered counter", () => {
  const s = state({ shortfall: 10, delivered: 10, newForUser: 0, hasFollowUp: false });
  assert.equal(isTargetReached(s), true, "a run with no specific waiting user is satisfied once the pool itself has grown by the requested amount");
  assert.equal(reportedDelivered(s), 10);
});

test("reportedDelivered() agrees with isTargetReached()/remainingTarget() on the same denominator in every case", () => {
  for (const hasFollowUp of [true, false]) {
    for (const delivered of [0, 5, 9, 10, 12]) {
      for (const newForUser of [0, 5, 9, 10]) {
        const s = state({ shortfall: 10, delivered, newForUser, hasFollowUp });
        const reported = reportedDelivered(s);
        const remaining = remainingTarget(s);
        assert.equal(reported, hasFollowUp ? newForUser : delivered);
        assert.equal(reported + remaining, 10, "reported + remaining must always reconstruct the original target — no drift between the three functions");
      }
    }
  }
});

test("crossing exactly from 9 to 10 newForUser flips isTargetReached from false to true (boundary)", () => {
  assert.equal(isTargetReached(state({ shortfall: 10, delivered: 10, newForUser: 9 })), false);
  assert.equal(isTargetReached(state({ shortfall: 10, delivered: 10, newForUser: 10 })), true);
});

// ── Cross-user behavior preserved: another user may still receive the ──
// same business a first user already owns (not this module's concern —
// pinned here as a documentation-level regression guard against a
// "fix" that scopes ownership globally instead of per-(user,business)).
test("insertLeadForUser's already-owns-this-business check is scoped to (user_id, business_id), never global", () => {
  const deliverLeadSrc = readFileSync(path.join(__dirname, "../../scraperBridge/deliverLead.ts"), "utf8");
  assert.match(
    deliverLeadSrc,
    /\.eq\("user_id", ctx\.userId\)\s*\n\s*\.eq\("business_id", business\.id\)/,
    "the already-owns-this-business existence check must be scoped to this specific user, not a global business existence check " +
      "— otherwise a second user could never receive a business the first user already has",
  );
});
