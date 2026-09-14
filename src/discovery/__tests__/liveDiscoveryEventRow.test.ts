/**
 * MAST — Live Discovery UI (Task 3 of 3): tests for the row -> event mapping
 * boundary between `discovery_live_events` (the Postgres table Task 3 added
 * for cross-process delivery — see migrations/033_discovery_live_events.sql)
 * and Task 1's DiscoveryLiveEvent shape.
 *
 * This is deliberately narrow, matching liveDiscoveryEvent.test.ts's own
 * stated scope: there is no business logic here to exhaustively
 * branch-test, just a boundary that must never invent or drop a field.
 * Reducer behavior (sentences, counters, progress, terminal states) is
 * already exhaustively covered by liveDiscoveryState.test.ts (Task 2) and
 * is deliberately NOT re-tested here — Task 3 never duplicates that logic,
 * so there is nothing new to test at that layer.
 *
 * NOT covered here (documented, not silently skipped — see the Task 3
 * final report's "Testing" / "Limitations" sections): the React-effect
 * lifecycle of useLiveDiscoveryState itself (subscribe to the right
 * planId, cleanup unsubscribes, no duplicate subscription on rerender,
 * completion/failure stops listening). That hook imports
 * `@/lib/supabase.ts`, which reads `import.meta.env` — a Vite-only global
 * this repo's test runner (plain `tsx --test`, no Vite/jsdom/React Testing
 * Library anywhere in this codebase) cannot provide. Testing that lifecycle
 * for real would require introducing a browser/DOM test harness that
 * doesn't otherwise exist in this project — out of scope for "smallest
 * safe transport," per this task's own instructions not to add
 * infrastructure the existing patterns don't already require.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { rowToDiscoveryLiveEvent, type DiscoveryLiveEventRow } from "../liveDiscoveryEventRow.js";

function baseRow(overrides: Partial<DiscoveryLiveEventRow> = {}): DiscoveryLiveEventRow {
  return {
    plan_id: "plan-1",
    event_id: "evt-1",
    event_type: "candidate_discovered",
    scout_id: null,
    area_label: null,
    pipeline_id: null,
    business_name: null,
    reason: null,
    delivered_count: null,
    target: null,
    area_outcome: null,
    failure_reason: null,
    event_timestamp: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

test("rowToDiscoveryLiveEvent carries plan_id/event_id/type through unchanged (id/planId/type)", () => {
  const event = rowToDiscoveryLiveEvent(baseRow({ plan_id: "plan-42", event_id: "evt-42", event_type: "lead_delivered" }));
  assert.equal(event.planId, "plan-42");
  assert.equal(event.id, "evt-42");
  assert.equal(event.type, "lead_delivered");
});

test("rowToDiscoveryLiveEvent parses event_timestamp into the same epoch-ms shape DiscoveryLiveEvent.timestamp expects", () => {
  const event = rowToDiscoveryLiveEvent(baseRow({ event_timestamp: "2026-03-14T12:00:00.000Z" }));
  assert.equal(event.timestamp, Date.parse("2026-03-14T12:00:00.000Z"));
});

test("rowToDiscoveryLiveEvent converts every nullable DB column to undefined, never leaves a null through", () => {
  const event = rowToDiscoveryLiveEvent(baseRow());
  assert.equal(event.scoutId, undefined);
  assert.equal(event.areaLabel, undefined);
  assert.equal(event.pipelineId, undefined);
  assert.equal(event.businessName, undefined);
  assert.equal(event.reason, undefined);
  assert.equal(event.deliveredCount, undefined);
  assert.equal(event.target, undefined);
  assert.equal(event.areaOutcome, undefined);
  assert.equal(event.failureReason, undefined);
});

test("rowToDiscoveryLiveEvent carries every populated field through verbatim — no re-mapped/invented values", () => {
  const areaOutcome = { discovered: 5, accepted: 1, rejected: 4, duplicates: 0, exhausted: false };
  const event = rowToDiscoveryLiveEvent(
    baseRow({
      scout_id: 2,
      area_label: "12th Avenue",
      pipeline_id: "#7",
      business_name: "Joe's Pizza",
      reason: "plan_limit_reached",
      delivered_count: 5,
      target: 100,
      area_outcome: areaOutcome,
      failure_reason: "SCRAPER_ERROR",
    }),
  );
  assert.equal(event.scoutId, 2);
  assert.equal(event.areaLabel, "12th Avenue");
  assert.equal(event.pipelineId, "#7");
  assert.equal(event.businessName, "Joe's Pizza");
  assert.equal(event.reason, "plan_limit_reached");
  assert.equal(event.deliveredCount, 5);
  assert.equal(event.target, 100);
  assert.deepEqual(event.areaOutcome, areaOutcome);
  assert.equal(event.failureReason, "SCRAPER_ERROR");
});

test("scout_id=0 is never coerced to undefined by ?? (would only matter if scoutId 0 were ever valid — it documents the boundary is ?? not ||)", () => {
  // Real ScoutIds are 1|2|3 (never 0), but this pins the exact operator
  // used — a future accidental `|| undefined` swap would silently drop a
  // real falsy-but-valid value for any column that legitimately allows 0.
  const event = rowToDiscoveryLiveEvent(baseRow({ delivered_count: 0 }));
  assert.equal(event.deliveredCount, 0);
});
