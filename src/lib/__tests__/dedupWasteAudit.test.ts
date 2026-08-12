/**
 * Phase 3C-4A — Early Dedup Audit instrumentation tests.
 *
 * Pure-logic tests for buildDedupWasteLogFields()/extractMapsPlaceId()/
 * logDedupWasteDecision(), matching the style of candidateBudget.test.ts
 * elsewhere in this directory: no Postgres/pg-boss/Supabase required, since
 * this module has no such dependency.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { buildDedupWasteLogFields, extractMapsPlaceId, logDedupWasteDecision } from "../dedupWasteAudit.js";

test("extractMapsPlaceId prefers a place: fingerprint over a map: fallback", () => {
  const id = extractMapsPlaceId(["ig:thecoffeespot", "place:chij123abc", "map:google.com/maps/foo"]);
  assert.equal(id, "chij123abc");
});

test("extractMapsPlaceId falls back to map: when no place: fingerprint exists", () => {
  const id = extractMapsPlaceId(["ig:thecoffeespot", "map:google.com/maps/foo"]);
  assert.equal(id, "google.com/maps/foo");
});

test("extractMapsPlaceId returns null when neither identity fingerprint is present", () => {
  const id = extractMapsPlaceId(["ig:thecoffeespot", "tel:3055551234"]);
  assert.equal(id, null);
});

test("buildDedupWasteLogFields marks all three enrichment stages complete when their fields are populated", () => {
  const fields = buildDedupWasteLogFields({
    scrapeJobId: "job-1",
    pipelineId: "#42",
    fingerprints: ["place:chij123abc", "web:thecoffeespot.com"],
    existingBusiness: true,
    website: "https://thecoffeespot.com",
    instagram: "thecoffeespot",
    email: "hello@thecoffeespot.com",
    phone: "3055551234",
  });

  assert.equal(fields.scrapeJobId, "job-1");
  assert.equal(fields.pipelineId, "#42");
  assert.equal(fields.mapsPlaceId, "chij123abc");
  assert.equal(fields.existingBusiness, true);
  assert.equal(fields.websiteEnrichmentCompleted, true);
  assert.equal(fields.instagramEnrichmentCompleted, true);
  assert.equal(fields.contactEnrichmentCompleted, true);
});

test("buildDedupWasteLogFields treats emails[]/phones[] as contact enrichment even with no single email/phone", () => {
  const fields = buildDedupWasteLogFields({
    fingerprints: [],
    existingBusiness: false,
    emails: [{ email: "hello@x.com", role: "general" }],
    phones: [],
  });

  assert.equal(fields.contactEnrichmentCompleted, true);
});

test("buildDedupWasteLogFields reads false for every enrichment stage when the lead has no such data at all", () => {
  const fields = buildDedupWasteLogFields({
    fingerprints: ["name:the coffee spot|miami"],
    existingBusiness: false,
  });

  assert.equal(fields.mapsPlaceId, null);
  assert.equal(fields.websiteEnrichmentCompleted, false);
  assert.equal(fields.instagramEnrichmentCompleted, false);
  assert.equal(fields.contactEnrichmentCompleted, false);
});

test("buildDedupWasteLogFields defaults scrapeJobId/pipelineId to null rather than undefined, so JSON.stringify always includes them", () => {
  const fields = buildDedupWasteLogFields({ fingerprints: [], existingBusiness: false });
  const json = JSON.stringify(fields);
  assert.match(json, /"scrapeJobId":null/);
  assert.match(json, /"pipelineId":null/);
});

test("logDedupWasteDecision never throws even if console.log is broken", () => {
  const original = console.log;
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  console.log = () => {
    throw new Error("stdout is broken");
  };
  try {
    assert.doesNotThrow(() =>
      logDedupWasteDecision(
        buildDedupWasteLogFields({ fingerprints: [], existingBusiness: false }),
      ),
    );
  } finally {
    console.log = original;
  }
});
