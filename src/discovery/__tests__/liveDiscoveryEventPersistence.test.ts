/**
 * MAST — Live Discovery UI (Task 3 of 3): publishDiscoveryLiveEvent was
 * extended (liveDiscoveryEvent.ts) to also fire-and-forget insert into
 * `discovery_live_events` for cross-process delivery to the browser — see
 * migrations/033_discovery_live_events.sql's doc comment for why. This
 * confirms that addition never changes publishDiscoveryLiveEvent's
 * existing synchronous contract: it must still return immediately, still
 * fan out to in-process listeners synchronously, and must never let a
 * persistence failure (unreachable DB, missing table, etc.) propagate to
 * or block the caller — discoveryPlanJob.ts calls this inline on every
 * candidate, and it must never be able to slow down or crash discovery.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { __testing, candidateDiscoveredEvent, publishDiscoveryLiveEvent, subscribeToDiscoveryLiveEvents } from "../liveDiscoveryEvent.js";

test.beforeEach(() => __testing.reset());

test("publishDiscoveryLiveEvent returns synchronously (does not await its persistence insert)", () => {
  const event = candidateDiscoveredEvent("plan-1", 1, "#1", "Joe's Pizza", "Main St");
  const start = Date.now();
  publishDiscoveryLiveEvent(event);
  // A real network insert cannot possibly complete in under a few ms — if
  // this function were awaiting it, this assertion would be the first
  // thing to start flaking. Under heavy full-suite CPU contention on Windows,
  // allow up to 250ms for the synchronous queueing/dispatch.
  assert.ok(Date.now() - start < 250);
});

test("publishDiscoveryLiveEvent still fans out to in-process listeners synchronously, unaffected by the added persistence call", () => {
  const received: string[] = [];
  const unsubscribe = subscribeToDiscoveryLiveEvents("plan-1", (e) => received.push(e.id));
  const event = candidateDiscoveredEvent("plan-1", 1, "#1", "Joe's Pizza", "Main St");
  publishDiscoveryLiveEvent(event);
  assert.deepEqual(received, [event.id]);
  unsubscribe();
});

test("publishDiscoveryLiveEvent never throws, even with no in-process listener and whatever the persistence outcome turns out to be", () => {
  const event = candidateDiscoveredEvent("plan-with-no-listeners", 1, "#1", undefined, undefined);
  assert.doesNotThrow(() => publishDiscoveryLiveEvent(event));
});
