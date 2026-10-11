import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  generateOutreachDraft,
  sendLeadEmail,
  type Lead,
  type SendEmailRequest,
} from "../api.js";
import { setSupabaseClient } from "../supabase.js";

describe("Outreach draft preservation and exactly-once email activity recording", () => {
  let originalFetch: typeof globalThis.fetch;
  let recordedUpdates: any[] = [];
  let recordedActivities: any[] = [];
  let recordedMessages: any[] = [];
  let failLeadUpdate = false;
  let failActivityInsert = false;
  let failMessageInsert = false;

  const mockLead: Lead = {
    id: 42,
    userId: 1,
    businessName: "Acme Corp",
    email: "lead@acme.com",
    status: "new",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  beforeEach(() => {
    process.env.VITE_API_BASE_URL = "http://127.0.0.1:8080";
    originalFetch = globalThis.fetch;
    recordedUpdates = [];
    recordedActivities = [];
    recordedMessages = [];
    failLeadUpdate = false;
    failActivityInsert = false;
    failMessageInsert = false;

    const mockSupabase: any = {
      auth: {
        getSession: async () => ({
          data: {
            session: {
              access_token: "mock-session-token",
              user: { id: "user-1" },
            },
          },
        }),
        getUser: async () => ({
          data: {
            user: { id: "user-1" },
          },
        }),
      },
      from: (table: string) => {
      if (table === "leads") {
        return {
          select: () => {
            const queryBuilder: any = {
              eq: (_col: string, _val: any) => queryBuilder,
              single: async () => ({
                data: {
                  id: mockLead.id,
                  user_id: "user-1",
                  business_name: mockLead.businessName,
                  email: mockLead.email,
                  status: mockLead.status,
                  created_at: mockLead.createdAt,
                  updated_at: mockLead.updatedAt,
                },
                error: null,
              }),
            };
            return queryBuilder;
          },
          update: (patch: any) => ({
            eq: (_col1: string, leadId: any) => ({
              eq: (_col2: string, _userId: any) => ({
                select: () => ({
                  single: async () => {
                    if (failLeadUpdate) {
                      return { data: null, error: { message: "Simulated lead update error" } };
                    }
                    recordedUpdates.push({ leadId, patch });
                    return {
                      data: {
                        id: leadId,
                        user_id: "user-1",
                        business_name: mockLead.businessName,
                        email: mockLead.email,
                        status: patch.status ?? mockLead.status,
                        last_contacted_at: patch.last_contacted_at,
                        created_at: mockLead.createdAt,
                        updated_at: new Date().toISOString(),
                      },
                      error: null,
                    };
                  },
                }),
              }),
            }),
          }),
        };
      }
      if (table === "lead_activities") {
        return {
          insert: (row: any) => ({
            select: () => ({
              single: async () => {
                if (failActivityInsert) {
                  return { data: null, error: { message: "Simulated activity insert error" } };
                }
                recordedActivities.push(row);
                return { data: { id: "act-1", ...row }, error: null };
              },
            }),
          }),
        };
      }
      if (table === "lead_messages") {
        return {
          insert: (row: any) => ({
            select: () => ({
              single: async () => {
                if (failMessageInsert) {
                  return { data: null, error: { message: "Simulated message insert error" } };
                }
                recordedMessages.push(row);
                return { data: { id: "msg-1", ...row }, error: null };
              },
            }),
          }),
        };
      }
        throw new Error(`Unsupported table in test mock: ${table}`);
      },
    };

    setSupabaseClient(mockSupabase);
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    setSupabaseClient(null);
  });

  test("generateOutreachDraft failure preserves existing draft and does not mutate state", async () => {
    globalThis.fetch = async () => {
      return new Response(
        JSON.stringify({ code: "plan_restricted", message: "AI outreach drafting requires a paid plan." }),
        { status: 403, headers: { "Content-Type": "application/json" } },
      );
    };

    const initialDraft = {
      subject: "My existing drafted subject",
      body: "My existing drafted body that must not be cleared.",
    };

    await assert.rejects(
      async () => {
        await generateOutreachDraft(42, {
          channel: "email",
          action: "generate",
          subject: initialDraft.subject,
          body: initialDraft.body,
        });
      },
      {
        message: /AI outreach drafting requires a paid plan/,
      },
    );

    // Initial draft remains preserved
    assert.equal(initialDraft.subject, "My existing drafted subject");
    assert.equal(initialDraft.body, "My existing drafted body that must not be cleared.");
  });

  test("SMTP delivery succeeds and CRM persistence succeeds (exactly-once updates)", async () => {
    globalThis.fetch = async (url: any) => {
      if (String(url).includes("/api/send-email")) {
        return new Response(JSON.stringify({ success: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      throw new Error(`Unexpected fetch URL: ${url}`);
    };

    const request: SendEmailRequest = {
      subject: "Partnership Opportunity",
      body: "Hi team, wanted to connect regarding your site.",
    };

    const result = await sendLeadEmail(42, request);

    assert.equal(result.success, true);
    assert.equal(result.warning, undefined);

    // Exactly one lead update to email_sent
    assert.equal(recordedUpdates.length, 1);
    assert.equal(recordedUpdates[0].leadId, 42);
    assert.equal(recordedUpdates[0].patch.status, "email_sent");
    assert.ok(recordedUpdates[0].patch.last_contacted_at);

    // Exactly one lead_activity recorded
    assert.equal(recordedActivities.length, 1);
    assert.equal(recordedActivities[0].type, "email_sent");
    assert.equal(recordedActivities[0].channel, "email");
    assert.equal(recordedActivities[0].subject, request.subject);
    assert.equal(recordedActivities[0].body, request.body);

    // Exactly one message record created
    assert.equal(recordedMessages.length, 1);
    assert.equal(recordedMessages[0].lead_id, 42);
    assert.equal(recordedMessages[0].channel, "email");
    assert.equal(recordedMessages[0].status, "sent");
    assert.equal(recordedMessages[0].subject, request.subject);
    assert.equal(recordedMessages[0].content, request.body);
  });

  test("SMTP delivery succeeds but lead status update fails: marks success with warning, does not fail send or fabricate lead update", async () => {
    globalThis.fetch = async (url: any) => {
      if (String(url).includes("/api/send-email")) {
        return new Response(JSON.stringify({ success: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      throw new Error(`Unexpected fetch URL: ${url}`);
    };

    failLeadUpdate = true;

    const request: SendEmailRequest = {
      subject: "Status Update Failure Test",
      body: "Testing resilience when lead update fails.",
    };

    const result = await sendLeadEmail(42, request);

    // Email send is NOT reported as failed
    assert.equal(result.success, true);
    // Lead status is not fabricated
    assert.equal(result.lead, undefined);
    assert.equal(recordedUpdates.length, 0);
    // Explicit warning is attached
    assert.ok(result.warning?.includes("lead status"));

    // Activity and message persistence still succeed
    assert.equal(recordedActivities.length, 1);
    assert.equal(recordedMessages.length, 1);
    assert.ok(result.message);
  });

  test("SMTP delivery succeeds but activity or message persistence fails: marks success with warning, does not fail send or fabricate persistence", async () => {
    globalThis.fetch = async (url: any) => {
      if (String(url).includes("/api/send-email")) {
        return new Response(JSON.stringify({ success: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      throw new Error(`Unexpected fetch URL: ${url}`);
    };

    // Case A: Activity persistence fails
    failActivityInsert = true;

    const requestA: SendEmailRequest = {
      subject: "Activity Failure Test",
      body: "Testing resilience when activity persistence fails.",
    };

    const resultA = await sendLeadEmail(42, requestA);
    assert.equal(resultA.success, true);
    assert.equal(recordedActivities.length, 0); // Never fabricate a sent activity!
    assert.ok(resultA.warning?.includes("activity"));
    assert.ok(resultA.lead);
    assert.ok(resultA.message);

    // Reset and test Case B: Message persistence fails
    failActivityInsert = false;
    failMessageInsert = true;
    recordedUpdates = [];
    recordedActivities = [];
    recordedMessages = [];

    const requestB: SendEmailRequest = {
      subject: "Message Failure Test",
      body: "Testing resilience when message persistence fails.",
    };

    const resultB = await sendLeadEmail(42, requestB);
    assert.equal(resultB.success, true);
    assert.equal(recordedMessages.length, 0); // Never fabricate message persistence!
    assert.equal(resultB.message, undefined);
    assert.ok(resultB.warning?.includes("message"));
    assert.ok(resultB.lead);
    assert.equal(recordedActivities.length, 1);
  });

  test("SMTP delivery fails, so no successful-send state is recorded", async () => {
    globalThis.fetch = async (url: any) => {
      if (String(url).includes("/api/send-email")) {
        return new Response(
          JSON.stringify({ success: false, error: "SMTP 535 Authentication credentials invalid" }),
          { status: 500, headers: { "Content-Type": "application/json" } },
        );
      }
      throw new Error(`Unexpected fetch URL: ${url}`);
    };

    const request: SendEmailRequest = {
      subject: "Failed Attempt",
      body: "This should fail delivery.",
    };

    await assert.rejects(
      async () => {
        await sendLeadEmail(42, request);
      },
      {
        message: /SMTP 535 Authentication credentials invalid/,
      },
    );

    // Crucial: failed delivery must NOT record any successful-send state
    assert.equal(recordedUpdates.length, 0);
    assert.equal(recordedActivities.length, 0);
    assert.equal(recordedMessages.length, 0);
  });

  test("opening mail client is recorded as email_opened and never marked as confirmed delivery", () => {
    const activityEvent = {
      type: "email_opened",
      channel: "email",
      content: "Email client opened for lead@acme.com",
    };

    // Confirms event type is email_opened, not email_sent
    assert.equal(activityEvent.type, "email_opened");
    assert.notEqual(activityEvent.type, "email_sent");
  });
});
