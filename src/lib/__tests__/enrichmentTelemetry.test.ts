/**
 * Phase 29 — Unit tests for Truthful Enrichment Telemetry Correctness.
 *
 * Covers:
 *  1. enrichment job increments active count (website_active and contact_active).
 *  2. enrichment completion decrements count.
 *  3. enrichment failure decrements count.
 *  4. enrichment cancellation decrements count.
 *  5. multiple enrichment jobs count correctly (1 -> 4 -> 3 -> 0).
 *  6. Instagram job increments instagram_active.
 *  7. Instagram failure decrements instagram_active.
 *  8. queue depth reports actual pg-boss depth.
 *  9. confirmed empty queue reports 0.
 * 10. measurement failure reports unavailable/null, NOT false 0.
 * 11. no negative counters (underflow protection).
 * 12. 30-second heartbeat log formatter uses these real values.
 * 13. existing worker behavior unchanged (enrichment capacity calculation unaffected).
 */
import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";

import {
  incrementActiveEnrichment,
  decrementActiveEnrichment,
  incrementActiveIntelligence,
  decrementActiveIntelligence,
  trackActiveEnrichment,
  trackActiveIntelligence,
  getEnrichmentTelemetrySnapshot,
  getEnrichmentQueueDepth,
  formatEnrichmentTelemetryLog,
  resetEnrichmentTelemetry,
} from "../enrichmentTelemetry.js";

import {
  computeSafeResourceCapacity,
  splitEnrichmentCapacity,
} from "../resourceCapacity.js";

beforeEach(() => {
  resetEnrichmentTelemetry();
});

// ── 1. enrichment job increments active count ──────────────────────────────
test("1. enrichment job increments website_active and contact_active on start", async () => {
  let observedWebsiteActive = -1;
  let observedContactActive = -1;

  await trackActiveEnrichment(async () => {
    const snapshot = getEnrichmentTelemetrySnapshot();
    observedWebsiteActive = snapshot.website_active;
    observedContactActive = snapshot.contact_active;
  });

  assert.equal(observedWebsiteActive, 1);
  assert.equal(observedContactActive, 1);
});

// ── 2. enrichment completion decrements count ──────────────────────────────
test("2. enrichment completion decrements active count back to 0", async () => {
  assert.equal(getEnrichmentTelemetrySnapshot().website_active, 0);

  await trackActiveEnrichment(async () => {
    assert.equal(getEnrichmentTelemetrySnapshot().website_active, 1);
  });

  assert.equal(getEnrichmentTelemetrySnapshot().website_active, 0);
  assert.equal(getEnrichmentTelemetrySnapshot().contact_active, 0);
});

// ── 3. enrichment failure decrements count ─────────────────────────────────
test("3. enrichment failure/thrown exception decrements active count in finally", async () => {
  assert.equal(getEnrichmentTelemetrySnapshot().website_active, 0);

  await assert.rejects(
    async () => {
      await trackActiveEnrichment(async () => {
        assert.equal(getEnrichmentTelemetrySnapshot().website_active, 1);
        throw new Error("Simulated enrichment subprocess failure");
      });
    },
    { message: "Simulated enrichment subprocess failure" },
  );

  assert.equal(getEnrichmentTelemetrySnapshot().website_active, 0);
  assert.equal(getEnrichmentTelemetrySnapshot().contact_active, 0);
});

// ── 4. enrichment cancellation decrements count ───────────────────────────
test("4. enrichment cancellation/abort decrements active count", async () => {
  const controller = new AbortController();

  await assert.rejects(
    async () => {
      await trackActiveEnrichment(async () => {
        controller.abort();
        const err = new Error("AbortError: Operation cancelled");
        err.name = "AbortError";
        throw err;
      });
    },
    { name: "AbortError" },
  );

  assert.equal(getEnrichmentTelemetrySnapshot().website_active, 0);
  assert.equal(getEnrichmentTelemetrySnapshot().contact_active, 0);
});

// ── 5. multiple concurrent enrichment jobs count correctly ────────────────
test("5. multiple enrichment jobs track concurrent execution correctly (1 -> 4 -> 3 -> 0)", async () => {
  type Resolver = () => void;
  const gate1: { promise: Promise<void>; resolve: Resolver } = {} as any;
  gate1.promise = new Promise<void>((res) => { gate1.resolve = res; });
  const gate2: { promise: Promise<void>; resolve: Resolver } = {} as any;
  gate2.promise = new Promise<void>((res) => { gate2.resolve = res; });
  const gate3: { promise: Promise<void>; resolve: Resolver } = {} as any;
  gate3.promise = new Promise<void>((res) => { gate3.resolve = res; });
  const gate4: { promise: Promise<void>; resolve: Resolver } = {} as any;
  gate4.promise = new Promise<void>((res) => { gate4.resolve = res; });

  const p1 = trackActiveEnrichment(() => gate1.promise);
  assert.equal(getEnrichmentTelemetrySnapshot().website_active, 1);

  const p2 = trackActiveEnrichment(() => gate2.promise);
  const p3 = trackActiveEnrichment(() => gate3.promise);
  const p4 = trackActiveEnrichment(() => gate4.promise);

  // 4 concurrent jobs active
  assert.equal(getEnrichmentTelemetrySnapshot().website_active, 4);
  assert.equal(getEnrichmentTelemetrySnapshot().contact_active, 4);

  // One job finishes -> 3 active
  gate1.resolve();
  await p1;
  assert.equal(getEnrichmentTelemetrySnapshot().website_active, 3);
  assert.equal(getEnrichmentTelemetrySnapshot().contact_active, 3);

  // Remaining jobs finish -> 0 active
  gate2.resolve();
  gate3.resolve();
  gate4.resolve();
  await Promise.all([p2, p3, p4]);

  assert.equal(getEnrichmentTelemetrySnapshot().website_active, 0);
  assert.equal(getEnrichmentTelemetrySnapshot().contact_active, 0);
});

// ── 6. Instagram job increments instagram_active ──────────────────────────
test("6. Instagram job increments instagram_active independently from website_active", async () => {
  let observedInstagramActive = -1;
  let observedWebsiteActive = -1;

  await trackActiveIntelligence(async () => {
    const snapshot = getEnrichmentTelemetrySnapshot();
    observedInstagramActive = snapshot.instagram_active;
    observedWebsiteActive = snapshot.website_active;
  });

  assert.equal(observedInstagramActive, 1);
  assert.equal(observedWebsiteActive, 0); // Website/contact unaffected
  assert.equal(getEnrichmentTelemetrySnapshot().instagram_active, 0);
});

// ── 7. Instagram failure decrements instagram_active ──────────────────────
test("7. Instagram failure decrements instagram_active in finally", async () => {
  assert.equal(getEnrichmentTelemetrySnapshot().instagram_active, 0);

  await assert.rejects(
    async () => {
      await trackActiveIntelligence(async () => {
        assert.equal(getEnrichmentTelemetrySnapshot().instagram_active, 1);
        throw new Error("Instagram rate limit or timeout");
      });
    },
    { message: "Instagram rate limit or timeout" },
  );

  assert.equal(getEnrichmentTelemetrySnapshot().instagram_active, 0);
});

// ── 8. queue depth reports actual pg-boss depth ───────────────────────────
test("8. queue depth reports actual pg-boss depth", async () => {
  const fakeBoss = {
    getQueueSize: async (name: string) => {
      if (name === "business-enrich") return 12;
      if (name === "business-score") return 7;
      return 0;
    },
  };

  const enrichDepth = await getEnrichmentQueueDepth(fakeBoss, "business-enrich");
  const scoreDepth = await getEnrichmentQueueDepth(fakeBoss, "business-score");

  assert.equal(enrichDepth, 12);
  assert.equal(scoreDepth, 7);
});

// ── 9. confirmed empty queue reports 0 ────────────────────────────────────
test("9. confirmed empty queue reports 0 (not null or undefined)", async () => {
  const fakeBoss = {
    getQueueSize: async () => 0,
  };

  const enrichDepth = await getEnrichmentQueueDepth(fakeBoss, "business-enrich");
  assert.equal(enrichDepth, 0);
});

// ── 10. measurement failure reports unavailable, NOT false 0 ──────────────
test("10. measurement failure reports unavailable, NOT false 0", async () => {
  // Case A: boss throws error
  const throwingBoss = {
    getQueueSize: async () => {
      throw new Error("DB connection lost");
    },
  };
  const depthThrow = await getEnrichmentQueueDepth(throwingBoss, "business-enrich");
  assert.equal(depthThrow, "unavailable");

  // Case B: boss is null or missing getQueueSize
  const nullBoss = null;
  const depthNull = await getEnrichmentQueueDepth(nullBoss, "business-enrich");
  assert.equal(depthNull, "unavailable");

  // Case C: boss returns NaN
  const nanBoss = {
    getQueueSize: async () => NaN,
  };
  const depthNan = await getEnrichmentQueueDepth(nanBoss, "business-enrich");
  assert.equal(depthNan, "unavailable");
});

// ── 11. no negative counters (underflow protection) ───────────────────────
test("11. active counters are guarded against negative values (underflow clamp)", () => {
  assert.equal(getEnrichmentTelemetrySnapshot().website_active, 0);
  assert.equal(getEnrichmentTelemetrySnapshot().instagram_active, 0);

  decrementActiveEnrichment();
  decrementActiveEnrichment();
  decrementActiveIntelligence();
  decrementActiveIntelligence();

  const snapshot = getEnrichmentTelemetrySnapshot();
  assert.equal(snapshot.website_active, 0);
  assert.equal(snapshot.contact_active, 0);
  assert.equal(snapshot.instagram_active, 0);
  assert.equal(snapshot.enrichment_active_total, 0);
  assert.equal(snapshot.intelligence_active_total, 0);
});

// ── 12. 30-second heartbeat log formatter uses real values ─────────────────
test("12. formatEnrichmentTelemetryLog formats truthful active counts and queue depths", () => {
  incrementActiveEnrichment();
  incrementActiveEnrichment();
  incrementActiveIntelligence();

  const snapshot = getEnrichmentTelemetrySnapshot();
  const logLine = formatEnrichmentTelemetryLog(snapshot, {
    enrichment_queue_depth: 12,
    intelligence_queue_depth: 7,
  });

  assert.match(logLine, /website_active=2/);
  assert.match(logLine, /contact_active=2/);
  assert.match(logLine, /instagram_active=1/);
  assert.match(logLine, /enrichment_queue_depth=12/);
  assert.match(logLine, /intelligence_queue_depth=7/);
  assert.match(logLine, /enrichment_active_total=2/);
  assert.match(logLine, /intelligence_active_total=1/);
});

// ── 13. existing worker behavior and capacity unchanged ───────────────────
test("13. existing enrichment capacity calculation remains completely intact", () => {
  const result = computeSafeResourceCapacity({
    pidsMax: 4096,
    pidsCurrent: 3596,
    pidsPerAreaWorker: 20,
    reservePids: 300,
    fallbackCeiling: 16,
    configuredCeiling: 16,
  });
  assert.equal(result.safeAreaWorkers, 10);

  const { enrichConcurrency, intelligenceConcurrency } = splitEnrichmentCapacity(10, 8, 8);
  assert.equal(enrichConcurrency, 5);
  assert.equal(intelligenceConcurrency, 5);
});
