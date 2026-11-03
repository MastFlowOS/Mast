import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type EngineEnrichResult, StderrLineBuffer } from "../pythonBridge.js";
import { resolveInstagramToPersist } from "../../lib/instagram.js";
import { channelsSatisfied, mergeEnrichedChannels } from "../../lib/channelFilter.js";
import { PlanFunnelTracker, getCandidateFunnelTracker } from "../../discovery/candidateFunnelTelemetry.js";
import { buildCandidateCorrelationId } from "../../discovery/candidatePipeline.js";
import { CityCandidateBudgetCoordinator } from "../../discovery/candidateBudget.js";
import { __testing } from "../../jobs/discoveryPlanJob.js";

describe("Phase 4 Candidate Observability & Contracts", () => {
  it("deserializes Python diagnostic fields accurately into EngineEnrichResult", () => {
    const rawPythonOutput = JSON.stringify({
      website_reachable: true,
      http_status: 200,
      email: "hello@bakery.example",
      emails: ["hello@bakery.example", "orders@bakery.example"],
      phone: "+1 555-0199",
      phones: ["+1 555-0199"],
      instagram: "https://www.instagram.com/bakery_nyc/",
      homepage_fetch_failed: false,
      contact_page_fetch_failed: false,
      secondary_page_fetch_failed: false,
      secondary_fallback_fetch_failed: false,
      mailto_extracted: true,
      tel_extracted: true,
      instagram_source: "anchor_href",
      instagram_invalid_candidate_seen: false,
      contact_page_hint: "contact",
      fetch_duration: 145.2,
      email_count: 2,
      phone_count: 1,
      instagram_found: true,
    });

    const parsed = JSON.parse(rawPythonOutput) as EngineEnrichResult;

    assert.equal(parsed.email, "hello@bakery.example");
    assert.equal(parsed.phone, "+1 555-0199");
    assert.equal(parsed.instagram, "https://www.instagram.com/bakery_nyc/");
    assert.equal(parsed.homepage_fetch_failed, false);
    assert.equal(parsed.contact_page_fetch_failed, false);
    assert.equal(parsed.mailto_extracted, true);
    assert.equal(parsed.tel_extracted, true);
    assert.equal(parsed.instagram_source, "anchor_href");
    assert.equal(parsed.email_count, 2);
    assert.equal(parsed.phone_count, 1);
    assert.equal(parsed.instagram_found, true);
    assert.equal(parsed.fetch_duration, 145.2);
  });

  it("handles website fetch failures (e.g. 403 / unreachable) cleanly", () => {
    const rawPythonFail = JSON.stringify({
      website_reachable: false,
      http_status: 403,
      email: null,
      emails: [],
      phone: null,
      phones: [],
      instagram: null,
      homepage_fetch_failed: true,
      contact_page_fetch_failed: true,
      secondary_page_fetch_failed: false,
      secondary_fallback_fetch_failed: false,
      mailto_extracted: false,
      tel_extracted: false,
      instagram_source: null,
      instagram_invalid_candidate_seen: false,
      contact_page_hint: null,
      fetch_duration: 50.0,
      email_count: 0,
      phone_count: 0,
      instagram_found: false,
    });

    const parsed = JSON.parse(rawPythonFail) as EngineEnrichResult;
    assert.equal(parsed.website_reachable, false);
    assert.equal(parsed.http_status, 403);
    assert.equal(parsed.homepage_fetch_failed, true);
    assert.equal(parsed.contact_page_fetch_failed, true);
    assert.equal(parsed.email, null);
    assert.equal(parsed.instagram, null);
  });

  it("resolveInstagramToPersist: preserves existing valid URL and does not overwrite with empty or invalid", () => {
    const existing = "https://www.instagram.com/stored_profile/";
    // Case A: Extraction is null -> returns null (do not overwrite existing)
    assert.equal(resolveInstagramToPersist(existing, null), null);
    // Case B: Extraction is reserved path (invalid) -> returns null (do not overwrite existing)
    assert.equal(resolveInstagramToPersist(existing, "https://www.instagram.com/p/123/"), null);
    // Case C: Extraction is different valid URL -> returns null (existing takes precedence, non-destructive)
    assert.equal(resolveInstagramToPersist(existing, "https://www.instagram.com/other_profile/"), null);
    // Case D: Stored is null, extraction is valid -> returns canonicalized URL for update
    assert.equal(
      resolveInstagramToPersist(null, "https://www.instagram.com/new_profile?hl=en"),
      "https://www.instagram.com/new_profile/",
    );
  });

  it("channel qualification: passes when all requested channels exist, rejects when missing", () => {
    const requested = ["email", "instagram"];
    const leadMaps = { name: "Bakery", phone: "+1 555-0100", website: "https://bakery.example" };
    const enrichedRow = {
      email: "hello@bakery.example",
      phone: "+1 555-0100",
      instagram: "https://www.instagram.com/bakery_nyc/",
      website: "https://bakery.example",
    };

    const deliverable = mergeEnrichedChannels(leadMaps, enrichedRow);
    assert.equal(channelsSatisfied(deliverable, requested), true);

    const missingChannels = requested.filter((ch) => !channelsSatisfied(deliverable, [ch]));
    assert.deepEqual(missingChannels, []);

    // If Instagram is missing:
    const deliverableNoIg = mergeEnrichedChannels(leadMaps, { ...enrichedRow, instagram: null });
    assert.equal(channelsSatisfied(deliverableNoIg, requested), false);
    const missingNow = requested.filter((ch) => !channelsSatisfied(deliverableNoIg, [ch]));
    assert.deepEqual(missingNow, ["instagram"]);
  });

  it("candidate correlation ID: area worker IDs do not collide in PlanFunnelTracker", () => {
    const funnel = new PlanFunnelTracker("plan_test_audit");

    // Worker 1 emits #1, #2
    const pid1_w1 = "scout_1:#1";
    const pid2_w1 = "scout_1:#2";
    funnel.recordDiscovered(pid1_w1);
    funnel.recordDiscovered(pid2_w1);

    // Worker 2 emits its own #1, #2 (different candidates from different area)
    const pid1_w2 = "scout_2:#1";
    const pid2_w2 = "scout_2:#2";
    funnel.recordDiscovered(pid1_w2);
    funnel.recordDiscovered(pid2_w2);

    const snapshot = funnel.getSnapshot();
    // All 4 candidates are registered as unique discoveries! None discarded as false retry!
    assert.equal(snapshot.counts.mapsDiscovered, 4);
    assert.equal(snapshot.counts.retriesTotal, 0);

    // If the same place is genuinely re-observed:
    const genuineSamePlace = "place:ChIJ123456789";
    funnel.recordDiscovered(genuineSamePlace);
    assert.equal(funnel.getSnapshot().counts.mapsDiscovered, 5);

    // Re-observation of same place:
    funnel.recordDiscovered(genuineSamePlace);
    assert.equal(funnel.getSnapshot().counts.mapsDiscovered, 5); // Did not increment mapsDiscovered
    assert.equal(funnel.getSnapshot().counts.retriesTotal, 1); // Incremented retriesTotal
  });

  it("pipeline accounting: rejections and dedup skips do not increment delivered leads", () => {
    const funnel = new PlanFunnelTracker("plan_test_accounting");

    // Candidate 1: rejected missing channels
    funnel.recordDiscovered("c1");
    funnel.recordMissingChannelRejection(["email", "instagram"], "c1");

    // Candidate 2: duplicate skipped
    funnel.recordDiscovered("c2");
    funnel.recordDuplicateSkipped("post_upsert_owned_lead", "c2");

    // Candidate 3: quality rejection
    funnel.recordDiscovered("c3");
    funnel.recordQualityRejection("low_rating", "c3");

    // Candidate 4: actually qualified and delivered
    funnel.recordDiscovered("c4");
    funnel.recordContactExtracted(["website_homepage"], "c4");
    funnel.recordReachingDelivery("c4");
    funnel.recordDelivered("c4");

    const snapshot = funnel.getSnapshot();
    assert.equal(snapshot.counts.mapsDiscovered, 4);
    assert.equal(snapshot.counts.deliveredLeads, 1);
    assert.equal(snapshot.counts.userDuplicatesSkipped, 1);
    assert.equal(snapshot.counts.contactsExtracted, 1);
    assert.equal(snapshot.breakdowns.missingChannels["email"], 1);
    assert.equal(snapshot.breakdowns.missingChannels["instagram"], 1);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Candidate Correlation ID Collision Regression Tests (Requirement 1 & 2)
  // Exercising the REAL allocator (`ctx.nextAttemptId()` & `funnel.nextAttemptId()`)
  // ──────────────────────────────────────────────────────────────────────────

  it("regression 1: same pool worker slot handles two sequential area attempts using the real allocator", () => {
    const funnel = new PlanFunnelTracker("plan_allocator_sequential");
    const taskAttempt = 1;
    const ctx = { nextAttemptId: () => funnel.nextAttemptId(taskAttempt) };

    // OLD SLOT-ONLY APPROACH DEMONSTRATION OF DEFECT:
    // Slot 1 runs Area A and Area B, both emitting #1.
    const oldSlotOnlyAttempt1 = "scout_1:#1";
    const oldSlotOnlyAttempt2 = "scout_1:#1";
    const flawedFunnel = new PlanFunnelTracker("flawed_plan");
    flawedFunnel.recordDiscovered(oldSlotOnlyAttempt1);
    flawedFunnel.recordDiscovered(oldSlotOnlyAttempt2);
    // Under the old approach, Attempt 2 collides with Attempt 1:
    assert.equal(flawedFunnel.getSnapshot().counts.mapsDiscovered, 1, "Old approach falsely suppressed Area B discovery");
    assert.equal(flawedFunnel.getSnapshot().counts.retriesTotal, 1, "Old approach falsely recorded Area B as a retry");

    // NEW REAL ALLOCATOR APPROACH:
    // Area 1 runs in Slot 1:
    const attempt1 = ctx.nextAttemptId();
    assert.equal(attempt1, "1_1");
    const pidAttempt1 = buildCandidateCorrelationId({ effectiveScoutId: 1, attemptId: attempt1, rawPid: "#1" });

    // Area 2 runs in Slot 1:
    const attempt2 = ctx.nextAttemptId();
    assert.equal(attempt2, "1_2");
    const pidAttempt2 = buildCandidateCorrelationId({ effectiveScoutId: 1, attemptId: attempt2, rawPid: "#1" });

    assert.equal(pidAttempt1, "scout_1_att1_1:#1");
    assert.equal(pidAttempt2, "scout_1_att1_2:#1");
    assert.notEqual(pidAttempt1, pidAttempt2);

    funnel.recordDiscovered(pidAttempt1);
    funnel.recordDiscovered(pidAttempt2);

    // Both candidates are registered as unique discoveries!
    const snap = funnel.getSnapshot();
    assert.equal(snap.counts.mapsDiscovered, 2);
    assert.equal(snap.counts.retriesTotal, 0);
  });

  it("regression 2: area/subprocess retry inside the SAME handleDiscoveryTask() execution with SAME taskAttempt uses monotonically increasing sequence", () => {
    // Models an actual area/subprocess retry occurring inside the SAME handleDiscoveryTask() invocation:
    // taskAttempt remains 1 (same task execution), but a failed area attempt triggers a retry subprocess.
    const funnel = new PlanFunnelTracker("plan_allocator_area_retry_same_task");
    const taskAttempt = 1;
    const ctx = { nextAttemptId: () => funnel.nextAttemptId(taskAttempt) };

    // Initial area attempt in slot 1 (fails or stops early, emitting candidate #1):
    const initialAttempt = ctx.nextAttemptId();
    assert.equal(initialAttempt, "1_1");
    const initialAttemptPid = buildCandidateCorrelationId({ effectiveScoutId: 1, attemptId: initialAttempt, rawPid: "#1" });
    assert.equal(initialAttemptPid, "scout_1_att1_1:#1");
    funnel.recordDiscovered(initialAttemptPid);

    // Area-level retry inside the SAME taskAttempt (calling real allocator again):
    const retryAttempt = ctx.nextAttemptId();
    // taskAttempt is STILL 1, but attemptSeq has advanced to 2:
    assert.equal(retryAttempt, "1_2");
    const retryAttemptPid = buildCandidateCorrelationId({ effectiveScoutId: 1, attemptId: retryAttempt, rawPid: "#1" });
    assert.equal(retryAttemptPid, "scout_1_att1_2:#1");
    assert.notEqual(initialAttemptPid, retryAttemptPid);

    // Monotonically increasing sequence in PlanFunnelTracker completely prevents collision!
    funnel.recordDiscovered(retryAttemptPid);

    assert.equal(funnel.getSnapshot().counts.mapsDiscovered, 2);
    assert.equal(funnel.getSnapshot().counts.retriesTotal, 0);
  });

  it("regression 3: separate subprocesses launched by the same area operation (multi-query niche) receive distinct IDs", () => {
    // Models an area attempt searching a multi-niche target (e.g. "yoga, pilates")
    // where GoogleMapsSearchGenerator generates 2 queries, spawning 2 separate Python subprocesses
    // within the same runOneAreaAttempt() call.
    const funnel = new PlanFunnelTracker("plan_multi_query_subprocess");
    const taskAttempt = 1;
    const ctx = { nextAttemptId: () => funnel.nextAttemptId(taskAttempt) };

    // Query 1 spawns Subprocess 1 in slot 1:
    const query1AttemptId = ctx.nextAttemptId();
    assert.equal(query1AttemptId, "1_1");
    const lead1Subprocess1 = buildCandidateCorrelationId({ effectiveScoutId: 1, attemptId: query1AttemptId, rawPid: "#1" });
    funnel.recordDiscovered(lead1Subprocess1);

    // Query 2 spawns Subprocess 2 in slot 1 (same area operation!):
    const query2AttemptId = ctx.nextAttemptId();
    assert.equal(query2AttemptId, "1_2");
    // Subprocess 2 resets its internal _pipeline_id counter to #1:
    const lead1Subprocess2 = buildCandidateCorrelationId({ effectiveScoutId: 1, attemptId: query2AttemptId, rawPid: "#1" });
    funnel.recordDiscovered(lead1Subprocess2);

    assert.equal(lead1Subprocess1, "scout_1_att1_1:#1");
    assert.equal(lead1Subprocess2, "scout_1_att1_2:#1");
    assert.notEqual(lead1Subprocess1, lead1Subprocess2);

    // Both candidates are preserved as distinct discoveries:
    assert.equal(funnel.getSnapshot().counts.mapsDiscovered, 2);
    assert.equal(funnel.getSnapshot().counts.retriesTotal, 0);
  });

  it("regression 4: separate job-level retry and multiple city tasks in the same plan using the real allocator", () => {
    const funnel = new PlanFunnelTracker("plan_cross_task_execution");

    // Task Execution 1 (attempts: 0 -> taskAttempt: 1)
    const task1Attempt = 1;
    const ctx1 = { nextAttemptId: () => funnel.nextAttemptId(task1Attempt) };
    const attempt1 = ctx1.nextAttemptId();
    assert.equal(attempt1, "1_1");
    const pid1 = buildCandidateCorrelationId({ effectiveScoutId: 1, attemptId: attempt1, rawPid: "#1" });
    funnel.recordDiscovered(pid1);

    // Task Execution 2 (pg-boss retries task at job level: attempts: 1 -> taskAttempt: 2)
    const task2Attempt = 2;
    const ctx2 = { nextAttemptId: () => funnel.nextAttemptId(task2Attempt) };
    const attempt2 = ctx2.nextAttemptId();
    assert.equal(attempt2, "2_2");
    const pid2 = buildCandidateCorrelationId({ effectiveScoutId: 1, attemptId: attempt2, rawPid: "#1" });
    funnel.recordDiscovered(pid2);

    // Task Execution 3 (second city task in the same plan, attempts: 0 -> taskAttempt: 1)
    const ctx3 = { nextAttemptId: () => funnel.nextAttemptId(1) };
    const attempt3 = ctx3.nextAttemptId();
    assert.equal(attempt3, "1_3"); // Monotonic counter in plan tracker guarantees 3, not 1!
    const pid3 = buildCandidateCorrelationId({ effectiveScoutId: 1, attemptId: attempt3, rawPid: "#1" });
    funnel.recordDiscovered(pid3);

    assert.equal(new Set([pid1, pid2, pid3]).size, 3, "All 3 task executions generated unique correlation IDs");
    assert.equal(funnel.getSnapshot().counts.mapsDiscovered, 3);
    assert.equal(funnel.getSnapshot().counts.retriesTotal, 0);
  });

  it("regression 5: multiple concurrent area workers using the real allocator", () => {
    const funnel = new PlanFunnelTracker("plan_concurrent_allocator");
    const taskAttempt = 1;
    const ctx = { nextAttemptId: () => funnel.nextAttemptId(taskAttempt) };

    const worker1Attempt = ctx.nextAttemptId();
    const worker2Attempt = ctx.nextAttemptId();
    assert.equal(worker1Attempt, "1_1");
    assert.equal(worker2Attempt, "1_2");

    const worker1Pid = buildCandidateCorrelationId({ effectiveScoutId: 1, attemptId: worker1Attempt, rawPid: "#1" });
    const worker2Pid = buildCandidateCorrelationId({ effectiveScoutId: 2, attemptId: worker2Attempt, rawPid: "#1" });

    assert.equal(worker1Pid, "scout_1_att1_1:#1");
    assert.equal(worker2Pid, "scout_2_att1_2:#1");
    assert.notEqual(worker1Pid, worker2Pid);

    funnel.recordDiscovered(worker1Pid);
    funnel.recordDiscovered(worker2Pid);

    assert.equal(funnel.getSnapshot().counts.mapsDiscovered, 2);
    assert.equal(funnel.getSnapshot().counts.retriesTotal, 0);
  });

  it("regression 6: genuine duplicate Place IDs retaining canonical identity with real allocator", () => {
    const funnel = new PlanFunnelTracker("plan_place_dedup_real");
    const ctx = { nextAttemptId: () => funnel.nextAttemptId(1) };

    const pidAttempt1 = buildCandidateCorrelationId({ placeId: "ChIJ_global_abc", effectiveScoutId: 1, attemptId: ctx.nextAttemptId(), rawPid: "#1" });
    const pidAttempt2 = buildCandidateCorrelationId({ placeId: "ChIJ_global_abc", effectiveScoutId: 2, attemptId: ctx.nextAttemptId(), rawPid: "#2" });

    // Place ID always takes precedence and maps to canonical business identity:
    assert.equal(pidAttempt1, "place:ChIJ_global_abc");
    assert.equal(pidAttempt2, "place:ChIJ_global_abc");
    assert.equal(pidAttempt1, pidAttempt2);

    funnel.recordDiscovered(pidAttempt1);
    assert.equal(funnel.getSnapshot().counts.mapsDiscovered, 1);
    assert.equal(funnel.getSnapshot().counts.retriesTotal, 0);

    // Second sighting of identical place:
    funnel.recordDiscovered(pidAttempt2);
    assert.equal(funnel.getSnapshot().counts.mapsDiscovered, 1); // Not double counted!
    assert.equal(funnel.getSnapshot().counts.retriesTotal, 1); // Recorded as retry/re-sighting!
  });

  it("regression 7: repeated genuine Place IDs still consume separate raw candidate admission slots", () => {
    const budgetCoordinator = new CityCandidateBudgetCoordinator(5);
    const funnel = new PlanFunnelTracker("plan_budget_consumption");
    const pid = "place:ChIJ_same_place";

    // 1st sighting: consumes budget slot 1, registers unique discovery
    assert.equal(budgetCoordinator.tryAdmitCandidate(), true);
    funnel.recordDiscovered(pid);

    // 2nd sighting: consumes budget slot 2, records retry
    assert.equal(budgetCoordinator.tryAdmitCandidate(), true);
    funnel.recordDiscovered(pid);

    // 3rd sighting: consumes budget slot 3, records retry
    assert.equal(budgetCoordinator.tryAdmitCandidate(), true);
    funnel.recordDiscovered(pid);

    assert.equal(budgetCoordinator.admittedCount, 3, "All 3 sightings consumed budget slots");
    assert.equal(budgetCoordinator.remainingBudget, 2);
    assert.equal(funnel.getSnapshot().counts.mapsDiscovered, 1, "Only 1 unique business registered");
    assert.equal(funnel.getSnapshot().counts.retriesTotal, 2, "2 repeated sightings tracked as retries");
  });

  it("regression 8: real runOneAreaAttempt integration: multiple query subprocesses and overrides receive distinct IDs", async () => {
    const { runOneAreaAttempt } = __testing;
    const planId = "plan_run_one_area_integration";
    const funnel = getCandidateFunnelTracker(planId);

    // Track all correlation IDs that pass through funnel.recordDiscovered:
    const recordedPids: string[] = [];
    const origRecordDiscovered = funnel.recordDiscovered.bind(funnel);
    funnel.recordDiscovered = (pid?: string) => {
      if (pid) recordedPids.push(pid);
      origRecordDiscovered(pid);
    };

    // Mock DB:
    const mockDb = {
      from: () => ({
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({
              data: { status: "running", delivered_count: 0, requested_count: 10 },
            }),
          }),
        }),
      }),
    };

    // Task with 2 niches -> 2 queries:
    const task = {
      niche: "dentist, orthodontist",
      city: "Austin",
      country_code: "US",
      candidate_budget: 10,
      user_id: undefined, // skips db in getKnownPlaceIdsForTask
    };

    const payload = {
      taskId: "task_integration_subprocesses",
      planId,
      request: {
        userId: "u1",
        region: "Texas",
        channels: ["phone"], // Early-prunes leads without phone, safely avoiding DB upserts
        quantity: 10,
      },
    };

    const profiler = {
      timer: () => ({ end: () => {} }),
    } as any;

    const generator = {
      generate: () => [
        { queryString: "dentist Austin", niche: "dentist" },
        { queryString: "orthodontist Austin", niche: "orthodontist" },
      ],
    } as any;

    let queryIteration = 0;
    const mockProvider = {
      id: "google_maps",
      displayName: "Mock Maps",
      search: async function* () {
        queryIteration++;
        if (queryIteration === 1) {
          // Subprocess 1: emits candidate #1 and #2
          yield {
            name: "Alpha Dental",
            _pipeline_id: "#1",
            website: "https://alpha.example",
          };
          yield {
            name: "Beta Dental",
            _pipeline_id: "#2",
            website: "https://beta.example",
          };
        } else {
          // Subprocess 2: Python restarts monotonic counter at #1!
          yield {
            name: "Gamma Ortho",
            _pipeline_id: "#1", // Same raw _pipeline_id as Subprocess 1's first lead!
            website: "https://gamma.example",
          };
          // Also emits a genuine Place ID candidate:
          yield {
            name: "Delta Ortho Place",
            place_id: "ChIJ_real_delta_place",
            _pipeline_id: "#2",
            website: "https://delta.example",
          };
        }
      },
    } as any;

    const budgetCoordinator = new CityCandidateBudgetCoordinator(10);
    const abortController = new AbortController();

    const ctx = {
      db: mockDb,
      task,
      payload,
      profiler,
      provider: mockProvider,
      generator,
      requestAbort: abortController,
      observeTerminalPlan: async () => undefined,
      startedAt: Date.now(),
      budgetCoordinator,
      nextAttemptId: () => funnel.nextAttemptId(1), // taskAttempt = 1
    };

    // Run the actual runOneAreaAttempt function:
    await runOneAreaAttempt(ctx as any, "Downtown", undefined, 1);

    // Verify all 4 candidates were discovered:
    assert.equal(recordedPids.length, 4);

    // 1. All candidates within Subprocess 1 share attempt ID "1_1":
    assert.equal(recordedPids[0], "scout_1_att1_1:#1");
    assert.equal(recordedPids[1], "scout_1_att1_1:#2");

    // 2. Subprocess 2 received distinct attempt ID "1_2" even within the SAME area operation:
    assert.equal(recordedPids[2], "scout_1_att1_2:#1");
    assert.notEqual(recordedPids[0], recordedPids[2], "Subprocess 1 & 2 candidate #1 do not collide!");

    // 3. Genuine Place ID candidate retained its canonical format:
    assert.equal(recordedPids[3], "place:ChIJ_real_delta_place");

    // 4. Verify that an optional static attemptId passed to runOneAreaAttempt cannot cause collisions across queries:
    const overridePlanId = "plan_override_test";
    const funnelWithOverride = getCandidateFunnelTracker(overridePlanId);
    const overridePids: string[] = [];
    const origRecordOverride = funnelWithOverride.recordDiscovered.bind(funnelWithOverride);
    funnelWithOverride.recordDiscovered = (pid?: string) => {
      if (pid) overridePids.push(pid);
      origRecordOverride(pid);
    };

    queryIteration = 0;
    const ctxWithoutAllocator = {
      ...ctx,
      payload: { ...payload, planId: overridePlanId },
      nextAttemptId: undefined, // Simulate caller without allocator
    };

    // Pass static attemptId override "custom_att":
    await runOneAreaAttempt(ctxWithoutAllocator as any, "Downtown", undefined, 1, "custom_att");

    // Query 1 gets custom_att; Query 2 gets custom_att_2 (no collision):
    assert.equal(overridePids[0], "scout_1_attcustom_att:#1");
    assert.equal(overridePids[2], "scout_1_attcustom_att_2:#1");
    assert.notEqual(overridePids[0], overridePids[2], "Static override does not cause cross-query collision!");
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Stderr Chunk Buffering Tests (Requirement 2)
  // ──────────────────────────────────────────────────────────────────────────

  it("stderr buffer: one candidate-audit record split across several stderr chunks is assembled cleanly", () => {
    const emitted: string[] = [];
    const buffer = new StderrLineBuffer((line) => emitted.push(line));

    buffer.append('[candidate-audit] {"pipeline_id": ');
    assert.equal(emitted.length, 0, "Partial line must not be emitted");

    buffer.append('"#1", "status": ');
    assert.equal(emitted.length, 0, "Partial line must not be emitted");

    buffer.append('"ok", "email_found": true}\n');
    assert.equal(emitted.length, 1, "Complete line emitted once newline arrives");
    assert.equal(emitted[0], '[candidate-audit] {"pipeline_id": "#1", "status": "ok", "email_found": true}');
  });

  it("stderr buffer: multiple complete records delivered in a single chunk are emitted individually", () => {
    const emitted: string[] = [];
    const buffer = new StderrLineBuffer((line) => emitted.push(line));

    const multiChunk = [
      '[candidate-audit] {"id": 1, "channel": "phone"}',
      '[candidate-audit] {"id": 2, "channel": "email"}',
      '[candidate-audit] {"id": 3, "channel": "instagram"}',
      "",
    ].join("\n");

    buffer.append(multiChunk);
    assert.equal(emitted.length, 3);
    assert.deepEqual(emitted, [
      '[candidate-audit] {"id": 1, "channel": "phone"}',
      '[candidate-audit] {"id": 2, "channel": "email"}',
      '[candidate-audit] {"id": 3, "channel": "instagram"}',
    ]);
  });

  it("stderr buffer: a final partial line when the process closes is discarded, but complete record is emitted", () => {
    // Case A: Truncated JSON fragment from crashed/aborted process
    const emittedA: string[] = [];
    const bufferA = new StderrLineBuffer((line) => emittedA.push(line));
    bufferA.append('[candidate-audit] {"id": 4, "truncated": ');
    bufferA.flush(); // Process closes
    assert.equal(emittedA.length, 0, "Incomplete partial candidate-audit JSON must be safely discarded");

    // Case B: Complete record that happened to lack trailing newline before close
    const emittedB: string[] = [];
    const bufferB = new StderrLineBuffer((line) => emittedB.push(line));
    bufferB.append('[candidate-audit] {"id": 5, "complete": true}');
    bufferB.flush(); // Process closes
    assert.equal(emittedB.length, 1, "Complete valid candidate-audit JSON lacking newline is emitted on flush");
    assert.equal(emittedB[0], '[candidate-audit] {"id": 5, "complete": true}');
  });

  it("stderr buffer: one-shot enrichment bridge buffers chunks without dropping audit records", () => {
    const logs: string[] = [];
    const buffer = new StderrLineBuffer((line) => {
      if (line.includes("[candidate-audit]")) {
        logs.push(line);
      }
    });

    // Simulate 2 split chunks from one-shot enrichment
    buffer.append("[candidate-audit] ");
    buffer.append('{"pipeline_id": "#10", "email_count": 1, "website_reachable": true}\n');

    assert.equal(logs.length, 1);
    const parsed = JSON.parse(logs[0].replace("[candidate-audit] ", ""));
    assert.equal(parsed.pipeline_id, "#10");
    assert.equal(parsed.email_count, 1);
  });

  it("stderr buffer: persistent enrichment daemon buffers chunks across multiple daemon requests", () => {
    const daemonAuditLogs: string[] = [];
    const buffer = new StderrLineBuffer((line) => {
      if (line.includes("[candidate-audit]")) {
        daemonAuditLogs.push(line);
      }
    });

    // Request 1 chunk
    buffer.append('[candidate-audit] {"pipeline_id": "#d1", "instagram_found": true}\n');
    // Request 2 chunk split across 2 packets
    buffer.append('[candidate-audit] {"pipeline_id": "#d2", ');
    buffer.append('"instagram_found": false}\n');

    assert.equal(daemonAuditLogs.length, 2);
    assert.equal(JSON.parse(daemonAuditLogs[0].replace("[candidate-audit] ", "")).pipeline_id, "#d1");
    assert.equal(JSON.parse(daemonAuditLogs[1].replace("[candidate-audit] ", "")).pipeline_id, "#d2");
  });
});
