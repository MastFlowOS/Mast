import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import jwt from "jsonwebtoken";
import { outreachRouter, resetOutreachRateLimiter } from "../outreach.js";
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
  const validToken = jwt.sign(
    { sub: validUserId, email: "pro@example.com" },
    env.SUPABASE_JWT_SECRET,
    { algorithm: "HS256" },
  );
  const otherUserToken = jwt.sign(
    { sub: otherUserId, email: "other@example.com" },
    env.SUPABASE_JWT_SECRET,
    { algorithm: "HS256" },
  );

  let userPlan = "pro";
  let dbLeads: any[] = [];
  let dbBusinesses: any[] = [];
  let lastCapturedDeepSeekCall: { model: string; system: string; user: any } | null = null;
  let mockDeepSeekResponse: any = {
    content: [
      {
        type: "text",
        text: JSON.stringify({ subject: "Custom Subject", body: "Custom Generated Body" }),
      },
    ],
  };

  before(async () => {
    originalEnvKey = env.DEEPSEEK_API_KEY;
    (env as any).DEEPSEEK_API_KEY = "test-deepseek-key";

    app = express();
    app.use(express.json());
    app.use("/v1/outreach", outreachRouter);
    app.use((err: any, _req: any, res: any, _next: any) => {
      res
        .status(err.status || 500)
        .json({ code: "internal_error", message: err.message || "Internal error" });
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
    resetOutreachRateLimiter();
    userPlan = "pro";
    lastCapturedDeepSeekCall = null;
    mockDeepSeekResponse = {
      content: [
        {
          type: "text",
          text: JSON.stringify({ subject: "Custom Subject", body: "Custom Generated Body" }),
        },
      ],
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
    userPlan = "starter";
    mockDeepSeekResponse = {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            subject: "Apex Dental Question",
            body: "Hi team, loved your reviews.",
          }),
        },
      ],
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
    assert.equal(
      lastCapturedDeepSeekCall.user.personalizationSettings.includeBusinessNameAndNiche,
      true,
    );
    assert.equal(
      lastCapturedDeepSeekCall.user.personalizationSettings.includeReviewsAndReputation,
      true,
    );
  });

  test("supports rewrite action and passes customInstructions", async () => {
    mockDeepSeekResponse = {
      content: [
        {
          type: "text",
          text: JSON.stringify({ subject: "Quick question", body: "Rewritten more directly." }),
        },
      ],
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
    assert.equal(
      lastCapturedDeepSeekCall.user.customInstructions,
      "Make it more direct and ask for a 10-minute call",
    );
    assert.equal(lastCapturedDeepSeekCall.user.currentDraft.body, "Existing initial draft body");
    assert.equal(lastCapturedDeepSeekCall.user.tone, "direct");
  });

  test("supports shorten action", async () => {
    mockDeepSeekResponse = {
      content: [
        {
          type: "text",
          text: JSON.stringify({ subject: "Quick note", body: "Short punchy pitch." }),
        },
      ],
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
      content: [
        {
          type: "text",
          text: JSON.stringify({
            subject: "Detailed note",
            body: "Expanded draft with case studies.",
          }),
        },
      ],
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
      content: [
        {
          type: "text",
          text: JSON.stringify({
            subject: null,
            body: "I completely understand budget is tight right now...",
          }),
        },
      ],
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

  test("Pro and Premium accounts receive Pro model according to server policy", async () => {
    mockDeepSeekResponse = {
      content: [
        { type: "text", text: JSON.stringify({ subject: "Pro draft", body: "Pro tier message." }) },
      ],
    };

    userPlan = "pro";
    const res = await fetch(`${baseUrl}/draft`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${validToken}` },
      body: JSON.stringify({
        leadId: 1,
        channel: "email",
        action: "generate",
      }),
    });

    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.tier, "pro");
    assert.equal(data.model, "deepseek-v4-pro");
    assert.equal(lastCapturedDeepSeekCall?.model, "deepseek-v4-pro");

    // Premium plan also receives Pro model
    userPlan = "premium";
    const resPrem = await fetch(`${baseUrl}/draft`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${validToken}` },
      body: JSON.stringify({
        leadId: 1,
        channel: "email",
        action: "generate",
      }),
    });
    assert.equal(resPrem.status, 200);
    const dataPrem = await resPrem.json();
    assert.equal(dataPrem.tier, "pro");
    assert.equal(dataPrem.model, "deepseek-v4-pro");
  });

  test("Starter account requesting tier 'pro' is capped by server policy and receives Fast model", async () => {
    userPlan = "starter";
    mockDeepSeekResponse = {
      content: [
        {
          type: "text",
          text: JSON.stringify({ subject: "Starter subject", body: "Starter body." }),
        },
      ],
    };

    const res = await fetch(`${baseUrl}/draft`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${validToken}` },
      body: JSON.stringify({
        leadId: 1,
        channel: "email",
        action: "generate",
        tier: "pro", // Client requests Pro tier, but account is only Starter!
      }),
    });

    assert.equal(res.status, 200);
    const data = await res.json();
    // Must remain Fast model!
    assert.equal(data.tier, "fast");
    assert.equal(data.model, "deepseek-flash");
    assert.equal(lastCapturedDeepSeekCall?.model, "deepseek-flash");
  });

  test("Pro account explicitly requesting Fast tier receives Fast model", async () => {
    userPlan = "pro";
    mockDeepSeekResponse = {
      content: [
        { type: "text", text: JSON.stringify({ subject: "Fast choice", body: "Fast message." }) },
      ],
    };

    const res = await fetch(`${baseUrl}/draft`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${validToken}` },
      body: JSON.stringify({
        leadId: 1,
        channel: "email",
        action: "generate",
        tier: "fast",
      }),
    });

    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.tier, "fast");
    assert.equal(data.model, "deepseek-flash");
    assert.equal(lastCapturedDeepSeekCall?.model, "deepseek-flash");
  });

  test("rejects oversized inputs with 400 excessive_input", async () => {
    // 1. Oversized customInstructions (> 2000)
    let res = await fetch(`${baseUrl}/draft`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${validToken}` },
      body: JSON.stringify({ leadId: 1, channel: "email", customInstructions: "x".repeat(2001) }),
    });
    assert.equal(res.status, 400);
    let data = await res.json();
    assert.equal(data.code, "excessive_input");

    // 2. Oversized contextNotes (> 2000)
    res = await fetch(`${baseUrl}/draft`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${validToken}` },
      body: JSON.stringify({ leadId: 1, channel: "email", contextNotes: "x".repeat(2001) }),
    });
    assert.equal(res.status, 400);
    data = await res.json();
    assert.equal(data.code, "excessive_input");

    // 3. Oversized senderName (> 100)
    res = await fetch(`${baseUrl}/draft`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${validToken}` },
      body: JSON.stringify({ leadId: 1, channel: "email", senderName: "x".repeat(101) }),
    });
    assert.equal(res.status, 400);
    data = await res.json();
    assert.equal(data.code, "excessive_input");

    // 4. Oversized subject (> 250)
    res = await fetch(`${baseUrl}/draft`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${validToken}` },
      body: JSON.stringify({ leadId: 1, channel: "email", subject: "x".repeat(251) }),
    });
    assert.equal(res.status, 400);
    data = await res.json();
    assert.equal(data.code, "excessive_input");

    // 5. Oversized body (> 10000)
    res = await fetch(`${baseUrl}/draft`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${validToken}` },
      body: JSON.stringify({ leadId: 1, channel: "email", body: "x".repeat(10001) }),
    });
    assert.equal(res.status, 400);
    data = await res.json();
    assert.equal(data.code, "excessive_input");

    // 6. Oversized template (> 100)
    res = await fetch(`${baseUrl}/draft`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${validToken}` },
      body: JSON.stringify({ leadId: 1, channel: "email", template: "x".repeat(101) }),
    });
    assert.equal(res.status, 400);
    data = await res.json();
    assert.equal(data.code, "excessive_input");
  });

  test("validates field types and rejects non-string values with 400 invalid_input", async () => {
    let res = await fetch(`${baseUrl}/draft`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${validToken}` },
      body: JSON.stringify({ leadId: 1, channel: "email", senderName: 12345 }),
    });
    assert.equal(res.status, 400);
    let data = await res.json();
    assert.equal(data.code, "invalid_input");

    res = await fetch(`${baseUrl}/draft`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${validToken}` },
      body: JSON.stringify({
        leadId: 1,
        channel: "email",
        customInstructions: ["invalid", "array"],
      }),
    });
    assert.equal(res.status, 400);
    data = await res.json();
    assert.equal(data.code, "invalid_input");
  });

  test("validates tone and rejects unrecognized tone values with 400 invalid_tone", async () => {
    const res = await fetch(`${baseUrl}/draft`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${validToken}` },
      body: JSON.stringify({ leadId: 1, channel: "email", tone: "aggressive_salesman" }),
    });
    assert.equal(res.status, 400);
    const data = await res.json();
    assert.equal(data.code, "invalid_tone");
  });

  test("validates personalization object and types with 400 invalid_personalization", async () => {
    // Non-object
    let res = await fetch(`${baseUrl}/draft`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${validToken}` },
      body: JSON.stringify({ leadId: 1, channel: "email", personalization: "invalid-string" }),
    });
    assert.equal(res.status, 400);
    let data = await res.json();
    assert.equal(data.code, "invalid_personalization");

    // Unrecognized key
    res = await fetch(`${baseUrl}/draft`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${validToken}` },
      body: JSON.stringify({ leadId: 1, channel: "email", personalization: { fakeFlag: true } }),
    });
    assert.equal(res.status, 400);
    data = await res.json();
    assert.equal(data.code, "invalid_personalization");

    // Non-boolean value
    res = await fetch(`${baseUrl}/draft`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${validToken}` },
      body: JSON.stringify({
        leadId: 1,
        channel: "email",
        personalization: { businessNameAndNiche: "yes" },
      }),
    });
    assert.equal(res.status, 400);
    data = await res.json();
    assert.equal(data.code, "invalid_personalization");
  });

  test("enforces 10 requests per minute rate limit per authenticated user", async () => {
    userPlan = "starter";
    // 10 requests should succeed
    for (let i = 0; i < 10; i++) {
      const res = await fetch(`${baseUrl}/draft`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${validToken}` },
        body: JSON.stringify({ leadId: 1, channel: "email" }),
      });
      assert.equal(res.status, 200, `Request ${i + 1} should have succeeded with 200`);
    }

    // 11th request within window must be rate limited
    const res11 = await fetch(`${baseUrl}/draft`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${validToken}` },
      body: JSON.stringify({ leadId: 1, channel: "email" }),
    });
    assert.equal(res11.status, 429);
    const data11 = await res11.json();
    assert.equal(data11.code, "rate_limited");
    assert.ok(res11.headers.get("retry-after"));

    // Resetting rate limiter clears state for subsequent tests
    resetOutreachRateLimiter();
    const resAfterReset = await fetch(`${baseUrl}/draft`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${validToken}` },
      body: JSON.stringify({ leadId: 1, channel: "email" }),
    });
    assert.equal(resAfterReset.status, 200);
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

  test("generates outreach draft using OpenRouter Free when OPENROUTER_API_KEY is configured", async () => {
    const origOr = env.OPENROUTER_API_KEY;
    const origDs = env.DEEPSEEK_API_KEY;
    try {
      (env as any).OPENROUTER_API_KEY = "sk-or-v1-mock-key";
      delete (env as any).DEEPSEEK_API_KEY;

      let capturedCall: any = null;
      setAiClient({
        chat: {
          completions: {
            create: async (params: any) => {
              capturedCall = params;
              return {
                choices: [
                  {
                    message: {
                      role: "assistant",
                      content: JSON.stringify({
                        subject: "OpenRouter Free Subject",
                        body: "OpenRouter Free Message Body for Apex Dental Studio",
                      }),
                    },
                  },
                ],
              };
            },
          },
        },
      } as any);

      userPlan = "starter";
      const res = await fetch(`${baseUrl}/draft`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${validToken}` },
        body: JSON.stringify({
          leadId: 1,
          channel: "email",
          action: "generate",
        }),
      });

      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.subject, "OpenRouter Free Subject");
      assert.equal(data.body, "OpenRouter Free Message Body for Apex Dental Studio");
      assert.equal(data.model, "openrouter/free");
      assert.equal(capturedCall?.model, "openrouter/free");
      assert.equal(capturedCall?.messages?.[0]?.role, "system");
      assert.equal(capturedCall?.messages?.[1]?.role, "user");
    } finally {
      (env as any).OPENROUTER_API_KEY = origOr;
      (env as any).DEEPSEEK_API_KEY = origDs;
      resetAiClient();
    }
  });

  test("handles OpenRouter 429 rate limit error gracefully in outreach route", async () => {
    const origOr = env.OPENROUTER_API_KEY;
    try {
      (env as any).OPENROUTER_API_KEY = "sk-or-v1-mock-key";
      setAiClient({
        chat: {
          completions: {
            create: async () => {
              const err = new Error("Provider rate limit reached (openrouter free pool 20 RPM)");
              (err as any).status = 429;
              throw err;
            },
          },
        },
      } as any);

      const res = await fetch(`${baseUrl}/draft`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${validToken}` },
        body: JSON.stringify({ leadId: 1, channel: "email" }),
      });

      assert.equal(res.status, 429);
      const data = await res.json();
      assert.match(data.message, /rate limit/i);
    } finally {
      (env as any).OPENROUTER_API_KEY = origOr;
      resetAiClient();
    }
  });

  test("GET /v1/outreach/status returns safe AI configuration state without exposing secrets", async () => {
    const origOr = env.OPENROUTER_API_KEY;
    const origDs = env.DEEPSEEK_API_KEY;
    try {
      // 1. When AI is configured with OpenRouter
      (env as any).OPENROUTER_API_KEY = "sk-or-v1-mock-key";
      (env as any).DEEPSEEK_API_KEY = undefined;

      const res1 = await fetch(`${baseUrl}/status`, {
        headers: { Authorization: `Bearer ${validToken}` },
      });
      assert.equal(res1.status, 200);
      const data1 = await res1.json();
      assert.equal(data1.aiConfigured, true);
      assert.equal(typeof data1.model, "string");
      assert.equal(JSON.stringify(data1).includes("sk-or-v1-mock-key"), false);

      // 2. When AI is unconfigured
      (env as any).OPENROUTER_API_KEY = undefined;
      (env as any).DEEPSEEK_API_KEY = undefined;

      const res2 = await fetch(`${baseUrl}/status`, {
        headers: { Authorization: `Bearer ${validToken}` },
      });
      assert.equal(res2.status, 200);
      const data2 = await res2.json();
      assert.equal(data2.aiConfigured, false);
      assert.equal(data2.model, null);
    } finally {
      (env as any).OPENROUTER_API_KEY = origOr;
      (env as any).DEEPSEEK_API_KEY = origDs;
    }
  });
});
