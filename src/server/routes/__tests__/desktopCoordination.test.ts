import { describe, test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import jwt from "jsonwebtoken";
import { randomUUID } from "node:crypto";
import { desktopRouter, desktopDeps, DESKTOP_LEASE_TTL_MS } from "../desktop.js";
import { isDesktopTaskLeased } from "../../../jobs/discoveryPlanJob.js";
import { discoverRouter, discoverDeps } from "../discover.js";
import { supabaseAdmin } from "../../../lib/supabaseAdmin.js";
import { env } from "../../../config/env.js";

describe("Desktop Discovery Cloud Coordination (/v1/desktop)", () => {
  let app: express.Express;
  let server: any;
  let baseUrl: string;
  let discoverBaseUrl: string;
  let origSupabaseRpc: any;
  let origSupabaseFrom: any;

  const userA = "user-aaa-1111";
  const userB = "user-bbb-2222";

  const tokenUserA = jwt.sign(
    { sub: userA, email: "userA@example.com" },
    env.SUPABASE_JWT_SECRET,
    { algorithm: "HS256" },
  );

  const tokenUserB = jwt.sign(
    { sub: userB, email: "userB@example.com" },
    env.SUPABASE_JWT_SECRET,
    { algorithm: "HS256" },
  );

  // In-memory data store for tests
  let mockProfiles: Record<string, any> = {};
  let mockDiscoveryTasks: Record<string, any> = {};
  let mockDiscoveryPlans: Record<string, any> = {};
  let mockDeliverLeadCalls: any[] = [];
  let mockRecordOutcomeCalls: any[] = [];
  let mockCompletePlanCalls: any[] = [];
  let mockEnqueuePlanCalls: any[] = [];

  // Create mock DB query builder
  function createMockDb() {
    return {
      from(tableName: string) {
        return {
          select(columns = "*") {
            let filters: Array<(row: any) => boolean> = [];
            let orders: Array<{ col: string; asc: boolean }> = [];
            let limitCount: number | null = null;

            const chain: any = {
              eq(col: string, val: any) {
                filters.push((row) => row[col] === val);
                return chain;
              },
              in(col: string, vals: any[]) {
                filters.push((row) => vals.includes(row[col]));
                return chain;
              },
              is(col: string, val: any) {
                filters.push((row) => row[col] === val);
                return chain;
              },
              order(col: string, opts = { ascending: true }) {
                orders.push({ col, asc: opts.ascending });
                return chain;
              },
              limit(n: number) {
                limitCount = n;
                return chain;
              },
              async maybeSingle() {
                const res = await this.execute();
                return { data: res.data?.[0] || null, error: null };
              },
              async single() {
                const res = await this.execute();
                if (!res.data || res.data.length === 0) {
                  return { data: null, error: { message: "Row not found" } };
                }
                return { data: res.data[0], error: null };
              },
              async execute() {
                let rows: any[] = [];
                if (tableName === "profiles") {
                  rows = Object.values(mockProfiles);
                } else if (tableName === "discovery_tasks") {
                  rows = Object.values(mockDiscoveryTasks);
                } else if (tableName === "discovery_plans") {
                  rows = Object.values(mockDiscoveryPlans);
                }

                let filtered = rows.filter((r) => filters.every((f) => f(r)));

                for (const o of orders) {
                  filtered.sort((a, b) => {
                    if (a[o.col] < b[o.col]) return o.asc ? -1 : 1;
                    if (a[o.col] > b[o.col]) return o.asc ? 1 : -1;
                    return 0;
                  });
                }

                if (limitCount !== null) {
                  filtered = filtered.slice(0, limitCount);
                }

                return { data: JSON.parse(JSON.stringify(filtered)), error: null };
              },
              then(resolve: any, reject: any) {
                return this.execute().then(resolve, reject);
              },
            };
            return chain;
          },

          update(patch: any) {
            let filters: Array<(row: any) => boolean> = [];
            const chain: any = {
              eq(col: string, val: any) {
                filters.push((row) => row[col] === val);
                return chain;
              },
              is(col: string, val: any) {
                filters.push((row) => row[col] === val);
                return chain;
              },
              select() {
                return chain;
              },
              async maybeSingle() {
                const res = await this.execute();
                return { data: res.data?.[0] || null, error: null };
              },
              async execute() {
                let store: Record<string, any> = {};
                if (tableName === "discovery_tasks") store = mockDiscoveryTasks;
                else if (tableName === "discovery_plans") store = mockDiscoveryPlans;

                const matched: any[] = [];
                for (const [id, row] of Object.entries(store)) {
                  if (filters.every((f) => f(row))) {
                    Object.assign(row, patch);
                    matched.push(JSON.parse(JSON.stringify(row)));
                  }
                }
                return { data: matched, error: null };
              },
              then(resolve: any, reject: any) {
                return this.execute().then(resolve, reject);
              },
            };
            return chain;
          },

          insert(recordOrRows: any) {
            const rows = Array.isArray(recordOrRows) ? recordOrRows : [recordOrRows];
            return {
              select() {
                return {
                  async single() {
                    const inserted = rows.map((r) => ({
                      id: r.id || randomUUID(),
                      ...r,
                    }));
                    if (tableName === "discovery_plans") {
                      for (const r of inserted) mockDiscoveryPlans[r.id] = r;
                    } else if (tableName === "discovery_tasks") {
                      for (const r of inserted) mockDiscoveryTasks[r.id] = r;
                    }
                    return { data: inserted[0], error: null };
                  },
                };
              },
            };
          },

          rpc(fn: string, args: any) {
            if (fn === "try_increment_lead_usage") {
              return Promise.resolve({ data: { allowed: true }, error: null });
            }
            return Promise.resolve({ data: null, error: null });
          },
        };
      },
      rpc(fn: string, args: any) {
        if (fn === "try_increment_lead_usage") {
          return Promise.resolve({ data: { allowed: true }, error: null });
        }
        return Promise.resolve({ data: null, error: null });
      },
    };
  }

  before(async () => {
    app = express();
    app.use(express.json());
    app.use("/v1/desktop", desktopRouter);
    app.use("/v1/discover", discoverRouter);

    app.use((err: any, _req: any, res: any, _next: any) => {
      res.status(err.status || 500).json({
        code: err.code || "internal_error",
        message: err.message || "Internal error",
      });
    });

    await new Promise<void>((resolve) => {
      server = app.listen(0, "127.0.0.1", () => {
        const port = (server.address() as any).port;
        baseUrl = `http://127.0.0.1:${port}/v1/desktop`;
        discoverBaseUrl = `http://127.0.0.1:${port}/v1/discover`;
        resolve();
      });
    });

    // Wire up desktop mock dependencies
    desktopDeps.db = createMockDb();
    desktopDeps.deliverLead = async (lead: any, ctx: any) => {
      mockDeliverLeadCalls.push({ lead, ctx });
      if (lead.name === "Duplicate Business") {
        return { businessId: "biz-dup", wasNewForUser: false };
      }
      return { businessId: "biz-" + randomUUID(), wasNewForUser: true };
    };
    desktopDeps.recordTaskOutcome = async (task: any, outcome: any) => {
      mockRecordOutcomeCalls.push({ task, outcome });
    };
    desktopDeps.completePlanIfDrained = async (planId: string) => {
      mockCompletePlanCalls.push(planId);
    };

    discoverDeps.enqueueDiscoveryPlan = async (req: any) => {
      mockEnqueuePlanCalls.push(req);
      return "mock-plan-" + randomUUID();
    };

    // Patch supabaseAdmin for discover route testing
    origSupabaseRpc = (supabaseAdmin as any).rpc;
    origSupabaseFrom = (supabaseAdmin as any).from;

    (supabaseAdmin as any).rpc = (fn: string, args: any) => {
      const res = {
        data: {
          allowed: true,
          subscription_plan: "pro",
          daily_leads_used: 0,
          monthly_leads_used: 0,
        },
        error: null,
      };
      return {
        single: async () => res,
        maybeSingle: async () => res,
        then: (onSuccess: any, onError: any) => Promise.resolve(res).then(onSuccess, onError),
      };
    };

    (supabaseAdmin as any).from = (table: string) => {
      if (table === "profiles") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({ data: { plan: "pro", settings: {} }, error: null }),
              single: async () => ({ data: { plan: "pro", settings: {} }, error: null }),
            }),
          }),
        };
      }
      if (table === "scrape_jobs") {
        return {
          insert: (row: any) => ({
            select: () => ({
              single: async () => ({ data: { id: randomUUID(), ...row }, error: null }),
            }),
          }),
          update: (patch: any) => ({
            eq: () => ({
              maybeSingle: async () => ({ data: null, error: null }),
              single: async () => ({ data: null, error: null }),
              then: (res: any) => Promise.resolve({ data: null, error: null }).then(res),
            }),
          }),
        };
      }
      return origSupabaseFrom ? origSupabaseFrom.call(supabaseAdmin, table) : (desktopDeps.db as any).from(table);
    };
  });

  after(() => {
    if (origSupabaseRpc) (supabaseAdmin as any).rpc = origSupabaseRpc;
    if (origSupabaseFrom) (supabaseAdmin as any).from = origSupabaseFrom;
    if (server) server.close();
  });

  beforeEach(() => {
    mockProfiles = {
      [userA]: { id: userA, plan: "pro" },
      [userB]: { id: userB, plan: "free" },
    };
    mockDiscoveryTasks = {};
    mockDiscoveryPlans = {};
    mockDeliverLeadCalls = [];
    mockRecordOutcomeCalls = [];
    mockCompletePlanCalls = [];
    mockEnqueuePlanCalls = [];
  });

  // ── 1. Unauthenticated requests are rejected ───────────────────────────────

  test("unauthenticated requests are rejected with 401 across all desktop endpoints", async () => {
    const endpoints = [
      { method: "POST", path: "/tasks/claim", body: { workerId: "worker-1" } },
      { method: "POST", path: `/tasks/${randomUUID()}/heartbeat`, body: { leaseToken: randomUUID() } },
      { method: "POST", path: `/tasks/${randomUUID()}/ingest`, body: { leaseToken: randomUUID(), batchId: "b1", candidates: [] } },
      { method: "POST", path: `/tasks/${randomUUID()}/complete`, body: { leaseToken: randomUUID(), status: "completed" } },
    ];

    for (const ep of endpoints) {
      const res = await fetch(`${baseUrl}${ep.path}`, {
        method: ep.method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(ep.body),
      });
      assert.equal(res.status, 401, `Expected 401 for ${ep.path}, got ${res.status}`);
      const data = await res.json();
      assert.equal(data.code, "unauthenticated");
    }
  });

  // ── 2. A user cannot claim or operate on another user's task ────────────────

  test("a user cannot claim, heartbeat, ingest, or complete another user's task", async () => {
    const planId = randomUUID();
    const taskId = randomUUID();
    const leaseTokenA = randomUUID();

    mockDiscoveryPlans[planId] = {
      id: planId,
      user_id: userA,
      requested_count: 10,
      delivered_count: 0,
      status: "running",
      channels: ["email"],
      region: "United States",
      profession_slug: "dentists",
    };

    mockDiscoveryTasks[taskId] = {
      id: taskId,
      plan_id: planId,
      user_id: userA, // Owned by userA
      city: "Austin",
      niche: "dentists",
      country_code: "US",
      candidate_budget: 20,
      priority: 10,
      status: "running",
      last_heartbeat_at: new Date().toISOString(),
      task_summary: {
        execution_target: "desktop",
        lease_token: leaseTokenA,
      },
    };

    // User B attempts heartbeat on User A's task
    const hbRes = await fetch(`${baseUrl}/tasks/${taskId}/heartbeat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${tokenUserB}`,
      },
      body: JSON.stringify({ leaseToken: leaseTokenA }),
    });
    assert.equal(hbRes.status, 403, "User B heartbeat on User A task should return 403");

    // User B attempts ingest on User A's task
    const ingestRes = await fetch(`${baseUrl}/tasks/${taskId}/ingest`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${tokenUserB}`,
      },
      body: JSON.stringify({
        leaseToken: leaseTokenA,
        batchId: "batch-user-b",
        candidates: [{ name: "Acme Dental" }],
      }),
    });
    assert.equal(ingestRes.status, 403, "User B ingest on User A task should return 403");

    // User B attempts complete on User A's task
    const compRes = await fetch(`${baseUrl}/tasks/${taskId}/complete`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${tokenUserB}`,
      },
      body: JSON.stringify({
        leaseToken: leaseTokenA,
        status: "completed",
      }),
    });
    assert.equal(compRes.status, 403, "User B complete on User A task should return 403");

    // User B attempts claim: should NOT receive User A's queued tasks
    const queuedTaskAId = randomUUID();
    mockDiscoveryTasks[queuedTaskAId] = {
      id: queuedTaskAId,
      plan_id: planId,
      user_id: userA,
      city: "Dallas",
      niche: "dentists",
      priority: 10,
      status: "queued",
      task_summary: { execution_target: "desktop" },
    };

    const claimRes = await fetch(`${baseUrl}/tasks/claim`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${tokenUserB}`,
      },
      body: JSON.stringify({ workerId: "worker-b" }),
    });
    assert.equal(claimRes.status, 200);
    const claimData = await claimRes.json();
    assert.equal(claimData.task, null, "User B claim must never return User A's task");
  });

  // ── 3. Concurrent claim attempts cannot assign one task to two workers ───────

  test("atomic claim ensures one task is only assigned to one worker", async () => {
    const planId = randomUUID();
    const taskId = randomUUID();

    mockDiscoveryPlans[planId] = {
      id: planId,
      user_id: userA,
      requested_count: 5,
      delivered_count: 0,
      status: "running",
      channels: ["email"],
      region: "United States",
      profession_slug: "dentists",
    };

    mockDiscoveryTasks[taskId] = {
      id: taskId,
      plan_id: planId,
      user_id: userA,
      city: "Miami",
      niche: "dentists",
      country_code: "US",
      candidate_budget: 20,
      priority: 10,
      status: "queued",
      task_summary: { execution_target: "desktop" },
    };

    // First claim succeeds
    const claim1Res = await fetch(`${baseUrl}/tasks/claim`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${tokenUserA}`,
      },
      body: JSON.stringify({ workerId: "worker-1" }),
    });
    assert.equal(claim1Res.status, 200);
    const claim1Data = await claim1Res.json();
    assert.ok(claim1Data.task, "First claim should receive the task");
    assert.equal(claim1Data.task.id, taskId);
    assert.ok(claim1Data.task.leaseToken, "Should include a lease token");

    // Second claim immediately after for another worker: task is now running with fresh lease
    const claim2Res = await fetch(`${baseUrl}/tasks/claim`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${tokenUserA}`,
      },
      body: JSON.stringify({ workerId: "worker-2" }),
    });
    assert.equal(claim2Res.status, 200);
    const claim2Data = await claim2Res.json();
    assert.equal(claim2Data.task, null, "Second worker should receive null (task is actively leased)");
  });

  // ── 4. A cloud worker cannot process a task while it has an active desktop lease ─

  test("isDesktopTaskLeased protects queued and actively running desktop tasks from cloud workers", () => {
    // Queued desktop task: cloud worker must skip
    const queuedDesktopTask = {
      id: "task-1",
      status: "queued",
      task_summary: { execution_target: "desktop" },
    };
    assert.equal(isDesktopTaskLeased(queuedDesktopTask), true);

    // Actively running desktop task with fresh heartbeat: cloud worker must skip
    const activeRunningTask = {
      id: "task-2",
      status: "running",
      last_heartbeat_at: new Date().toISOString(),
      task_summary: { execution_target: "desktop", lease_token: randomUUID() },
    };
    assert.equal(isDesktopTaskLeased(activeRunningTask), true);

    // Standard cloud task: cloud worker can run
    const standardCloudTask = {
      id: "task-3",
      status: "queued",
      task_summary: { execution_target: "cloud" },
    };
    assert.equal(isDesktopTaskLeased(standardCloudTask), false);

    // Expired desktop lease (> 60s): isDesktopTaskLeased returns false, allowing recovery
    const expiredDesktopTask = {
      id: "task-4",
      status: "running",
      last_heartbeat_at: new Date(Date.now() - 120_000).toISOString(),
      task_summary: { execution_target: "desktop", lease_token: randomUUID() },
    };
    assert.equal(isDesktopTaskLeased(expiredDesktopTask), false);
  });

  // ── 5. Expired leases can be recovered safely ────────────────────────────────

  test("expired lease can be re-claimed by another worker and invalidates old lease", async () => {
    const planId = randomUUID();
    const taskId = randomUUID();
    const oldLeaseToken = randomUUID();

    mockDiscoveryPlans[planId] = {
      id: planId,
      user_id: userA,
      requested_count: 5,
      delivered_count: 0,
      status: "running",
      channels: ["email"],
      region: "United States",
      profession_slug: null,
    };

    // Task is running, but last heartbeat was 90 seconds ago (expired lease)
    mockDiscoveryTasks[taskId] = {
      id: taskId,
      plan_id: planId,
      user_id: userA,
      city: "Seattle",
      niche: "dentists",
      country_code: "US",
      candidate_budget: 20,
      priority: 10,
      status: "running",
      last_heartbeat_at: new Date(Date.now() - 90_000).toISOString(),
      task_summary: {
        execution_target: "desktop",
        worker_id: "crashed-worker",
        lease_token: oldLeaseToken,
      },
    };

    // Worker 2 claims the task
    const claimRes = await fetch(`${baseUrl}/tasks/claim`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${tokenUserA}`,
      },
      body: JSON.stringify({ workerId: "recovered-worker" }),
    });
    assert.equal(claimRes.status, 200);
    const claimData = await claimRes.json();
    assert.ok(claimData.task, "Should reclaim expired task");
    assert.equal(claimData.task.id, taskId);
    assert.notEqual(claimData.task.leaseToken, oldLeaseToken, "Should generate fresh lease token");

    // Crashed worker tries to heartbeat with old lease: rejected with 409
    const hbRes = await fetch(`${baseUrl}/tasks/${taskId}/heartbeat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${tokenUserA}`,
      },
      body: JSON.stringify({ leaseToken: oldLeaseToken }),
    });
    assert.equal(hbRes.status, 409, "Old lease token must be rejected with 409 Conflict");
  });

  // ── 6. Invalid candidate payloads are rejected ───────────────────────────────

  test("ingest endpoint rejects invalid candidate schemas and oversized batches", async () => {
    const taskId = randomUUID();

    // Missing candidate name (invalid)
    const res1 = await fetch(`${baseUrl}/tasks/${taskId}/ingest`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${tokenUserA}`,
      },
      body: JSON.stringify({
        leaseToken: randomUUID(),
        batchId: "batch-invalid",
        candidates: [{ name: "" }], // name must have length >= 1
      }),
    });
    assert.equal(res1.status, 400);

    // Exceeding max batch size (100)
    const tooMany = Array.from({ length: 105 }, (_, i) => ({ name: `Candidate ${i}` }));
    const res2 = await fetch(`${baseUrl}/tasks/${taskId}/ingest`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${tokenUserA}`,
      },
      body: JSON.stringify({
        leaseToken: randomUUID(),
        batchId: "batch-oversize",
        candidates: tooMany,
      }),
    });
    assert.equal(res2.status, 400);
  });

  // ── 7. Duplicate ingestion retries do not create duplicate leads or charge credits twice ─

  test("duplicate ingestion retries are idempotent and do not duplicate leads or credit usage", async () => {
    const planId = randomUUID();
    const taskId = randomUUID();
    const leaseToken = randomUUID();

    mockDiscoveryPlans[planId] = {
      id: planId,
      user_id: userA,
      requested_count: 10,
      delivered_count: 0,
      status: "running",
      channels: ["email"],
      region: "United States",
      profession_slug: "dentists",
    };

    mockDiscoveryTasks[taskId] = {
      id: taskId,
      plan_id: planId,
      user_id: userA,
      city: "Boston",
      niche: "dentists",
      status: "running",
      last_heartbeat_at: new Date().toISOString(),
      task_summary: {
        execution_target: "desktop",
        lease_token: leaseToken,
      },
    };

    const batchPayload = {
      leaseToken,
      batchId: "batch-idemp-1",
      candidates: [
        { name: "First Dental Clinic", phone: "555-0101", email: "info@firstdental.com" },
      ],
    };

    // First ingestion attempt
    const res1 = await fetch(`${baseUrl}/tasks/${taskId}/ingest`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${tokenUserA}`,
      },
      body: JSON.stringify(batchPayload),
    });
    assert.equal(res1.status, 200);
    const data1 = await res1.json();
    assert.equal(data1.accepted, 1);
    assert.equal(data1.duplicates, 0);
    assert.equal(mockDeliverLeadCalls.length, 1);

    // Retrying EXACT same batchId: idempotent cache hit!
    const res2 = await fetch(`${baseUrl}/tasks/${taskId}/ingest`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${tokenUserA}`,
      },
      body: JSON.stringify(batchPayload),
    });
    assert.equal(res2.status, 200);
    const data2 = await res2.json();
    assert.equal(data2.accepted, 1);
    assert.equal(data2.batchId, "batch-idemp-1");
    // deliverLead must NOT have been called a second time
    assert.equal(mockDeliverLeadCalls.length, 1, "Cached batch must not re-invoke deliverLead");

    // Sending a duplicate lead under a NEW batchId: server-side deduplication identifies duplicate
    const res3 = await fetch(`${baseUrl}/tasks/${taskId}/ingest`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${tokenUserA}`,
      },
      body: JSON.stringify({
        leaseToken,
        batchId: "batch-idemp-2",
        candidates: [{ name: "Duplicate Business", phone: "555-0101" }],
      }),
    });
    assert.equal(res3.status, 200);
    const data3 = await res3.json();
    assert.equal(data3.accepted, 0);
    assert.equal(data3.duplicates, 1, "Duplicate lead must be counted as duplicate without credit charge");
  });

  // ── 8. Completion cannot be submitted by an unauthorized worker ───────────────

  test("completion rejects superseded lease tokens and completes plan when valid", async () => {
    const planId = randomUUID();
    const taskId = randomUUID();
    const activeLeaseToken = randomUUID();

    mockDiscoveryPlans[planId] = {
      id: planId,
      user_id: userA,
      requested_count: 5,
      delivered_count: 5,
      status: "running",
      channels: ["email"],
      region: "United States",
      profession_slug: "dentists",
    };

    mockDiscoveryTasks[taskId] = {
      id: taskId,
      plan_id: planId,
      user_id: userA,
      city: "Denver",
      niche: "dentists",
      status: "running",
      last_heartbeat_at: new Date().toISOString(),
      task_summary: {
        execution_target: "desktop",
        lease_token: activeLeaseToken,
      },
    };

    // Attempt completion with bogus lease token -> 409
    const badRes = await fetch(`${baseUrl}/tasks/${taskId}/complete`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${tokenUserA}`,
      },
      body: JSON.stringify({
        leaseToken: randomUUID(),
        status: "completed",
      }),
    });
    assert.equal(badRes.status, 409);

    // Valid completion
    const goodRes = await fetch(`${baseUrl}/tasks/${taskId}/complete`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${tokenUserA}`,
      },
      body: JSON.stringify({
        leaseToken: activeLeaseToken,
        status: "completed",
        discovered: 10,
        accepted: 5,
        rejected: 2,
        duplicates: 3,
        exhausted: true,
      }),
    });
    assert.equal(goodRes.status, 200);
    const data = await goodRes.json();
    assert.equal(data.success, true);
    assert.equal(mockRecordOutcomeCalls.length, 1);
    assert.equal(mockCompletePlanCalls.length, 1);
    assert.equal(mockCompletePlanCalls[0], planId);
  });

  // ── 9. Existing web discovery routing remains backward-compatible ───────────

  test("POST /v1/discover defaults to cloud execution target and accepts desktop target", async () => {
    // 1. Web discovery request (no execution_target specified)
    const webReq = {
      quantity: 5,
      region: "United States",
      niche: "dentists",
      channels: ["email"],
      method: "live",
    };

    const webRes = await fetch(discoverBaseUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${tokenUserA}`,
      },
      body: JSON.stringify(webReq),
    });
    assert.equal(webRes.status, 202);
    const webData = await webRes.json();
    assert.equal(webData.executionTarget, "cloud", "Default execution target must be cloud");
    assert.equal(mockEnqueuePlanCalls.length, 1);
    assert.equal(mockEnqueuePlanCalls[0].executionTarget, "cloud");

    // 2. Desktop discovery request (execution_target = "desktop")
    const desktopReq = {
      quantity: 5,
      region: "United States",
      niche: "dentists",
      channels: ["email"],
      method: "live",
      execution_target: "desktop",
    };

    const deskRes = await fetch(discoverBaseUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${tokenUserA}`,
      },
      body: JSON.stringify(desktopReq),
    });
    assert.equal(deskRes.status, 202);
    const deskData = await deskRes.json();
    assert.equal(deskData.executionTarget, "desktop");
    assert.equal(mockEnqueuePlanCalls.length, 2);
    assert.equal(mockEnqueuePlanCalls[1].executionTarget, "desktop");
  });
});
