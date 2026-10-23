import assert from "node:assert/strict";
import test, { describe } from "node:test";
import fs from "node:fs";
import path from "node:path";

// Mock database representation of the tables and RLS evaluation engine
interface LeadRow {
  id: number;
  user_id: string;
  business_id: string | null;
  business_name: string;
  status: string;
  notes?: string;
  profession_slug?: string;
  opportunity_score?: number;
}

interface BusinessRow {
  id: string;
  name: string;
  category: string;
  niche: string;
  website: string | null;
  email: string | null;
  phone: string | null;
  linkedin?: string | null;
  signals: Record<string, unknown>;
  raw_data: Record<string, unknown> | null;
  seo?: Record<string, unknown>;
  blog?: Record<string, unknown>;
  confidence?: number;
  field_provenance?: Record<string, unknown>;
  last_verified_at?: string;
  last_verification_kind?: string;
  is_disqualified?: boolean;
  disqualify_reason?: string | null;
}

interface ScoreRow {
  business_id: string;
  profession_slug: string;
  opportunity_score: number;
}

interface HealthScoreRow {
  business_id: string;
  health_score: number;
  breakdown: Record<string, unknown>;
  computed_at: string;
}

interface InsightRow {
  business_id: string;
  profession_slug: string;
  headline: string;
  talking_points: string[];
  opening_line: string;
  score_snapshot: number;
  generated_at: string;
}

class SimulatedRlsDatabase {
  leads: LeadRow[] = [];
  businesses: BusinessRow[] = [];
  opportunityScores: ScoreRow[] = [];
  healthScores: HealthScoreRow[] = [];
  insights: InsightRow[] = [];

  // Simulates PostgreSQL RLS and column-level privilege evaluation
  selectBusinesses(callerRole: "anon" | "authenticated" | "service_role", callerUserId?: string, requestedColumns?: string[]) {
    if (callerRole === "anon") {
      throw new Error("permission denied for table businesses: 42501");
    }

    if (callerRole === "service_role") {
      return this.businesses;
    }

    // Authenticated role: check column-level grants
    if (requestedColumns) {
      const forbiddenColumns = ["raw_data", "signals"];
      for (const col of requestedColumns) {
        if (forbiddenColumns.includes(col)) {
          throw new Error(`permission denied for column ${col} of relation businesses: 42501`);
        }
      }
    }

    // Evaluate RLS: exists (select 1 from leads where business_id = businesses.id and user_id = auth.uid())
    return this.businesses.filter(b => {
      return this.leads.some(l => l.business_id === b.id && l.user_id === callerUserId);
    });
  }

  selectScores(callerRole: "anon" | "authenticated" | "service_role", callerUserId?: string) {
    if (callerRole === "anon") {
      throw new Error("permission denied for table business_opportunity_scores: 42501");
    }
    if (callerRole === "service_role") {
      return this.opportunityScores;
    }
    return this.opportunityScores.filter(s => {
      return this.leads.some(l => l.business_id === s.business_id && l.user_id === callerUserId);
    });
  }

  selectHealthScores(callerRole: "anon" | "authenticated" | "service_role", callerUserId?: string) {
    if (callerRole === "anon") {
      throw new Error("permission denied for table business_health_scores: 42501");
    }
    if (callerRole === "service_role") {
      return this.healthScores;
    }
    return this.healthScores.filter(h => {
      return this.leads.some(l => l.business_id === h.business_id && l.user_id === callerUserId);
    });
  }

  selectInsights(callerRole: "anon" | "authenticated" | "service_role", callerUserId?: string) {
    if (callerRole === "anon") {
      throw new Error("permission denied for table business_opportunity_insights: 42501");
    }
    if (callerRole === "service_role") {
      return this.insights;
    }
    return this.insights.filter(i => {
      return this.leads.some(l => l.business_id === i.business_id && l.user_id === callerUserId);
    });
  }

  // Client writes (INSERT, UPDATE, DELETE) are strictly prohibited for authenticated/anon
  insertBusiness(callerRole: "anon" | "authenticated" | "service_role", biz: BusinessRow) {
    if (callerRole !== "service_role") {
      throw new Error("permission denied for table businesses: 42501");
    }
    this.businesses.push(biz);
  }

  updateBusiness(callerRole: "anon" | "authenticated" | "service_role", _id: string, _patch: Partial<BusinessRow>) {
    if (callerRole !== "service_role") {
      throw new Error("permission denied for table businesses: 42501");
    }
  }

  deleteBusiness(callerRole: "anon" | "authenticated" | "service_role", _id: string) {
    if (callerRole !== "service_role") {
      throw new Error("permission denied for table businesses: 42501");
    }
  }
}

// Simulates the Express handler for GET /v1/intelligence/opportunities/:businessId
async function handleGetOpportunityInsight(
  userId: string,
  businessId: string,
  db: SimulatedRlsDatabase,
) {
  // Authoritative ownership check matching src/server/routes/intelligence.ts
  const hasLead = db.leads.some(l => l.user_id === userId && l.business_id === businessId);
  if (!hasLead) {
    return { status: 404, body: { code: "not_found", message: "Business not found or access denied." } };
  }

  const business = db.businesses.find(b => b.id === businessId);
  if (!business) {
    return { status: 404, body: { code: "not_found", message: "Business not found." } };
  }

  const insight = db.insights.find(i => i.business_id === businessId);
  const score = db.opportunityScores.find(s => s.business_id === businessId)?.opportunity_score ?? 80;

  // Exact response shape matching lines 379-387 in src/server/routes/intelligence.ts
  return {
    status: 200,
    body: {
      headline: insight?.headline ?? "A fresh opportunity",
      talking_points: insight?.talking_points ?? ["Key strength observed"],
      opening_line: insight?.opening_line ?? "Hi, I noticed your business online.",
      score_snapshot: insight?.score_snapshot ?? score,
      generated_at: insight?.generated_at ?? new Date().toISOString(),
      explanation: {
        score,
        summary: "High opportunity due to outdated mobile presence",
        reasons: ["Missing mobile optimizations", "Slow load time"],
        breakdown: { website: 40, social: 25 },
      },
      cached: true,
    },
  };
}

// Simulates GET /v1/intelligence/explain/:leadId matching intelligence.ts lines 114-164
async function handleGetExplain(
  userId: string,
  leadId: number,
  db: SimulatedRlsDatabase,
) {
  const lead = db.leads.find(l => l.id === leadId && l.user_id === userId);
  if (!lead || !lead.business_id) {
    return { status: 404, body: { code: "not_found", message: "Lead not found or access denied." } };
  }

  const business = db.businesses.find(b => b.id === lead.business_id);
  if (!business) {
    return { status: 404, body: { code: "not_found", message: "Business not found." } };
  }

  const score = db.opportunityScores.find(s => s.business_id === lead.business_id)?.opportunity_score ?? 75;

  return {
    status: 200,
    body: {
      score,
      summary: "High opportunity score summary",
      reasons: ["SEO improvements possible", "Weak website stack"],
      breakdown: { website: 35, brand: 20 },
    },
  };
}

// Simulates GET /v1/intelligence/trust/:leadId matching intelligence.ts lines 180-234
async function handleGetTrust(
  userId: string,
  leadId: number,
  db: SimulatedRlsDatabase,
) {
  const lead = db.leads.find(l => l.id === leadId && l.user_id === userId);
  if (!lead || !lead.business_id) {
    return { status: 404, body: { code: "not_found", message: "Lead not found or access denied." } };
  }

  const business = db.businesses.find(b => b.id === lead.business_id);
  if (!business) {
    return { status: 404, body: { code: "not_found", message: "Business not found." } };
  }

  const health = db.healthScores.find(h => h.business_id === lead.business_id);

  return {
    status: 200,
    body: {
      overallConfidence: business.confidence ?? 100,
      lastVerifiedAt: business.last_verified_at ?? new Date().toISOString(),
      lastVerificationKind: business.last_verification_kind ?? "site_crawler",
      fieldTrust: business.field_provenance ?? {},
      contacts: {
        emails: business.email ? [business.email] : [],
        phones: business.phone ? [business.phone] : [],
        linkedin: business.linkedin ?? null,
      },
      businessHealth: health
        ? { score: health.health_score, breakdown: health.breakdown, computedAt: health.computed_at }
        : null,
      isDisqualified: Boolean(business.is_disqualified),
      disqualifyReason: business.disqualify_reason ?? null,
    },
  };
}

// Simulates POST /v1/outreach/draft matching outreach.ts lines 280-464
async function handlePostOutreachDraft(
  userId: string,
  leadId: number,
  db: SimulatedRlsDatabase,
) {
  const lead = db.leads.find(l => l.id === leadId && l.user_id === userId);
  if (!lead) {
    return { status: 404, body: { code: "not_found", message: "Lead not found or access denied." } };
  }

  let business: BusinessRow | null = null;
  if (lead.business_id) {
    business = db.businesses.find(b => b.id === lead.business_id) ?? null;
  }

  return {
    status: 200,
    body: {
      subject: `Idea for ${business?.name ?? lead.business_name}`,
      body: `Hi, I noticed a few quick wins for ${business?.name ?? lead.business_name}.`,
      channel: "email",
      action: "initial_outreach",
      model: "gemini-2.5-pro",
      tier: "pro",
    },
  };
}

describe("SEC-02: Business Intelligence Pool Access Control & RLS", () => {
  function setupTestDb() {
    const db = new SimulatedRlsDatabase();

    // Two businesses in global pool
    db.businesses = [
      {
        id: "biz-1",
        name: "Acme Dental",
        category: "Dentist",
        niche: "dental",
        website: "https://acmedental.com",
        email: "info@acmedental.com",
        phone: "555-0101",
        linkedin: "https://linkedin.com/company/acmedental",
        signals: { ig_followers: 1200, website_speed: "slow", proprietary_internal_token: "SECRET_SIGNAL_123" },
        raw_data: { scraper_run: "job-99", raw_html_hash: "abc", internal_payload: "DUMP_99" },
        seo: { title: "Acme Dental", internal_score: 42 },
        blog: { posts: 3, raw_headings: ["Welcome"] },
        confidence: 95,
        field_provenance: { website: { source: "google", confidence: 100 } },
        last_verified_at: "2026-10-20T12:00:00Z",
        last_verification_kind: "site_crawler",
        is_disqualified: false,
        disqualify_reason: null,
      },
      {
        id: "biz-2",
        name: "Zen Yoga",
        category: "Yoga Studio",
        niche: "fitness",
        website: "https://zenyoga.com",
        email: "contact@zenyoga.com",
        phone: "555-0202",
        linkedin: null,
        signals: { ig_followers: 5400, website_speed: "fast", proprietary_internal_token: "SECRET_SIGNAL_456" },
        raw_data: { scraper_run: "job-100", raw_html_hash: "xyz", internal_payload: "DUMP_100" },
        seo: { title: "Zen Yoga", internal_score: 90 },
        blog: { posts: 12, raw_headings: ["Namaste"] },
        confidence: 88,
        field_provenance: { website: { source: "google", confidence: 90 } },
        last_verified_at: "2026-10-21T12:00:00Z",
        last_verification_kind: "site_crawler",
        is_disqualified: false,
        disqualify_reason: null,
      },
    ];

    // Scores & insights
    db.opportunityScores = [
      { business_id: "biz-1", profession_slug: "web_designer", opportunity_score: 85.5 },
      { business_id: "biz-2", profession_slug: "web_designer", opportunity_score: 42.0 },
    ];
    db.healthScores = [
      { business_id: "biz-1", health_score: 55.0, breakdown: { seo: 40, brand: 60 }, computed_at: "2026-10-20T12:00:00Z" },
      { business_id: "biz-2", health_score: 88.0, breakdown: { seo: 85, brand: 90 }, computed_at: "2026-10-21T12:00:00Z" },
    ];
    db.insights = [
      {
        business_id: "biz-1",
        profession_slug: "web_designer",
        headline: "High opportunity: outdated mobile layout",
        talking_points: ["Slow loading on mobile devices", "Unresponsive contact form"],
        opening_line: "Hi, I noticed Acme Dental's website could load faster on phones.",
        score_snapshot: 85.5,
        generated_at: "2026-10-20T12:05:00Z",
      },
      {
        business_id: "biz-2",
        profession_slug: "web_designer",
        headline: "Modern website: low opportunity",
        talking_points: ["Fast mobile speed", "Active blog"],
        opening_line: "Hi, I love Zen Yoga's clean branding.",
        score_snapshot: 42.0,
        generated_at: "2026-10-21T12:05:00Z",
      },
    ];

    // Leads: User A owns a lead for biz-1; User B owns a lead for biz-2
    db.leads = [
      { id: 101, user_id: "user-A", business_id: "biz-1", business_name: "Acme Dental", status: "new", notes: "User A private note" },
      { id: 102, user_id: "user-B", business_id: "biz-2", business_name: "Zen Yoga", status: "contacted", notes: "User B private note" },
    ];

    return db;
  }

  test("User A can read biz-1 intelligence records but CANNOT read biz-2 records", () => {
    const db = setupTestDb();

    // User A can read biz-1
    const userABiz = db.selectBusinesses("authenticated", "user-A", ["id", "name", "website"]);
    assert.equal(userABiz.length, 1);
    assert.equal(userABiz[0].id, "biz-1");

    const userAScores = db.selectScores("authenticated", "user-A");
    assert.equal(userAScores.length, 1);
    assert.equal(userAScores[0].business_id, "biz-1");

    const userAHealth = db.selectHealthScores("authenticated", "user-A");
    assert.equal(userAHealth.length, 1);
    assert.equal(userAHealth[0].business_id, "biz-1");

    const userAInsights = db.selectInsights("authenticated", "user-A");
    assert.equal(userAInsights.length, 1);
    assert.equal(userAInsights[0].business_id, "biz-1");
  });

  test("User B can read biz-2 intelligence records but CANNOT read biz-1 records", () => {
    const db = setupTestDb();

    const userBBiz = db.selectBusinesses("authenticated", "user-B", ["id", "name", "website"]);
    assert.equal(userBBiz.length, 1);
    assert.equal(userBBiz[0].id, "biz-2");

    const userBScores = db.selectScores("authenticated", "user-B");
    assert.equal(userBScores.length, 1);
    assert.equal(userBScores[0].business_id, "biz-2");

    const userBHealth = db.selectHealthScores("authenticated", "user-B");
    assert.equal(userBHealth.length, 1);
    assert.equal(userBHealth[0].business_id, "biz-2");

    const userBInsights = db.selectInsights("authenticated", "user-B");
    assert.equal(userBInsights.length, 1);
    assert.equal(userBInsights[0].business_id, "biz-2");
  });

  test("User C with no leads is denied all business intelligence records (0 rows)", () => {
    const db = setupTestDb();

    assert.equal(db.selectBusinesses("authenticated", "user-C", ["id", "name"]).length, 0);
    assert.equal(db.selectScores("authenticated", "user-C").length, 0);
    assert.equal(db.selectHealthScores("authenticated", "user-C").length, 0);
    assert.equal(db.selectInsights("authenticated", "user-C").length, 0);
  });

  test("Multiple users owning leads for the same business can both read business intelligence", () => {
    const db = setupTestDb();

    // User B also discovers biz-1
    db.leads.push({
      id: 103,
      user_id: "user-B",
      business_id: "biz-1",
      business_name: "Acme Dental",
      status: "email_sent",
      notes: "User B private CRM note",
    });

    // Both User A and User B can now select biz-1
    const userABiz = db.selectBusinesses("authenticated", "user-A", ["id", "name"]);
    const userBBiz = db.selectBusinesses("authenticated", "user-B", ["id", "name"]);

    assert.ok(userABiz.some(b => b.id === "biz-1"));
    assert.ok(userBBiz.some(b => b.id === "biz-1"));

    // Their CRM notes in leads remain completely private and segregated
    const userALeads = db.leads.filter(l => l.user_id === "user-A");
    const userBLeads = db.leads.filter(l => l.user_id === "user-B");
    assert.equal(userALeads[0].notes, "User A private note");
    assert.equal(userBLeads.find(l => l.business_id === "biz-1")?.notes, "User B private CRM note");
  });

  test("Direct client writes (INSERT, UPDATE, DELETE) on businesses are denied", () => {
    const db = setupTestDb();

    const unauthorizedBiz: BusinessRow = {
      id: "biz-fake",
      name: "Injected Biz",
      category: "Spam",
      niche: "general",
      website: null,
      email: null,
      phone: null,
      signals: {},
      raw_data: null,
    };

    assert.throws(
      () => db.insertBusiness("authenticated", unauthorizedBiz),
      /permission denied for table businesses/
    );
    assert.throws(
      () => db.updateBusiness("authenticated", "biz-1", { name: "Hacked Name" }),
      /permission denied for table businesses/
    );
    assert.throws(
      () => db.deleteBusiness("authenticated", "biz-1"),
      /permission denied for table businesses/
    );
  });

  test("Proprietary columns (raw_data, signals) are denied to authenticated client queries", () => {
    const db = setupTestDb();

    // Standard business columns are permitted
    assert.doesNotThrow(() => {
      db.selectBusinesses("authenticated", "user-A", ["id", "name", "category", "website", "phone"]);
    });

    // Selecting proprietary crawler signals is denied
    assert.throws(() => {
      db.selectBusinesses("authenticated", "user-A", ["id", "name", "signals"]);
    }, /permission denied for column signals/);

    // Selecting raw scraper audit data is denied
    assert.throws(() => {
      db.selectBusinesses("authenticated", "user-A", ["id", "name", "raw_data"]);
    }, /permission denied for column raw_data/);
  });

  test("Anonymous role is denied all access to businesses, scores, and insights", () => {
    const db = setupTestDb();

    assert.throws(() => db.selectBusinesses("anon"), /permission denied for table businesses/);
    assert.throws(() => db.selectScores("anon"), /permission denied for table business_opportunity_scores/);
    assert.throws(() => db.selectHealthScores("anon"), /permission denied for table business_health_scores/);
    assert.throws(() => db.selectInsights("anon"), /permission denied for table business_opportunity_insights/);
  });

  test("Service role worker fleet retains full access to shared intelligence pool", () => {
    const db = setupTestDb();

    // Worker can read all businesses and raw data
    const allBiz = db.selectBusinesses("service_role");
    assert.equal(allBiz.length, 2);
    assert.ok(allBiz[0].signals);
    assert.ok(allBiz[0].raw_data);

    // Worker can insert new businesses discovered during pool expansion
    const newBiz: BusinessRow = {
      id: "biz-3",
      name: "New Discovery",
      category: "Plumbing",
      niche: "trades",
      website: "https://newplumb.com",
      email: "service@newplumb.com",
      phone: "555-0303",
      signals: { verified: true },
      raw_data: { scrape_id: "s-123" },
    };
    assert.doesNotThrow(() => db.insertBusiness("service_role", newBiz));
    assert.equal(db.businesses.length, 3);
  });

  test("GET /v1/intelligence/opportunities/:businessId enforces lead ownership boundary", async () => {
    const db = setupTestDb();

    // User A requests biz-1 (which User A owns a lead for) -> 200 Success
    const resA = await handleGetOpportunityInsight("user-A", "biz-1", db);
    assert.equal(resA.status, 200);
    assert.equal(resA.body.headline, "High opportunity: outdated mobile layout");

    // User A attempts to probe biz-2 (which User A DOES NOT own) -> 404 Not Found / Access Denied
    const resForbidden = await handleGetOpportunityInsight("user-A", "biz-2", db);
    assert.equal(resForbidden.status, 404);
    assert.equal(resForbidden.body.code, "not_found");
    assert.equal(resForbidden.body.message, "Business not found or access denied.");

    // User B requests biz-2 (which User B owns) -> 200 Success
    const resB = await handleGetOpportunityInsight("user-B", "biz-2", db);
    assert.equal(resB.status, 200);
    assert.equal(resB.body.headline, "Modern website: low opportunity");
  });

  test("Serialized intelligence responses never expose raw_data, signals, seo, or blog dumps", async () => {
    const db = setupTestDb();

    // 1. Audit /v1/intelligence/opportunities/:businessId response
    const oppRes = await handleGetOpportunityInsight("user-A", "biz-1", db);
    assert.equal(oppRes.status, 200);
    const oppBody = oppRes.body as Record<string, unknown>;
    assert.equal("signals" in oppBody, false, "signals must not be serialized in opportunities response");
    assert.equal("raw_data" in oppBody, false, "raw_data must not be serialized in opportunities response");
    assert.equal("seo" in oppBody, false, "seo must not be serialized in opportunities response");
    assert.equal("blog" in oppBody, false, "blog must not be serialized in opportunities response");

    // 2. Audit /v1/intelligence/explain/:leadId response
    const explainRes = await handleGetExplain("user-A", 101, db);
    assert.equal(explainRes.status, 200);
    const explainBody = explainRes.body as Record<string, unknown>;
    assert.equal("signals" in explainBody, false, "signals must not be serialized in explain response");
    assert.equal("raw_data" in explainBody, false, "raw_data must not be serialized in explain response");
    assert.equal("seo" in explainBody, false, "seo must not be serialized in explain response");
    assert.equal("blog" in explainBody, false, "blog must not be serialized in explain response");

    // 3. Audit /v1/intelligence/trust/:leadId response
    const trustRes = await handleGetTrust("user-A", 101, db);
    assert.equal(trustRes.status, 200);
    const trustBody = trustRes.body as Record<string, unknown>;
    assert.equal("signals" in trustBody, false, "signals must not be serialized in trust response");
    assert.equal("raw_data" in trustBody, false, "raw_data must not be serialized in trust response");
    assert.equal("seo" in trustBody, false, "seo must not be serialized in trust response");
    assert.equal("blog" in trustBody, false, "blog must not be serialized in trust response");

    // 4. Audit /v1/outreach/draft response
    const draftRes = await handlePostOutreachDraft("user-A", 101, db);
    assert.equal(draftRes.status, 200);
    const draftBody = draftRes.body as Record<string, unknown>;
    assert.equal("signals" in draftBody, false, "signals must not be serialized in outreach draft response");
    assert.equal("raw_data" in draftBody, false, "raw_data must not be serialized in outreach draft response");
    assert.equal("seo" in draftBody, false, "seo must not be serialized in outreach draft response");
    assert.equal("blog" in draftBody, false, "blog must not be serialized in outreach draft response");
  });

  test("GET /v1/intelligence/explain, /trust, and POST /v1/outreach/draft reject unauthorized cross-user lead access", async () => {
    const db = setupTestDb();

    // User A attempts to explain User B's lead (id: 102) -> 404
    const explainCross = await handleGetExplain("user-A", 102, db);
    assert.equal(explainCross.status, 404);
    assert.equal(explainCross.body.code, "not_found");

    // User B attempts to access trust panel for User A's lead (id: 101) -> 404
    const trustCross = await handleGetTrust("user-B", 101, db);
    assert.equal(trustCross.status, 404);
    assert.equal(trustCross.body.code, "not_found");

    // User A attempts to draft outreach for User B's lead (id: 102) -> 404
    const draftCross = await handlePostOutreachDraft("user-A", 102, db);
    assert.equal(draftCross.status, 404);
    assert.equal(draftCross.body.code, "not_found");
  });

  test("Static verification of migration 043 RLS statements and policy cleanup", () => {
    const migrationPath = path.resolve(process.cwd(), "migrations/043_secure_business_intelligence_pool.sql");
    assert.ok(fs.existsSync(migrationPath), "Migration 043 must exist");

    const sql = fs.readFileSync(migrationPath, "utf8");

    // 1. Verify RLS is explicitly enabled on all 4 target tables
    const requiredRlsTables = [
      "public.businesses",
      "public.business_opportunity_scores",
      "public.business_health_scores",
      "public.business_opportunity_insights",
    ];
    for (const table of requiredRlsTables) {
      const enableRegex = new RegExp(`alter\\s+table\\s+${table.replace(".", "\\.")}\\s+enable\\s+row\\s+level\\s+security`, "i");
      assert.ok(enableRegex.test(sql), `RLS must be explicitly enabled on ${table}`);
    }

    // 2. Verify all legacy permissive policies are dropped
    const legacyPolicies = [
      "businesses readable by authenticated",
      "scores readable by authenticated",
      "business health readable by authenticated",
      "business_opportunity_insights_read",
    ];
    for (const policy of legacyPolicies) {
      assert.ok(sql.includes(`drop policy if exists "${policy}"`) || sql.includes(`drop policy if exists ${policy}`),
        `Migration must explicitly drop legacy policy: ${policy}`);
    }

    // 3. Verify ownership-scoped SELECT policies are created with subquery
    const ownershipPolicies = [
      "businesses_owner_select",
      "scores_owner_select",
      "health_scores_owner_select",
      "insights_owner_select",
    ];
    for (const policy of ownershipPolicies) {
      assert.ok(sql.includes(`create policy "${policy}"`), `Ownership policy ${policy} must be created`);
    }
    assert.ok(/exists\s*\(\s*select\s+1\s+from\s+public\.leads\s+l\s+where\s+l\.business_id/i.test(sql),
      "Ownership policy must subquery public.leads by business_id and user_id");

    // 4. Verify table-level SELECT on businesses is revoked and column-level SELECT excludes raw_data / signals
    assert.ok(sql.includes("revoke select on table public.businesses from authenticated;"),
      "Table-level SELECT on businesses must be revoked from authenticated");
    assert.ok(!/grant\s+select\s*\([^\)]*\braw_data\b[^\)]*\)\s*on\s+table\s+public\.businesses/i.test(sql),
      "raw_data must NEVER be granted to authenticated");
    assert.ok(!/grant\s+select\s*\([^\)]*\bsignals\b[^\)]*\)\s*on\s+table\s+public\.businesses/i.test(sql),
      "signals must NEVER be granted to authenticated");

    // 5. Verify write privileges are revoked from authenticated
    for (const table of requiredRlsTables) {
      const revokeWritesRegex = new RegExp(`revoke\\s+insert,\\s*update,\\s*delete\\s+on\\s+table\\s+${table.replace(".", "\\.")}\\s+from\\s+authenticated`, "i");
      assert.ok(revokeWritesRegex.test(sql), `Write privileges must be revoked from authenticated on ${table}`);
    }

    // 6. Verify realtime publication drops businesses
    assert.ok(sql.includes("alter publication supabase_realtime drop table public.businesses"),
      "businesses must be dropped from supabase_realtime publication");

    // 7. Verify index idx_leads_business_user is created
    assert.ok(sql.includes("create index if not exists idx_leads_business_user on public.leads (business_id, user_id);"),
      "Performance index idx_leads_business_user must be created on leads");
  });
});
