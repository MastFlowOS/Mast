import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import jwt from "jsonwebtoken";
import { outreachRouter } from "../outreach.js";
import { env } from "../../../config/env.js";
import { supabaseAdmin } from "../../../lib/supabaseAdmin.js";
import { setAiClient, resetAiClient } from "../../../lib/ai.js";

describe("POST /v1/outreach/draft", () => {
  let app: express.Express;
  let server: any;
  let baseUrl: string;
  let originalEnvKey: string | undefined;

  const validUserId = "user-123";
  const otherUserId = "user-999";
  const validToken = jwt.sign({ sub: validUserId, email: "pro@example.com" }, env.SUPABASE_JWT_SECRET, { algorithm: "HS256" });
  const otherUserToken = jwt.sign({ sub: otherUserId, email: "other@example.com" }, env.SUPABASE_JWT_SECRET, { algorithm: "HS256" });

  let userPlan = "pro";
  let dbLeads: any[] = [];
  let dbBusinesses: any[] = [];
  let lastCapturedDeepSeekCall: { model: string; system: string; user: any } | null = null;
  let mockDeepSeekResponse: any = {
    content: [{ type: "text", text: JSON.stringify({ subject: "Custom Subject", body: "Custom Generated Body" }) }],
  };

  before(async () => {
    originalEnvKey = env.DEEPSEEK_API_KEY;
    (env as any).DEEPSEEK_API_KEY = "test-deepseek-key";

    app = express();
    app.use(express.json());
    app.use("/v1/outreach", outreachRouter);
    app.use((err: any, _req: any, res: any, _next: any) => {
      res.status(err.status || 500).json({ code: "internal_error", message: err.message || "Internal error" });
    });

    await new Promise<void>((resolve) => {
      server = app.listen(0, "127.0.0.1", () => {
        const port = (server.address() as any).port;
        baseUrl = `http://127.0.0.1:${port}/v1/outreach`;
        resolve();
      });
    });
  });

  after(async () => {
    (env as any).DEEPSEEK_API_KEY = originalEnvKey;
    resetAiClient();
    if (server) server.close();
  });

  beforeEach(() => {
    userPlan = "pro";
    lastCapturedDeepSeekCall = null;
    mockDeepSeekResponse = {
      content: [{ type: "text", text: JSON.stringify({ subject: "Custom Subject", body: "Custom Generated Body" }) }],
    };

    dbLeads = [
      {
        id: 1,
        user_id: validUserId,
        business_id: "biz-1",
        business_name: "Apex Dental Studio",
        niche: "dentist",
        email: "contact@apexdental.com",
        phone: "+15551234567",
        website: "https://apexdental.com",
        instagram_handle: "apexdental",
        location: "Austin, TX",
        status: "new",
        priority: "high",
        opportunity_score: 85,
      },
      {
        id: 2,
        user_id: otherUserId, // belongs to another user
        business_id: "biz-2",
        business_name: "Secret Cafe",
        niche: "coffee_shop",
        email: "cafe@secret.com",
        status: "new",
        opportunity_score: 90,
      },
    ];

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
      },
    ];

    // Mock Supabase
    (supabaseAdmin as any).from = (table: string) => {
      if (table === "profiles") {
        return {
          select: () => ({
            eq: (_col: string, val: string) => ({
              single: async () => ({
                data: { subscription_plan: userPlan },
                error: null,
              }),
            }),
          }),
        };
      }
      if (table === "leads") {
        return {
          select: () => ({
            eq: (col1: string, val1: any) => ({
              eq: (col2: string, val2: any) => ({
                maybeSingle: async () => {
                  const found = dbLeads.find((l) => l[col1] === val1 && l[col2] === val2);
                  return { data: found || null, error: null };
                },
              }),
            }),
          }),
        };
      }
      if (table === "businesses") {
        return {
          select: () => ({
            eq: (_col: string, val: string) => ({
              maybeSingle: async () => {
                const found = dbBusinesses.find((b) => b.id === val);
                return { data: found || null, error: null };
              },
            }),
          }),
        };
      }
      throw new Error(`Unsupported mock table: ${table}`);
    };

    // Mock DeepSeek client
    setAiClient({
      messages: {
        create: async (params: any) => {
          lastCapturedDeepSeekCall = {
            model: params.model,
            system: params.system,
            user: JSON.parse(params.messages[0].content),
          };
          if (mockDeepSeekResponse instanceof Error) {
            throw mockDeepSeekResponse;
          }
          return mockDeepSeekResponse;
        },
      },
    } as any);
  });

  test("rejects unauthenticated requests with 401", async () => {
    const res = await fetch(`${baseUrl}/draft`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ leadId: 1, channel: "email" }),
    });
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.equal(body.code, "unauthenticated");
  });

  test("rejects invalid token with 401", async () => {
    const res = await fetch(`${baseUrl}/draft`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer invalid-token",
      },
      body: JSON.stringify({ leadId: 1, channel: "email" }),
    });
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.equal(body.code, "invalid_token");
  });

  test("rejects users on free plan with 403 plan_restricted", async () => {
    userPlan = "free";
    const res = await fetch(`${baseUrl}/draft`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${validToken}`,
      },
      body: JSON.stringify({ leadId: 1, channel: "email" }),
    });
    assert.equal(res.status, 403);
    const body = await res.json();
    assert.equal(body.code, "plan_restricted");
  });

  test("prevents cross-user lead access and returns 404 for leads of another user", async () => {
    // Lead 2 belongs to otherUserId, request is made with validToken (validUserId)
    const res = await fetch(`${baseUrl}/draft`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${validToken}`,
      },
      body: JSON.stringify({ leadId: 2, channel: "email" }),
    });
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.equal(body.code, "not_found");
  });

  test("returns 400 for invalid leadId, channel, or action", async () => {
    // Invalid leadId
    let res = await fetch(`${baseUrl}/draft`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${validToken}` },
      body: JSON.stringify({ leadId: "invalid", channel: "email" }),
    });
    assert.equal(res.status, 400);

    // Invalid channel
    res = await fetch(`${baseUrl}/draft`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${validToken}` },
      body: JSON.stringify({ leadId: 1, channel: "tiktok" }),
    });
    assert.equal(res.status, 400);

    // Invalid action
    res = await fetch(`${baseUrl}/draft`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${validToken}` },
      body: JSON.stringify({ leadId: 1, channel: "email", action: "dance" }),
    });
    assert.equal(res.status, 400);
  });

  test("returns 400 when rewrite/shorten/expand is attempted without an existing draft body", async () => {
    const res = await fetch(`${baseUrl}/draft`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${validToken}` },
      body: JSON.stringify({ leadId: 1, channel: "email", action: "rewrite", body: "   " }),
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.code, "missing_body");
  });

  test("generates message with Fast tier default, passing lead facts and personalization", async () => {
    mockDeepSeekResponse = {
      content: [{ type: "text", text: JSON.stringify({ subject: "Apex Dental Question", body: "Hi team, loved your reviews." }) }],
    };

    const res = await fetch(`${baseUrl}/draft`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${validToken}` },
      body: JSON.stringify({
        leadId: 1,
        channel: "email",
        action: "generate",
        tone: "friendly",
        senderName: "Jordan",
        contextNotes: "Specializes in pediatric dentistry",
        personalization: {
          businessNameAndNiche: true,
          locationAndLocalMarket: true,
          businessReviewsAndReputation: true,
        },
      }),
    });

    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.subject, "Apex Dental Question");
    assert.equal(data.body, "Hi team, loved your reviews.");
    assert.equal(data.channel, "email");
    assert.equal(data.action, "generate");
    assert.equal(data.tier, "fast");
    assert.equal(data.model, "deepseek-flash");

    // Verify DeepSeek received lead facts and settings
    assert.ok(lastCapturedDeepSeekCall);
    assert.equal(lastCapturedDeepSeekCall.model, "deepseek-flash");
    assert.equal(lastCapturedDeepSeekCall.user.leadData.businessName, "Apex Dental Studio");
    assert.equal(lastCapturedDeepSeekCall.user.leadData.niche, "dentist");
    assert.equal(lastCapturedDeepSeekCall.user.contextNotes, "Specializes in pediatric dentistry");
    assert.equal(lastCapturedDeepSeekCall.user.senderName, "Jordan");
    assert.equal(lastCapturedDeepSeekCall.user.personalizationSettings.includeBusinessNameAndNiche, true);
    assert.equal(lastCapturedDeepSeekCall.user.personalizationSettings.includeReviewsAndReputation, true);
  });

  test("supports rewrite action and passes customInstructions", async () => {
    mockDeepSeekResponse = {
      content: [{ type: "text", text: JSON.stringify({ subject: "Quick question", body: "Rewritten more directly." }) }],
    };

    const res = await fetch(`${baseUrl}/draft`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${validToken}` },
      body: JSON.stringify({
        leadId: 1,
        channel: "email",
        action: "rewrite",
        body: "Existing initial draft body",
        customInstructions: "Make it more direct and ask for a 10-minute call",
        tone: "direct",
      }),
    });

    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.body, "Rewritten more directly.");
    assert.equal(data.action, "rewrite");

    assert.ok(lastCapturedDeepSeekCall);
    assert.equal(lastCapturedDeepSeekCall.user.action, "rewrite");
    assert.equal(lastCapturedDeepSeekCall.user.customInstructions, "Make it more direct and ask for a 10-minute call");
    assert.equal(lastCapturedDeepSeekCall.user.currentDraft.body, "Existing initial draft body");
    assert.equal(lastCapturedDeepSeekCall.user.tone, "direct");
  });

  test("supports shorten action", async () => {
    mockDeepSeekResponse = {
      content: [{ type: "text", text: JSON.stringify({ subject: "Quick note", body: "Short punchy pitch." }) }],
    };

    const res = await fetch(`${baseUrl}/draft`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${validToken}` },
      body: JSON.stringify({
        leadId: 1,
        channel: "email",
        action: "shorten",
        body: "Long initial draft body with too many words and fluff.",
      }),
    });

    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.body, "Short punchy pitch.");
    assert.equal(data.action, "shorten");
    assert.equal(lastCapturedDeepSeekCall?.user.action, "shorten");
  });

  test("supports expand action", async () => {
    mockDeepSeekResponse = {
      content: [{ type: "text", text: JSON.stringify({ subject: "Detailed note", body: "Expanded draft with case studies." }) }],
    };

    const res = await fetch(`${baseUrl}/draft`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${validToken}` },
      body: JSON.stringify({
        leadId: 1,
        channel: "email",
        action: "expand",
        body: "Brief initial draft.",
      }),
    });

    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.body, "Expanded draft with case studies.");
    assert.equal(data.action, "expand");
    assert.equal(lastCapturedDeepSeekCall?.user.action, "expand");
  });

  test("supports objections action", async () => {
    mockDeepSeekResponse = {
      content: [{ type: "text", text: JSON.stringify({ subject: null, body: "I completely understand budget is tight right now..." }) }],
    };

    const res = await fetch(`${baseUrl}/draft`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${validToken}` },
      body: JSON.stringify({
        leadId: 1,
        channel: "instagram",
        action: "objections",
        body: "They said they don't have budget for design services.",
        customInstructions: "Acknowledge budget constraint and offer a free mini audit first",
      }),
    });

    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.subject, null);
    assert.equal(data.action, "objections");
    assert.equal(data.channel, "instagram");
    assert.equal(lastCapturedDeepSeekCall?.user.action, "objections");
  });

  test("uses Pro tier model identifier when requested", async () => {
    mockDeepSeekResponse = {
      content: [{ type: "text", text: JSON.stringify({ subject: "Pro draft", body: "Pro tier message." }) }],
    };

    const res = await fetch(`${baseUrl}/draft`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${validToken}` },
      body: JSON.stringify({
        leadId: 1,
        channel: "email",
        action: "generate",
        tier: "pro",
      }),
    });

    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.tier, "pro");
    assert.equal(data.model, "deepseek-v4-pro");
    assert.equal(lastCapturedDeepSeekCall?.model, "deepseek-v4-pro");
  });

  test("returns 503 when AI provider is not enabled", async () => {
    const origKey = env.DEEPSEEK_API_KEY;
    try {
      delete (env as any).DEEPSEEK_API_KEY;
      resetAiClient();

      const res = await fetch(`${baseUrl}/draft`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${validToken}` },
        body: JSON.stringify({ leadId: 1, channel: "email" }),
      });

      assert.equal(res.status, 503);
      const data = await res.json();
      assert.equal(data.code, "ai_unavailable");
    } finally {
      (env as any).DEEPSEEK_API_KEY = origKey;
    }
  });

  test("preserves honest error handling when provider fails", async () => {
    mockDeepSeekResponse = new Error("DeepSeek 500 Internal Server Error");

    const res = await fetch(`${baseUrl}/draft`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${validToken}` },
      body: JSON.stringify({ leadId: 1, channel: "email" }),
    });

    assert.equal(res.status, 500);
    const data = await res.json();
    assert.ok(data.message.includes("DeepSeek 500"));
  });
});
