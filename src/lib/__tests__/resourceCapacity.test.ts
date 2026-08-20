/**
 * Phase 6 — TASK 3 unit tests for resourceCapacity.ts's pure arithmetic.
 * No fs, no env, no process — fabricated cgroup snapshots only, matching
 * this codebase's existing pure/DB-split test convention (see
 * googleAreaPool.test.ts's own doc comment).
 */
import assert from "node:assert/strict";
import test from "node:test";

import { computeSafePidWorkerCeiling } from "../resourceCapacity.js";

test("computeSafePidWorkerCeiling: derives a ceiling from real pids.max/pids.current", () => {
  // Production-evidence-shaped example: a container with a 4096 pids.max,
  // 300 pids already in use (Node worker + pg-boss + OS baseline), and a
  // measured 220 pids per area worker -> floor((4096-300-300)/220) = 15.
  const { ceiling, basis } = computeSafePidWorkerCeiling(4096, 300, 220, 300, 2);
  assert.equal(basis, "measured");
  assert.equal(ceiling, 15);
});

test("computeSafePidWorkerCeiling: a small pids.max produces a small ceiling even with huge free memory", () => {
  // This is the exact shape of bug the phase prompt describes: memory
  // looks enormous (93 GB / ~266 browserSlots) but a tight container PID
  // limit (e.g. Railway's default) still caps real concurrency hard.
  const { ceiling, basis } = computeSafePidWorkerCeiling(512, 100, 220, 100, 2);
  assert.equal(basis, "measured");
  // floor((512-100-100)/220) = 1
  assert.equal(ceiling, 1);
});

test("computeSafePidWorkerCeiling: never goes negative when current usage already exceeds the budget", () => {
  const { ceiling } = computeSafePidWorkerCeiling(500, 480, 220, 100, 2);
  assert.equal(ceiling, 0);
});

test("computeSafePidWorkerCeiling: pidsMax === null (unreadable/unavailable) falls back, never unbounded", () => {
  const { ceiling, basis } = computeSafePidWorkerCeiling(null, null, 220, 300, 2);
  assert.equal(basis, "fallback_unavailable");
  assert.equal(ceiling, 2);
});

test("computeSafePidWorkerCeiling: pidsCurrent unreadable treats current usage as 0 (still measured, not a fallback)", () => {
  const { ceiling, basis } = computeSafePidWorkerCeiling(4096, null, 220, 300, 2);
  assert.equal(basis, "measured");
  assert.equal(ceiling, Math.floor((4096 - 300) / 220));
});

test("computeSafePidWorkerCeiling: scales down as pidsPerAreaWorker (the real measured footprint) grows", () => {
  const cheap = computeSafePidWorkerCeiling(4096, 300, 100, 300, 2);
  const expensive = computeSafePidWorkerCeiling(4096, 300, 400, 300, 2);
  assert.ok(cheap.ceiling > expensive.ceiling);
});
