/**
 * Live Discovery quality gate wiring (rating / review count).
 *
 * handleDiscoveryTask needs a database, a Python subprocess and a job queue,
 * so — like liveDiscoveryEarlyPruneWiring.test.ts and
 * discoveryPlanJobDisqualifiedGate.test.ts — ORDER is asserted against the
 * source. The verdict logic itself is covered behaviorally in
 * src/lib/__tests__/leadQualityPolicy.test.ts.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const src = readFileSync(path.join(here, "../../jobs/discoveryPlanJob.ts"), "utf8").replace(/\r\n/g, "\n");
const loop = src.slice(src.indexOf("const validation = validateDiscoveryCandidate(lead);"));
const at = (needle: string) => {
  const i = loop.indexOf(needle);
  assert.notEqual(i, -1, `expected to find ${needle} in the discovery loop`);
  return i;
};

test("the quality gate evaluates the engine lead's rating/reviews fields", () => {
  assert.match(src, /evaluateLeadQuality\(\{ rating: lead\.rating, reviews: lead\.reviews \}\)/);
});

test("quality gate runs after existing validation and BEFORE upsert, enrichment, and delivery", () => {
  const gate = at("evaluateLeadQuality(");
  assert.ok(at("validateDiscoveryCandidate(lead)") < gate, "existing validation still runs first");
  assert.ok(gate < at("upsertBusinessFromEngineLead("), "no DB write for a rejected candidate");
  assert.ok(gate < at('enqueueBusinessProcessing(businessId, "enrich")'), "no enrichment scheduled for a rejected candidate");
  assert.ok(gate < at("ensureEnriched(businessId)"), "no synchronous enrichment for a rejected candidate");
  assert.ok(gate < at("deliverLead(deliverable"), "no delivery for a rejected candidate");
});

test("a rejected candidate is counted, traced, reported as candidate_rejected, and skipped (continue)", () => {
  const start = at("if (quality.reject) {");
  const body = loop.slice(start, loop.indexOf("\n    }\n", start));
  assert.match(body, /rejected \+= 1/);
  assert.match(body, /candidateRejectedEvent\(payload\.planId, effectiveScoutId, pid, quality\.reason, areaLabel\)/);
  assert.match(body, /continue;/);
  assert.doesNotMatch(body, /upsertBusinessFromEngineLead|deliverLead|enqueueBusinessProcessing/);
});

test("existing checks are preserved: disqualification, channel early prune, post-enrichment channel gate", () => {
  assert.match(src, /lead\.closed \|\| lead\.is_disqualified/);
  assert.match(src, /evaluateEarlyChannelPrune\(lead, requestedChannels\)/);
  assert.match(src, /channelsSatisfied\(enriched, requestedChannels\)/);
  assert.match(src, /requiredChannels: engineRequiredChannels\(payload\.request\.channels\)/);
});

test("the live gate does not read the results-card key or the HTTP request (thresholds stay server-side)", () => {
  assert.doesNotMatch(src, /lead\.review_count/);
  assert.doesNotMatch(src, /payload\.request\.(minRating|minReviews)/);
});
