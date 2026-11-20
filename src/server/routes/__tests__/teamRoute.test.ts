import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import jwt from "jsonwebtoken";
import { env } from "../../../config/env.js";
import { teamDeps, teamRouter } from "../team.js";
import { resolveWorkspaceContext } from "../../../lib/workspaceContext.js";

describe("Team Workspaces & Seats (/v1/team)", () => {
  let server: any;
  let baseUrl: string;

  const ownerId = "owner-1";
  const rep1Id = "rep-1";
  const rep2Id = "rep-2";
  const rep3Id = "rep-3";

  const makeToken = (sub: string, email: string) =>
    jwt.sign({ sub, email }, env.SUPABASE_JWT_SECRET, { algorithm: "HS256" });

  const ownerToken = makeToken(ownerId, "owner@agency.com");
  const rep1Token = makeToken(rep1Id, "rep1@agency.com");
  const rep2Token = makeToken(rep2Id, "rep2@agency.com");
  const rep3Token = makeToken(rep3Id, "rep3@agency.com");

  let profiles: Record<string, any> = {};
  let members: any[] = [];
  let invites: any[] = [];
  let seq = 1;

  const authEmails: Record<string, string> = {
    [ownerId]: "owner@agency.com",
    [rep1Id]: "rep1@agency.com",
    [rep2Id]: "rep2@agency.com",
    [rep3Id]: "rep3@agency.com",
  };

  function createMockDb() {
    return {
      auth: {
        admin: {
          getUserById: async (uid: string) => ({
            data: { user: authEmails[uid] ? { id: uid, email: authEmails[uid] } : null },
            error: null,
          }),
        },
      },
      from: (table: string) => {
        if (table === "profiles") {
          const state: any = { eq: {}, inList: null, selectErr: null };
          const builder: any = {
            select: (cols = "") => {
              if (/\bemail\b|\bsubscription_status\b/.test(String(cols))) {
                state.selectErr = { code: "42703", message: `Invalid column on public.profiles: ${cols}` };
              }
              return builder;
            },
            eq: (col: string, val: any) => {
              state.eq[col] = val;
              return builder;
            },
            in: (_col: string, vals: any[]) => {
              state.inList = vals;
              if (state.selectErr) return Promise.resolve({ data: null, error: state.selectErr });
              return Promise.resolve({
                data: vals.map((id) => profiles[id]).filter(Boolean),
                error: null,
              });
            },
            single: async () =>
              state.selectErr
                ? { data: null, error: state.selectErr }
                : {
                    data: profiles[state.eq.id] ?? null,
                    error: profiles[state.eq.id] ? null : { message: "Not found" },
                  },
            maybeSingle: async () =>
              state.selectErr
                ? { data: null, error: state.selectErr }
                : {
                    data: profiles[state.eq.id] ?? null,
                    error: null,
                  },
          };
          return builder;
        }

        if (table === "workspace_members") {
          const state: any = { eq: {} };
          const matches = (row: any) =>
            Object.entries(state.eq).every(([k, v]) => row[k] === v);

          const builder: any = {
            select: () => builder,
            eq: (col: string, val: any) => {
              state.eq[col] = val;
              return builder;
            },
            order: () => builder,
            maybeSingle: async () => ({
              data: members.find(matches) ?? null,
              error: null,
            }),
            then: (resolve: any) => {
              resolve({ data: members.filter(matches), error: null });
            },
            upsert: async (row: any) => {
              const existing = members.find(
                (m) => m.owner_id === row.owner_id && m.member_id === row.member_id,
              );
              if (existing) {
                Object.assign(existing, row);
              } else {
                members.push({ id: `mem-${seq++}`, created_at: new Date().toISOString(), ...row });
              }
              return { error: null };
            },
            update: (patch: any) => {
              const updState: any = { eq: {} };
              const updBuilder: any = {
                eq: (col: string, val: any) => {
                  updState.eq[col] = val;
                  return updBuilder;
                },
                then: (resolve: any) => {
                  for (const m of members) {
                    if (Object.entries(updState.eq).every(([k, v]) => m[k] === v)) {
                      Object.assign(m, patch);
                    }
                  }
                  resolve({ error: null });
                },
              };
              return updBuilder;
            },
          };
          return builder;
        }

        if (table === "workspace_invites") {
          const state: any = { eq: {}, ilike: {}, gt: {} };
          const matches = (row: any) =>
            Object.entries(state.eq).every(([k, v]) => row[k] === v) &&
            Object.entries(state.ilike).every(
              ([k, v]) => String(row[k] ?? "").toLowerCase() === String(v).toLowerCase(),
            ) &&
            Object.entries(state.gt).every(([k, v]) => String(row[k] ?? "") > String(v));

          const builder: any = {
            select: () => builder,
            eq: (col: string, val: any) => {
              state.eq[col] = val;
              return builder;
            },
            ilike: (col: string, val: any) => {
              state.ilike[col] = val;
              return builder;
            },
            gt: (col: string, val: any) => {
              state.gt[col] = val;
              return builder;
            },
            order: () => builder,
            maybeSingle: async () => ({
              data: invites.find(matches) ?? null,
              error: null,
            }),
            then: (resolve: any) => {
              resolve({ data: invites.filter(matches), error: null });
            },
            insert: (row: any) => {
              const created = {
                id: `inv-${seq++}`,
                created_at: new Date().toISOString(),
                ...row,
              };
              invites.push(created);
              return {
                select: () => ({
                  single: async () => ({ data: created, error: null }),
                }),
              };
            },
            update: (patch: any) => {
              const updState: any = { eq: {} };
              const updBuilder: any = {
                eq: (col: string, val: any) => {
                  updState.eq[col] = val;
                  return updBuilder;
                },
                then: (resolve: any) => {
                  for (const inv of invites) {
                    if (Object.entries(updState.eq).every(([k, v]) => inv[k] === v)) {
                      Object.assign(inv, patch);
                    }
                  }
                  resolve({ error: null });
                },
              };
              return updBuilder;
            },
          };
          return builder;
        }

        throw new Error(`Unexpected table ${table}`);
      },
    };
  }

  before(async () => {
    const app = express();
    app.use(express.json());
    app.use("/v1/team", teamRouter);
    app.use((err: any, _req: any, res: any, _next: any) => {
      res.status(err.status || 500).json({ message: err.message });
    });

    await new Promise<void>((resolve) => {
      server = app.listen(0, "127.0.0.1", () => {
        const port = (server.address() as any).port;
        baseUrl = `http://127.0.0.1:${port}/v1/team`;
        resolve();
      });
    });
  });

  after(() => {
    if (server) server.close();
  });

  beforeEach(() => {
    profiles = {
      [ownerId]: { id: ownerId, full_name: "Agency Owner", subscription_plan: "pro" },
      [rep1Id]: { id: rep1Id, full_name: "Rep One", subscription_plan: "free" },
      [rep2Id]: { id: rep2Id, full_name: "Rep Two", subscription_plan: "free" },
      [rep3Id]: { id: rep3Id, full_name: "Rep Three", subscription_plan: "free" },
    };
    members = [];
    invites = [];
    const db = createMockDb();
    teamDeps.db = db;
    teamDeps.resolveWorkspaceContext = (uid: string) => resolveWorkspaceContext(uid, db);
  });

  it("blocks invites on Free/Starter (1 seat) and enforces 3 seats on Pro", async () => {
    profiles[ownerId].subscription_plan = "free";
    const freeRes = await fetch(`${baseUrl}/invites`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${ownerToken}` },
      body: JSON.stringify({ email: "rep1@agency.com" }),
    });
    assert.equal(freeRes.status, 403);

    profiles[ownerId].subscription_plan = "pro";
    const inv1 = await fetch(`${baseUrl}/invites`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${ownerToken}` },
      body: JSON.stringify({ email: "rep1@agency.com" }),
    });
    assert.equal(inv1.status, 201);

    const inv2 = await fetch(`${baseUrl}/invites`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${ownerToken}` },
      body: JSON.stringify({ email: "rep2@agency.com" }),
    });
    assert.equal(inv2.status, 201);

    // 3rd invite (4th seat) must be rejected on Pro
    const inv3 = await fetch(`${baseUrl}/invites`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${ownerToken}` },
      body: JSON.stringify({ email: "rep3@agency.com" }),
    });
    assert.equal(inv3.status, 403);
    const inv3Json = await inv3.json();
    assert.equal(inv3Json.code, "seat_limit_reached");
  });

  it("accepts invite with matching email, blocks wrong email, and supports revoking/removing", async () => {
    const createRes = await fetch(`${baseUrl}/invites`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${ownerToken}` },
      body: JSON.stringify({ email: "rep1@agency.com", role: "member" }),
    });
    const { invite } = await createRes.json();

    // Wrong user email cannot accept
    const wrongAccept = await fetch(`${baseUrl}/invites/accept`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${rep2Token}` },
      body: JSON.stringify({ token: invite.token }),
    });
    assert.equal(wrongAccept.status, 403);

    // Matching user accepts
    const okAccept = await fetch(`${baseUrl}/invites/accept`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${rep1Token}` },
      body: JSON.stringify({ token: invite.token }),
    });
    assert.equal(okAccept.status, 200);

    // Rep1 sees shared team workspace via GET /v1/team
    const repViewRes = await fetch(`${baseUrl}`, {
      headers: { Authorization: `Bearer ${rep1Token}` },
    });
    const repView = await repViewRes.json();
    assert.equal(repView.isTeamMember, true);
    assert.equal(repView.workspaceOwnerId, ownerId);
    assert.equal(repView.seatUsage.activeSeats, 2);

    // Owner promotes Rep1 to admin, then Rep1 leaves
    const patchRes = await fetch(`${baseUrl}/members/${rep1Id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${ownerToken}` },
      body: JSON.stringify({ role: "admin" }),
    });
    assert.equal(patchRes.status, 200);

    const leaveRes = await fetch(`${baseUrl}/members/${rep1Id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${rep1Token}` },
    });
    assert.equal(leaveRes.status, 200);
  });
});
