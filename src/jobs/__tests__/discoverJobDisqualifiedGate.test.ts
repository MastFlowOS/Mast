/**
 * CRITMODE — Disqualified Lead Delivery / Credit Leak (discoverJob.ts).
 *
 * CONFIRMED BUG: discoverJob.ts's main delivery loop ran
 * `channelsSatisfied()` and `validateLead()` on every engine lead before
 * calling `deliverLead()`, but never checked `lead.is_disqualified` — so a
 * disqualified business (`is_disqualified === true`) could still:
 *   - be delivered into the user's CRM (`leads` row inserted)
 *   - increment `results_count` / `newForUser`
 *   - consume a daily/monthly lead credit via `try_increment_lead_usage()`
 *
 * `discoveryPlanJob.ts`'s `validateDiscoveryCandidate()` already had the
 * correct gate (`if (lead.closed || lead.is_disqualified) return { valid:
 * false, reason: "disqualified" }`) run BEFORE any delivery/accounting
 * path — this file was missing the equivalent check entirely.
 *
 * Like poolExpandJobUserScopedDedup.test.ts (this repo's own precedent for
 * these heavily entangled orchestration files — real Supabase/Python
 * subprocess dependencies throughout, not independently callable units),
 * this pins the guarantee directly against the source: it asserts the
 * `is_disqualified` gate exists, runs strictly before the `deliverLead(`
 * call, and results in `continue` (never counted) rather than any
 * accounting side effect.
 *
 * This test would FAIL if the gate is ever removed, moved to run AFTER
 * `deliverLead()`, or changed to still count the candidate as
 * delivered/new — i.e. exactly the confirmed regression.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const discoverJobSrc = readFileSync(path.join(__dirname, "../discoverJob.ts"), "utf8");

test("discoverJob.ts checks lead.is_disqualified before calling deliverLead(", () => {
  const disqualifiedGateIndex = discoverJobSrc.indexOf("if (lead.is_disqualified)");
  assert.notEqual(
    disqualifiedGateIndex,
    -1,
    "expected discoverJob.ts's main delivery loop to gate on lead.is_disqualified — this is the exact leak: " +
      "disqualified leads could reach deliverLead() uncaught",
  );

  const deliverLeadCallIndex = discoverJobSrc.indexOf("result = await deliverLead(");
  assert.notEqual(deliverLeadCallIndex, -1, "expected to find the deliverLead() call site in discoverJob.ts");

  assert.ok(
    disqualifiedGateIndex < deliverLeadCallIndex,
    "the lead.is_disqualified gate must run BEFORE deliverLead() is called — a gate placed after delivery " +
      "does not prevent the CRM row / credit consumption / target increment",
  );
});

test("the disqualified branch in discoverJob.ts does not call deliverLead and does not count toward delivered/newForUser", () => {
  const gateStart = discoverJobSrc.indexOf("if (lead.is_disqualified)");
  assert.notEqual(gateStart, -1, "gate not found");
  // The gate's own block — up to its closing `continue;` — should contain
  // no delivery or accounting side effects.
  const blockEnd = discoverJobSrc.indexOf("continue; // not counted, keep streaming", gateStart);
  assert.notEqual(blockEnd, -1, "expected the disqualified branch to end in a `continue` that is explicitly documented as not counted");
  const block = discoverJobSrc.slice(gateStart, blockEnd);

  assert.doesNotMatch(block, /deliverLead\(/, "disqualified branch must never call deliverLead()");
  assert.doesNotMatch(block, /delivered \+= 1/, "disqualified branch must never increment `delivered`");
  assert.doesNotMatch(block, /newForUser \+= 1/, "disqualified branch must never increment `newForUser`");
});

test("channelsSatisfied() and validateLead() gates are preserved unchanged ahead of the new disqualified gate", () => {
  // Regression guard for the "preserve existing behavior for every
  // non-disqualified lead" requirement — the two pre-existing gates must
  // still both run, and still run BEFORE the new one (order: channel gate
  // -> validation -> disqualification -> deliverLead).
  const channelGateIndex = discoverJobSrc.indexOf("if (!channelsSatisfied(lead, payload.channels))");
  const validationGateIndex = discoverJobSrc.indexOf("const validation = validateLead(lead);");
  const disqualifiedGateIndex = discoverJobSrc.indexOf("if (lead.is_disqualified)");
  const deliverLeadCallIndex = discoverJobSrc.indexOf("result = await deliverLead(");

  assert.notEqual(channelGateIndex, -1);
  assert.notEqual(validationGateIndex, -1);
  assert.notEqual(disqualifiedGateIndex, -1);
  assert.notEqual(deliverLeadCallIndex, -1);

  assert.ok(channelGateIndex < validationGateIndex, "channel gate must still run before validation");
  assert.ok(validationGateIndex < disqualifiedGateIndex, "validation must still run before the new disqualification gate");
  assert.ok(disqualifiedGateIndex < deliverLeadCallIndex, "disqualification gate must run before deliverLead()");
});
