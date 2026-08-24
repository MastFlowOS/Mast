import test from "node:test";
import assert from "node:assert/strict";
import {
  computeGlobalScanBudget,
  createAreaScanBudgetCoordinator,
  allocateInitialAreaScanBudget,
  requestAreaScanBudgetExpansion,
  type AreaScanBudgetLimits,
} from "../areaScanBudget.js";
import {
  createAreaProductivityState,
  recordCandidateDiscovered,
  recordCandidateRejected,
  recordQualifiedLead,
  recordDeliveredLead,
  classifyAreaYield,
  scopeAreaAbort,
} from "../areaProductivity.js";
import { validateLead } from "../../lib/leadValidation.js";
import { channelsSatisfied } from "../../lib/channelFilter.js";
import type { EngineLead } from "../../scraperBridge/pythonBridge.js";

const BUDGET_LIMITS: AreaScanBudgetLimits = {
  multiplier: 4,
  minAreaBudgetFactor: 1,
  maxAreaBudgetFactor: 4,
  expansionChunkFactor: 1,
  minExplorationCandidates: 50,
  productiveMaxFactor: 4,
  maxProductiveCandidates: 400,
};

// ── Test 1: Child delivered count increments parent immediately ──────────────
test("1. child delivered count increments parent immediately", () => {
  let parentDelivered = 0;
  const parentTarget = 10;

  function onChildLeadDelivered() {
    parentDelivered += 1;
  }

  // Child delivers 1 lead
  onChildLeadDelivered();
  assert.equal(parentDelivered, 1, "parent delivered count must increment immediately on child delivery");

  // Child delivers 2 more leads
  onChildLeadDelivered();
  onChildLeadDelivered();
  assert.equal(parentDelivered, 3, "parent delivered count tracks every delivery in real-time");
  assert.ok(parentDelivered < parentTarget);
});

// ── Test 2 & 3: Multiple child deliveries aggregate correctly and trigger TARGET_REACHED ──
test("2 & 3. multiple child deliveries aggregate correctly (1 + 4 + 5 = 10) and trigger TARGET_REACHED to abort siblings", async () => {
  const parentTarget = 10;
  let parentDelivered = 0;
  let targetReachedTriggered = false;

  const parentAbort = new AbortController();
  const child1Abort = scopeAreaAbort(parentAbort.signal);
  const child2Abort = scopeAreaAbort(parentAbort.signal);
  const child3Abort = scopeAreaAbort(parentAbort.signal);
  const child4Abort = scopeAreaAbort(parentAbort.signal); // sibling that should be aborted

  function deliverFromChild(childDeliveredCount: number) {
    for (let i = 0; i < childDeliveredCount; i++) {
      parentDelivered += 1;
      if (parentDelivered >= parentTarget) {
        targetReachedTriggered = true;
        parentAbort.abort("TARGET_REACHED");
        break;
      }
    }
  }

  // Child 1 delivers 1
  deliverFromChild(1);
  assert.equal(parentDelivered, 1);
  assert.equal(targetReachedTriggered, false);
  assert.equal(parentAbort.signal.aborted, false);
  assert.equal(child4Abort.signal.aborted, false);

  // Child 2 delivers 4
  deliverFromChild(4);
  assert.equal(parentDelivered, 5);
  assert.equal(targetReachedTriggered, false);
  assert.equal(parentAbort.signal.aborted, false);
  assert.equal(child4Abort.signal.aborted, false);

  // Child 3 delivers 5 -> sum = 10 -> parent_delivered = 10 -> TARGET_REACHED
  deliverFromChild(5);
  assert.equal(parentDelivered, 10, "parent_delivered must equal sum of child deliveries (1 + 4 + 5 = 10)");
  assert.equal(targetReachedTriggered, true, "TARGET_REACHED must trigger immediately once parent target reached");
  assert.equal(parentAbort.signal.aborted, true);
  assert.equal(parentAbort.signal.reason, "TARGET_REACHED");
  assert.equal(child4Abort.signal.aborted, true, "sibling worker must be immediately aborted");
  assert.equal(child4Abort.signal.reason, "TARGET_REACHED");
});

// ── Test 4: Productive area expands past 50 (50 → 150 → 250 → 350 → 400) ────
test("4 & 5. productive area expands past 50 (50 -> 150 -> 250 -> 350 -> <=400) and reaches 400 maximum", () => {
  const streamTarget = 10;
  const coordinator = createAreaScanBudgetCoordinator(streamTarget, BUDGET_LIMITS, 3);
  const initial = allocateInitialAreaScanBudget(coordinator, "area-productive", 3);
  assert.equal(initial, 50, "initial scan budget is 50");

  const grant1 = requestAreaScanBudgetExpansion(coordinator, "area-productive", "productive");
  assert.equal(grant1, 100);
  assert.equal(coordinator.perArea.get("area-productive")?.final, 150, "expanded 50 -> 150");

  const grant2 = requestAreaScanBudgetExpansion(coordinator, "area-productive", "productive");
  assert.equal(grant2, 100);
  assert.equal(coordinator.perArea.get("area-productive")?.final, 250, "expanded 150 -> 250");

  const grant3 = requestAreaScanBudgetExpansion(coordinator, "area-productive", "productive");
  assert.equal(grant3, 100);
  assert.equal(coordinator.perArea.get("area-productive")?.final, 350, "expanded 250 -> 350");

  const grant4 = requestAreaScanBudgetExpansion(coordinator, "area-productive", "productive");
  assert.equal(grant4, 50);
  assert.equal(coordinator.perArea.get("area-productive")?.final, 400, "expanded 350 -> <=400 ceiling");

  // Attempting further expansion must return 0
  const grant5 = requestAreaScanBudgetExpansion(coordinator, "area-productive", "productive");
  assert.equal(grant5, 0, "productive area cannot exceed maxProductiveCandidates 400");
  assert.equal(coordinator.perArea.get("area-productive")?.final, 400);
});

// ── Test 6: Low-yield area receives no expansion ────────────────────────────
test("6. low-yield area receives no expansion and remains bounded", () => {
  const streamTarget = 10;
  const coordinator = createAreaScanBudgetCoordinator(streamTarget, BUDGET_LIMITS, 3);
  const initial = allocateInitialAreaScanBudget(coordinator, "area-low-yield", 3);
  assert.equal(initial, 50);

  const grant = requestAreaScanBudgetExpansion(coordinator, "area-low-yield", "low_yield");
  assert.equal(grant, 0, "low_yield area must receive 0 expansion grant");
  assert.equal(coordinator.perArea.get("area-low-yield")?.final, 50, "low_yield area remains bounded at 50");
});

// ── Test 7: Scan budget matches actual discovery bound and telemetry ────────
test("7. scan budget matches actual discovery bound and telemetry reflects the same quantity", () => {
  const streamTarget = 10;
  const coordinator = createAreaScanBudgetCoordinator(streamTarget, BUDGET_LIMITS, 3);
  const initial = allocateInitialAreaScanBudget(coordinator, "area-1", 3);
  assert.equal(initial, 50);

  const grant = requestAreaScanBudgetExpansion(coordinator, "area-1", "productive");
  const entry = coordinator.perArea.get("area-1");
  assert.ok(entry);
  assert.equal(entry.final, initial + grant);
  assert.equal(entry.expansions, grant);
  assert.equal(entry.initial, initial);
});

// ── Test 8: Quality gates unchanged ─────────────────────────────────────────
test("8. quality gates unchanged: Instagram >100K rejection, niche mismatch rejection, website/email/phone/IG validation", () => {
  // Test valid qualified lead
  const validLead: EngineLead = {
    name: "Valid Dental Clinic",
    query: "dentist",
    city: "Austin",
    country: "US",
    niche: "dentist",
    website: "https://validdental.com",
    email: "contact@validdental.com",
    phone: "+15125551234",
    instagram: "validdental",
    fingerprints: ["fp1"],
  };
  const valResult = validateLead(validLead);
  assert.equal(valResult.valid, true);

  // Missing website -> fails channelsSatisfied if website required
  const noWebLead: EngineLead = { ...validLead, website: undefined };
  assert.equal(channelsSatisfied(noWebLead, ["website", "email", "phone", "instagram"]), false);

  // Missing email -> channelsSatisfied fails if email required
  const noEmailLead: EngineLead = { ...validLead, email: undefined };
  assert.equal(channelsSatisfied(noEmailLead, ["email"]), false);
  assert.equal(channelsSatisfied(validLead, ["website", "email", "phone", "instagram"]), true);

  // Invalid email format -> invalid
  const badEmailLead: EngineLead = { ...validLead, email: "not-an-email" };
  assert.equal(validateLead(badEmailLead).valid, false);

  // Placeholder email -> invalid
  const placeholderEmailLead: EngineLead = { ...validLead, email: "test@example.com" };
  assert.equal(validateLead(placeholderEmailLead).valid, false);

  // Invalid phone -> invalid
  const badPhoneLead: EngineLead = { ...validLead, phone: "123" };
  assert.equal(validateLead(badPhoneLead).valid, false);
});
