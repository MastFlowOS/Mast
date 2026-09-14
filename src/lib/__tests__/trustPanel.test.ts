import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveTrustPanelState, getFieldTrustEntry, formatVerificationLine, resolveDisqualificationDisplay } from "../trustPanel.js";
import type { LeadTrust, FieldTrustEntry } from "../api.js";

describe("Trust panel — resolveTrustPanelState", () => {
  it("shows loading while the query is in flight, regardless of stale data/error", () => {
    assert.equal(resolveTrustPanelState({ isLoading: true, isError: false, data: undefined }), "loading");
    assert.equal(resolveTrustPanelState({ isLoading: true, isError: true, data: undefined }), "loading");
  });

  it("shows a non-destructive error state on request failure", () => {
    assert.equal(resolveTrustPanelState({ isLoading: false, isError: true, data: undefined }), "error");
  });

  it("shows an honest empty state when there's no trust data, never a fabricated score", () => {
    assert.equal(resolveTrustPanelState({ isLoading: false, isError: false, data: undefined }), "empty");
    assert.equal(resolveTrustPanelState({ isLoading: false, isError: false, data: null }), "empty");
  });

  it("renders the panel once real data has arrived", () => {
    const data = { overallConfidence: 80, lastVerifiedAt: null, lastVerificationKind: null, fieldTrust: {}, contacts: { emails: [], phones: [], linkedin: null }, businessHealth: null, isDisqualified: false, disqualifyReason: null } satisfies LeadTrust;
    assert.equal(resolveTrustPanelState({ isLoading: false, isError: false, data }), "data");
  });
});

describe("Trust panel — getFieldTrustEntry", () => {
  const entry: FieldTrustEntry = { value: "hello@example.com", source: "Google Business", method: "google_business", confidence: 95, verifiedAt: "2026-01-01T00:00:00.000Z" };

  it("returns the entry for a field that has provenance", () => {
    assert.deepEqual(getFieldTrustEntry({ email: entry }, "email"), entry);
  });

  it("returns undefined (not a fabricated value) for a field with no provenance", () => {
    assert.equal(getFieldTrustEntry({ email: entry }, "instagram"), undefined);
  });

  it("handles missing/null fieldTrust maps without throwing", () => {
    assert.equal(getFieldTrustEntry(undefined, "email"), undefined);
    assert.equal(getFieldTrustEntry(null, "email"), undefined);
  });
});

describe("Trust panel — formatVerificationLine", () => {
  it("returns null when there's nothing to show, rather than guessing", () => {
    assert.equal(formatVerificationLine(null, null), null);
    assert.equal(formatVerificationLine(undefined, undefined), null);
  });

  it("formats date + kind when both are present", () => {
    const line = formatVerificationLine("2026-03-15T00:00:00.000Z", "website_crawl");
    assert.match(line!, /2026/);
    assert.match(line!, /website_crawl/);
  });

  it("falls back to 'Unknown date' when only the kind is present", () => {
    const line = formatVerificationLine(null, "website_crawl");
    assert.equal(line, "Unknown date · website_crawl");
  });

  it("shows just the date when only the date is present", () => {
    const line = formatVerificationLine("2026-03-15T00:00:00.000Z", null);
    assert.doesNotMatch(line!, /·/);
  });
});

describe("Trust panel — resolveDisqualificationDisplay", () => {
  it("renders the exact stored reason for a disqualified business", () => {
    const display = resolveDisqualificationDisplay({ isDisqualified: true, disqualifyReason: "Chain business" });
    assert.deepEqual(display, { label: "Disqualified", reason: "Chain business" });
  });

  it("falls back to an honest 'Reason unavailable' label when no reason is stored, never fabricating one", () => {
    assert.deepEqual(resolveDisqualificationDisplay({ isDisqualified: true, disqualifyReason: null }), { label: "Disqualified", reason: "Reason unavailable" });
    assert.deepEqual(resolveDisqualificationDisplay({ isDisqualified: true, disqualifyReason: "" }), { label: "Disqualified", reason: "Reason unavailable" });
    assert.deepEqual(resolveDisqualificationDisplay({ isDisqualified: true, disqualifyReason: "   " }), { label: "Disqualified", reason: "Reason unavailable" });
  });

  it("shows nothing for a non-disqualified business — no scary warning in the normal case", () => {
    assert.equal(resolveDisqualificationDisplay({ isDisqualified: false, disqualifyReason: null }), null);
    assert.equal(resolveDisqualificationDisplay({ isDisqualified: false, disqualifyReason: "Chain business" }), null);
  });

  it("handles missing/null trust data without throwing", () => {
    assert.equal(resolveDisqualificationDisplay(undefined), null);
    assert.equal(resolveDisqualificationDisplay(null), null);
  });
});
