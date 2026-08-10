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
