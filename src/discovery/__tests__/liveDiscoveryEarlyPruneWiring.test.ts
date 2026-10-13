/**
 * Live Discovery early-prune wiring.
 *
 * Part A is behavioral (provider -> engine param flow).
 * Part B pins the ORDER of operations inside handleDiscoveryTask. That handler
 * needs a database, a Python subprocess and a job queue, so — like the
 * existing discoveryPlanJobDisqualifiedGate.test.ts — it is asserted against
 * the source. Each assertion is narrow and states what it protects.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { buildGoogleMapsEngineParams } from "../providers/googleMaps/googleMapsProvider.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(path.join(here, rel), "utf8").replace(/\r\n/g, "\n");

const query = { queryString: "dentist Springfield", niche: "dentist" } as any;
const target = { city: "Springfield", countryCode: "US", region: "IL", niche: "dentist", area: "Downtown" } as any;
const baseOpts = { maxResults: 50, candidateBudget: 50, discoveryOnly: true, taskDbPath: "data/x.db", requestId: "plan-1" };

// ── Part A: options reach the engine ────────────────────────────────────────

test("requiredChannels reach the Python engine as required_channels", () => {
  const p = buildGoogleMapsEngineParams(query, target, { ...baseOpts, requiredChannels: ["website", "phone"] });
  assert.deepEqual(p.required_channels, ["website", "phone"]);
  assert.equal(p.discovery_only, true, "discovery_only must be unchanged");
  assert.equal(p.require_viability, false);
});

test("without requiredChannels the engine payload has NO required_channels key (backward compatible)", () => {
  for (const requiredChannels of [undefined, []] as const) {
    const p = buildGoogleMapsEngineParams(query, target, { ...baseOpts, requiredChannels: requiredChannels as any });
    assert.equal("required_channels" in p, false);
  }
});

test("all pre-existing engine params are unchanged by the new option", () => {
  const p = buildGoogleMapsEngineParams(query, { ...target, street: "Main St" }, { ...baseOpts, requiredChannels: ["website"] });
  assert.deepEqual(
    { ...p, required_channels: undefined },
    {
      query: "dentist Springfield",
      city: "Springfield",
      country: "US",
      region: "IL",
      niche: "dentist",
      area: "Main St",
      max_results: 50,
      discovery_only: true,
      require_viability: false,
      db_path: "data/x.db",
      required_channels: undefined,
    },
  );
});

// ── Part B: ordering inside handleDiscoveryTask ─────────────────────────────

const plan = read("../../jobs/discoveryPlanJob.ts");
const idx = (needle: string | RegExp) =>
  typeof needle === "string" ? plan.indexOf(needle) : plan.search(needle);

test("the active plan job forwards only engineRequiredChannels(...) to the provider", () => {
  assert.match(plan, /requiredChannels: engineRequiredChannels\(payload\.request\.channels\)/);
  assert.doesNotMatch(plan, /requiredChannels: payload\.request\.channels/, "must not forward email/instagram");
});

test("early channel prune runs BEFORE upsert and BEFORE enrichment is enqueued", () => {
  const prune = idx("evaluateEarlyChannelPrune(lead, requestedChannels)");
  const upsert = idx("const businessId = await upsertBusinessFromEngineLead(");
  const enqueue = idx('await enqueueBusinessProcessing(businessId, "enrich")');
  const deliver = idx(/const delivery = await deliverLead\(/);
  assert.ok(prune !== -1 && upsert !== -1 && enqueue !== -1 && deliver !== -1);
  assert.ok(prune < upsert, "prune must precede upsert");
  assert.ok(prune < enqueue, "prune must precede enrichment scheduling");
  assert.ok(upsert < deliver);
});

test("existing validation (closed/disqualified) still precedes the early prune", () => {
  assert.ok(idx("validateDiscoveryCandidate(lead);") < idx("evaluateEarlyChannelPrune(lead, requestedChannels)"));
});

test("the old post-enqueue Maps channel gate is gone (no double evaluation / double counting)", () => {
  assert.doesNotMatch(plan, /channelsSatisfied\(lead, mapsCheckableChannels\)/);
  assert.equal(plan.split("maps_channel_gate").length - 1, 0, "reason string now comes from earlyPrune.ts only");
});

test("a pruned candidate exits via `continue` before any upsert / enqueue / deliverLead (=> no credit reserved, no enrichment job)", () => {
  const start = idx("if (earlyPrune.prune) {");
  const end = plan.indexOf("continue;", start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const block = plan.slice(start, end);
  assert.doesNotMatch(block, /upsertBusinessFromEngineLead\(/);
  assert.doesNotMatch(block, /enqueueBusinessProcessing\(/);
  assert.doesNotMatch(block, /ensureEnriched\(/);
  assert.doesNotMatch(block, /deliverLead\(/);
  assert.doesNotMatch(block, /accepted \+= 1/);
  assert.doesNotMatch(block, /duplicates \+= 1/);
});

test("a pruned candidate emits exactly ONE terminal event and is counted ONCE as rejected", () => {
  const start = idx("if (earlyPrune.prune) {");
  const end = plan.indexOf("continue;", start);
  const block = plan.slice(start, end);
  assert.equal(block.split("candidateRejectedEvent(").length - 1, 1);
  assert.equal(block.split("rejected += 1").length - 1, 1);
});

test("credits are only ever reserved inside deliverLead, which the prune path never reaches", () => {
  const code = plan.split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
  assert.doesNotMatch(code, /insertLeadForUser\(|reserveUsage\(|credit_charged/, "plan job must not charge credits itself (comments excluded)");
});

test("prune telemetry logs channel counts only — no candidate name/phone/website", () => {
  const start = idx("[discoveryPlanJob] early_prune");
  assert.notEqual(start, -1);
  const line = plan.slice(start, start + 260);
  assert.doesNotMatch(line, /lead\.|\.name|\.phone|\.website|\.email/);
  assert.match(line, /by_channel=/);
});

test("the legacy discoverJob path is untouched by this change", () => {
  const legacy = read("../../jobs/discoverJob.ts");
  assert.doesNotMatch(legacy, /earlyPrune|evaluateEarlyChannelPrune|engineRequiredChannels/);
});
