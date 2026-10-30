import test from "node:test";
import assert from "node:assert/strict";
import { evaluateEarlyChannelPrune, isChannelPotentiallySatisfiable } from "../earlyPrune.js";
import { channelsSatisfied, mergeEnrichedChannels } from "../../lib/channelFilter.js";
import { isValidEmail, isValidPhone, isValidWebsite, validateLead } from "../../lib/leadValidation.js";
import { expandPlaceIdForms, chijToHex, hexToChij, canonicalPlaceId } from "../../lib/placeId.js";
import { PROFESSION_SLUGS, PROFESSION_WEIGHTS } from "../../scoring/professionWeights.js";
import { evaluateServiceNeedGate, recordServiceNeedGateObservation } from "../serviceNeedGate.js";
import { getCandidateFunnelTracker, clearCandidateFunnelTracker } from "../candidateFunnelTelemetry.js";
import { processDiscoveredCandidate, type ProcessCandidateParams } from "../candidatePipeline.js";
import { getKnownPlaceIdsForTask } from "../../jobs/discoveryPlanJob.js";
import type { EngineLead } from "../../scraperBridge/pythonBridge.js";

function mockLead(overrides: Partial<EngineLead> = {}): EngineLead {
  return {
    name: "Dr. Smith Dental Clinic",
    address: "123 Main St, Springfield, IL",
    city: "Springfield",
    country: "US",
    query: "dentist springfield",
    region: "IL",
    phone: "",
    email: "",
    website: "",
    instagram: "",
    facebook: "",
    linkedin: "",
    contact_form: "",
    maps_link: "https://maps.google.com/?cid=12345",
    rating: 4.8,
    reviews: 25,
    category: "Dentist",
    price_range: "$$",
    has_photos: true,
    has_popular_times: false,
    owner_responds_to_reviews: true,
    is_google_verified: true,
    multi_location: false,
    closed: false,
    ig_followers: null,
    ig_bio: "",
    ig_activity: "",
    ig_last_post_days: null,
    ig_legitimacy: 0,
    tech_stack: {},
    score: 85,
    quality: "high",
    tier: "tier_1",
    action: "contact",
    fingerprints: ["place:0x880fcd7f8fee01b5:0x89b38e817d796008"],
    is_disqualified: false,
    ...overrides,
  };
}

function createMockDb(config: {
  leadsMaybeSingle?: (userId: string, businessId: string) => any;
  businessMaybeSingle?: (businessId: string) => any;
  knownPlaceIdsRange?: (from: number, to: number) => any;
}) {
  return {
    from: (table: string) => {
      const filters: Record<string, any> = {};
      const builder: any = {
        select: () => builder,
        eq: (col: string, val: any) => {
          filters[col] = val;
          return builder;
        },
        range: async (from: number, to: number) => {
          if (config.knownPlaceIdsRange) {
            return config.knownPlaceIdsRange(from, to);
          }
          return { data: [], error: null };
        },
        maybeSingle: async () => {
          if (table === "leads") {
            if (config.leadsMaybeSingle) {
              return config.leadsMaybeSingle(filters["user_id"], filters["business_id"]);
            }
            return { data: null, error: null };
          }
          if (table === "businesses") {
            if (config.businessMaybeSingle) {
              return config.businessMaybeSingle(filters["id"]);
            }
            return {
              data: {
                id: filters["id"],
                email: "drsmith@smithdental.com",
                phone: "+1 555 0199",
                website: "https://smithdental.com",
              },
              error: null,
            };
          }
          return { data: null, error: null };
        },
      };
      return builder;
    },
  };
}

// ── 1. Phase 1: Missing Maps phone does not cause premature rejection ─────────

test("Phase 1: Missing Maps phone with usable website does NOT trigger early prune", () => {
  const lead = mockLead({
    phone: "",
    website: "https://smithdental.example",
  });
  const decision = evaluateEarlyChannelPrune(lead, ["phone"]);
  assert.equal(decision.prune, false, "Must not prune when website can supply phone");
});

test("Phase 1: Missing Maps phone AND missing website triggers early prune", () => {
  const lead = mockLead({
    phone: "",
    website: "",
  });
  const decision = evaluateEarlyChannelPrune(lead, ["phone"]);
  assert.equal(decision.prune, true, "Must prune when no website and no phone");
  if (decision.prune) {
    assert.deepEqual(decision.missing, ["phone"]);
  }
});

test("Phase 1: Missing Maps phone + missing email with usable website does NOT trigger early prune", () => {
  const lead = mockLead({
    phone: "",
    email: "",
    website: "https://smithdental.example",
  });
  const decision = evaluateEarlyChannelPrune(lead, ["email", "phone"]);
  assert.equal(decision.prune, false, "Must allow enrichment to discover both channels");
});

test("Phase 1: Missing Maps phone + missing email with NO website triggers early prune", () => {
  const lead = mockLead({
    phone: "",
    email: "",
    website: "",
  });
  const decision = evaluateEarlyChannelPrune(lead, ["email", "phone"]);
  assert.equal(decision.prune, true);
  if (decision.prune) {
    assert.ok(decision.missing.includes("phone"));
    assert.ok(decision.missing.includes("email"));
  }
});

// ── 2. Phase 1: Final channel requirements remain strict (AND semantics) ──────

test("Phase 1: Final channel validation strictly enforces AND semantics", () => {
  const reqChannels = ["email", "phone"];

  // Case A: Has only phone -> NOT satisfied
  const phoneOnly = { phone: "+1 555 0100", email: null, website: "https://x.example" };
  assert.equal(channelsSatisfied(phoneOnly, reqChannels), false);

  // Case B: Has only email -> NOT satisfied
  const emailOnly = { phone: null, email: "contact@smithdental.example", website: "https://x.example" };
  assert.equal(channelsSatisfied(emailOnly, reqChannels), false);

  // Case C: Has both valid email and phone -> Satisfied
  const both = { phone: "+1 555 0100", email: "contact@smithdental.example", website: "https://x.example" };
  assert.equal(channelsSatisfied(both, reqChannels), true);
});

test("Phase 1: Lead fails post-enrichment validation when contact info cannot be obtained", () => {
  const validation = validateLead({
    name: "Uncontactable Business",
    email: "",
    phone: "",
    website: "",
    instagram: "",
  });
  assert.equal(validation.valid, false);
  assert.equal((validation as any).reason, "no_usable_channel");
});

// ── 3. Phase 1: Contact extraction formats and merging ─────────────────────────

test("Phase 1: Contact validation correctly recognizes valid phone, email, and website", () => {
  assert.equal(isValidPhone("+1 555-0199"), true);
  assert.equal(isValidPhone("123"), false);
  assert.equal(isValidEmail("office@smithdental.com"), true);
  assert.equal(isValidEmail("logo@2x.png"), false);
  assert.equal(isValidWebsite("https://smithdental.com"), true);
  assert.equal(isValidWebsite("not_a_website"), false);
});

test("Phase 1: mergeEnrichedChannels merges discovered channels without inventing data", () => {
  const original = mockLead({
    phone: "",
    website: "https://smithdental.com",
    email: "",
  });
  const enriched = {
    email: "drsmith@smithdental.com",
    phone: "+1 555 0188",
    website: "https://smithdental.com",
  };
  const merged = mergeEnrichedChannels(original, enriched);
  assert.equal(merged.email, "drsmith@smithdental.com");
  assert.equal(merged.phone, "+1 555 0188");
  assert.equal(merged.name, "Dr. Smith Dental Clinic", "Original fields preserved");
});

// ── 4. Phase 2: Eliminate user-level duplicates earlier ────────────────────────

test("Phase 2: Already-owned user lead is skipped early BEFORE enrichment in candidatePipeline", async () => {
  let enrichmentCalled = false;
  let deliveryCalled = false;

  const mockDb = createMockDb({
    leadsMaybeSingle: (userId, businessId) => {
      if (userId === "user-123" && businessId === "biz-456") {
        return { data: { id: "lead-existing-123" }, error: null };
      }
      return { data: null, error: null };
    },
  });

  const lead = mockLead({
    phone: "",
    website: "https://smithdental.example",
  });

  const result = await processDiscoveredCandidate(
    {
      lead,
      planId: "plan-test-1",
      effectiveScoutId: 1,
      requestedChannels: ["website"],
      userId: "user-123",
      region: "IL",
      scrapeJobId: "job-1",
    },
    {
      db: mockDb as any,
      upsertBusinessFromEngineLead: async () => "biz-456",
      enqueueBusinessProcessing: async () => {
        enrichmentCalled = true;
      },
      ensureEnriched: async () => {
        enrichmentCalled = true;
      },
      deliverLead: async () => {
        deliveryCalled = true;
        return { businessId: "biz-456", wasNewForUser: false };
      },
      publishDiscoveryLiveEvent: () => {},
    },
  );

  assert.equal(result.outcome, "duplicate");
  assert.equal(enrichmentCalled, false, "Enrichment MUST NOT be called for known user duplicates");
  assert.equal(deliveryCalled, false, "deliverLead MUST NOT be reached when skipped early");
});

test("Phase 2: Globally existing business NOT owned by user proceeds to enrichment and delivery", async () => {
  let enrichmentCalled = false;
  let delivered = false;

  const mockDb = createMockDb({
    leadsMaybeSingle: () => ({ data: null, error: null }),
    businessMaybeSingle: (bizId) => ({
      data: {
        id: bizId,
        email: "info@smithdental.example",
        phone: "+1 555 0199",
        website: "https://smithdental.example",
      },
      error: null,
    }),
  });

  const lead = mockLead({
    phone: "",
    website: "https://smithdental.example",
  });

  const result = await processDiscoveredCandidate(
    {
      lead,
      planId: "plan-test-2",
      effectiveScoutId: 1,
      requestedChannels: ["phone"],
      userId: "user-456",
      region: "IL",
      scrapeJobId: "job-2",
    },
    {
      db: mockDb as any,
      upsertBusinessFromEngineLead: async () => "biz-global-999",
      enqueueBusinessProcessing: async () => {
        enrichmentCalled = true;
      },
      ensureEnriched: async () => {
        enrichmentCalled = true;
      },
      deliverLead: async (deliv) => {
        delivered = true;
        return { businessId: "biz-global-999", wasNewForUser: true };
      },
      publishDiscoveryLiveEvent: () => {},
    },
  );

  assert.equal(result.outcome, "accepted");
  assert.equal(enrichmentCalled, true, "Enrichment must be called to discover missing phone");
  assert.equal(delivered, true, "Globally existing lead must be delivered if new for this user");
});

// ── 5. Phase 2: Place ID Aliasing and Normalization ───────────────────────────

test("Phase 2: Place ID conversion and expansion normalizes ChIJ and hex forms consistently", () => {
  const hexPair = "0x880fcd7f8fee01b5:0x89b38e817d796008";
  const chij = hexToChij(hexPair);
  assert.ok(chij && chij.startsWith("ChIJ"), "Must convert to valid ChIJ string");

  const backToHex = chijToHex(chij);
  assert.equal(backToHex?.toLowerCase(), hexPair.toLowerCase(), "Round-trip conversion must match hex pair");

  const forms = expandPlaceIdForms(chij);
  assert.ok(forms.has(chij));
  assert.ok(forms.has(hexPair));
  assert.ok(forms.has(hexPair.toLowerCase()));
});

test("Phase 2: getKnownPlaceIdsForTask paginates and extracts expanded forms", async () => {
  const mockDb = createMockDb({
    knownPlaceIdsRange: (from: number) => {
      if (from === 0) {
        return {
          data: [
            {
              place_id: "0x880fcd7f8fee01b5:0x89b38e817d796008",
              fingerprints: ["place:0x880fcd7f8fee01b5:0x89b38e817d796008"],
            },
          ],
          error: null,
        };
      }
      return { data: [], error: null };
    },
  });

  const placeIds = await getKnownPlaceIdsForTask(mockDb, "user-test", "US", "Springfield");
  assert.ok(placeIds.length > 0);
  assert.ok(placeIds.some((id) => id.includes("0x880fcd7f8fee01b5")));
  assert.ok(placeIds.some((id) => id.startsWith("ChIJ")), "Must contain expanded ChIJ format");
});

// ── 6. Phase 3: Profession Opportunity Scores & Observational Gate ────────────

test("Phase 3: 12 professions exist and all weight vectors sum exactly to 1.0", () => {
  assert.equal(PROFESSION_SLUGS.length, 12);
  for (const slug of PROFESSION_SLUGS) {
    const w = PROFESSION_WEIGHTS[slug];
    const sum = w.website + w.branding + w.social + w.growth + w.newness + w.tech;
    assert.ok(Math.abs(sum - 1.0) < 1e-9, `Weight vector for ${slug} must sum to 1.0`);
  }
});

test("Phase 3: Service-need gate evaluates signals observationally without modifying delivery", () => {
  const candidate = {
    name: "Modern Dental Clinic",
    category: "Dentist",
    website: "https://moderndental.example",
    website_reachable: true,
    reviews_count: 50,
    reviews_rating: 4.9,
    has_photos: true,
  };

  const evalResult = evaluateServiceNeedGate({
    candidate,
    professionSlug: "programming_tech",
  });

  assert.ok(evalResult.outcome === "QUALIFIED" || evalResult.outcome === "UNCERTAIN");
  assert.notEqual(evalResult.outcome, "REJECTED", "High ratings/reviews alone must not cause rejection");

  // Observational logging test
  const observation = recordServiceNeedGateObservation(
    mockLead({ name: "Observational Test Co" }),
    { professionSlug: "programming_tech", scrapeJobId: "job-obs-1" },
    "biz-obs-1",
  );
  assert.ok(observation !== null);
  assert.ok(observation?.outcome);
});

// ── 7. Phase 4: Candidate Funnel Telemetry ─────────────────────────────────────

test("Phase 4: Candidate funnel telemetry accurately accounts for candidates and contact sources", () => {
  const planId = `plan-funnel-test-${Date.now()}`;
  const funnel = getCandidateFunnelTracker(planId);

  // 1. Discovered
  funnel.recordDiscovered("pid-1");
  funnel.recordDiscovered("pid-2");
  funnel.recordDiscovered("pid-3");

  // 2. Duplicate skipped
  funnel.recordDuplicateSkipped("post_upsert_owned_lead", "pid-1");

  // 3. Quality rejection
  funnel.recordQualityRejection("low_rating", "pid-2");

  // 4. Eligible for enrichment
  funnel.recordEligibleForEnrichment("pid-3");

  // 5. Contacts extracted with source attribution
  funnel.recordContactExtracted(["website_homepage", "jsonld"], "pid-3");

  // 6. Reaching delivery
  funnel.recordReachingDelivery("pid-3");

  // 7. Delivered
  funnel.recordDelivered("pid-3");

  const snapshot = funnel.getSnapshot();
  assert.equal(snapshot.counts.mapsDiscovered, 3);
  assert.equal(snapshot.counts.userDuplicatesSkipped, 1);
  assert.equal(snapshot.counts.rejectedQualityRelevance, 1);
  assert.equal(snapshot.counts.newCandidatesEligible, 1);
  assert.equal(snapshot.counts.contactsExtracted, 1);
  assert.equal(snapshot.breakdowns.contactsBySource.website_homepage, 1);
  assert.equal(snapshot.breakdowns.contactsBySource.jsonld, 1);
  assert.equal(snapshot.counts.candidatesReachingDelivery, 1);
  assert.equal(snapshot.counts.deliveredLeads, 1);

  clearCandidateFunnelTracker(planId);
});
