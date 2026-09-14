/**
 * MAST — Task 1 (live discovery event infrastructure): focused tests for
 * liveDiscoveryEvent.ts's pure builders and process-local pub/sub.
 *
 * These are deliberately narrow — the builders take already-computed data
 * and stamp it onto a typed shape; there is no business logic to
 * exhaustively branch-test. What matters (and what these tests check) is:
 *   - every event carries the real data passed in, unmodified/uninvented
 *   - candidate_qualified-equivalent (lead_delivered) is distinguishable
 *     from candidate_discovered
 *   - rejection reasons pass through verbatim (no re-mapped taxonomy)
 *   - target is never touched/derived by this module (discoveryCompletedEvent
 *     just carries through the two numbers it's given)
 *   - the pub/sub never crosses plans and never drops a listener's own
 *     throw onto the publisher
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  __testing,
  areaCompletedEvent,
  candidateDiscoveredEvent,
  candidateRejectedEvent,
  discoveryCompletedEvent,
  discoveryFailedEvent,
  leadDeliveredEvent,
  publishDiscoveryLiveEvent,
  scoutStartedEvent,
  areaStartedEvent,
  subscribeToDiscoveryLiveEvents,
  type DiscoveryLiveEvent,
} from "../liveDiscoveryEvent.js";

test.beforeEach(() => __testing.reset());

test("candidate_discovered carries the real pipelineId/businessName/scoutId/areaLabel through unchanged", () => {
  const event = candidateDiscoveredEvent("plan-1", 2, "#7", "Joe's Pizza", "12th Avenue");
  assert.equal(event.type, "candidate_discovered");
  assert.equal(event.planId, "plan-1");
  assert.equal(event.scoutId, 2);
  assert.equal(event.pipelineId, "#7");
  assert.equal(event.businessName, "Joe's Pizza");
  assert.equal(event.areaLabel, "12th Avenue");
  assert.ok(event.id);
  assert.ok(event.timestamp > 0);
});

test("candidate_discovered never invents a businessName when none is known", () => {
  const event = candidateDiscoveredEvent("plan-1", 1, "#3", undefined, undefined);
  assert.equal(event.businessName, undefined);
  assert.equal(event.areaLabel, undefined);
});

test("candidate_rejected carries the EXACT reason string given — no re-mapped taxonomy", () => {
  const reasons = [
    "validateDiscoveryCandidate:is_disqualified",
    "maps_channel_gate:requested=[\"website\"]",
    "post_enrichment_channel_gate:requested=[\"email\",\"instagram\"]",
    "plan_limit_reached",
    "duplicate_already_owned_by_user",
    "ensureEnriched_threw",
  ];
  for (const reason of reasons) {
    const event = candidateRejectedEvent("plan-1", 1, "#1", reason, "Main Street");
    assert.equal(event.type, "candidate_rejected");
    assert.equal(event.reason, reason, `expected the exact reason string "${reason}" to pass through unchanged`);
  }
});

test("lead_delivered is distinguishable from candidate_discovered even for the same candidate", () => {
  const discovered = candidateDiscoveredEvent("plan-1", 1, "#5", "Acme Bakery", "Elm Street");
  const delivered = leadDeliveredEvent("plan-1", 1, "#5", "Acme Bakery", "Elm Street");
  assert.notEqual(discovered.type, delivered.type);
  assert.equal(discovered.pipelineId, delivered.pipelineId, "same candidate — same pipelineId across its lifecycle");
});

test("target/delivered accounting is never derived here — discoveryCompletedEvent just carries the two numbers it's given", () => {
  const event = discoveryCompletedEvent("plan-1", 42, 100);
  assert.equal(event.deliveredCount, 42);
  assert.equal(event.target, 100);
  // Passing already-inconsistent numbers through unchanged proves this
  // module performs no clamping/derivation of its own — the caller (which
  // reads discovery_plans.delivered_count/requested_count) is the sole
  // source of truth, matching the task's "no second competing counter"
  // requirement.
  const inconsistent = discoveryCompletedEvent("plan-1", 999, 10);
  assert.equal(inconsistent.deliveredCount, 999);
  assert.equal(inconsistent.target, 10);
});

test("area_completed carries the real per-area outcome object through unchanged, never re-derived", () => {
  const outcome = { discovered: 9, accepted: 3, rejected: 6, duplicates: 0, exhausted: true };
  const event = areaCompletedEvent("plan-1", 2, "Brooklyn", outcome);
  assert.deepEqual(event.areaOutcome, outcome);
});

test("discovery_failed carries the real failure reason and is plan-scoped, not scout-scoped", () => {
  const event = discoveryFailedEvent("plan-1", "cancelled");
  assert.equal(event.failureReason, "cancelled");
  assert.equal(event.scoutId, undefined);
});

test("scout_started / area_started carry the real scoutId and areaLabel, never fabricate one", () => {
  const started = scoutStartedEvent("plan-1", 3, "Queens");
  assert.equal(started.scoutId, 3);
  assert.equal(started.areaLabel, "Queens");
  const areaStarted = areaStartedEvent("plan-1", 3, undefined);
  assert.equal(areaStarted.areaLabel, undefined, "no area label available (non-curated city) must stay absent, not invented");
});

test("no fake/dummy events: every builder requires real caller-supplied identity data, not a UI-only placeholder", () => {
  // Every builder that identifies a candidate takes both a pipelineId and
  // scoutId explicitly — there is no zero-arg "make something up" builder
  // in this module a caller could reach for as a shortcut.
  const event = candidateDiscoveredEvent("plan-1", 1, "#1", undefined, undefined);
  assert.equal(typeof event.pipelineId, "string");
  assert.equal(typeof event.scoutId, "number");
});

test("pub/sub: a listener only receives events published for ITS plan, never a sibling plan's", () => {
  const receivedA: DiscoveryLiveEvent[] = [];
  const receivedB: DiscoveryLiveEvent[] = [];
  const unsubA = subscribeToDiscoveryLiveEvents("plan-A", (e) => receivedA.push(e));
  const unsubB = subscribeToDiscoveryLiveEvents("plan-B", (e) => receivedB.push(e));

  publishDiscoveryLiveEvent(candidateDiscoveredEvent("plan-A", 1, "#1", "A", undefined));
  publishDiscoveryLiveEvent(candidateDiscoveredEvent("plan-B", 1, "#1", "B", undefined));

  assert.equal(receivedA.length, 1);
  assert.equal(receivedA[0].businessName, "A");
  assert.equal(receivedB.length, 1);
  assert.equal(receivedB[0].businessName, "B");

  unsubA();
  unsubB();
});

test("pub/sub: publishing with no subscribers is a safe no-op", () => {
  assert.doesNotThrow(() => publishDiscoveryLiveEvent(discoveryCompletedEvent("plan-nobody-listening", 0, 5)));
});

test("pub/sub: unsubscribing stops further delivery and reclaims the listener set", () => {
  const received: DiscoveryLiveEvent[] = [];
  const unsub = subscribeToDiscoveryLiveEvents("plan-1", (e) => received.push(e));
  assert.equal(__testing.listenerCount("plan-1"), 1);
  publishDiscoveryLiveEvent(discoveryCompletedEvent("plan-1", 1, 1));
  unsub();
  assert.equal(__testing.listenerCount("plan-1"), 0);
  publishDiscoveryLiveEvent(discoveryCompletedEvent("plan-1", 2, 2));
  assert.equal(received.length, 1, "no event should be delivered after unsubscribe");
});

test("pub/sub: a throwing listener never breaks delivery to sibling listeners of the same plan", () => {
  const received: DiscoveryLiveEvent[] = [];
  subscribeToDiscoveryLiveEvents("plan-1", () => {
    throw new Error("simulated listener bug");
  });
  subscribeToDiscoveryLiveEvents("plan-1", (e) => received.push(e));

  assert.doesNotThrow(() => publishDiscoveryLiveEvent(discoveryCompletedEvent("plan-1", 1, 1)));
  assert.equal(received.length, 1);
});
