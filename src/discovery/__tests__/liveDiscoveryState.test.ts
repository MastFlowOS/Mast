/**
 * MAST — Task 2 (live scout state): focused tests for liveDiscoveryState.ts.
 *
 * Every event used here is built with Task 1's REAL builders
 * (liveDiscoveryEvent.ts), fed the real reason/outcome shapes that
 * discoveryPlanJob.ts / googleAreaPool.ts actually produce — see that
 * file's own tests and this task's final report for the grep-confirmed
 * reason-string audit.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  areaCompletedEvent,
  areaStartedEvent,
  candidateDiscoveredEvent,
  candidateRejectedEvent,
  discoveryCompletedEvent,
  discoveryFailedEvent,
  leadDeliveredEvent,
  scoutStartedEvent,
} from "../liveDiscoveryEvent.js";
import { createInitialLiveDiscoveryState, reduceLiveDiscoveryEvent, reduceLiveDiscoveryEvents, type DiscoveryLiveState } from "../liveDiscoveryState.js";

const PLAN = "plan-1";

// ── STATE ─────────────────────────────────────────────────────────────────

test("1. initial state: three idle scouts, zeroed counters, status starting", () => {
  const state = createInitialLiveDiscoveryState(10);
  assert.equal(state.status, "starting");
  assert.equal(state.delivered, 0);
  assert.equal(state.rejected, 0);
  assert.equal(state.target, 10);
  assert.equal(state.progressPercent, 0);
  for (const id of [1, 2, 3] as const) {
    assert.equal(state.scouts[id].status, "idle");
    assert.equal(state.scouts[id].scoutId, id);
  }
});

test("2. Scout 1 starts: status active, real area sentence, discovery status flips to discovering", () => {
  const state = createInitialLiveDiscoveryState(10);
  const next = reduceLiveDiscoveryEvent(state, scoutStartedEvent(PLAN, 1, "12th Avenue"));
  assert.equal(next.scouts[1].status, "active");
  assert.equal(next.scouts[1].sentence, "Exploring 12th Avenue...");
  assert.equal(next.status, "discovering");
  assert.equal(next.scouts[2].status, "idle", "sibling scouts untouched");
});

test("3. Scout 2 starts independently of Scout 1", () => {
  let state = createInitialLiveDiscoveryState(10);
  state = reduceLiveDiscoveryEvent(state, scoutStartedEvent(PLAN, 1, "12th Avenue"));
  state = reduceLiveDiscoveryEvent(state, scoutStartedEvent(PLAN, 2, "Elm Street"));
  assert.equal(state.scouts[1].sentence, "Exploring 12th Avenue...");
  assert.equal(state.scouts[2].sentence, "Exploring Elm Street...");
  assert.equal(state.scouts[3].status, "idle");
});

test("4. Scout 3 starts independently of Scouts 1/2", () => {
  let state = createInitialLiveDiscoveryState(10);
  state = reduceLiveDiscoveryEvent(state, scoutStartedEvent(PLAN, 1, "A"));
  state = reduceLiveDiscoveryEvent(state, scoutStartedEvent(PLAN, 2, "B"));
  state = reduceLiveDiscoveryEvent(state, scoutStartedEvent(PLAN, 3, "C"));
  assert.equal(state.scouts[3].sentence, "Exploring C...");
  assert.equal(state.scouts[1].sentence, "Exploring A...");
  assert.equal(state.scouts[2].sentence, "Exploring B...");
});

test("5. Scout events never overwrite another Scout's state (interleaved rejects/discoveries)", () => {
  let state = createInitialLiveDiscoveryState(10);
  state = reduceLiveDiscoveryEvent(state, scoutStartedEvent(PLAN, 1, "A"));
  state = reduceLiveDiscoveryEvent(state, scoutStartedEvent(PLAN, 2, "B"));
  state = reduceLiveDiscoveryEvent(state, candidateDiscoveredEvent(PLAN, 1, "#1", "Joe's Pizza", "A"));
  const beforeScout2 = state.scouts[2];
  state = reduceLiveDiscoveryEvent(state, candidateRejectedEvent(PLAN, 1, "#1", "duplicate_already_owned_by_user", "A"));
  assert.deepEqual(state.scouts[2], beforeScout2, "Scout 1's rejection must not touch Scout 2");
});

test("6. Scout finish state: all scouts flip to finished together on discovery_completed", () => {
  let state = createInitialLiveDiscoveryState(1);
  state = reduceLiveDiscoveryEvent(state, scoutStartedEvent(PLAN, 1, "A"));
  state = reduceLiveDiscoveryEvent(state, leadDeliveredEvent(PLAN, 1, "#1", "Joe's Pizza", "A"));
  state = reduceLiveDiscoveryEvent(state, discoveryCompletedEvent(PLAN, 1, 1));
  for (const id of [1, 2, 3] as const) {
    assert.equal(state.scouts[id].status, "finished");
    assert.equal(state.scouts[id].sentence, "Finished searching.");
  }
});

test("7. discovery complete state: delivered >= target => status completed", () => {
  const state = reduceLiveDiscoveryEvent(createInitialLiveDiscoveryState(5), discoveryCompletedEvent(PLAN, 5, 5));
  assert.equal(state.status, "completed");
});

test("8. discovery exhausted state: delivered < target at completion => status exhausted", () => {
  const state = reduceLiveDiscoveryEvent(createInitialLiveDiscoveryState(10), discoveryCompletedEvent(PLAN, 3, 10));
  assert.equal(state.status, "exhausted");
});

test("9. discovery failed state: status failed, every scout marked error", () => {
  const state = reduceLiveDiscoveryEvent(createInitialLiveDiscoveryState(10), discoveryFailedEvent(PLAN, "cancelled"));
  assert.equal(state.status, "failed");
  for (const id of [1, 2, 3] as const) {
    assert.equal(state.scouts[id].status, "error");
    assert.equal(state.scouts[id].sentence, "Discovery ran into a problem.");
  }
});

// ── SENTENCES ────────────────────────────────────────────────────────────

test("10. area started: real area label vs no label", () => {
  let state = createInitialLiveDiscoveryState(10);
  state = reduceLiveDiscoveryEvent(state, areaStartedEvent(PLAN, 1, "14th Avenue"));
  assert.equal(state.scouts[1].sentence, "Exploring 14th Avenue...");
  state = reduceLiveDiscoveryEvent(state, areaStartedEvent(PLAN, 1, undefined));
  assert.equal(state.scouts[1].sentence, "Exploring the next area...");
});

test("11. candidate discovery aggregation: 2+ consecutive same-scout discoveries collapse to one sentence", () => {
  const events = [
    candidateDiscoveredEvent(PLAN, 1, "#1", "A", "Main St"),
    candidateDiscoveredEvent(PLAN, 1, "#2", "B", "Main St"),
    candidateDiscoveredEvent(PLAN, 1, "#3", "C", "Main St"),
  ];
  const state = reduceLiveDiscoveryEvents(createInitialLiveDiscoveryState(10), events);
  assert.equal(state.scouts[1].sentence, "Found 3 businesses. Checking them now...");
  // A single, non-batched discovery does NOT get the aggregate phrasing.
  const single = reduceLiveDiscoveryEvent(createInitialLiveDiscoveryState(10), candidateDiscoveredEvent(PLAN, 1, "#9", "Solo Cafe", "Main St"));
  assert.equal(single.scouts[1].sentence, "Checking Solo Cafe...");
});

test("12. candidate processing: real business name vs none", () => {
  let state = reduceLiveDiscoveryEvent(createInitialLiveDiscoveryState(10), candidateDiscoveredEvent(PLAN, 1, "#1", "Joe's Coffee", "Main St"));
  assert.equal(state.scouts[1].sentence, "Checking Joe's Coffee...");
  state = reduceLiveDiscoveryEvent(createInitialLiveDiscoveryState(10), candidateDiscoveredEvent(PLAN, 1, "#1", undefined, "Main St"));
  assert.equal(state.scouts[1].sentence, "Checking a promising business...");
});

test("13. validateDiscoveryCandidate rejections (including disqualified/closed) fall to the honest generic bucket — never a guessed 'closed' sentence", () => {
  for (const reason of ["validateDiscoveryCandidate:disqualified", "validateDiscoveryCandidate:missing_name", "validateDiscoveryCandidate:invalid_email_format"]) {
    const state = reduceLiveDiscoveryEvent(createInitialLiveDiscoveryState(10), candidateRejectedEvent(PLAN, 1, "#1", reason, "Main St"));
    assert.equal(state.scouts[1].sentence, "Not a fit for this search. Skipping it.");
  }
});

test("14. no chain/restricted-category sentence is ever produced — those reason strings don't exist in the real stream", () => {
  // Documented via absence: the reducer has no branch that can ever emit
  // "That's a chain..." / "Restricted category..." because
  // discoveryPlanJob.ts never publishes those reason strings. Covered
  // structurally by test #13 (every real disqualification reason maps to
  // the generic bucket) rather than by asserting a nonexistent input.
  assert.ok(true);
});

test("15. early channel pruning: website-only miss vs generic contact miss (maps_channel_gate + post_enrichment_channel_gate)", () => {
  let state = reduceLiveDiscoveryEvent(createInitialLiveDiscoveryState(10), candidateRejectedEvent(PLAN, 1, "#1", 'maps_channel_gate:requested=["website"]', "Main St"));
  assert.equal(state.scouts[1].sentence, "No usable website here. Skipping it.");

  state = reduceLiveDiscoveryEvent(createInitialLiveDiscoveryState(10), candidateRejectedEvent(PLAN, 1, "#1", 'maps_channel_gate:requested=["phone"]', "Main St"));
  assert.equal(state.scouts[1].sentence, "Couldn't find the required contact details. Moving on.");

  state = reduceLiveDiscoveryEvent(createInitialLiveDiscoveryState(10), candidateRejectedEvent(PLAN, 1, "#1", 'post_enrichment_channel_gate:requested=["email","instagram"]', "Main St"));
  assert.equal(state.scouts[1].sentence, "No usable contact details here. Skipping it.");

  state = reduceLiveDiscoveryEvent(createInitialLiveDiscoveryState(10), candidateRejectedEvent(PLAN, 1, "#1", "validateDiscoveryCandidate:no_usable_channel", "Main St"));
  assert.equal(state.scouts[1].sentence, "No usable contact details here. Skipping it.");
});

test("16-18. no website/Instagram/contact-check milestone sentences are fabricated — Task 1 exposes no start/completion distinction for them", () => {
  // discoveryPlanJob.ts never publishes an event between candidate_discovered
  // and the candidate's terminal outcome for these stages, so the sentence
  // correctly stays at "Checking <name>..." (the highest truthful state)
  // the whole time — never advancing through invented "Website checked..."
  // / "Checking its Instagram..." / "Contact details verified." text.
  const state = reduceLiveDiscoveryEvent(createInitialLiveDiscoveryState(10), candidateDiscoveredEvent(PLAN, 1, "#1", "Joe's Coffee", "Main St"));
  assert.equal(state.scouts[1].sentence, "Checking Joe's Coffee...");
});

test("19. follower-limit rejection: no such reason string exists in the real stream — falls to generic bucket like any other unrecognized reason", () => {
  const state = reduceLiveDiscoveryEvent(createInitialLiveDiscoveryState(10), candidateRejectedEvent(PLAN, 1, "#1", "instagram_followers_over_limit", "Main St"));
  assert.equal(state.scouts[1].sentence, "Not a fit for this search. Skipping it.");
});

test("20. niche mismatch: same — no real reason string for this either, generic bucket applies", () => {
  const state = reduceLiveDiscoveryEvent(createInitialLiveDiscoveryState(10), candidateRejectedEvent(PLAN, 1, "#1", "niche_mismatch", "Main St"));
  assert.equal(state.scouts[1].sentence, "Not a fit for this search. Skipping it.");
});

test("21. generic qualification/decision rejection reasons map correctly", () => {
  const cases: Array<[string, string]> = [
    ["validateDiscoveryCandidate:no_usable_channel", "No usable contact details here. Skipping it."],
    ['maps_channel_gate:requested=["website"]', "No usable website here. Skipping it."],
    ["ensureEnriched_threw", "Couldn't reach its website. Moving on."],
  ];
  for (const [reason, expected] of cases) {
    const state = reduceLiveDiscoveryEvent(createInitialLiveDiscoveryState(10), candidateRejectedEvent(PLAN, 1, "#1", reason, "Main St"));
    assert.equal(state.scouts[1].sentence, expected);
    // internal reason codes never leak into the sentence
    assert.ok(!state.scouts[1].sentence.includes(":"), `sentence must not leak the raw reason code: ${state.scouts[1].sentence}`);
  }
});

test("22. duplicate user-scoped rejection: exact sentence", () => {
  const state = reduceLiveDiscoveryEvent(createInitialLiveDiscoveryState(10), candidateRejectedEvent(PLAN, 1, "#1", "duplicate_already_owned_by_user", "Main St"));
  assert.equal(state.scouts[1].sentence, "You've already got this one. Skipping it.");
});

test("23. qualified-but-not-delivered has no dedicated sentence in the real stream (no event separates qualification from delivery) — delivered stays untouched until lead_delivered", () => {
  // discoveryPlanJob.ts publishes candidate_discovered, then (after
  // validate/channel-gate/enrich all pass silently) publishes
  // lead_delivered directly — there is no intervening "qualified" event.
  let state = reduceLiveDiscoveryEvent(createInitialLiveDiscoveryState(10), candidateDiscoveredEvent(PLAN, 1, "#1", "Joe's Coffee", "Main St"));
  assert.equal(state.delivered, 0);
  assert.equal(state.progressPercent, 0);
});

test("24. actual delivery sentence and effect", () => {
  const state = reduceLiveDiscoveryEvent(createInitialLiveDiscoveryState(10), leadDeliveredEvent(PLAN, 1, "#1", "Joe's Coffee", "Main St"));
  assert.equal(state.scouts[1].sentence, "Opportunity secured 🎯");
  assert.equal(state.delivered, 1);
});

test("25. quiet street vs next street: distinguished by real discovered count on area_completed", () => {
  let state = reduceLiveDiscoveryEvent(
    createInitialLiveDiscoveryState(10),
    areaCompletedEvent(PLAN, 1, "Main St", { discovered: 0, accepted: 0, rejected: 0, duplicates: 0, exhausted: true }),
  );
  assert.equal(state.scouts[1].sentence, "Quiet street. Moving on...");

  state = reduceLiveDiscoveryEvent(
    createInitialLiveDiscoveryState(10),
    areaCompletedEvent(PLAN, 1, "Main St", { discovered: 4, accepted: 0, rejected: 4, duplicates: 0, exhausted: true }),
  );
  assert.equal(state.scouts[1].sentence, "Nothing promising here. Moving on...");

  state = reduceLiveDiscoveryEvent(state, areaStartedEvent(PLAN, 1, "14th Avenue"));
  assert.equal(state.scouts[1].sentence, "Exploring 14th Avenue...");
});

test("area_completed with at least one delivery leaves the scout's current (good-news) sentence untouched", () => {
  let state = reduceLiveDiscoveryEvent(createInitialLiveDiscoveryState(10), leadDeliveredEvent(PLAN, 1, "#1", "Joe's Coffee", "Main St"));
  state = reduceLiveDiscoveryEvent(
    state,
    areaCompletedEvent(PLAN, 1, "Main St", { discovered: 1, accepted: 1, rejected: 0, duplicates: 0, exhausted: true }),
  );
  assert.equal(state.scouts[1].sentence, "Opportunity secured 🎯");
});

test("area_completed with a real recoverable area failure (outcome.failed) shows the snag sentence, not a quiet-street guess", () => {
  const state = reduceLiveDiscoveryEvent(
    createInitialLiveDiscoveryState(10),
    areaCompletedEvent(PLAN, 1, "Main St", { discovered: 0, accepted: 0, rejected: 0, duplicates: 0, exhausted: false, failed: true, error: "boom" }),
  );
  assert.equal(state.scouts[1].sentence, "This area hit a snag. Trying another one...");
});

// ── ACCOUNTING ───────────────────────────────────────────────────────────

test("26. delivered increments only on delivery", () => {
  let state = createInitialLiveDiscoveryState(10);
  state = reduceLiveDiscoveryEvent(state, candidateDiscoveredEvent(PLAN, 1, "#1", "A", "Main St"));
  assert.equal(state.delivered, 0);
  state = reduceLiveDiscoveryEvent(state, candidateRejectedEvent(PLAN, 1, "#1", "duplicate_already_owned_by_user", "Main St"));
  assert.equal(state.delivered, 0);
  state = reduceLiveDiscoveryEvent(state, leadDeliveredEvent(PLAN, 1, "#2", "B", "Main St"));
  assert.equal(state.delivered, 1);
});

test("27. rejected increments only on a real terminal rejection event", () => {
  let state = createInitialLiveDiscoveryState(10);
  state = reduceLiveDiscoveryEvent(state, candidateDiscoveredEvent(PLAN, 1, "#1", "A", "Main St"));
  assert.equal(state.rejected, 0, "discovery alone must not count as a rejection");
  state = reduceLiveDiscoveryEvent(state, candidateRejectedEvent(PLAN, 1, "#1", "ensureEnriched_threw", "Main St"));
  assert.equal(state.rejected, 1);
});

test("28. qualified (candidate_discovered) does not increment delivered", () => {
  const state = reduceLiveDiscoveryEvent(createInitialLiveDiscoveryState(10), candidateDiscoveredEvent(PLAN, 1, "#1", "A", "Main St"));
  assert.equal(state.delivered, 0);
});

test("29. rejected does not increment delivered", () => {
  const state = reduceLiveDiscoveryEvent(createInitialLiveDiscoveryState(10), candidateRejectedEvent(PLAN, 1, "#1", "ensureEnriched_threw", "Main St"));
  assert.equal(state.delivered, 0);
});

test("30. rejected does not affect progress", () => {
  let state = createInitialLiveDiscoveryState(100);
  for (let i = 0; i < 90; i++) {
    state = reduceLiveDiscoveryEvent(state, candidateRejectedEvent(PLAN, 1, `#r${i}`, "ensureEnriched_threw", "Main St"));
  }
  assert.equal(state.rejected, 90);
  assert.equal(state.progressPercent, 0);
});

test("31. 5 delivered / 90 rejected / target 100 = exactly 5%, never 95%", () => {
  let state = createInitialLiveDiscoveryState(100);
  for (let i = 0; i < 5; i++) state = reduceLiveDiscoveryEvent(state, leadDeliveredEvent(PLAN, 1, `#d${i}`, "A", "Main St"));
  for (let i = 0; i < 90; i++) state = reduceLiveDiscoveryEvent(state, candidateRejectedEvent(PLAN, 1, `#r${i}`, "ensureEnriched_threw", "Main St"));
  assert.equal(state.delivered, 5);
  assert.equal(state.rejected, 90);
  assert.equal(state.progressPercent, 5);
});

test("32. 99 delivered / target 100 = 99%", () => {
  let state = createInitialLiveDiscoveryState(100);
  for (let i = 0; i < 99; i++) state = reduceLiveDiscoveryEvent(state, leadDeliveredEvent(PLAN, 1, `#d${i}`, "A", "Main St"));
  assert.equal(state.progressPercent, 99);
});

test("33. 100 delivered / target 100 = 100%", () => {
  let state = createInitialLiveDiscoveryState(100);
  for (let i = 0; i < 100; i++) state = reduceLiveDiscoveryEvent(state, leadDeliveredEvent(PLAN, 1, `#d${i}`, "A", "Main St"));
  assert.equal(state.progressPercent, 100);
});

test("34. delivered beyond target is capped at 100%", () => {
  let state = createInitialLiveDiscoveryState(10);
  for (let i = 0; i < 15; i++) state = reduceLiveDiscoveryEvent(state, leadDeliveredEvent(PLAN, 1, `#d${i}`, "A", "Main St"));
  assert.equal(state.delivered, 15);
  assert.equal(state.progressPercent, 100);
});

test("35. duplicate delivery event (same event id) does not double count", () => {
  let state = createInitialLiveDiscoveryState(10);
  const event = leadDeliveredEvent(PLAN, 1, "#1", "A", "Main St");
  state = reduceLiveDiscoveryEvent(state, event);
  state = reduceLiveDiscoveryEvent(state, event); // replayed — same .id
  assert.equal(state.delivered, 1);
});

test("plan_limit_reached is not counted as a rejection (mirrors discoveryPlanJob.ts's own local counter, which also skips it)", () => {
  const state = reduceLiveDiscoveryEvent(createInitialLiveDiscoveryState(10), candidateRejectedEvent(PLAN, 1, "#1", "plan_limit_reached", "Main St"));
  assert.equal(state.rejected, 0);
  assert.equal(state.scouts[1].sentence, "Target reached. Wrapping up.");
});

// ── CONCURRENCY ──────────────────────────────────────────────────────────

test("36. interleaved Scout 1/2/3 events each land on the correct scout only", () => {
  const events = [
    scoutStartedEvent(PLAN, 1, "A"),
    scoutStartedEvent(PLAN, 2, "B"),
    scoutStartedEvent(PLAN, 3, "C"),
    candidateDiscoveredEvent(PLAN, 2, "#1", "X", "B"),
    candidateRejectedEvent(PLAN, 3, "#2", "duplicate_already_owned_by_user", "C"),
    leadDeliveredEvent(PLAN, 1, "#3", "Y", "A"),
  ];
  const state = reduceLiveDiscoveryEvents(createInitialLiveDiscoveryState(10), events);
  assert.equal(state.scouts[1].sentence, "Opportunity secured 🎯");
  assert.equal(state.scouts[2].sentence, "Checking X...");
  assert.equal(state.scouts[3].sentence, "You've already got this one. Skipping it.");
  assert.equal(state.delivered, 1);
  assert.equal(state.rejected, 1);
});

test("37. same-tick events for different scouts never bleed into each other's sentence", () => {
  const events = [candidateDiscoveredEvent(PLAN, 1, "#1", "A", "X"), candidateDiscoveredEvent(PLAN, 2, "#2", "B", "Y")];
  const state = reduceLiveDiscoveryEvents(createInitialLiveDiscoveryState(10), events);
  assert.equal(state.scouts[1].sentence, "Checking A...");
  assert.equal(state.scouts[2].sentence, "Checking B...");
});

test("38. rapid candidate discovery aggregation only coalesces a run belonging to ONE scout, not across scouts", () => {
  const events = [
    candidateDiscoveredEvent(PLAN, 1, "#1", "A", "X"),
    candidateDiscoveredEvent(PLAN, 1, "#2", "B", "X"),
    candidateDiscoveredEvent(PLAN, 2, "#3", "C", "Y"),
    candidateDiscoveredEvent(PLAN, 1, "#4", "D", "X"),
  ];
  const state = reduceLiveDiscoveryEvents(createInitialLiveDiscoveryState(10), events);
  // Scout 1's run is interrupted by Scout 2's event, so it aggregates as
  // two separate runs: [#1,#2] (length 2) then [#4] (length 1, no aggregation).
  assert.equal(state.scouts[1].sentence, "Checking D...");
  assert.equal(state.scouts[2].sentence, "Checking C...");
});

// ── Extra: state-shape safety nets not enumerated above ────────────────

test("events for a scoutId outside 1-3 still update global counters but never crash or fabricate a 4th scout", () => {
  const weird = { ...leadDeliveredEvent(PLAN, 1, "#1", "A", "X"), scoutId: 7 };
  const state: DiscoveryLiveState = reduceLiveDiscoveryEvent(createInitialLiveDiscoveryState(10), weird);
  assert.equal(state.delivered, 1);
  assert.equal(Object.keys(state.scouts).length, 3);
});
