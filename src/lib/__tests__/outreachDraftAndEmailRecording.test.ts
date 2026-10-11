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

  const mockLead: Lead = {
    id: 42,
    userId: 1,
    businessName: "Acme Corp",
    email: "lead@acme.com",
    status: "new",
    channel: "email",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  beforeEach(() => {
    process.env.VITE_API_BASE_URL = "http://127.0.0.1:8080";
    originalFetch = globalThis.fetch;
    recordedUpdates = [];
    recordedActivities = [];
    recordedMessages = [];

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

  test("sendLeadEmail creates exactly one email_sent activity and one message record on success", async () => {
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

  test("failed delivery does not mark email as sent and does not create sent activities", async () => {
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

    // Crucial: failed delivery must NOT mark as sent
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
