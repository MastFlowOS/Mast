/**
 * CRITMODE — Disqualified Lead Delivery / Credit Leak (poolExpandJob.ts).
 *
 * CONFIRMED BUG: poolExpandJob.ts's single `processLead()` helper (shared
 * by every delivery path in this file — legacy sequential, curated-area
 * pool, and street-pooled) ran `channelsSatisfied()` and `validateLead()`
 * on every engine lead before calling `deliverLead()`, but never checked
 * `lead.is_disqualified` — so a disqualified business could still reach
 * `deliverLead()` -> `insertLeadForUser()` -> `try_increment_lead_usage()`
 * -> `claim_discovery_delivery()`, consuming a `discoveryPlanId` delivery
 * slot, incrementing `results_count` / `newForUser`, and charging the
 * user's daily/monthly credit.
 *
 * Like poolExpandJobUserScopedDedup.test.ts (this repo's own precedent for
 * this file — heavily entangled with Supabase/the browser-slot semaphore/
 * the real Python subprocess bridge, not an independently callable unit),
 * this pins the guarantee directly against the source: it asserts the
 * `is_disqualified` gate exists inside `processLead()`, runs strictly
 * before the `deliverLead(` call, and returns `"continue"` without any
 * accounting side effect.
 *
 * Because `processLead()` is the SINGLE choke point every poolExpandJob
 * delivery path (legacy, curated-area pool, street pool) routes through,
 * gating it here closes the leak for all of them at once — this test
 * would FAIL if the gate were ever removed, moved to run AFTER
 * `deliverLead()`, or changed to still count the candidate as delivered.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const poolExpandJobSrc = readFileSync(path.join(__dirname, "../poolExpandJob.ts"), "utf8");

function extractProcessLeadBody(src: string): string {
  const start = src.indexOf("async function processLead(");
  assert.notEqual(start, -1, "expected to find processLead() in poolExpandJob.ts");
  // processLead() is immediately followed by runGoogleAreaPoolForCity() —
  // use that function's declaration as the end boundary (line-ending
  // agnostic, unlike matching a specific comment block).
  const end = src.indexOf("async function runGoogleAreaPoolForCity(", start);
  assert.notEqual(end, -1, "expected to find the end boundary of processLead() (start of runGoogleAreaPoolForCity)");
  assert.ok(end > start, "runGoogleAreaPoolForCity must be declared after processLead()");
  return src.slice(start, end);
}

test("poolExpandJob.ts's processLead() checks lead.is_disqualified before calling deliverLead(", () => {
  const body = extractProcessLeadBody(poolExpandJobSrc);

  const disqualifiedGateIndex = body.indexOf("if (lead.is_disqualified)");
  assert.notEqual(
    disqualifiedGateIndex,
    -1,
    "expected processLead() to gate on lead.is_disqualified — this is the exact leak: disqualified leads " +
      "could reach deliverLead() uncaught via any of this file's delivery paths",
  );

  const deliverLeadCallIndex = body.indexOf("result = await deliverLead(");
  assert.notEqual(deliverLeadCallIndex, -1, "expected to find the deliverLead() call site inside processLead()");

  assert.ok(
    disqualifiedGateIndex < deliverLeadCallIndex,
    "the lead.is_disqualified gate must run BEFORE deliverLead() is called",
  );
});

test("the disqualified branch in processLead() returns 'continue' without calling deliverLead or touching accounting counters", () => {
  const body = extractProcessLeadBody(poolExpandJobSrc);
  const gateStart = body.indexOf("if (lead.is_disqualified)");
  assert.notEqual(gateStart, -1, "gate not found");

  const blockEnd = body.indexOf('return "continue"; // not counted, keep streaming', gateStart);
  assert.notEqual(blockEnd, -1, "expected the disqualified branch to return \"continue\" explicitly documented as not counted");
  const block = body.slice(gateStart, blockEnd);

  assert.doesNotMatch(block, /deliverLead\(/, "disqualified branch must never call deliverLead()");
  assert.doesNotMatch(block, /delivered \+= 1/, "disqualified branch must never increment `delivered`");
  assert.doesNotMatch(block, /newForUser \+= 1/, "disqualified branch must never increment `newForUser`");
  assert.doesNotMatch(block, /bumpResultsCount\(/, "disqualified branch must never bump results_count");
});

test("channelsSatisfied() and validateLead() gates are preserved unchanged ahead of the new disqualified gate", () => {
  const body = extractProcessLeadBody(poolExpandJobSrc);

  const channelGateIndex = body.indexOf("if (followUp && !channelsSatisfied(lead, followUp.channels))");
  const validationGateIndex = body.indexOf("const validation = validateLead(lead);");
  const disqualifiedGateIndex = body.indexOf("if (lead.is_disqualified)");
  const deliverLeadCallIndex = body.indexOf("result = await deliverLead(");

  assert.notEqual(channelGateIndex, -1);
  assert.notEqual(validationGateIndex, -1);
  assert.notEqual(disqualifiedGateIndex, -1);
  assert.notEqual(deliverLeadCallIndex, -1);

  assert.ok(channelGateIndex < validationGateIndex, "channel gate must still run before validation");
  assert.ok(validationGateIndex < disqualifiedGateIndex, "validation must still run before the new disqualification gate");
  assert.ok(disqualifiedGateIndex < deliverLeadCallIndex, "disqualification gate must run before deliverLead()");
});

test("processLead() is the single delivery choke point — only one actual deliverLead(...) call site exists in poolExpandJob.ts", () => {
  // Confirms the fix inside processLead() actually covers every delivery
  // path in this file (legacy sequential, curated-area pool, street pool)
  // rather than needing to be duplicated elsewhere. Matches only real call
  // expressions (`= await deliverLead(` / `of deliverLead(`), not the
  // several prose mentions of "deliverLead()" in comments throughout this
  // file.
  const matches = poolExpandJobSrc.match(/(?:=\s*await\s+|of\s+)deliverLead\(/g) ?? [];
  assert.equal(
    matches.length,
    1,
    "expected exactly one deliverLead(...) call site in poolExpandJob.ts (inside processLead()) — if this " +
      "count changes, the new call site needs its own is_disqualified gate too",
  );
});
