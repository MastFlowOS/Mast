import assert from "node:assert/strict";
import test from "node:test";

import {
  ADMISSION_BLOCKED_TASK_ERROR_PREFIX,
  BUSINESS_TASK_RECOVERY_MIN_AGE_MS,
  isRecoverableAdmissionBlockedTask,
} from "../businessTaskRecovery.js";

const now = Date.parse("2026-10-10T12:00:00.000Z");
const oldCreatedAt = new Date(now - BUSINESS_TASK_RECOVERY_MIN_AGE_MS - 1).toISOString();
const freshCreatedAt = new Date(now - BUSINESS_TASK_RECOVERY_MIN_AGE_MS + 1).toISOString();

test("recovers an old queued enrichment task blocked by transient PID admission", () => {
  assert.equal(isRecoverableAdmissionBlockedTask({
    kind: "enrich",
    status: "queued",
    error: `${ADMISSION_BLOCKED_TASK_ERROR_PREFIX} insufficient live PID headroom`,
    created_at: oldCreatedAt,
  }, now), true);
});

test("recovers an old queued scoring task blocked by transient PID admission", () => {
  assert.equal(isRecoverableAdmissionBlockedTask({
    kind: "score",
    status: "queued",
    error: `${ADMISSION_BLOCKED_TASK_ERROR_PREFIX} headroom=-6`,
    created_at: oldCreatedAt,
  }, now), true);
});

test("does not dispatch a fresh task before the recovery grace period", () => {
  assert.equal(isRecoverableAdmissionBlockedTask({
    kind: "enrich",
    status: "queued",
    error: `${ADMISSION_BLOCKED_TASK_ERROR_PREFIX} headroom=1`,
    created_at: freshCreatedAt,
  }, now), false);
});

test("does not recycle completed, running, unknown-kind, or unrelated failures", () => {
  for (const overrides of [
    { status: "running" },
    { status: "completed" },
    { kind: "discovery" },
    { error: "network timeout" },
    { error: null },
  ]) {
    assert.equal(isRecoverableAdmissionBlockedTask({
      kind: "enrich",
      status: "queued",
      error: `${ADMISSION_BLOCKED_TASK_ERROR_PREFIX} headroom=1`,
      created_at: oldCreatedAt,
      ...overrides,
    } as Parameters<typeof isRecoverableAdmissionBlockedTask>[0], now), false);
  }
});

test("does not redispatch a task already marked as sent to the queue", () => {
  assert.equal(isRecoverableAdmissionBlockedTask({
    kind: "enrich",
    status: "queued",
    error: `recovery-dispatched-at=2026-10-10T11:59:00.000Z; previous-error=${ADMISSION_BLOCKED_TASK_ERROR_PREFIX} headroom=1`,
    created_at: oldCreatedAt,
  }, now), false);
});

test("fails closed when created_at is not a parseable timestamp", () => {
  assert.equal(isRecoverableAdmissionBlockedTask({
    kind: "enrich",
    status: "queued",
    error: `${ADMISSION_BLOCKED_TASK_ERROR_PREFIX} headroom=1`,
    created_at: "not-a-date",
  }, now), false);
});
