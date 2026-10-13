import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  resolveTrustPanelState,
  getFieldTrustEntry,
  formatVerificationLine,
  resolveDisqualificationDisplay,
  resolveScoreDisplay,
  resolveContactVerificationBadge,
} from "../trustPanel.js";
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

describe("Trust panel — resolveScoreDisplay", () => {
  it("uses the genuine stored score and derives honest levels", () => {
    const high = resolveScoreDisplay(92);
    assert.equal(high.isScored, true);
    assert.equal(high.score, 92);
    assert.equal(high.level, "High Opportunity");
    assert.equal(high.label, "92");

    const medium = resolveScoreDisplay(65.4);
    assert.equal(medium.isScored, true);
    assert.equal(medium.score, 65);
    assert.equal(medium.level, "Medium Opportunity");
    assert.equal(medium.label, "65");

    const low = resolveScoreDisplay(40);
    assert.equal(low.isScored, true);
    assert.equal(low.score, 40);
    assert.equal(low.level, "Opportunity");
    assert.equal(low.label, "40");
  });

  it("displays an honest unscored state when no real score exists, never inventing numbers from priority", () => {
    const nullScore = resolveScoreDisplay(null);
    assert.equal(nullScore.isScored, false);
    assert.equal(nullScore.score, null);
    assert.equal(nullScore.level, "Unscored");
    assert.equal(nullScore.label, "—");

    const undefinedScore = resolveScoreDisplay(undefined);
    assert.equal(undefinedScore.isScored, false);
    assert.equal(undefinedScore.score, null);
    assert.equal(undefinedScore.level, "Unscored");
    assert.equal(undefinedScore.label, "—");
  });
});

describe("Trust panel — resolveContactVerificationBadge", () => {
  it("marks a contact as Verified only when a genuine trust entry confirms it with confidence >= 0.7", () => {
    const verifiedEntry: FieldTrustEntry = {
      value: "hello@example.com",
      source: "Google Business",
      method: "google_business",
      confidence: 0.95,
      verifiedAt: "2026-03-01T00:00:00.000Z",
    };
    const result = resolveContactVerificationBadge("hello@example.com", verifiedEntry);
    assert.deepEqual(result, { label: "Verified", status: "verified" });
  });

  it("does not label contact as Verified merely because a value exists", () => {
    const unverified = resolveContactVerificationBadge("hello@example.com", null);
    assert.deepEqual(unverified, { label: "Available", status: "available" });

    const lowConfidenceEntry: FieldTrustEntry = {
      value: "hello@example.com",
      source: "Web crawl",
      method: "website_crawl",
      confidence: 0.3,
      verifiedAt: "2026-03-01T00:00:00.000Z",
    };
    const lowConfResult = resolveContactVerificationBadge("hello@example.com", lowConfidenceEntry);
    assert.deepEqual(lowConfResult, { label: "Available", status: "available" });
  });

  it("marks empty or absent contacts as Missing", () => {
    assert.deepEqual(resolveContactVerificationBadge(null), { label: "Missing", status: "missing" });
    assert.deepEqual(resolveContactVerificationBadge(undefined), { label: "Missing", status: "missing" });
    assert.deepEqual(resolveContactVerificationBadge(""), { label: "Missing", status: "missing" });
    assert.deepEqual(resolveContactVerificationBadge("   "), { label: "Missing", status: "missing" });
  });
});
