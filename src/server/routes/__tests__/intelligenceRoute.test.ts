import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import jwt from "jsonwebtoken";
import { intelligenceRouter, resetIntelligenceRateLimiters } from "../intelligence.js";
import { env } from "../../../config/env.js";
import { supabaseAdmin } from "../../../lib/supabaseAdmin.js";
import { setAiClient, resetAiClient } from "../../../lib/ai.js";

describe("Intelligence Route Entitlements & Caching (/v1/intelligence)", () => {
  let app: express.Express;
  let server: any;
  let baseUrl: string;
  let originalOrKey: string | undefined;

  const validUserId = "user-123";
  const validToken = jwt.sign(
    { sub: validUserId, email: "tester@example.com" },
    env.SUPABASE_JWT_SECRET,
    { algorithm: "HS256" },
  );

  let userPlan = "pro";
  let userProfessionFocus = "Programming & Tech";
  let capturedAiCalls: any[] = [];
  let mockAiResult: any = null;

  let dbOpportunityInsights: Record<string, any> = {};
  let dbAiIntelligence: Record<string, any> = {};
  let dbLeads: any[] = [];
  let dbBusinesses: any[] = [];
  let dbFollowups: any[] = [];

  before(async () => {
    originalOrKey = env.OPENROUTER_API_KEY;
    (env as any).OPENROUTER_API_KEY = "sk-or-v1-mock-test-key";

    app = express();
    app.use(express.json());
    app.use("/v1/intelligence", intelligenceRouter);
    app.use((err: any, _req: any, res: any, _next: any) => {
      res
        .status(err.status || 500)
        .json({ code: "internal_error", message: err.message || "Internal error" });
    });

    await new Promise<void>((resolve) => {
      server = app.listen(0, "127.0.0.1", () => {
        const port = (server.address() as any).port;
        baseUrl = `http://127.0.0.1:${port}/v1/intelligence`;
        resolve();
      });
    });
  });

  after(async () => {
    (env as any).OPENROUTER_API_KEY = originalOrKey;
    resetAiClient();
    if (server) server.close();
  });

  beforeEach(() => {
    resetIntelligenceRateLimiters();
    userPlan = "pro";
    userProfessionFocus = "Programming & Tech";
    capturedAiCalls = [];
    mockAiResult = null;
    dbOpportunityInsights = {};
    dbAiIntelligence = {};
    dbFollowups = [];

    dbBusinesses = [
      {
        id: "biz-1",
        name: "Apex Dental Studio",
        category: "Healthcare",
        niche: "dentist",
        address: "100 Congress Ave, Austin, TX",
        region: "Texas",
        country_code: "US",
        website: "https://apexdental.com",
        email: "contact@apexdental.com",
        phone: "+15551234567",
        instagram: "apexdental",
        reviews_count: 42,
        reviews_rating: 4.8,
        signals: { ig_followers: 1200 },
        website_is_weak: false,
        load_time_ms: 1200,
        ssl_valid: true,
      },
    ];

    dbLeads = [
      {
        id: 1,
        user_id: validUserId,
        business_id: "biz-1",
        profession_slug: "programming_tech",
        opportunity_score: 85,
        status: "new",
        updated_at: new Date().toISOString(),
      },
    ];

    const mockClient = {
      chat: {
        completions: {
          create: async (params: any) => {
            capturedAiCalls.push(params);
            if (mockAiResult instanceof Error) {
              throw mockAiResult;
            }
            return {
              choices: [
                {
                  message: {
                    role: "assistant",
                    content: JSON.stringify(mockAiResult ?? {}),
                  },
                },
              ],
            };
          },
        },
      },
    };
    setAiClient(mockClient);

    // Mock Supabase
    (supabaseAdmin as any).from = (table: string) => {
      if (table === "profiles") {
        return {
          select: () => ({
            eq: () => ({
              single: async () => ({
                data: {
                  subscription_plan: userPlan,
                  settings: { focusArea: userProfessionFocus },
                },
                error: null,
              }),
            }),
          }),
        };
      }

      if (table === "businesses") {
        return {
          select: () => ({
            eq: (_col: string, val: string) => ({
              single: async () => ({
                data: dbBusinesses.find((b) => b.id === val) ?? null,
                error: null,
              }),
              maybeSingle: async () => ({
                data: dbBusinesses.find((b) => b.id === val) ?? null,
                error: null,
              }),
            }),
          }),
        };
      }

      if (table === "leads") {
        return {
          select: () => {
            const builder: any = {
              eq: (col: string, val: any) => {
                builder._eq = builder._eq || {};
                builder._eq[col] = val;
                return builder;
              },
              gte: () => builder,
              lte: () => builder,
              order: () => builder,
              limit: () => builder,
              single: async () => {
                const lead = dbLeads.find(
                  (l) =>
                    (!builder._eq?.id || l.id === builder._eq.id) &&
                    (!builder._eq?.user_id || l.user_id === builder._eq.user_id),
                );
                return { data: lead ?? null, error: null };
              },
              maybeSingle: async () => {
                const lead = dbLeads.find(
                  (l) =>
                    (!builder._eq?.id || l.id === builder._eq.id) &&
                    (!builder._eq?.user_id || l.user_id === builder._eq.user_id),
                );
                return { data: lead ?? null, error: null };
              },
              // For pipeline snapshot queries
              then: (resolve: any) => {
                const filtered = dbLeads.filter(
                  (l) => !builder._eq?.user_id || l.user_id === builder._eq.user_id,
                );
                resolve({ data: filtered, error: null });
              },
            };
            return builder;
          },
        };
      }

      if (table === "business_opportunity_insights") {
        return {
          select: () => {
            const builder: any = {
              eq: (col: string, val: string) => {
                builder._eq = builder._eq || {};
                builder._eq[col] = val;
                return builder;
              },
              maybeSingle: async () => {
                const key = `${builder._eq?.business_id}:${builder._eq?.profession_slug}`;
                return { data: dbOpportunityInsights[key] ?? null, error: null };
              },
            };
            return builder;
          },
          upsert: async (row: any) => {
            const key = `${row.business_id}:${row.profession_slug}`;
            dbOpportunityInsights[key] = { ...row };
            return { error: null };
          },
        };
      }

      if (table === "ai_intelligence") {
        return {
          select: () => {
            const builder: any = {
              eq: (col: string, val: string) => {
                builder._eq = builder._eq || {};
                builder._eq[col] = val;
                return builder;
              },
              maybeSingle: async () => {
                const key = `${builder._eq?.user_id}:${builder._eq?.kind}:${builder._eq?.period_key}`;
                return { data: dbAiIntelligence[key] ?? null, error: null };
              },
            };
            return builder;
          },
          upsert: async (row: any) => {
            const key = `${row.user_id}:${row.kind}:${row.period_key}`;
            dbAiIntelligence[key] = { ...row };
            return { error: null };
          },
        };
      }

      if (table === "lead_activities") {
        return {
          select: () => ({
            eq: () => ({
              order: () => ({
                limit: async () => ({ data: [], error: null }),
              }),
            }),
          }),
        };
      }

      if (table === "lead_followups") {
        return {
          select: () => {
            const builder: any = {
              eq: (col: string, val: any) => {
                builder._eq = builder._eq || {};
                builder._eq[col] = val;
                return builder;
              },
              order: () => builder,
              limit: () => builder,
              then: (resolve: any) => {
                const filtered = dbFollowups.filter(
                  (f) => !builder._eq?.user_id || f.user_id === builder._eq.user_id,
                );
                resolve({ data: filtered, error: null });
              },
            };
            return builder;
          },
        };
      }

      return {
        select: () => ({ eq: () => ({ single: async () => ({ data: null, error: null }) }) }),
      };
    };
  });

  describe("GET /v1/intelligence/opportunities/:businessId", () => {
    test("Free plan is blocked with 403 even if insight is cached in DB", async () => {
      userPlan = "free";
      // Pre-seed cache in DB
      dbOpportunityInsights["biz-1:programming_tech"] = {
        headline: "Precomputed cached headline",
        talking_points: ["Point 1"],
        opening_line: "Opening line",
        score_snapshot: 48,
        generated_at: new Date().toISOString(),
      };

      const res = await fetch(`${baseUrl}/opportunities/biz-1`, {
        headers: { Authorization: `Bearer ${validToken}` },
      });
      const data = await res.json();

      assert.equal(res.status, 403);
      assert.equal(data.code, "plan_restricted");
      assert.match(data.message, /Pro or Premium/);
      assert.equal(capturedAiCalls.length, 0, "Free user must not trigger model calls");
    });

    test("Starter plan is blocked with 403 even if insight is cached in DB", async () => {
      userPlan = "starter";
      dbOpportunityInsights["biz-1:programming_tech"] = {
        headline: "Precomputed cached headline",
        talking_points: ["Point 1"],
        opening_line: "Opening line",
        score_snapshot: 48,
        generated_at: new Date().toISOString(),
      };

      const res = await fetch(`${baseUrl}/opportunities/biz-1`, {
        headers: { Authorization: `Bearer ${validToken}` },
      });
      const data = await res.json();

      assert.equal(res.status, 403);
      assert.equal(data.code, "plan_restricted");
      assert.equal(capturedAiCalls.length, 0, "Starter user must not trigger model calls for insights");
    });

    test("Pro plan is entitled and receives cached insight without calling AI model", async () => {
      userPlan = "pro";
      dbOpportunityInsights["biz-1:programming_tech"] = {
        headline: "Precomputed cached headline",
        talking_points: ["Point 1", "Point 2"],
        opening_line: "Cached opening line",
        score_snapshot: 48, // Engine score for biz-1 is 47.8, delta <= 10
        generated_at: new Date().toISOString(),
      };

      const res = await fetch(`${baseUrl}/opportunities/biz-1`, {
        headers: { Authorization: `Bearer ${validToken}` },
      });
      const data = await res.json();

      assert.equal(res.status, 200);
      assert.equal(data.cached, true);
      assert.equal(data.headline, "Precomputed cached headline");
      assert.equal(capturedAiCalls.length, 0, "Fresh cache hit must not invoke model");
    });

    test("Pro plan generates fresh insight and writes to cache on cache-miss", async () => {
      userPlan = "pro";
      mockAiResult = {
        headline: "Fresh opportunity for Apex Dental",
        talkingPoints: ["Fast site upgrade", "Digital booking"],
        openingLine: "Hi, I noticed your site could benefit from a modern booking flow.",
      };

      const res = await fetch(`${baseUrl}/opportunities/biz-1`, {
        headers: { Authorization: `Bearer ${validToken}` },
      });
      const data = await res.json();

      assert.equal(res.status, 200);
      assert.equal(data.cached, false);
      assert.equal(data.headline, "Fresh opportunity for Apex Dental");
      assert.equal(capturedAiCalls.length, 1, "Cache miss must invoke model");
      assert.ok(dbOpportunityInsights["biz-1:programming_tech"], "Result must be cached in DB");
    });

    test("Premium plan inherits Pro insight capability", async () => {
      userPlan = "premium";
      dbOpportunityInsights["biz-1:programming_tech"] = {
        headline: "Premium cached headline",
        talking_points: ["Point A"],
        opening_line: "Opening A",
        score_snapshot: 48,
        generated_at: new Date().toISOString(),
      };

      const res = await fetch(`${baseUrl}/opportunities/biz-1`, {
        headers: { Authorization: `Bearer ${validToken}` },
      });
      const data = await res.json();

      assert.equal(res.status, 200);
      assert.equal(data.headline, "Premium cached headline");
    });

    test("Honest 503 error returned when provider is unavailable", async () => {
      userPlan = "pro";
      const err = new Error("Connection refused");
      (err as any).status = 503;
      mockAiResult = err;

      const res = await fetch(`${baseUrl}/opportunities/biz-1`, {
        headers: { Authorization: `Bearer ${validToken}` },
      });
      const data = await res.json();

      assert.equal(res.status, 503);
      assert.match(data.message, /temporarily unavailable/i);
    });
  });

  describe("GET /v1/intelligence/briefing", () => {
    test("Free plan is blocked with 403 from Executive Briefing even if cached", async () => {
      userPlan = "free";
      const periodKey = new Date().toISOString().slice(0, 10);
      dbAiIntelligence[`${validUserId}:executive_briefing:${periodKey}`] = {
        content: { summary: "Cached briefing", priorities: ["Do x"], tone: "brand" },
        generated_at: new Date().toISOString(),
      };

      const res = await fetch(`${baseUrl}/briefing`, {
        headers: { Authorization: `Bearer ${validToken}` },
      });
      const data = await res.json();

      assert.equal(res.status, 403);
      assert.equal(data.code, "plan_restricted");
      assert.equal(capturedAiCalls.length, 0);
    });

    test("Starter plan is blocked with 403 from Executive Briefing", async () => {
      userPlan = "starter";
      const res = await fetch(`${baseUrl}/briefing`, {
        headers: { Authorization: `Bearer ${validToken}` },
      });
      const data = await res.json();

      assert.equal(res.status, 403);
      assert.equal(data.code, "plan_restricted");
      assert.equal(capturedAiCalls.length, 0);
    });

    test("Pro plan is entitled to Executive Briefing and receives cached snapshot", async () => {
      userPlan = "pro";
      const periodKey = new Date().toISOString().slice(0, 10);
      dbAiIntelligence[`${validUserId}:executive_briefing:${periodKey}`] = {
        content: { summary: "Cached daily briefing for today", priorities: ["Call Apex"], tone: "success" },
        generated_at: new Date().toISOString(),
      };

      const res = await fetch(`${baseUrl}/briefing`, {
        headers: { Authorization: `Bearer ${validToken}` },
      });
      const data = await res.json();

      assert.equal(res.status, 200);
      assert.equal(data.cached, true);
      assert.equal(data.summary, "Cached daily briefing for today");
      assert.equal(capturedAiCalls.length, 0, "No LLM call when daily cache hit");
    });

    test("Pro plan generates and caches Executive Briefing on cache miss", async () => {
      userPlan = "pro";
      mockAiResult = {
        summary: "Pipeline has steady activity with one new lead.",
        priorities: ["Reach out to Apex Dental"],
        tone: "brand",
      };

      const res = await fetch(`${baseUrl}/briefing`, {
        headers: { Authorization: `Bearer ${validToken}` },
      });
      const data = await res.json();

      assert.equal(res.status, 200);
      assert.equal(data.cached, false);
      assert.equal(data.summary, "Pipeline has steady activity with one new lead.");
      assert.equal(capturedAiCalls.length, 1);
    });
  });

  describe("GET /v1/intelligence/coaching", () => {
    test("Free and Starter plans are blocked with 403", async () => {
      for (const p of ["free", "starter"]) {
        userPlan = p;
        const res = await fetch(`${baseUrl}/coaching`, {
          headers: { Authorization: `Bearer ${validToken}` },
        });
        const data = await res.json();

        assert.equal(res.status, 403);
        assert.equal(data.code, "plan_restricted");
      }
    });

    test("Pro plan with 0 stalled deals returns allClear without calling model", async () => {
      userPlan = "pro";
      // dbLeads has 1 lead updated just now (not stalled)
      const res = await fetch(`${baseUrl}/coaching`, {
        headers: { Authorization: `Bearer ${validToken}` },
      });
      const data = await res.json();

      assert.equal(res.status, 200);
      assert.equal(data.allClear, true);
      assert.deepEqual(data.alerts, []);
      assert.equal(capturedAiCalls.length, 0, "Zero stalled deals must skip model calls completely");
    });

    test("Pro plan with stalled deals calls model and returns risk coaching alerts", async () => {
      userPlan = "pro";
      // Create a stalled lead (updated 10 days ago in replied status, threshold is >= 7 days)
      const tenDaysAgo = new Date(Date.now() - 10 * 86_400_000).toISOString();
      dbLeads = [
        {
          id: 10,
          user_id: validUserId,
          business_id: "biz-1",
          business_name: "Apex Dental Studio",
          status: "replied",
          updated_at: tenDaysAgo,
        },
      ];

      mockAiResult = {
        alerts: [
          {
            businessName: "Apex Dental Studio",
            message: "Deal has been idle for 5 days following their last reply.",
            suggestedAction: "Send a polite check-in offering a short demo link.",
          },
        ],
      };

      const res = await fetch(`${baseUrl}/coaching`, {
        headers: { Authorization: `Bearer ${validToken}` },
      });
      const data = await res.json();

      assert.equal(res.status, 200);
      assert.equal(data.allClear, false);
      assert.equal(data.alerts.length, 1);
      assert.equal(data.alerts[0].businessName, "Apex Dental Studio");
      assert.equal(capturedAiCalls.length, 1);
    });
  });

  describe("GET /v1/intelligence/weekly", () => {
    test("Free and Starter are blocked; Pro and Premium are admitted", async () => {
      userPlan = "starter";
      let res = await fetch(`${baseUrl}/weekly`, {
        headers: { Authorization: `Bearer ${validToken}` },
      });
      assert.equal(res.status, 403);

      userPlan = "pro";
      mockAiResult = {
        reflection: "Solid outbound week with steady touchpoints.",
        wins: ["Contacted Apex Dental"],
        focusForNextWeek: ["Follow up on active discussions"],
      };
      res = await fetch(`${baseUrl}/weekly`, {
        headers: { Authorization: `Bearer ${validToken}` },
      });
      const data = await res.json();
      assert.equal(res.status, 200);
      assert.equal(data.wins[0], "Contacted Apex Dental");
    });
  });

  describe("GET /v1/intelligence/discover-overview", () => {
    test("Free plan is blocked with 403 (0 model calls)", async () => {
      userPlan = "free";
      const res = await fetch(`${baseUrl}/discover-overview`, {
        headers: { Authorization: `Bearer ${validToken}` },
      });
      const data = await res.json();
      assert.equal(res.status, 403);
      assert.equal(data.code, "plan_restricted");
      assert.equal(capturedAiCalls.length, 0);
    });

    test("Starter plan is blocked with 403 (0 model calls)", async () => {
      userPlan = "starter";
      const res = await fetch(`${baseUrl}/discover-overview`, {
        headers: { Authorization: `Bearer ${validToken}` },
      });
      const data = await res.json();
      assert.equal(res.status, 403);
      assert.equal(data.code, "plan_restricted");
      assert.equal(capturedAiCalls.length, 0);
    });

    test("Free/Starter cannot bypass entitlement even if overview is cached in DB", async () => {
      const today = new Date().toISOString().slice(0, 10);
      const mockKey = `${validUserId}:discover_overview:${today}:1:1:1:0:0`;
      dbAiIntelligence[mockKey] = {
        user_id: validUserId,
        kind: "discover_overview",
        period_key: `${today}:1:1:1:0:0`,
        content: { label: "Cached", headline: "Cached overview", body: "Body", confidence: "Recommended", tone: "brand" },
        generated_at: new Date().toISOString(),
      };

      userPlan = "free";
      let res = await fetch(`${baseUrl}/discover-overview`, {
        headers: { Authorization: `Bearer ${validToken}` },
      });
      assert.equal(res.status, 403);

      userPlan = "starter";
      res = await fetch(`${baseUrl}/discover-overview`, {
        headers: { Authorization: `Bearer ${validToken}` },
      });
      assert.equal(res.status, 403);
      assert.equal(capturedAiCalls.length, 0);
    });

    test("Empty leads queue returns honest deterministic overview without calling AI model", async () => {
      userPlan = "pro";
      dbLeads = [];
      const res = await fetch(`${baseUrl}/discover-overview`, {
        headers: { Authorization: `Bearer ${validToken}` },
      });
      const data = await res.json();
      assert.equal(res.status, 200);
      assert.equal(data.label, "Discovery Overview");
      assert.equal(data.headline, "No leads discovered yet");
      assert.equal(capturedAiCalls.length, 0);
    });

    test("Pro calls genuine AI model with bounded payload and caches result for subsequent requests", async () => {
      userPlan = "pro";
      dbLeads = [
        {
          id: 1,
          user_id: validUserId,
          business_name: "Apex Dental Studio",
          niche: "dentist",
          location: "Austin, TX",
          opportunity_score: 92,
          status: "new",
          email: "secret@apexdental.com",
          phone: "+15551234567",
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
      ];

      mockAiResult = {
        label: "High Demand",
        headline: "Austin dentistry market presents immediate outreach viability.",
        body: "Top leads feature high opportunity scores with verified digital gaps.",
        confidence: "High Confidence",
        tone: "brand",
        patterns: ["Dental practices in Austin lack booking automation."],
        promisingOpportunities: ["Apex Dental Studio"],
        nextSteps: ["Initiate outreach focused on website modernization."],
        action: { label: "View Leads", href: "#leads-table" },
      };

      // Call 1: Cache miss -> model invoked
      const res1 = await fetch(`${baseUrl}/discover-overview`, {
        headers: { Authorization: `Bearer ${validToken}` },
      });
      const data1 = await res1.json();

      assert.equal(res1.status, 200);
      assert.equal(data1.cached, false);
      assert.equal(data1.headline, "Austin dentistry market presents immediate outreach viability.");
      assert.equal(data1.confidence, "High Confidence");
      assert.equal(capturedAiCalls.length, 1);

      // Verify Bounded Minimal Context: NO email or phone sent to LLM
      const userMessage = capturedAiCalls[0].messages.find((m: any) => m.role === "user").content;
      assert.equal(userMessage.includes("secret@apexdental.com"), false);
      assert.equal(userMessage.includes("+15551234567"), false);
      assert.equal(userMessage.includes("Apex Dental Studio"), true);
      assert.equal(userMessage.includes("dentist"), true);

      // Call 2: Cache hit -> returns cached without invoking model
      const res2 = await fetch(`${baseUrl}/discover-overview`, {
        headers: { Authorization: `Bearer ${validToken}` },
      });
      const data2 = await res2.json();

      assert.equal(res2.status, 200);
      assert.equal(data2.cached, true);
      assert.equal(data2.headline, "Austin dentistry market presents immediate outreach viability.");
      assert.equal(capturedAiCalls.length, 1);
    });

    test("Modifying lead results updates material state key and invalidates cache", async () => {
      userPlan = "pro";
      dbLeads = [
        {
          id: 1,
          user_id: validUserId,
          business_name: "Apex Dental Studio",
          niche: "dentist",
          location: "Austin, TX",
          opportunity_score: 92,
          status: "new",
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
      ];

      mockAiResult = {
        label: "Initial",
        headline: "Initial overview.",
        body: "Initial body.",
        confidence: "Recommended",
        tone: "brand",
        patterns: [],
        promisingOpportunities: [],
        nextSteps: [],
      };

      // First call primes cache
      const res1 = await fetch(`${baseUrl}/discover-overview`, {
        headers: { Authorization: `Bearer ${validToken}` },
      });
      assert.equal(res1.status, 200);
      assert.equal(capturedAiCalls.length, 1);

      // Add another lead, changing total count and material key
      dbLeads.push({
        id: 2,
        user_id: validUserId,
        business_name: "Bright Smiles",
        niche: "dentist",
        location: "Austin, TX",
        opportunity_score: 78,
        status: "contacted",
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });

      mockAiResult = {
        label: "Pipeline Active",
        headline: "Two dentistry leads now available with expanding contact progress.",
        body: "Follow up with contacted leads while reaching out to new opportunities.",
        confidence: "Recommended",
        tone: "success",
        patterns: ["Healthy mix of contacted and uncontacted prospects."],
        promisingOpportunities: ["Bright Smiles"],
        nextSteps: ["Send initial touch to new leads."],
      };

      const res2 = await fetch(`${baseUrl}/discover-overview`, {
        headers: { Authorization: `Bearer ${validToken}` },
      });
      const data2 = await res2.json();

      assert.equal(res2.status, 200);
      assert.equal(data2.cached, false);
      assert.equal(data2.headline, "Two dentistry leads now available with expanding contact progress.");
      // Triggered a second LLM call due to material state change
      assert.equal(capturedAiCalls.length, 2);
    });

    test("Changing an existing lead's opportunity score or niche invalidates cache with identical counts", async () => {
      userPlan = "pro";
      dbLeads = [
        {
          id: 1,
          user_id: validUserId,
          business_name: "Apex Dental Studio",
          niche: "dentist",
          location: "Austin, TX",
          opportunity_score: 80,
          status: "new",
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
      ];

      mockAiResult = {
        label: "Initial",
        headline: "Initial overview.",
        body: "Initial body.",
        confidence: "Recommended",
        tone: "brand",
        patterns: [],
        promisingOpportunities: [],
        nextSteps: [],
      };

      // Call 1: Primes cache
      const res1 = await fetch(`${baseUrl}/discover-overview`, {
        headers: { Authorization: `Bearer ${validToken}` },
      });
      assert.equal(res1.status, 200);
      assert.equal(capturedAiCalls.length, 1);

      // Repeat request without changes: Cache hit (0 new AI calls)
      const resCache = await fetch(`${baseUrl}/discover-overview`, {
        headers: { Authorization: `Bearer ${validToken}` },
      });
      const dataCache = await resCache.json();
      assert.equal(dataCache.cached, true);
      assert.equal(capturedAiCalls.length, 1);

      // 1. Change opportunity score on existing lead (counts remain 1)
      dbLeads[0].opportunity_score = 95;
      const resScore = await fetch(`${baseUrl}/discover-overview`, {
        headers: { Authorization: `Bearer ${validToken}` },
      });
      const dataScore = await resScore.json();
      assert.equal(resScore.status, 200);
      assert.equal(dataScore.cached, false);
      assert.equal(capturedAiCalls.length, 2);

      // 2. Change niche on existing lead (counts remain 1)
      dbLeads[0].niche = "roofing";
      const resNiche = await fetch(`${baseUrl}/discover-overview`, {
        headers: { Authorization: `Bearer ${validToken}` },
      });
      const dataNiche = await resNiche.json();
      assert.equal(resNiche.status, 200);
      assert.equal(dataNiche.cached, false);
      assert.equal(capturedAiCalls.length, 3);
    });

    test("Changing an existing lead's region invalidates cache and unrelated fields preserve cache", async () => {
      userPlan = "pro";
      dbLeads = [
        {
          id: 1,
          user_id: validUserId,
          business_name: "Apex Dental Studio",
          niche: "dentist",
          location: "Austin, TX",
          opportunity_score: 80,
          status: "new",
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
      ];

      mockAiResult = {
        label: "Initial",
        headline: "Initial overview.",
        body: "Initial body.",
        confidence: "Recommended",
        tone: "brand",
        patterns: [],
        promisingOpportunities: [],
        nextSteps: [],
      };

      // Call 1: Primes cache
      const res1 = await fetch(`${baseUrl}/discover-overview`, {
        headers: { Authorization: `Bearer ${validToken}` },
      });
      assert.equal(res1.status, 200);
      assert.equal(capturedAiCalls.length, 1);

      // 1. Change region/location on existing lead (counts remain 1)
      dbLeads[0].location = "Dallas, TX";
      const resRegion = await fetch(`${baseUrl}/discover-overview`, {
        headers: { Authorization: `Bearer ${validToken}` },
      });
      const dataRegion = await resRegion.json();
      assert.equal(resRegion.status, 200);
      assert.equal(dataRegion.cached, false);
      assert.equal(capturedAiCalls.length, 2);

      // 2. Irrelevant change not in bounded context (updated_at only): Cache preserved
      dbLeads[0].updated_at = new Date(Date.now() + 10000).toISOString();
      const resUnrelated = await fetch(`${baseUrl}/discover-overview`, {
        headers: { Authorization: `Bearer ${validToken}` },
      });
      const dataUnrelated = await resUnrelated.json();
      assert.equal(resUnrelated.status, 200);
      assert.equal(dataUnrelated.cached, true);
      assert.equal(capturedAiCalls.length, 2);
    });

    test("A different lead becoming highest-priority recommendation invalidates discover-overview cache", async () => {
      userPlan = "pro";
      dbLeads = [
        {
          id: 1,
          user_id: validUserId,
          business_name: "Apex Dental",
          niche: "dentist",
          location: "Austin, TX",
          opportunity_score: 90,
          status: "new",
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
        {
          id: 2,
          user_id: validUserId,
          business_name: "Central HVAC",
          niche: "hvac",
          location: "Austin, TX",
          opportunity_score: 70,
          status: "new",
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
      ];

      mockAiResult = {
        label: "Dental Focus",
        headline: "Apex Dental is currently your highest-scored opportunity.",
        body: "Focus on dental leads first.",
        confidence: "High Confidence",
        tone: "brand",
        patterns: [],
        promisingOpportunities: ["Apex Dental"],
        nextSteps: [],
      };

      const res1 = await fetch(`${baseUrl}/discover-overview`, {
        headers: { Authorization: `Bearer ${validToken}` },
      });
      assert.equal(res1.status, 200);
      assert.equal(capturedAiCalls.length, 1);

      // Lead 2's score jumps above Lead 1, making Central HVAC the top recommendation
      dbLeads[1].opportunity_score = 98;
      mockAiResult = {
        label: "HVAC Focus",
        headline: "Central HVAC is now your top opportunity.",
        body: "Prioritize HVAC outreach.",
        confidence: "High Confidence",
        tone: "brand",
        patterns: [],
        promisingOpportunities: ["Central HVAC"],
        nextSteps: [],
      };

      const res2 = await fetch(`${baseUrl}/discover-overview`, {
        headers: { Authorization: `Bearer ${validToken}` },
      });
      const data2 = await res2.json();
      assert.equal(res2.status, 200);
      assert.equal(data2.cached, false);
      assert.equal(data2.headline, "Central HVAC is now your top opportunity.");
      assert.equal(capturedAiCalls.length, 2);
    });

    test("Cache is strictly user-scoped and prevents cross-user cache reuse", async () => {
      userPlan = "pro";
      dbLeads = [
        {
          id: 50,
          user_id: validUserId,
          business_name: "Apex Dental",
          niche: "dentist",
          location: "Austin, TX",
          opportunity_score: 90,
          status: "new",
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
      ];
      mockAiResult = {
        label: "User A",
        headline: "User A discovery overview.",
        body: "Insights for User A.",
        confidence: "Recommended",
        tone: "brand",
        patterns: [],
        promisingOpportunities: [],
        nextSteps: [],
      };

      // User A call
      const resA = await fetch(`${baseUrl}/discover-overview`, {
        headers: { Authorization: `Bearer ${validToken}` },
      });
      assert.equal(resA.status, 200);
      assert.equal(capturedAiCalls.length, 1);

      // User B token
      const userBToken = jwt.sign(
        { sub: "user-456", email: "userb@example.com" },
        env.SUPABASE_JWT_SECRET,
        { algorithm: "HS256" },
      );

      // User B has identical leads structure in DB
      dbLeads.push({
        id: 51,
        user_id: "user-456",
        business_name: "Apex Dental",
        niche: "dentist",
        location: "Austin, TX",
        opportunity_score: 90,
        status: "new",
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });

      mockAiResult = {
        label: "User B",
        headline: "User B discovery overview.",
        body: "Insights for User B.",
        confidence: "Recommended",
        tone: "brand",
        patterns: [],
        promisingOpportunities: [],
        nextSteps: [],
      };

      // User B should NOT get User A's cached entry — User B gets their own generation
      const resB = await fetch(`${baseUrl}/discover-overview`, {
        headers: { Authorization: `Bearer ${userBToken}` },
      });
      const dataB = await resB.json();
      assert.equal(resB.status, 200);
      assert.equal(dataB.cached, false);
      assert.equal(dataB.headline, "User B discovery overview.");
      assert.equal(capturedAiCalls.length, 2);
    });

    test("Honest 500 error when AI provider fails on entitled request (never masquerades deterministic fallback as AI)", async () => {
      userPlan = "pro";
      // Invalidate cache by changing status
      dbLeads[0].status = "replied";
      mockAiResult = new Error("DeepSeek upstream failure");

      const res = await fetch(`${baseUrl}/discover-overview`, {
        headers: { Authorization: `Bearer ${validToken}` },
      });
      assert.equal(res.status, 500);
    });
  });

  describe("GET /v1/intelligence/mission-coach", () => {
    test("Free plan is blocked with 403 (0 model calls)", async () => {
      userPlan = "free";
      const res = await fetch(`${baseUrl}/mission-coach`, {
        headers: { Authorization: `Bearer ${validToken}` },
      });
      const data = await res.json();
      assert.equal(res.status, 403);
      assert.equal(data.code, "plan_restricted");
      assert.equal(capturedAiCalls.length, 0);
    });

    test("Starter plan is blocked with 403 (0 model calls)", async () => {
      userPlan = "starter";
      const res = await fetch(`${baseUrl}/mission-coach`, {
        headers: { Authorization: `Bearer ${validToken}` },
      });
      const data = await res.json();
      assert.equal(res.status, 403);
      assert.equal(data.code, "plan_restricted");
      assert.equal(capturedAiCalls.length, 0);
    });

    test("Free/Starter cannot bypass entitlement even if coach insight is cached in DB", async () => {
      const today = new Date().toISOString().slice(0, 10);
      const mockKey = `${validUserId}:mission_coach:${today}:1:1:0:0:f-1`;
      dbAiIntelligence[mockKey] = {
        user_id: validUserId,
        kind: "mission_coach",
        period_key: `${today}:1:1:0:0:f-1`,
        content: { briefing: "Cached coach", recommendedLeadId: 1, recommendedAction: "Call", rationale: "Why", reasons: ["R1"] },
        generated_at: new Date().toISOString(),
      };

      userPlan = "free";
      let res = await fetch(`${baseUrl}/mission-coach`, {
        headers: { Authorization: `Bearer ${validToken}` },
      });
      assert.equal(res.status, 403);

      userPlan = "starter";
      res = await fetch(`${baseUrl}/mission-coach`, {
        headers: { Authorization: `Bearer ${validToken}` },
      });
      assert.equal(res.status, 403);
      assert.equal(capturedAiCalls.length, 0);
    });

    test("Completely empty queue returns honest deterministic status without calling AI model", async () => {
      userPlan = "pro";
      dbFollowups = [];
      dbLeads = [];
      const res = await fetch(`${baseUrl}/mission-coach`, {
        headers: { Authorization: `Bearer ${validToken}` },
      });
      const data = await res.json();
      assert.equal(res.status, 200);
      assert.equal(data.briefing.includes("Nothing due today"), true);
      assert.equal(capturedAiCalls.length, 0);
    });

    test("Pro calls genuine AI model with bounded mission queue data and caches result", async () => {
      userPlan = "pro";
      dbLeads = [
        {
          id: 10,
          user_id: validUserId,
          business_name: "Apex Dental Studio",
          niche: "dentist",
          status: "replied",
          opportunity_score: 92,
          priority: "high",
          last_contacted_at: new Date(Date.now() - 3 * 86400000).toISOString(),
          email: "confidential@apexdental.com",
          phone: "+15559876543",
          updated_at: new Date().toISOString(),
        },
      ];
      dbFollowups = [
        {
          id: "f-1",
          user_id: validUserId,
          lead_id: 10,
          channel: "email",
          due_at: new Date(Date.now() - 86400000).toISOString(),
          status: "pending",
          notes: "Replied asking for pricing and portfolio.",
          updated_at: new Date().toISOString(),
        },
      ];

      mockAiResult = {
        briefing: "You have 1 overdue follow-up with a high-priority prospect.",
        recommendedLeadId: 10,
        recommendedAction: "Send customized case study and pricing options.",
        rationale: "Apex Dental Studio marked as replied and has an opportunity score of 92.",
        reasons: ["Marked as replied", "1 day overdue", "Opportunity score 92"],
      };

      // Call 1: Model invoked
      const res1 = await fetch(`${baseUrl}/mission-coach`, {
        headers: { Authorization: `Bearer ${validToken}` },
      });
      const data1 = await res1.json();

      assert.equal(res1.status, 200);
      assert.equal(data1.cached, false);
      assert.equal(data1.recommendedLeadId, 10);
      assert.equal(data1.recommendedAction, "Send customized case study and pricing options.");
      assert.equal(capturedAiCalls.length, 1);

      // Verify Bounded Minimal Context: NO email or phone sent to LLM
      const userMessage = capturedAiCalls[0].messages.find((m: any) => m.role === "user").content;
      assert.equal(userMessage.includes("confidential@apexdental.com"), false);
      assert.equal(userMessage.includes("+15559876543"), false);
      assert.equal(userMessage.includes("Apex Dental Studio"), true);
      assert.equal(userMessage.includes("overdue"), true);

      // Call 2: Returns cached
      const res2 = await fetch(`${baseUrl}/mission-coach`, {
        headers: { Authorization: `Bearer ${validToken}` },
      });
      const data2 = await res2.json();

      assert.equal(res2.status, 200);
      assert.equal(data2.cached, true);
      assert.equal(data2.recommendedLeadId, 10);
      assert.equal(capturedAiCalls.length, 1);
    });

    test("Completing a follow-up invalidates cache and triggers fresh AI coaching", async () => {
      userPlan = "pro";
      dbLeads = [
        {
          id: 10,
          user_id: validUserId,
          business_name: "Apex Dental Studio",
          niche: "dentist",
          status: "replied",
          opportunity_score: 92,
          priority: "high",
          last_contacted_at: new Date(Date.now() - 3 * 86400000).toISOString(),
          updated_at: new Date().toISOString(),
        },
      ];
      dbFollowups = [
        {
          id: "f-1",
          user_id: validUserId,
          lead_id: 10,
          channel: "email",
          due_at: new Date(Date.now() - 86400000).toISOString(),
          status: "pending",
          notes: "Initial follow-up",
          updated_at: new Date().toISOString(),
        },
      ];

      mockAiResult = {
        briefing: "First briefing.",
        recommendedLeadId: 10,
        recommendedAction: "Act on f-1.",
        rationale: "Why f-1.",
        reasons: ["Reason 1"],
      };

      // Call 1
      const res1 = await fetch(`${baseUrl}/mission-coach`, {
        headers: { Authorization: `Bearer ${validToken}` },
      });
      assert.equal(res1.status, 200);
      assert.equal(capturedAiCalls.length, 1);

      // Complete previous follow-up and add a new one
      dbFollowups[0].status = "completed";
      dbFollowups[0].completed_at = new Date().toISOString();
      dbFollowups.push({
        id: "f-2",
        user_id: validUserId,
        lead_id: 10,
        channel: "phone",
        due_at: new Date().toISOString(),
        status: "pending",
        notes: "Call to confirm meeting",
        updated_at: new Date().toISOString(),
      });

      mockAiResult = {
        briefing: "All overdue actions cleared. 1 call scheduled for today.",
        recommendedLeadId: 10,
        recommendedAction: "Call to confirm meeting details.",
        rationale: "Apex Dental is warm and ready for conversation.",
        reasons: ["Due today", "Warm conversation"],
      };

      const res2 = await fetch(`${baseUrl}/mission-coach`, {
        headers: { Authorization: `Bearer ${validToken}` },
      });
      const data2 = await res2.json();

      assert.equal(res2.status, 200);
      assert.equal(data2.cached, false);
      assert.equal(data2.recommendedAction, "Call to confirm meeting details.");
      // Second LLM call triggered
      assert.equal(capturedAiCalls.length, 2);
    });

    test("Changing an existing mission's priority or due date invalidates cache with identical counts", async () => {
      userPlan = "pro";
      const tomorrowIso = new Date(Date.now() + 86400000).toISOString();
      dbLeads = [
        {
          id: 20,
          user_id: validUserId,
          business_name: "Summit Plumbing",
          niche: "plumber",
          status: "contacted",
          opportunity_score: 75,
          priority: "normal",
          updated_at: new Date().toISOString(),
        },
      ];
      dbFollowups = [
        {
          id: "f-summit",
          user_id: validUserId,
          lead_id: 20,
          channel: "email",
          due_at: tomorrowIso,
          status: "pending",
          notes: "Follow-up #1",
          updated_at: new Date().toISOString(),
        },
      ];

      mockAiResult = {
        briefing: "1 upcoming follow-up scheduled for tomorrow.",
        recommendedLeadId: 20,
        recommendedAction: "Prepare email draft.",
        rationale: "Summit Plumbing is upcoming tomorrow.",
        reasons: ["Upcoming tomorrow"],
      };

      // Call 1: Primes cache
      const res1 = await fetch(`${baseUrl}/mission-coach`, {
        headers: { Authorization: `Bearer ${validToken}` },
      });
      assert.equal(res1.status, 200);
      assert.equal(capturedAiCalls.length, 1);

      // Repeat without changes: Cache hit
      const resCache = await fetch(`${baseUrl}/mission-coach`, {
        headers: { Authorization: `Bearer ${validToken}` },
      });
      const dataCache = await resCache.json();
      assert.equal(dataCache.cached, true);
      assert.equal(capturedAiCalls.length, 1);

      // 1. Change mission priority on existing lead (from normal to high)
      dbLeads[0].priority = "high";
      const resPriority = await fetch(`${baseUrl}/mission-coach`, {
        headers: { Authorization: `Bearer ${validToken}` },
      });
      const dataPriority = await resPriority.json();
      assert.equal(resPriority.status, 200);
      assert.equal(dataPriority.cached, false);
      assert.equal(capturedAiCalls.length, 2);

      // 2. Change due date within upcoming bucket (e.g., from tomorrow to 5 days out)
      dbFollowups[0].due_at = new Date(Date.now() + 5 * 86400000).toISOString();
      const resDueDate = await fetch(`${baseUrl}/mission-coach`, {
        headers: { Authorization: `Bearer ${validToken}` },
      });
      const dataDueDate = await resDueDate.json();
      assert.equal(resDueDate.status, 200);
      assert.equal(dataDueDate.cached, false);
      assert.equal(capturedAiCalls.length, 3);
    });

    test("A mission status change without changing aggregate counts invalidates mission-coach cache", async () => {
      userPlan = "pro";
      const pastDate = new Date(Date.now() - 2 * 86400000).toISOString();
      const futureDate = new Date(Date.now() + 2 * 86400000).toISOString();

      dbLeads = [
        {
          id: 31,
          user_id: validUserId,
          business_name: "Lead Alpha",
          niche: "legal",
          status: "replied",
          opportunity_score: 88,
          priority: "high",
          updated_at: new Date().toISOString(),
        },
        {
          id: 32,
          user_id: validUserId,
          business_name: "Lead Beta",
          niche: "finance",
          status: "replied",
          opportunity_score: 85,
          priority: "normal",
          updated_at: new Date().toISOString(),
        },
      ];

      // Initially: Alpha is overdue (1), Beta is upcoming (1). Aggregate: overdue=1, upcoming=1, dueToday=0.
      dbFollowups = [
        {
          id: "f-alpha",
          user_id: validUserId,
          lead_id: 31,
          channel: "email",
          due_at: pastDate,
          status: "pending",
          notes: "Alpha overdue follow-up",
          updated_at: new Date().toISOString(),
        },
        {
          id: "f-beta",
          user_id: validUserId,
          lead_id: 32,
          channel: "phone",
          due_at: futureDate,
          status: "pending",
          notes: "Beta upcoming follow-up",
          updated_at: new Date().toISOString(),
        },
      ];

      mockAiResult = {
        briefing: "Alpha is overdue; handle immediately.",
        recommendedLeadId: 31,
        recommendedAction: "Send reminder to Alpha.",
        rationale: "Alpha is overdue.",
        reasons: ["Overdue 2 days"],
      };

      const res1 = await fetch(`${baseUrl}/mission-coach`, {
        headers: { Authorization: `Bearer ${validToken}` },
      });
      assert.equal(res1.status, 200);
      assert.equal(capturedAiCalls.length, 1);

      // Now swap statuses/dates: Beta is now overdue (1), Alpha is now upcoming (1).
      // Aggregate counts are STILL: overdue=1, upcoming=1, dueToday=0, completed=0!
      dbFollowups[0].due_at = futureDate;
      dbFollowups[1].due_at = pastDate;

      mockAiResult = {
        briefing: "Beta is overdue; handle immediately.",
        recommendedLeadId: 32,
        recommendedAction: "Call Beta now.",
        rationale: "Beta is overdue.",
        reasons: ["Overdue 2 days"],
      };

      const res2 = await fetch(`${baseUrl}/mission-coach`, {
        headers: { Authorization: `Bearer ${validToken}` },
      });
      const data2 = await res2.json();
      assert.equal(res2.status, 200);
      assert.equal(data2.cached, false);
      assert.equal(data2.recommendedLeadId, 32);
      // Confirmed invalidation even with identical aggregate bucket counts
      assert.equal(capturedAiCalls.length, 2);
    });

    test("A different mission becoming highest-priority recommendation invalidates mission-coach cache", async () => {
      userPlan = "pro";
      const yesterday = new Date(Date.now() - 86400000).toISOString();
      dbLeads = [
        {
          id: 41,
          user_id: validUserId,
          business_name: "Prospect One",
          niche: "retail",
          status: "new",
          opportunity_score: 50,
          priority: "normal",
          updated_at: new Date().toISOString(),
        },
        {
          id: 42,
          user_id: validUserId,
          business_name: "Prospect Two",
          niche: "tech",
          status: "new",
          opportunity_score: 60,
          priority: "normal",
          updated_at: new Date().toISOString(),
        },
      ];
      dbFollowups = [
        {
          id: "f-one",
          user_id: validUserId,
          lead_id: 41,
          channel: "email",
          due_at: yesterday,
          status: "pending",
          notes: "Task 1",
          updated_at: new Date().toISOString(),
        },
        {
          id: "f-two",
          user_id: validUserId,
          lead_id: 42,
          channel: "email",
          due_at: yesterday,
          status: "pending",
          notes: "Task 2",
          updated_at: new Date().toISOString(),
        },
      ];

      // Prospect Two has higher opportunity score (60 vs 50), so Prospect Two is top recommendation
      mockAiResult = {
        briefing: "Prioritize Prospect Two.",
        recommendedLeadId: 42,
        recommendedAction: "Email Prospect Two.",
        rationale: "Higher opportunity score.",
        reasons: ["Score 60"],
      };

      const res1 = await fetch(`${baseUrl}/mission-coach`, {
        headers: { Authorization: `Bearer ${validToken}` },
      });
      assert.equal(res1.status, 200);
      assert.equal(capturedAiCalls.length, 1);

      // Now Prospect One's score increases to 95 and priority becomes high
      dbLeads[0].opportunity_score = 95;
      dbLeads[0].priority = "high";

      mockAiResult = {
        briefing: "Prioritize Prospect One.",
        recommendedLeadId: 41,
        recommendedAction: "Email Prospect One immediately.",
        rationale: "Now highest priority prospect.",
        reasons: ["High priority", "Score 95"],
      };

      const res2 = await fetch(`${baseUrl}/mission-coach`, {
        headers: { Authorization: `Bearer ${validToken}` },
      });
      const data2 = await res2.json();
      assert.equal(res2.status, 200);
      assert.equal(data2.cached, false);
      assert.equal(data2.recommendedLeadId, 41);
      assert.equal(capturedAiCalls.length, 2);
    });

    test("Honest 500 error when AI provider fails on entitled request", async () => {
      userPlan = "pro";
      dbFollowups = [
        {
          id: "f-3",
          user_id: validUserId,
          lead_id: 10,
          channel: "email",
          due_at: new Date().toISOString(),
          status: "pending",
          updated_at: new Date().toISOString(),
        },
      ];
      mockAiResult = new Error("AI service unavailable");

      const res = await fetch(`${baseUrl}/mission-coach`, {
        headers: { Authorization: `Bearer ${validToken}` },
      });
      assert.equal(res.status, 500);
    });
  });
});
