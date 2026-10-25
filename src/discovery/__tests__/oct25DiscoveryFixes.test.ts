import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";

process.env.NODE_ENV ??= "test";
process.env.SUPABASE_URL ??= "https://example-project.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "test-service-role-key";
process.env.SUPABASE_JWT_SECRET ??= "test-jwt-secret";
process.env.DATABASE_URL ??= "postgres://user:pass@localhost:5432/testdb";
process.env.ALLOWED_ORIGIN ??= "http://localhost:5173";

const { runAreaWorkerPool } = await import("../googleAreaPool.js");
const { evaluateEarlyChannelPrune } = await import("../earlyPrune.js");
const { channelsSatisfied } = await import("../../lib/channelFilter.js");
const cityScheduling = await import("../cityScheduling.js");
const pythonBridge = await import("../../scraperBridge/pythonBridge.js");
const { createBrowserSlotPool } = await import("../../lib/browserSlotPool.js");

describe("Area 2: Bridge false-progress prevention & watchdog semantics", () => {
  it("classifies only verified discovery progress as genuine inactivity-resetting events", () => {
    const isGenuine = (pythonBridge as any).isGenuineProgressEvent as
      | ((parsed: Record<string, unknown>) => boolean)
      | undefined;
    assert.equal(typeof isGenuine, "function", "isGenuineProgressEvent must be exported from pythonBridge");

    // Stale panel / diagnostic / liveness-only events must NOT reset inactivity watchdog
    assert.equal(
      isGenuine!({ type: "progress", stage: "discovery", event: "stale_panel_mismatch", item_id: "0x1:0x2" }),
      false,
    );
    assert.equal(
      isGenuine!({ type: "progress", stage: "discovery", event: "stale_panel_recovery", item_id: "0x1:0x2" }),
      false,
    );
    assert.equal(
      isGenuine!({ type: "progress", stage: "discovery", event: "stale_panel_search_nav_recovery" }),
      false,
    );
    assert.equal(
      isGenuine!({ type: "progress", stage: "discovery", event: "card_deadline_exceeded" }),
      false,
    );
    assert.equal(
      isGenuine!({ type: "progress", stage: "discovery", event: "return_to_results_failed" }),
      false,
    );
    assert.equal(
      isGenuine!({ type: "progress", stage: "discovery", event: "phone_extraction_diagnostic" }),
      false,
    );
    assert.equal(
      isGenuine!({ type: "progress", stage: "discovery", event: "heartbeat" }),
      false,
    );
    assert.equal(
      isGenuine!({ type: "progress", stage: "discovery", event: "round_scanned", item_id: "12" }),
      false,
    );
    assert.equal(
      isGenuine!({ type: "diagnostic", event: "stale_panel_mismatch" }),
      false,
    );
    assert.equal(
      isGenuine!({ type: "progress", stage: "discovery", event: "candidate_discovered", diagnostic: true }),
      false,
    );

    // Genuine verified candidate & stage progress MUST reset inactivity watchdog
    assert.equal(
      isGenuine!({ type: "progress", stage: "discovery", event: "candidate_discovered", item_id: "0x1:0x2" }),
      true,
    );
    assert.equal(
      isGenuine!({ type: "progress", stage: "discovery", event: "candidate_queued", item_id: "0x1:0x2" }),
      true,
    );
    assert.equal(
      isGenuine!({ type: "progress", stage: "discovery", event: "panel_resolved", item_id: "div[role='feed']" }),
      true,
    );
    assert.equal(
      isGenuine!({ business_name: "Verified Dental", city: "Chicago" }),
      true,
    );
    assert.equal(
      isGenuine!({ __done__: true, count: 1 }),
      true,
    );
  });
});

describe("Area 3: Bounded shutdown ordering and idempotent process cleanup", () => {
  it("gracefulKillProcessTree is idempotent and handles closed stdin/stdout without unhandled errors", async () => {
    const child = spawn(
      process.execPath,
      [
        "-e",
        "process.stdin.on('error', () => {}); setInterval(() => {}, 1000);",
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );

    // Simulate broken/closed stdin pipe before shutdown
    child.stdin?.destroy();

    const p1 = pythonBridge.gracefulKillProcessTree(child, 300, "test_shutdown_1");
    const p2 = pythonBridge.gracefulKillProcessTree(child, 300, "test_shutdown_2");

    assert.equal(
      p1,
      p2,
      "Concurrent gracefulKillProcessTree calls on the same ChildProcess must share one in-flight shutdown promise",
    );

    await Promise.all([p1, p2]);
    assert.notEqual(child.exitCode !== null || child.signalCode !== null || child.killed, false);
  });
});

describe("Area 4: Zero-browser-slot city scheduling & deferral", () => {
  it("distinguishes zero available browser slots from zero curated areas in runAreaWorkerPool", async () => {
    const slotPool = createBrowserSlotPool(1);
    const releaseCityA = slotPool.tryAcquire();
    assert.equal(typeof releaseCityA, "function");
    assert.equal(slotPool.available(), 0);

    // City B has 3 curated areas, but City A holds the only browser slot.
    let claimCalls = 0;
    const cityBZeroSlotResult = await runAreaWorkerPool({
      configuredWorkers: 1,
      safeResourceWorkers: 1,
      totalCuratedAreas: 3,
      availableCapacity: slotPool.available(),
      claimNextArea: async () => {
        claimCalls += 1;
        return "Wicker Park";
      },
      runArea: async () => ({
        discovered: 5,
        accepted: 2,
        rejected: 3,
        duplicates: 0,
        exhausted: true,
        failed: false,
      }),
      tryAcquireSlot: () => slotPool.tryAcquire(),
    });

    assert.equal(claimCalls, 0, "City B must not claim an area while 0 slots are available");
    assert.equal(cityBZeroSlotResult.perArea.length, 0);
    assert.equal(
      (cityBZeroSlotResult as any).deferredNoSlot,
      true,
      "Pool result must mark deferredNoSlot=true when areas exist but capacity is 0",
    );
    assert.equal(
      cityBZeroSlotResult.stoppedReason,
      "no_slot_available" as any,
      "Pool stoppedReason must be 'no_slot_available' when capacity is 0 and totalCuratedAreas > 0",
    );

    // Once City A releases its slot, City B can run and process its areas.
    releaseCityA!();
    assert.equal(slotPool.available(), 1);

    const areas = ["Wicker Park", "Lincoln Park"];
    let idx = 0;
    const cityBRetryResult = await runAreaWorkerPool({
      configuredWorkers: 1,
      safeResourceWorkers: 1,
      totalCuratedAreas: areas.length,
      availableCapacity: slotPool.available(),
      claimNextArea: async () => areas[idx++],
      runArea: async () => ({
        discovered: 4,
        accepted: 2,
        rejected: 2,
        duplicates: 0,
        exhausted: true,
        failed: false,
      }),
      tryAcquireSlot: () => slotPool.tryAcquire(),
    });

    assert.equal((cityBRetryResult as any).deferredNoSlot, false);
    assert.equal(cityBRetryResult.perArea.length, 2);
    assert.equal(cityBRetryResult.totals.accepted, 4);

    // A city with genuinely 0 curated areas must NOT be marked deferredNoSlot.
    const emptyCityResult = await runAreaWorkerPool({
      configuredWorkers: 1,
      safeResourceWorkers: 1,
      totalCuratedAreas: 0,
      availableCapacity: 1,
      claimNextArea: async () => undefined,
      runArea: async () => ({
        discovered: 0,
        accepted: 0,
        rejected: 0,
        duplicates: 0,
        exhausted: true,
        failed: false,
      }),
    });
    assert.equal((emptyCityResult as any).deferredNoSlot, false);
    assert.equal(emptyCityResult.stoppedReason, "pool_size_zero");
  });

  it("bounds repeated zero-slot deferrals and preserves attempt eligibility until capacity is available", () => {
    const resolveDeferral = (cityScheduling as any).resolveZeroSlotCityScheduling as
      | ((input: {
          hasRemainingWork: boolean;
          deferredNoSlot: boolean;
          priorDeferrals: number;
          maxDeferrals?: number;
        }) => {
          action: "defer" | "terminal_no_slot" | "not_deferred";
          reason: string;
          nextDeferrals: number;
          consumeAttempt: boolean;
        })
      | undefined;

    assert.equal(
      typeof resolveDeferral,
      "function",
      "resolveZeroSlotCityScheduling must be exported from cityScheduling",
    );

    // 1st zero-slot encounter: defer without consuming attempt
    const first = resolveDeferral!({
      hasRemainingWork: true,
      deferredNoSlot: true,
      priorDeferrals: 0,
      maxDeferrals: 3,
    });
    assert.equal(first.action, "defer");
    assert.equal(first.reason, "CITY_DEFERRED_NO_SLOT");
    assert.equal(first.consumeAttempt, false);
    assert.equal(first.nextDeferrals, 1);

    // Reaching maxDeferrals: transitions to clear terminal outcome so plan never hangs
    const exhausted = resolveDeferral!({
      hasRemainingWork: true,
      deferredNoSlot: true,
      priorDeferrals: 3,
      maxDeferrals: 3,
    });
    assert.equal(exhausted.action, "terminal_no_slot");
    assert.equal(exhausted.reason, "CITY_NO_SLOT_CAPACITY_EXHAUSTED");
    assert.equal(exhausted.consumeAttempt, true);

    // City with 0 remaining work is not deferred
    const noWork = resolveDeferral!({
      hasRemainingWork: false,
      deferredNoSlot: false,
      priorDeferrals: 0,
      maxDeferrals: 3,
    });
    assert.equal(noWork.action, "not_deferred");
  });
});

describe("Area 5 & 6: Phone filter preservation & candidate/delivery counter reconciliation", () => {
  it("prunes candidates missing required phone and keeps candidates with valid phone while preserving website/email/IG filters", () => {
    const missingPhone = evaluateEarlyChannelPrune(
      { phone: "", website: "https://cafe.example.com" },
      ["phone", "website"],
    );
    assert.equal(missingPhone.prune, true);
    if (missingPhone.prune) {
      assert.deepEqual(missingPhone.missing, ["phone"]);
    }

    const validPhone = evaluateEarlyChannelPrune(
      { phone: "+1 312-555-0199", website: "https://cafe.example.com" },
      ["phone", "website"],
    );
    assert.deepEqual(validPhone, { prune: false });

    const missingWebsite = evaluateEarlyChannelPrune(
      { phone: "+1 312-555-0199", website: "" },
      ["phone", "website"],
    );
    assert.equal(missingWebsite.prune, true);
    if (missingWebsite.prune) {
      assert.deepEqual(missingWebsite.missing, ["website"]);
    }

    // Post-enrichment channel gate still strictly checks email & instagram
    assert.equal(
      channelsSatisfied(
        { phone: "+1 312-555-0199", website: "https://cafe-chicago.com", email: "", instagram: "https://instagram.com/cafechicago" },
        ["phone", "website", "email", "instagram"],
      ),
      false,
    );
    assert.equal(
      channelsSatisfied(
        { phone: "+1 312-555-0199", website: "https://cafe-chicago.com", email: "hi@cafe-chicago.com", instagram: "https://instagram.com/cafechicago" },
        ["phone", "website", "email", "instagram"],
      ),
      true,
    );
  });

  it("reconciles discovery counters across valid leads, duplicates, phone rejections, and stale-panel failures", () => {
    const reconcile = (cityScheduling as any).reconcileDiscoveryCounters as
      | ((input: {
          stalePanelMismatches: number;
          verifiedCandidatesYielded: number;
          accepted: number;
          duplicates: number;
          rejectedByChannelOrQuality: number;
          unexaminedAtEarlyStop?: number;
        }) => {
          valid: boolean;
          discovered: number;
          accounted: number;
          discrepancy: number;
          stalePanelMismatchesExcluded: boolean;
        })
      | undefined;

    assert.equal(
      typeof reconcile,
      "function",
      "reconcileDiscoveryCounters must be exported from cityScheduling",
    );

    const summary = reconcile!({
      stalePanelMismatches: 7,
      verifiedCandidatesYielded: 10,
      accepted: 4,
      duplicates: 2,
      rejectedByChannelOrQuality: 4,
      unexaminedAtEarlyStop: 0,
    });

    assert.equal(summary.valid, true);
    assert.equal(summary.discovered, 10);
    assert.equal(summary.accounted, 10);
    assert.equal(summary.discrepancy, 0);
    assert.equal(summary.stalePanelMismatchesExcluded, true);
  });
});
