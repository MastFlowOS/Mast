import test from "node:test";
import assert from "node:assert/strict";
import { validateDiscoveryCandidate } from "../candidatePipeline.js";
import { getCandidateFunnelTracker, clearCandidateFunnelTracker } from "../candidateFunnelTelemetry.js";
import type { EngineLead } from "../../scraperBridge/pythonBridge.js";

function baseLead(overrides: Partial<EngineLead> = {}): EngineLead {
  return {
    name: "Liam's Cafe",
    address: "1604 Williamsbridge Rd, Bronx, NY 10461",
    city: "New York",
    country: "US",
    query: "cafe the bronx",
    region: "NY",
    phone: "(929) 643-7593",
    email: "",
    website: "https://www.instagram.com/liams_cafe",
    instagram: "",
    facebook: "",
    linkedin: "",
    contact_form: "",
    maps_link: "https://www.google.com/maps/place/Liam's+Cafe/@40.8472955,-73.8490123",
    rating: 4.9,
    reviews: 196,
    category: "Cafe",
    price_range: "$",
    has_photos: true,
    has_popular_times: false,
    owner_responds_to_reviews: false,
    is_google_verified: true,
    multi_location: false,
    closed: false,
    ig_followers: null,
    ig_bio: "",
    ig_activity: "",
    ig_last_post_days: null,
    ig_legitimacy: 0,
    tech_stack: {},
    score: 80,
    quality: "high",
    tier: "tier_1",
    action: "contact",
    fingerprints: ["place:0x89c2f500322e9c67:0x2f8e74ea9cd25ee7"],
    is_disqualified: false,
    ...overrides,
  };
}

test("validateDiscoveryCandidate accepts canonical Google Maps link with phone and instagram website", () => {
  const lead = baseLead();
  const res = validateDiscoveryCandidate(lead);
  assert.equal(res.valid, true);
  assert.equal(lead.instagram, "https://www.instagram.com/liams_cafe");
});

test("validateDiscoveryCandidate accepts maps_url contract fallback when maps_link is undefined", () => {
  const lead = baseLead({ maps_link: undefined as any });
  (lead as any).maps_url = "https://www.google.com/maps/place/Liam's+Cafe";
  const res = validateDiscoveryCandidate(lead);
  assert.equal(res.valid, true);
  assert.equal(lead.maps_link, "https://www.google.com/maps/place/Liam's+Cafe");
});

test("validateDiscoveryCandidate accepts place_id provenance when maps_link is missing", () => {
  const lead = baseLead({ maps_link: "" });
  (lead as any).place_id = "0x89c2f500322e9c67:0x2f8e74ea9cd25ee7";
  const res = validateDiscoveryCandidate(lead);
  assert.equal(res.valid, true);
  assert.match(lead.maps_link, /google\.com\/maps\/place\/\?q=place_id:/);
});

test("validateDiscoveryCandidate normalizes website missing protocol", () => {
  const lead = baseLead({ website: "liamscafe.com" });
  const res = validateDiscoveryCandidate(lead);
  assert.equal(res.valid, true);
  assert.equal(lead.website, "https://liamscafe.com");
});

test("validateDiscoveryCandidate normalizes raw instagram domain website and sets instagram field", () => {
  const lead = baseLead({ website: "instagram.com/liams_cafe", instagram: "" });
  const res = validateDiscoveryCandidate(lead);
  assert.equal(res.valid, true);
  assert.equal(lead.website, "https://instagram.com/liams_cafe");
  assert.equal(lead.instagram, "https://instagram.com/liams_cafe");
});

test("validateDiscoveryCandidate sanitizes malformed website without discarding lead when valid phone exists", () => {
  const lead = baseLead({ website: "not a valid website url!!!" });
  const res = validateDiscoveryCandidate(lead);
  assert.equal(res.valid, true);
  assert.equal(lead.website, ""); // sanitized in place
  assert.equal(lead.phone, "(929) 643-7593");
});

test("validateDiscoveryCandidate rejects missing name", () => {
  const lead = baseLead({ name: "" });
  const res = validateDiscoveryCandidate(lead);
  assert.equal(res.valid, false);
  if (!res.valid) {
    assert.equal(res.reason, "missing_name");
  }
});

test("validateDiscoveryCandidate rejects missing address", () => {
  const lead = baseLead({ address: "   " });
  const res = validateDiscoveryCandidate(lead);
  assert.equal(res.valid, false);
  if (!res.valid) {
    assert.equal(res.reason, "missing_address");
  }
});

test("validateDiscoveryCandidate rejects missing maps provenance when no link or place_id is given", () => {
  const lead = baseLead({ maps_link: "", fingerprints: [] });
  const res = validateDiscoveryCandidate(lead);
  assert.equal(res.valid, false);
  if (!res.valid) {
    assert.equal(res.reason, "missing_maps_provenance");
  }
});

test("validateDiscoveryCandidate rejects permanently closed businesses", () => {
  const lead = baseLead({ closed: true });
  const res = validateDiscoveryCandidate(lead);
  assert.equal(res.valid, false);
  if (!res.valid) {
    assert.equal(res.reason, "disqualified");
  }
});

test("validateDiscoveryCandidate rejects when genuinely no contact channel exists", () => {
  const lead = baseLead({ phone: "", website: "", email: "", instagram: "" });
  const res = validateDiscoveryCandidate(lead);
  assert.equal(res.valid, false);
  if (!res.valid) {
    assert.equal(res.reason, "no_usable_channel");
  }
});

test("candidateFunnelTelemetry preserves validateDiscoveryCandidate subreason in telemetry and logs", () => {
  const planId = `test-telemetry-plan-${Date.now()}`;
  clearCandidateFunnelTracker(planId);
  const funnel = getCandidateFunnelTracker(planId);

  funnel.recordQualityRejection("validateDiscoveryCandidate:missing_maps_provenance", "pid-1");
  funnel.recordQualityRejection("validateDiscoveryCandidate:no_usable_channel", "pid-2");
  funnel.recordQualityRejection("outside_geographic_scope:street=Main St", "pid-3");

  const snapshot = funnel.getSnapshot();
  assert.equal(snapshot.breakdowns.qualityRejectionsByReason["validateDiscoveryCandidate:missing_maps_provenance"], 1);
  assert.equal(snapshot.breakdowns.qualityRejectionsByReason["validateDiscoveryCandidate:no_usable_channel"], 1);
  assert.equal(snapshot.breakdowns.qualityRejectionsByReason["outside_geographic_scope"], 1);
});
