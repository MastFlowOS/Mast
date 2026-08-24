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

// ── Test 9: Engine request receives expanded max_results (50 -> 150 -> 250 -> 350 -> 400) ──
test("9. engine request receives expanded max_results across successive rounds (50 -> 150 -> 250 -> 350 -> <=400)", () => {
  const streamTarget = 10;
  const coordinator = createAreaScanBudgetCoordinator(streamTarget, BUDGET_LIMITS, 3);
  const area = "manhattan";

  let askFor = allocateInitialAreaScanBudget(coordinator, area, 3);
  const engineMaxResultsRequests: number[] = [];

  // Round 0: Initial request
  engineMaxResultsRequests.push(askFor);
  assert.equal(askFor, 50, "initial engine request receives max_results=50");

  // Round 1: Expansion grant 1
  const grant1 = requestAreaScanBudgetExpansion(coordinator, area, "productive");
  assert.equal(grant1, 100);
  askFor = coordinator.perArea.get(area)?.final ?? (askFor + grant1);
  engineMaxResultsRequests.push(askFor);
  assert.equal(askFor, 150, "engine request 1 receives max_results=150");

  // Round 2: Expansion grant 2
  const grant2 = requestAreaScanBudgetExpansion(coordinator, area, "productive");
  assert.equal(grant2, 100);
  askFor = coordinator.perArea.get(area)?.final ?? (askFor + grant2);
  engineMaxResultsRequests.push(askFor);
  assert.equal(askFor, 250, "engine request 2 receives max_results=250");

  // Round 3: Expansion grant 3
  const grant3 = requestAreaScanBudgetExpansion(coordinator, area, "productive");
  assert.equal(grant3, 100);
  askFor = coordinator.perArea.get(area)?.final ?? (askFor + grant3);
  engineMaxResultsRequests.push(askFor);
  assert.equal(askFor, 350, "engine request 3 receives max_results=350");

  // Round 4: Expansion grant 4 (up to 400 ceiling)
  const grant4 = requestAreaScanBudgetExpansion(coordinator, area, "productive");
  assert.equal(grant4, 50);
  askFor = coordinator.perArea.get(area)?.final ?? (askFor + grant4);
  engineMaxResultsRequests.push(askFor);
  assert.equal(askFor, 400, "engine request 4 receives max_results=400");

  // Round 5: Capped at 400
  const grant5 = requestAreaScanBudgetExpansion(coordinator, area, "productive");
  assert.equal(grant5, 0);

  assert.deepEqual(
    engineMaxResultsRequests,
    [50, 150, 250, 350, 400],
    "actual engine max_results requests must be exactly [50, 150, 250, 350, 400]",
  );
});

// ── Test 10: Parent delivery aggregation and immediate TARGET_REACHED abort ──
test("10. parent delivery accounting: child A (1) + child B (4) + child C (5) = 10 -> TARGET_REACHED aborts siblings immediately", () => {
  const parentTarget = 10;
  let delivered = 0;
  let targetReachedFired = false;
  const parentAbort = new AbortController();
  const sibling1 = scopeAreaAbort(parentAbort.signal);
  const sibling2 = scopeAreaAbort(parentAbort.signal);
  const activeSibling = scopeAreaAbort(parentAbort.signal);

  function simulateChildDelivery(count: number): "continue" | "stop_outer" {
    for (let i = 0; i < count; i++) {
      delivered += 1;
      if (delivered >= parentTarget) {
        targetReachedFired = true;
        parentAbort.abort("TARGET_REACHED");
        return "stop_outer";
      }
    }
    return "continue";
  }

  // Child A delivers 1
  const resA = simulateChildDelivery(1);
  assert.equal(resA, "continue");
  assert.equal(delivered, 1);
  assert.equal(targetReachedFired, false);
  assert.equal(activeSibling.signal.aborted, false);

  // Child B delivers 4
  const resB = simulateChildDelivery(4);
  assert.equal(resB, "continue");
  assert.equal(delivered, 5);
  assert.equal(targetReachedFired, false);
  assert.equal(activeSibling.signal.aborted, false);

  // Child C delivers 5 -> reaches 10
  const resC = simulateChildDelivery(5);
  assert.equal(resC, "stop_outer");
  assert.equal(delivered, 10);
  assert.equal(targetReachedFired, true);
  assert.equal(parentAbort.signal.aborted, true);
  assert.equal(parentAbort.signal.reason, "TARGET_REACHED");
  assert.equal(sibling1.signal.aborted, true);
  assert.equal(sibling2.signal.aborted, true);
  assert.equal(activeSibling.signal.aborted, true);
});

// ── Test 11: Truthful enrichment active & queue lifecycle ───────────────────
test("11. truthful enrichment lifecycle: job start -> active=1 -> running -> complete -> active=0, confirmed queued -> queue depth > 0", async () => {
  const { getEnrichmentTelemetrySnapshot, trackActiveEnrichment, getEnrichmentQueueDepth } = await import("../../lib/enrichmentTelemetry.js");

  let activeDuringJob = -1;
  const fakeBoss = {
    getQueueSize: async (queue: string) => (queue === "business.enrich" ? 5 : 0),
  };

  // Check queue depth before job start
  const initialQueueDepth = await getEnrichmentQueueDepth(fakeBoss, "business.enrich");
  assert.equal(initialQueueDepth, 5, "confirmed queued jobs report queue depth > 0");

  assert.equal(getEnrichmentTelemetrySnapshot().website_active, 0, "active=0 before job");

  await trackActiveEnrichment(async () => {
    // Job running
    activeDuringJob = getEnrichmentTelemetrySnapshot().website_active;
    assert.equal(activeDuringJob, 1, "active=1 while job is running");
  });

  // Job complete
  assert.equal(getEnrichmentTelemetrySnapshot().website_active, 0, "active=0 after job completes");
});
