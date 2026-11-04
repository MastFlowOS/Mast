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
  const upsertCallIndex = discoveryPlanJobSrc.search(/(?:const\s+)?businessId\s*=\s*await\s+upsertBusinessFromEngineLead\(/);
  // The delivered lead is the engine lead merged with the enriched channels
  // (`deliverable`), so accept either binding name — the ORDER is what matters.
  const deliverCallIndex = discoveryPlanJobSrc.search(/(?:const\s+)?delivery\s*=\s*await\s+deliverLead\((?:lead|deliverable), \{/);

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

import { deriveWebsiteReachable } from "../../lib/reachability.js";
import { channelsSatisfied, mergeEnrichedChannels } from "../../lib/channelFilter.js";

test("discoveryPlanJob.ts uses deriveWebsiteReachable for post-enrichment reachability", () => {
  assert.match(
    discoveryPlanJobSrc,
    /const websiteReachable = deriveWebsiteReachable\(/,
    "discoveryPlanJob.ts must derive websiteReachable via deriveWebsiteReachable()",
  );
  assert.equal(deriveWebsiteReachable({ website_reachable: true }), true);
  assert.equal(deriveWebsiteReachable({ website_reachable: false }), false);
  assert.equal(deriveWebsiteReachable({ contact_audit: { homepage_fetch_failed: false } }), true);
  assert.equal(deriveWebsiteReachable({ contact_audit: { homepage_fetch_failed: true } }), false);
  assert.equal(deriveWebsiteReachable({}), undefined);
  assert.equal(deriveWebsiteReachable(undefined), undefined);
  assert.equal(deriveWebsiteReachable({ contact_audit: {} }), undefined);
  assert.equal(deriveWebsiteReachable({ website: "https://example.com", signals: {} }), undefined);
  assert.equal(
    deriveWebsiteReachable({ website_reachable: false, contact_audit: { homepage_fetch_failed: false } }),
    false,
  );
  assert.equal(
    deriveWebsiteReachable({ website_reachable: true, contact_audit: { homepage_fetch_failed: true } }),
    true,
  );
});

test("post-enrichment deliverable preserves derived website_reachable alongside channel satisfaction", () => {
  const baseLead = {
    name: "Test Cafe",
    place_id: "0x89c2590014a48ff9:0x34466e9af9759422",
    website: "https://testcafe.example.com",
  };
  const enrichedUnreachable = {
    email: null,
    phone: "+12125550199",
    instagram: null,
    website: "https://testcafe.example.com",
    signals: { contact_audit: { homepage_fetch_failed: true } },
  };
  const reachableFalse = deriveWebsiteReachable(enrichedUnreachable.signals);
  assert.equal(reachableFalse, false);
  const deliverableUnreachable = {
    ...mergeEnrichedChannels(baseLead as any, enrichedUnreachable),
    ...(reachableFalse !== undefined ? { website_reachable: reachableFalse } : {}),
  };
  assert.equal(deliverableUnreachable.website_reachable, false);
  assert.equal(
    channelsSatisfied(deliverableUnreachable as any, ["phone", "email", "instagram"]),
    false,
    "candidate missing email and instagram must be rejected by strict AND channel gate",
  );
});
