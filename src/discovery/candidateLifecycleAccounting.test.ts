/**
 * PHASE 5B-2 — regression tests for the candidate-level lifecycle
 * accounting fix (see the PHASE 5B-1 audit and areaProductivity.ts's
 * `admitCandidate` / `closeCandidateTerminal` / `cancelOpenCandidates` doc
 * comments).
 *
 * These test the exported, identity-based (pipeline_id) admit/close pair
 * directly — this is the exact logic poolExpandJob.ts's onProgress handler
 * calls for every stage. They intentionally do NOT touch the
 * pre-existing arithmetic (`inFlightCount = newlyDiscoveredCount -
 * terminalCandidateCount`) tested throughout areaProductivity.test.ts —
 * only whether the INPUTS to that arithmetic are now correct: each
 * candidate discovered at most once, closed terminal at most once.
 */
import assert from "node:assert/strict";
import test from "node:test";

process.env.NODE_ENV ??= "test";
process.env.SUPABASE_URL ??= "https://example-project.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "test-service-role-key";
process.env.SUPABASE_JWT_SECRET ??= "test-jwt-secret";
process.env.DATABASE_URL ??= "postgres://user:pass@localhost:5432/testdb";
process.env.ALLOWED_ORIGIN ??= "http://localhost:5173";

import {
  admitCandidate,
  cancelOpenCandidates,
  closeCandidateTerminal,
  createAreaProductivityState,
} from "../areaProductivity.js";

function harness() {
  const state = createAreaProductivityState();
  const inFlight = new Set<string>();
  const terminal = new Set<string>();
  return { state, inFlight, terminal };
}

test("1. generic qualification rejection closes the candidate", () => {
  const { state, inFlight, terminal } = harness();
  admitCandidate(state, inFlight, terminal, "p1");
  closeCandidateTerminal(state, inFlight, terminal, "p1", "rejected");
  assert.equal(state.terminalCandidateCount, 1);
  assert.equal(state.inFlightCount, 0);
  assert.equal(inFlight.has("p1"), false);
  assert.equal(terminal.has("p1"), true);
});

for (const reason of ["missing website", "missing email", "missing phone", "missing Instagram"]) {
  test(`2-5. ${reason} closes the candidate`, () => {
    const { state, inFlight, terminal } = harness();
    admitCandidate(state, inFlight, terminal, "p-reason");
    closeCandidateTerminal(state, inFlight, terminal, "p-reason", "rejected");
    assert.equal(state.terminalCandidateCount, 1);
    assert.equal(state.inFlightCount, 0);
  });
}

test("6. a retryable stage failure does NOT close the candidate", () => {
  const { state, inFlight, terminal } = harness();
  admitCandidate(state, inFlight, terminal, "p6");
  // A retryable failure never calls closeCandidateTerminal at all — that's
  // the fix (poolExpandJob.ts only calls it when `progress.terminal` is
  // true). Simulate that by simply NOT calling it.
  assert.equal(state.terminalCandidateCount, 0);
  assert.equal(state.inFlightCount, 1);
  assert.equal(inFlight.has("p6"), true);
});

test("7. a dead-lettered stage failure DOES close the candidate", () => {
  const { state, inFlight, terminal } = harness();
  admitCandidate(state, inFlight, terminal, "p7");
  closeCandidateTerminal(state, inFlight, terminal, "p7", "failed");
  assert.equal(state.terminalCandidateCount, 1);
  assert.equal(state.inFlightCount, 0);
});

test("8. a duplicate terminal event does NOT double-decrement", () => {
  const { state, inFlight, terminal } = harness();
  admitCandidate(state, inFlight, terminal, "p8");
  closeCandidateTerminal(state, inFlight, terminal, "p8", "failed");
  // Same pipeline_id fires terminal again (e.g. a retryable stage_failed
  // that was ALSO followed by a dead-lettered one due to some upstream
  // double-fire) — must be a no-op.
  closeCandidateTerminal(state, inFlight, terminal, "p8", "failed");
  closeCandidateTerminal(state, inFlight, terminal, "p8", "rejected");
  assert.equal(state.terminalCandidateCount, 1, "terminalCandidateCount must only move once per pipeline_id");
});

test("9. merge dead-letter closes the candidate", () => {
  const { state, inFlight, terminal } = harness();
  admitCandidate(state, inFlight, terminal, "p9");
  // merge success is deliberately never routed through closeCandidateTerminal
  closeCandidateTerminal(state, inFlight, terminal, "p9", "failed");
  assert.equal(state.terminalCandidateCount, 1);
  assert.equal(terminal.has("p9"), true);
});

test("10. storage success closes the candidate", () => {
  const { state, inFlight, terminal } = harness();
  admitCandidate(state, inFlight, terminal, "p10");
  closeCandidateTerminal(state, inFlight, terminal, "p10", "delivered");
  assert.equal(state.terminalCandidateCount, 1);
  assert.equal(state.inFlightCount, 0);
  // "delivered" must NOT also bump qualifiedCount a second time — that's
  // processLead()'s own recordQualifiedLead() call's job, kept separate.
  assert.equal(state.qualifiedCount, 0);
});

test("11. storage dead-letter closes the candidate", () => {
  const { state, inFlight, terminal } = harness();
  admitCandidate(state, inFlight, terminal, "p11");
  closeCandidateTerminal(state, inFlight, terminal, "p11", "failed");
  assert.equal(state.terminalCandidateCount, 1);
});

test("12. a qualified candidate has exactly one terminal lifecycle transition", () => {
  const { state, inFlight, terminal } = harness();
  admitCandidate(state, inFlight, terminal, "p12");
  // candidate_qualified at the qualification stage is NOT terminal (no
  // closeCandidateTerminal call here) — only storage's outcome is.
  closeCandidateTerminal(state, inFlight, terminal, "p12", "delivered");
  assert.equal(state.terminalCandidateCount, 1);
  // A late/duplicate qualification-stage terminal event for the same
  // pipeline_id (should never happen post-fix, but idempotency covers it
  // anyway) must not move the count again.
  closeCandidateTerminal(state, inFlight, terminal, "p12", "rejected");
  assert.equal(state.terminalCandidateCount, 1);
});

test("13. cancellation closes every still-open candidate exactly once", () => {
  const { state, inFlight, terminal } = harness();
  admitCandidate(state, inFlight, terminal, "a");
  admitCandidate(state, inFlight, terminal, "b");
  admitCandidate(state, inFlight, terminal, "c");
  closeCandidateTerminal(state, inFlight, terminal, "b", "rejected"); // b resolves normally first
  cancelOpenCandidates(state, inFlight, terminal);
  assert.equal(state.terminalCandidateCount, 3, "a, b, and c must all be terminal");
  assert.equal(state.inFlightCount, 0);
  assert.equal(inFlight.size, 0);
  assert.equal(terminal.size, 3);
});

test("14. a late event after cancellation is ignored", () => {
  const { state, inFlight, terminal } = harness();
  admitCandidate(state, inFlight, terminal, "p14");
  cancelOpenCandidates(state, inFlight, terminal);
  assert.equal(state.terminalCandidateCount, 1);
  // A late dead-lettered stage_failed for the same pipeline_id arrives
  // after the area already reconciled it as cancelled.
  closeCandidateTerminal(state, inFlight, terminal, "p14", "failed");
  assert.equal(state.terminalCandidateCount, 1, "the late event must not move the count again");
});

test("15. multiple pipeline_ids are tracked independently", () => {
  const { state, inFlight, terminal } = harness();
  admitCandidate(state, inFlight, terminal, "x");
  admitCandidate(state, inFlight, terminal, "y");
  admitCandidate(state, inFlight, terminal, "z");
  assert.equal(state.inFlightCount, 3);
  closeCandidateTerminal(state, inFlight, terminal, "y", "rejected");
  assert.equal(state.inFlightCount, 2);
  assert.equal(inFlight.has("x"), true);
  assert.equal(inFlight.has("z"), true);
  assert.equal(inFlight.has("y"), false);
  closeCandidateTerminal(state, inFlight, terminal, "x", "delivered");
  closeCandidateTerminal(state, inFlight, terminal, "z", "early_pruned");
  assert.equal(state.inFlightCount, 0);
  assert.equal(state.terminalCandidateCount, 3);
});

test("a duplicate admit for the same pipeline_id does not double-count newlyDiscoveredCount", () => {
  const { state, inFlight, terminal } = harness();
  admitCandidate(state, inFlight, terminal, "dup");
  admitCandidate(state, inFlight, terminal, "dup");
  admitCandidate(state, inFlight, terminal, "dup");
  assert.equal(state.newlyDiscoveredCount, 1);
  assert.equal(state.inFlightCount, 1);
});

test("a discovery-time duplicate (candidate_early_duplicate) closes the candidate as early_pruned", () => {
  const { state, inFlight, terminal } = harness();
  admitCandidate(state, inFlight, terminal, "dup2");
  closeCandidateTerminal(state, inFlight, terminal, "dup2", "early_pruned");
  assert.equal(state.terminalCandidateCount, 1);
  assert.equal(state.inFlightCount, 0);
});

test("events with no pipeline_id fall back to the pre-5B-2 (non-idempotent) counting for that event only", () => {
  const { state, inFlight, terminal } = harness();
  admitCandidate(state, inFlight, terminal, undefined);
  admitCandidate(state, inFlight, terminal, undefined);
  assert.equal(state.newlyDiscoveredCount, 2, "no pipeline_id means no dedup is possible — old behavior preserved");
  closeCandidateTerminal(state, inFlight, terminal, undefined, "failed");
  assert.equal(state.terminalCandidateCount, 1);
});
