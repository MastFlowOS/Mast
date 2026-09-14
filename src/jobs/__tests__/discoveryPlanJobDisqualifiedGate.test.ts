/**
 * CRITMODE — regression guard for the EXISTING safe path.
 *
 * discoveryPlanJob.ts's validateDiscoveryCandidate() already correctly
 * rejects `lead.is_disqualified` (and `lead.closed`) before a candidate is
 * upserted into `businesses` or handed to deliverLead() — this file is the
 * reference implementation the discoverJob.ts / poolExpandJob.ts fixes
 * were modeled on. This test only pins that the reference itself was not
 * regressed while making those fixes.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const discoveryPlanJobSrc = readFileSync(path.join(__dirname, "../discoveryPlanJob.ts"), "utf8");

test("discoveryPlanJob.ts's validateDiscoveryCandidate() still rejects lead.is_disqualified", () => {
  const fnStart = discoveryPlanJobSrc.indexOf("function validateDiscoveryCandidate(");
  assert.notEqual(fnStart, -1, "expected to find validateDiscoveryCandidate() in discoveryPlanJob.ts");
  const fnBody = discoveryPlanJobSrc.slice(fnStart, fnStart + 800);

  assert.match(
    fnBody,
    /if \(lead\.closed \|\| lead\.is_disqualified\) return \{ valid: false, reason: "disqualified" \};/,
    "the existing disqualification guard in validateDiscoveryCandidate() must be preserved unchanged",
  );
});

test("validateDiscoveryCandidate() still runs before upsertBusinessFromEngineLead() and deliverLead() in the main loop", () => {
  const validationCallIndex = discoveryPlanJobSrc.indexOf("const validation = validateDiscoveryCandidate(lead);");
  const upsertCallIndex = discoveryPlanJobSrc.indexOf("const businessId = await upsertBusinessFromEngineLead(");
  const deliverCallIndex = discoveryPlanJobSrc.indexOf("const delivery = await deliverLead(lead, {");

  assert.notEqual(validationCallIndex, -1);
  assert.notEqual(upsertCallIndex, -1);
  assert.notEqual(deliverCallIndex, -1);

  assert.ok(validationCallIndex < upsertCallIndex, "disqualification check must still run before the business is even upserted");
  assert.ok(upsertCallIndex < deliverCallIndex, "business upsert must still happen before deliverLead()");
});

test("a rejected (disqualified) candidate still hits `continue` before reaching upsert/deliver — no accounting side effects", () => {
  const validationCallIndex = discoveryPlanJobSrc.indexOf("const validation = validateDiscoveryCandidate(lead);");
  const rejectionBlockEnd = discoveryPlanJobSrc.indexOf("continue;", validationCallIndex);
  assert.notEqual(rejectionBlockEnd, -1);
  const block = discoveryPlanJobSrc.slice(validationCallIndex, rejectionBlockEnd);

  assert.doesNotMatch(block, /upsertBusinessFromEngineLead\(/, "rejected candidates must never be upserted");
  assert.doesNotMatch(block, /deliverLead\(/, "rejected candidates must never reach deliverLead()");
  assert.doesNotMatch(block, /accepted \+= 1/, "rejected candidates must never increment `accepted`");
});
