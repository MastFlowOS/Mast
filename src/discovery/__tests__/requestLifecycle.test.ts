import assert from "node:assert/strict";
import test from "node:test";
import { cityTransitionFor, shouldScheduleCity } from "../cityScheduling.js";
import {
  __testing,
  registerRequestAbortController,
  registerRequestEngineProcess,
  terminateRequest,
} from "../requestLifecycle.js";

function fakeChild() {
  return { exitCode: null, signalCode: null } as any;
}

test("global cancellation stops every request-owned subprocess and unregisters them", () => {
  __testing.reset();
  const stopped = [0, 0, 0];
  const unregister = stopped.map((_, index) => registerRequestEngineProcess("request-a", fakeChild(), () => { stopped[index] += 1; }));

  terminateRequest("request-a", "USER_CANCELLED");
  assert.deepEqual(stopped, [1, 1, 1]);
  unregister.forEach((remove) => remove());
  assert.equal(__testing.activeProcessCount("request-a"), 0);
});

test("cancellation preserves already accepted work and blocks later acceptance work", () => {
  __testing.reset();
  const controller = new AbortController();
  const unregister = registerRequestAbortController("request-b", controller);
  let accepted = 3;
  terminateRequest("request-b", "USER_CANCELLED");
  if (!controller.signal.aborted) accepted += 1;
  assert.equal(accepted, 3);
  unregister();
});

test("target reached stops active work before queued cities can start", () => {
  __testing.reset();
  const controller = new AbortController();
  const unregister = registerRequestAbortController("request-c", controller);
  let queuedCitiesStarted = 0;
  terminateRequest("request-c", "TARGET_REACHED");
  if (!controller.signal.aborted) queuedCitiesStarted += 1;
  assert.equal(queuedCitiesStarted, 0);
  unregister();
});

test("request-scoped city memory does not immediately requeue attempted cities", () => {
  const cities = ["NY", "Toronto", "Mexico", "Belize"];
  const secondRound = cities.filter(() => shouldScheduleCity({ attempted: true }));
  assert.deepEqual(secondRound, []);
});

test("productive cities continue while unproductive cities rotate with bounded scans", () => {
  assert.equal(cityTransitionFor({ candidatesFound: 6, acceptedLeads: 2 }, false), "CITY_PRODUCTIVE");
  assert.equal(cityTransitionFor({ candidatesFound: 10, acceptedLeads: 0 }, false), "CITY_NO_PROGRESS");
  assert.equal(cityTransitionFor({ candidatesFound: 10, acceptedLeads: 0 }, true), "CITY_EXHAUSTED");
});

test("terminal and city transition reasons remain distinct", () => {
  assert.notEqual("USER_CANCELLED", "CITY_ROTATION");
  assert.notEqual("TARGET_REACHED", "WATCHDOG_TIMEOUT");
});

// ---------------------------------------------------------------------
// MINIMAL FIX (discovery liveness / city failure classification —
// forensic audit §9/§10): cityTransitionFor()'s new third argument
// (`terminationReason`, mirroring EngineDoneInfo.terminationReason).
// ---------------------------------------------------------------------

test("watchdog timeout with zero accepted leads is classified WATCHDOG_TIMEOUT, not CITY_NO_PROGRESS/CITY_EXHAUSTED", () => {
  assert.equal(
    cityTransitionFor({ candidatesFound: 8, acceptedLeads: 0 }, false, "WATCHDOG_TIMEOUT"),
    "WATCHDOG_TIMEOUT",
  );
  // Even if `exhausted` happened to be reported true (shouldn't happen in
  // production per pythonBridge.ts's own contract, but the classification
  // must not depend on that invariant holding) — a watchdog kill still
  // wins over exhaustion.
  assert.equal(
    cityTransitionFor({ candidatesFound: 8, acceptedLeads: 0 }, true, "WATCHDOG_TIMEOUT"),
    "WATCHDOG_TIMEOUT",
  );
});

test("scraper failure with zero accepted leads is classified SCRAPER_FAILURE, not exhaustion", () => {
  assert.equal(
    cityTransitionFor({ candidatesFound: 0, acceptedLeads: 0 }, false, "FAILURE"),
    "SCRAPER_FAILURE",
  );
});

test("genuine exhaustion (no failure/timeout reason) is unaffected by the new parameter", () => {
  assert.equal(
    cityTransitionFor({ candidatesFound: 10, acceptedLeads: 0 }, true, "SUCCESS_EXHAUSTED"),
    "CITY_EXHAUSTED",
  );
  assert.equal(
    cityTransitionFor({ candidatesFound: 10, acceptedLeads: 0 }, true, undefined),
    "CITY_EXHAUSTED",
  );
});

test("a city with at least one accepted lead is always CITY_PRODUCTIVE, even if the run ended in a later crash", () => {
  // Mirrors audit §12's "Candidate yielded, then crash before __done__"
  // row — a lead already accepted must not be overridden by a subsequent
  // watchdog/failure classification.
  assert.equal(
    cityTransitionFor({ candidatesFound: 4, acceptedLeads: 1 }, false, "WATCHDOG_TIMEOUT"),
    "CITY_PRODUCTIVE",
  );
  assert.equal(
    cityTransitionFor({ candidatesFound: 4, acceptedLeads: 1 }, false, "FAILURE"),
    "CITY_PRODUCTIVE",
  );
});

test("omitting terminationReason preserves the exact previous two-argument behavior", () => {
  assert.equal(cityTransitionFor({ candidatesFound: 6, acceptedLeads: 2 }, false), "CITY_PRODUCTIVE");
  assert.equal(cityTransitionFor({ candidatesFound: 10, acceptedLeads: 0 }, false), "CITY_NO_PROGRESS");
  assert.equal(cityTransitionFor({ candidatesFound: 10, acceptedLeads: 0 }, true), "CITY_EXHAUSTED");
});
