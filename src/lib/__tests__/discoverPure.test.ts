/**
 * Deterministic unit tests for the pure decision logic behind the Discover
 * fixes: global ranking, enriched-channel merge, outcome wording/counts,
 * terminal-emission decisions, contact-channel presence, and the single
 * request builder shared by the submit handler and the AI Overview.
 */
import assert from "node:assert/strict";
import test from "node:test";

process.env.NODE_ENV ??= "test";
process.env.SUPABASE_URL ??= "https://example-project.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "test-service-role-key";

const { rankPoolCandidates, summarizePoolRanking } = await import("../poolLookup.js");
const { mergeEnrichedChannels, channelsSatisfied } = await import("../channelFilter.js");
const { describeDiscoverOutcome, decideTerminalEmission } = await import("../discoverProgress.js");
const { channelPresence, missingRequestedChannels } = await import("../leadChannels.js");
const { buildDiscoverRequest, summarizeDiscoverRequest } = await import("../discoverRequest.js");
const { createInitialLiveDiscoveryState, reduceLiveDiscoveryEvents } = await import("../../discovery/liveDiscoveryState.js");
const { leadDeliveredEvent, discoveryCompletedEvent, discoveryFailedEvent } = await import("../../discovery/liveDiscoveryEvent.js");

// ── global Opportunity Score ordering ───────────────────────────────────────

test("rankPoolCandidates: score desc, unscored last, ties keep retrieval order (stable)", () => {
  const rows = [
    { id: "a", opportunity_score: 50 },
    { id: "b", opportunity_score: null },
    { id: "c", opportunity_score: 90 },
    { id: "d", opportunity_score: 50 },
    { id: "e", opportunity_score: null },
    { id: "f", opportunity_score: 0 },
  ];
  assert.deepEqual(rankPoolCandidates(rows).map((r) => r.id), ["c", "a", "d", "f", "b", "e"]);
  assert.deepEqual(rows.map((r) => r.id), ["a", "b", "c", "d", "e", "f"], "input is not mutated");
});

test("a real score of 0 outranks an unscored candidate (0 is a score, not 'missing')", () => {
  const out = rankPoolCandidates([
    { id: "unscored", opportunity_score: null },
    { id: "zero", opportunity_score: 0 },
  ]);
  assert.equal(out[0].id, "zero");
});

test("summarizePoolRanking never claims more than is true", () => {
  assert.equal(summarizePoolRanking(false, "graphic_design", [{ opportunityScore: 1 }]).status, "not_requested");
  assert.equal(summarizePoolRanking(true, null, [{ opportunityScore: null }]).status, "unavailable");
  assert.equal(summarizePoolRanking(true, null, []).reason, "no_profession_focus");
  assert.equal(summarizePoolRanking(true, "graphic_design", [{ opportunityScore: 9 }, { opportunityScore: 5 }]).status, "full");
  const partial = summarizePoolRanking(true, "graphic_design", [{ opportunityScore: 9 }, { opportunityScore: null }]);
  assert.equal(partial.status, "partial");
  assert.deepEqual([partial.scored, partial.unscored, partial.policy], [1, 1, "unscored_last"]);
});

// ── Live: saved record agrees with the channel gate ─────────────────────────

test("mergeEnrichedChannels: a lead that passed the gate on the enriched row is SAVED with those channels", () => {
  const engineLead = { name: "Cafe", phone: "+1555", website: "https://cafe.test", email: null, instagram: null };
  const enriched = { phone: "+1555", website: "https://cafe.test", email: "hi@cafe.test", instagram: "@cafe" };
  const requested = ["email", "phone", "instagram", "website"];
  assert.equal(channelsSatisfied(engineLead, requested), false, "the raw engine lead would NOT have satisfied the gate");
  assert.equal(channelsSatisfied(enriched, requested), true, "the enriched row did");
  const deliverable = mergeEnrichedChannels(engineLead, enriched);
  assert.equal(channelsSatisfied(deliverable, requested), true, "what is saved now satisfies what was gated");
  assert.equal(deliverable.name, "Cafe", "non-channel fields are untouched");
});

test("mergeEnrichedChannels never invents values and never blanks existing ones", () => {
  const lead = { email: "kept@x.test", phone: null, instagram: "", website: "https://w.test" };
  const merged = mergeEnrichedChannels(lead, { email: "  ", phone: null, instagram: null, website: "" });
  assert.deepEqual(merged, lead);
  assert.equal(mergeEnrichedChannels(lead, null), lead);
});

// ── contact icons mean "this saved lead has this channel" ───────────────────

test("channelPresence reports presence + requested; missingRequestedChannels exposes AND-contract violations", () => {
  const lead = { email: null, phone: "+1555", instagramHandle: null, website: "https://w.test" };
  const requested = ["email", "phone", "instagram", "website"];
  const p = channelPresence(lead, requested);
  assert.deepEqual(p.filter((c) => c.present).map((c) => c.id), ["phone", "website"]);
  assert.ok(p.every((c) => c.requested));
  assert.deepEqual(missingRequestedChannels(lead, requested), ["email", "instagram"]);
  assert.deepEqual(missingRequestedChannels({ email: "a@b.c" }, ["email"]), []);
  assert.equal(channelPresence({ instagram: "@x" }, []).find((c) => c.id === "instagram")!.present, true);
});

// ── outcome wording / counts ────────────────────────────────────────────────

test("describeDiscoverOutcome: success ONLY when delivered >= requested", () => {
  const ok = describeDiscoverOutcome({ requested: 5, delivered: 5, status: "completed", source: "pool" });
  assert.equal(ok.kind, "complete");
  assert.equal(ok.toast, "success");
  assert.equal(ok.shortfall, 0);

  const partial = describeDiscoverOutcome({ requested: 5, delivered: 4, status: "completed_partial", shortfallReason: "pool_exhausted", source: "pool" });
  assert.equal(partial.kind, "partial");
  assert.notEqual(partial.toast, "success");
  assert.equal(partial.shortfall, 1);
  assert.match(partial.headline, /4 of 5/);
  assert.match(partial.detail!, /pool did not contain enough qualifying matches/i);
  assert.match(partial.detail!, /No filters were loosened/i);
});

test("describeDiscoverOutcome: a 'completed' status with fewer leads than requested is still reported as partial", () => {
  const o = describeDiscoverOutcome({ requested: 5, delivered: 2, status: "completed", source: "live" });
  assert.equal(o.kind, "partial");
  assert.equal(o.toast, "info");
});

test("describeDiscoverOutcome: empty, plan-limit, failed and cancelled are each distinct and never 'success'", () => {
  const empty = describeDiscoverOutcome({ requested: 5, delivered: 0, status: "completed_partial", source: "pool" });
  assert.equal(empty.kind, "empty");
  const limit = describeDiscoverOutcome({ requested: 5, delivered: 2, status: "completed_partial", shortfallReason: "plan_limit_reached", source: "pool" });
  assert.match(limit.detail!, /plan's lead limit/);
  const failed = describeDiscoverOutcome({ requested: 5, delivered: 0, status: "failed", source: "live" });
  assert.equal(failed.kind, "failed");
  assert.equal(failed.toast, "error");
  const failedPartial = describeDiscoverOutcome({ requested: 5, delivered: 2, status: "failed", source: "live" });
  assert.match(failedPartial.headline, /2 of 5 delivered/);
  const cancelled = describeDiscoverOutcome({ requested: 5, delivered: 1, status: "cancelled", source: "live" });
  assert.equal(cancelled.kind, "cancelled");
});

test("requested / delivered / shortfall stay distinguishable and never go negative", () => {
  const o = describeDiscoverOutcome({ requested: 3, delivered: 5, status: "completed", source: "pool" });
  assert.deepEqual([o.requested, o.delivered, o.shortfall], [3, 5, 0]);
});

// ── realtime terminal decision (the stuck-forever bug) ──────────────────────

test("decideTerminalEmission: completed + fewer visible leads reconciles ONCE, then emits (no endless refetch loop)", () => {
  const base = { terminalStatus: "completed", terminalResultsCount: 5, requestedQuantity: 5, seenCount: 4, isReconciling: false };
  assert.equal(decideTerminalEmission({ ...base, reconciled: false }), "reconcile");
  assert.equal(decideTerminalEmission({ ...base, reconciled: true }), "emit", "after one reconcile it must report, not refetch forever");
  assert.equal(decideTerminalEmission({ ...base, reconciled: false, isReconciling: true }), "wait");
});

test("decideTerminalEmission: emits immediately when everything the job reported is visible; waits for no terminal status", () => {
  assert.equal(decideTerminalEmission({ terminalStatus: "completed", terminalResultsCount: 5, requestedQuantity: 5, seenCount: 5, reconciled: false, isReconciling: false }), "emit");
  assert.equal(decideTerminalEmission({ terminalStatus: null, terminalResultsCount: 0, seenCount: 0, reconciled: false, isReconciling: false }), "none");
  // job reports 3 although 5 were requested: target is what the job delivered
  assert.equal(decideTerminalEmission({ terminalStatus: "completed_partial", terminalResultsCount: 3, requestedQuantity: 5, seenCount: 3, reconciled: false, isReconciling: false }), "emit");
});

// ── single request builder (UI submit + AI Overview) ────────────────────────

test("buildDiscoverRequest is the canonical request; the AI Overview summary is derived from the SAME object", () => {
  const req = buildDiscoverRequest({
    quantity: 5,
    regions: ["United States"],
    niches: ["Coffee Shops"],
    channels: ["email", "phone", "instagram", "website"],
    method: "instant_pool",
  });
  assert.deepEqual(req, {
    quantity: 5,
    region: "United States",
    niche: "Coffee Shops",
    channels: ["email", "phone", "instagram", "website"],
    method: "instant_pool",
    mode: "pool",
  });
  assert.deepEqual(summarizeDiscoverRequest(req), {
    niche: "Coffee Shops",
    region: "United States",
    amount: "5",
    channels: "email + phone + instagram + website",
    method: "instant_pool",
  });
  assert.equal("followsJobId" in req, false, "a normal request never carries a follow-up id");
});

test("buildDiscoverRequest: multi-select joins, follow-up carries followsJobId and live mode", () => {
  const req = buildDiscoverRequest({
    quantity: 2,
    regions: ["Canada", "Mexico"],
    niches: ["Gyms", "Bakeries"],
    channels: [],
    method: "live",
    followsJobId: "11111111-1111-4111-8111-111111111111",
  });
  assert.equal(req.region, "Canada, Mexico");
  assert.equal(req.niche, "Gyms, Bakeries");
  assert.equal(req.mode, "scrape");
  assert.equal(req.followsJobId, "11111111-1111-4111-8111-111111111111");
  assert.equal(summarizeDiscoverRequest(req).channels, "Any");
});

// ── Live stream: repeated events never double-count ─────────────────────────

test("live stream: a repeated lead_delivered event counts once; completion carries real counts; failure terminates visibly", () => {
  let state = createInitialLiveDiscoveryState(5, 0);
  const delivered = leadDeliveredEvent("plan-1", 1, "#1", "Joe's", "Area A");
  state = reduceLiveDiscoveryEvents(state, [delivered, delivered, delivered]);
  assert.equal(state.delivered, 1, "replayed/duplicated event must not inflate the counter");

  const done = reduceLiveDiscoveryEvents(state, [discoveryCompletedEvent("plan-1", 1, 5)]);
  assert.equal(done.delivered, 1);
  assert.equal(done.target, 5);

  const failed = reduceLiveDiscoveryEvents(createInitialLiveDiscoveryState(5, 0), [discoveryFailedEvent("plan-1", "worker crashed")]);
  assert.equal(failed.status, "failed");
  assert.equal(failed.delivered, 0, "a failure never reports delivered leads that don't exist");
});

// ── Live wiring guard (structural) ──────────────────────────────────────────

test("live delivery saves the ENRICHED-merged lead, merged only after the post-enrichment gate passed", async () => {
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const path = await import("node:path");
  const src = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "../../jobs/discoveryPlanJob.ts"), "utf8");
  const gate = src.indexOf("post_enrichment_channel_gate");
  const merge = src.indexOf("deliverable = mergeEnrichedChannels(lead, enriched);");
  const deliver = src.search(/const delivery = await deliverLead\(deliverable, \{/);
  assert.ok(gate !== -1 && merge !== -1 && deliver !== -1, "gate, merge and delivery must all exist");
  assert.ok(gate < merge && merge < deliver, "order: post-enrichment gate -> merge enriched channels -> deliver");
});
