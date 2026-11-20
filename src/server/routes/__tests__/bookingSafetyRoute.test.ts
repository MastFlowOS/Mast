import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import jwt from "jsonwebtoken";
import { env } from "../../../config/env.js";
import { bookingDeps, bookingRouter } from "../booking.js";
import { safetyDeps, safetyRouter } from "../safety.js";
import { signUnsubscribeToken } from "../../../lib/deliverability.js";

describe("Booking Sync (/v1/booking) & Safety (/v1/safety) Routes", () => {
  let server: any;
  let baseUrl: string;

  const ownerId = "owner-prelaunch-1";
  const ownerToken = jwt.sign({ sub: ownerId, email: "owner@agency.com" }, env.SUPABASE_JWT_SECRET, {
    algorithm: "HS256",
  });

  let bookingRows: Record<string, any> = {};
  let leads: any[] = [];
  let suppressions: any[] = [];
  let activities: any[] = [];
  let notifications: any[] = [];

  function createMockDb() {
    return {
      from: (table: string) => {
        if (table === "workspace_booking_settings") {
          const filters: Record<string, any> = {};
          const builder: any = {
            select: () => builder,
            eq: (col: string, val: any) => {
              filters[col] = val;
              return builder;
            },
            maybeSingle: async () => {
              const found = Object.values(bookingRows).find((r) =>
                Object.entries(filters).every(([k, v]) => r[k] === v),
              );
              return { data: found ?? null, error: null };
            },
            insert: (payload: any) => ({
              select: () => ({
                single: async () => {
                  bookingRows[payload.owner_id] = { ...payload };
                  return { data: bookingRows[payload.owner_id], error: null };
                },
              }),
            }),
            update: (patch: any) => {
              const uFilters: Record<string, any> = {};
              const uBuilder: any = {
                eq: (col: string, val: any) => {
                  uFilters[col] = val;
                  return uBuilder;
                },
                select: () => ({
                  single: async () => {
                    const row = bookingRows[uFilters.owner_id];
                    Object.assign(row, patch);
                    return { data: row, error: null };
                  },
                }),
                then: (resolve: any) => {
                  const row = bookingRows[uFilters.owner_id];
                  if (row) Object.assign(row, patch);
                  resolve({ data: row ?? null, error: null });
                },
              };
              return uBuilder;
            },
          };
          return builder;
        }

        if (table === "leads") {
          const state: any = { eq: {}, ilike: null, updatePatch: null };
          const matchLead = (l: any) => {
            for (const [k, v] of Object.entries(state.eq)) {
              if (String(l[k]) !== String(v)) return false;
            }
            if (state.ilike) {
              if (String(l[state.ilike.col] ?? "").toLowerCase() !== String(state.ilike.val).toLowerCase()) {
                return false;
              }
            }
            return true;
          };
          const builder: any = {
            select: () => builder,
            eq: (col: string, val: any) => {
              state.eq[col] = val;
              return builder;
            },
            ilike: (col: string, val: any) => {
              state.ilike = { col, val };
              return builder;
            },
            order: () => builder,
            limit: () => builder,
            maybeSingle: async () => ({
              data: leads.find(matchLead) ?? null,
              error: null,
            }),
            update: (patch: any) => {
              state.updatePatch = patch;
              return builder;
            },
            then: (resolve: any) => {
              if (state.updatePatch) {
                for (const l of leads.filter(matchLead)) {
                  Object.assign(l, state.updatePatch);
                }
              }
              resolve({ data: leads.filter(matchLead), error: null });
            },
          };
          return builder;
        }

        if (table === "workspace_suppressions") {
          const state: any = { eq: {} };
          const builder: any = {
            select: () => builder,
            eq: (col: string, val: any) => {
              state.eq[col] = val;
              return builder;
            },
            order: () => builder,
            limit: async () => ({
              data: suppressions.filter((s) => !state.eq.owner_id || s.owner_id === state.eq.owner_id),
              error: null,
            }),
            upsert: (payload: any) => {
              const existingIdx = suppressions.findIndex(
                (s) => s.owner_id === payload.owner_id && s.kind === payload.kind && s.value === payload.value,
              );
              const row = { id: `sup-${suppressions.length + 1}`, created_at: new Date().toISOString(), ...payload };
              if (existingIdx >= 0) suppressions[existingIdx] = row;
              else suppressions.push(row);
              return {
                select: () => ({
                  single: async () => ({ data: row, error: null }),
                }),
                then: (resolve: any) => resolve({ data: row, error: null }),
              };
            },
            delete: () => ({
              eq: (c1: string, v1: any) => ({
                eq: async (c2: string, v2: any) => {
                  suppressions = suppressions.filter((s) => !(s[c1] === v1 && s[c2] === v2));
                  return { error: null };
                },
              }),
            }),
            then: (resolve: any) => {
              resolve({
                data: suppressions.filter((s) => !state.eq.owner_id || s.owner_id === state.eq.owner_id),
                error: null,
              });
            },
          };
          return builder;
        }

        if (table === "lead_activities") {
          const state: any = { eq: {} };
          const builder: any = {
            select: () => builder,
            eq: (col: string, val: any) => {
              state.eq[col] = val;
              return builder;
            },
            in: () => builder,
            gte: () => builder,
            limit: async () => ({ data: activities, error: null }),
            insert: async (payload: any) => {
              activities.push(payload);
              return { data: payload, error: null };
            },
          };
          return builder;
        }

        if (table === "user_notifications") {
          return {
            insert: async (payload: any) => {
              notifications.push(payload);
              return { data: payload, error: null };
            },
          };
        }

        throw new Error(`Unexpected table: ${table}`);
      },
    };
  }

  before(async () => {
    const app = express();
    app.use(express.json());
    app.use("/v1/booking", bookingRouter);
    app.use("/v1/safety", safetyRouter);

    await new Promise<void>((resolve) => {
      server = app.listen(0, () => {
        const addr = server.address();
        baseUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(() => {
    bookingRows = {
      [ownerId]: {
        owner_id: ownerId,
        provider: "calcom",
        booking_url: "https://cal.com/agency/15min",
        webhook_token: "tok_booking_secret_123",
        auto_move_stage: true,
        last_event_at: null,
      },
    };
    leads = [
      {
        id: 42,
        user_id: ownerId,
        business_name: "Harbor Coffee",
        email: "founder@harborcoffee.com",
        website: "https://harborcoffee.com",
        instagram_handle: "harborcoffee",
        status: "replied",
      },
    ];
    suppressions = [];
    activities = [];
    notifications = [];

    const mockDb = createMockDb();
    const mockResolve = async () => ({
      authUserId: ownerId,
      workspaceOwnerId: ownerId,
      role: "owner" as const,
      isTeamMember: false,
    });

    bookingDeps.db = mockDb;
    bookingDeps.resolveWorkspaceContext = mockResolve;
    safetyDeps.db = mockDb;
    safetyDeps.resolveWorkspaceContext = mockResolve;
  });

  it("moves matching lead to meeting_booked and notifies on Cal.com booking webhook", async () => {
    const res = await fetch(`${baseUrl}/v1/booking/webhook/tok_booking_secret_123`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        triggerEvent: "BOOKING_CREATED",
        payload: {
          title: "Discovery Call",
          startTime: "2026-06-20T16:00:00Z",
          attendees: [{ name: "Sam", email: "founder@harborcoffee.com" }],
        },
      }),
    });

    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.matched, true);
    assert.equal(body.statusUpdated, true);
    assert.equal(leads[0].status, "meeting_booked");
    assert.equal(activities.length, 1);
    assert.equal(notifications.length, 1);
    assert.equal(notifications[0].type, "meeting_booked");
  });

  it("rejects unknown booking webhook tokens with 404", async () => {
    const res = await fetch(`${baseUrl}/v1/booking/webhook/unknown_token_1234567890`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "founder@harborcoffee.com" }),
    });
    assert.equal(res.status, 404);
  });

  it("processes 1-click signed unsubscribe, blocks lead on safety check, and marks lead dead", async () => {
    const token = signUnsubscribeToken(ownerId, "founder@harborcoffee.com");
    const unsubRes = await fetch(`${baseUrl}/v1/safety/unsubscribe?token=${encodeURIComponent(token)}`);
    assert.equal(unsubRes.status, 200);
    const html = await unsubRes.text();
    assert.ok(html.includes("You've been unsubscribed"));
    assert.equal(leads[0].status, "dead");
    assert.equal(suppressions.length, 1);
    assert.equal(suppressions[0].source, "unsubscribe");

    const checkRes = await fetch(`${baseUrl}/v1/safety/check-lead/42`, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    assert.equal(checkRes.status, 200);
    const checkJson = await checkRes.json();
    assert.equal(checkJson.blocked, true);
    assert.equal(checkJson.match.value, "founder@harborcoffee.com");
  });

  it("rejects invalid unsubscribe tokens with 400 HTML", async () => {
    const res = await fetch(`${baseUrl}/v1/safety/unsubscribe?token=invalid.token`);
    assert.equal(res.status, 400);
  });
});
