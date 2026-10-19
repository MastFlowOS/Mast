import { describe, test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import jwt from "jsonwebtoken";
import { randomUUID } from "node:crypto";
import { desktopRouter, desktopDeps, DESKTOP_LEASE_TTL_MS } from "../desktop.js";
import { isDesktopTaskLeased, completePlanIfDrained } from "../../../jobs/discoveryPlanJob.js";
import { candidatePipelineDeps } from "../../../discovery/candidatePipeline.js";
import { discoverRouter, discoverDeps } from "../discover.js";
import { supabaseAdmin } from "../../../lib/supabaseAdmin.js";
import { env } from "../../../config/env.js";
import { reduceLiveDiscoveryEvent, createInitialLiveDiscoveryState } from "../../../discovery/liveDiscoveryState.js";
import { subscribeToDiscoveryLiveEvents } from "../../../discovery/liveDiscoveryEvent.js";

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
  let mockBusinesses: Record<string, any> = {};
  let mockScrapeJobs: Record<string, any> = {};
  let mockDeliverLeadCalls: any[] = [];
  let mockRecordOutcomeCalls: any[] = [];
  let mockCompletePlanCalls: any[] = [];
  let mockEnqueuePlanCalls: any[] = [];
  let mockLiveEvents: any[] = [];

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
                } else if (tableName === "businesses") {
                  rows = Object.values(mockBusinesses);
                } else if (tableName === "scrape_jobs") {
                  rows = Object.values(mockScrapeJobs);
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
              in(col: string, vals: any[]) {
                filters.push((row) => vals.includes(row[col]));
                return chain;
              },
              not(col: string, op: string, val: any) {
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
              async single() {
                const res = await this.execute();
                return { data: res.data?.[0] || null, error: null };
              },
              async execute() {
                let store: Record<string, any> = {};
                if (tableName === "discovery_tasks") store = mockDiscoveryTasks;
                else if (tableName === "discovery_plans") store = mockDiscoveryPlans;
                else if (tableName === "businesses") store = mockBusinesses;
                else if (tableName === "scrape_jobs") store = mockScrapeJobs;

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
            const doInsert = () => {
              const inserted = rows.map((r) => ({
                id: r.id || randomUUID(),
                ...r,
              }));
              if (tableName === "discovery_plans") {
                for (const r of inserted) mockDiscoveryPlans[r.id] = r;
              } else if (tableName === "discovery_tasks") {
                for (const r of inserted) mockDiscoveryTasks[r.id] = r;
              } else if (tableName === "businesses") {
                for (const r of inserted) mockBusinesses[r.id] = r;
              } else if (tableName === "scrape_jobs") {
                for (const r of inserted) mockScrapeJobs[r.id] = r;
              }
              return { data: inserted[0], error: null };
            };
            return {
              select() {
                return {
                  async single() {
                    return doInsert();
                  },
                };
              },
              then(resolve: any, reject: any) {
                return Promise.resolve(doInsert()).then(resolve, reject);
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
    desktopDeps.publishDiscoveryLiveEvent = (event: any) => {
      mockLiveEvents.push(event);
    };
    candidatePipelineDeps.upsertBusinessFromEngineLead = async (lead: any) => {
      const id = "biz-" + randomUUID();
      mockBusinesses[id] = {
        id,
        name: lead.name,
        email: lead.email || null,
        phone: lead.phone || null,
        website: lead.website || null,
        instagram: lead.instagram || null,
      };
      return id;
    };
    candidatePipelineDeps.enqueueBusinessProcessing = async () => {};
    candidatePipelineDeps.ensureEnriched = async () => {};
    candidatePipelineDeps.ensureIntelligence = async () => {};
    candidatePipelineDeps.publishDiscoveryLiveEvent = (event: any) => {
      mockLiveEvents.push(event);
    };

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
    discoverDeps.publishDiscoveryLiveEvent = (event: any) => {
      mockLiveEvents.push(event);
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
      return (desktopDeps.db as any).from(table);
    };
  });

  after(() => {
    if (origSupabaseRpc) (supabaseAdmin as any).rpc = origSupabaseRpc;
    if (origSupabaseFrom) (supabaseAdmin as any).from = origSupabaseFrom;
    if (server) server.close();
  });

  beforeEach(() => {
    mockProfiles = {
      [userA]: { id: userA, plan: "pro", subscription_plan: "pro" },
      [userB]: { id: userB, plan: "free", subscription_plan: "free" },
    };
    mockDiscoveryTasks = {};
    mockDiscoveryPlans = {};
    mockBusinesses = {};
    mockScrapeJobs = {};
    mockDeliverLeadCalls = [];
    mockRecordOutcomeCalls = [];
    mockCompletePlanCalls = [];
    mockEnqueuePlanCalls = [];
    mockLiveEvents = [];
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
        {
          name: "First Dental Clinic",
          address: "100 Main St, Boston, MA",
          maps_link: "https://www.google.com/maps/place/first-dental",
          phone: "555-0101",
          email: "info@firstdental.com",
        },
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
        candidates: [
          {
            name: "Duplicate Business",
            address: "200 Main St, Boston, MA",
            maps_link: "https://www.google.com/maps/place/dup-biz",
            phone: "555-0101",
            email: "info@dup.com",
          },
        ],
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

  // ── 10. Live discovery event stream correctly drives UI state reducer ───────

  test("live discovery emits truthful progress events across claim, ingest, and complete, correctly driving the UI state reducer", async () => {
    const planId = randomUUID();
    const taskId = randomUUID();
    const target = 5;

    mockDiscoveryPlans[planId] = {
      id: planId,
      user_id: userA,
      requested_count: target,
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
      city: "Austin",
      niche: "dentists",
      country_code: "US",
      candidate_budget: 10,
      priority: 10,
      status: "queued",
      task_summary: { execution_target: "desktop" },
    };

    // 1. Claim task -> generates scout_started and area_started events
    const claimRes = await fetch(`${baseUrl}/tasks/claim`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${tokenUserA}`,
      },
      body: JSON.stringify({ workerId: "worker-scout-1" }),
    });
    assert.equal(claimRes.status, 200);
    const claimData = await claimRes.json();
    assert.ok(claimData.task);
    const leaseToken = claimData.task.leaseToken;
    const scoutId = claimData.task.scoutId;
    assert.equal(scoutId, 1, "First worker gets real scoutId 1");

    // Verify scout_started and area_started events emitted
    const scoutStartedEvt = mockLiveEvents.find((e) => e.type === "scout_started");
    const areaStartedEvt = mockLiveEvents.find((e) => e.type === "area_started");
    assert.ok(scoutStartedEvt, "Must emit scout_started event");
    assert.ok(areaStartedEvt, "Must emit area_started event");
    assert.equal(scoutStartedEvt.scoutId, 1);
    assert.equal(scoutStartedEvt.planId, planId);

    // 2. Ingest 1 valid candidate ("Sunny Smiles Dental")
    const ingestRes1 = await fetch(`${baseUrl}/tasks/${taskId}/ingest`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${tokenUserA}`,
      },
      body: JSON.stringify({
        leaseToken,
        batchId: "batch-live-1",
        candidates: [
          {
            name: "Sunny Smiles Dental",
            address: "500 Congress Ave, Austin, TX",
            maps_link: "https://www.google.com/maps/place/sunny-smiles",
            phone: "512-555-0199",
            email: "contact@sunnysmiles.com",
            pipeline_id: "#1",
          },
        ],
      }),
    });
    assert.equal(ingestRes1.status, 200);
    const ingestData1 = await ingestRes1.json();
    assert.equal(ingestData1.accepted, 1);

    // Verify candidate_discovered and lead_delivered events emitted
    const discoveredEvt = mockLiveEvents.find((e) => e.type === "candidate_discovered" && e.businessName === "Sunny Smiles Dental");
    const deliveredEvt = mockLiveEvents.find((e) => e.type === "lead_delivered" && e.businessName === "Sunny Smiles Dental");
    assert.ok(discoveredEvt, "Must emit candidate_discovered event");
    assert.ok(deliveredEvt, "Must emit lead_delivered event");
    assert.equal(deliveredEvt.scoutId, 1);
    assert.equal(deliveredEvt.pipelineId, "#1");

    // 3. Ingest 1 invalid candidate (missing address -> rejected by validateDiscoveryCandidate)
    const ingestRes2 = await fetch(`${baseUrl}/tasks/${taskId}/ingest`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${tokenUserA}`,
      },
      body: JSON.stringify({
        leaseToken,
        batchId: "batch-live-2",
        candidates: [
          {
            name: "Vague Dental Practice",
            address: "", // missing address!
            maps_link: "https://www.google.com/maps/place/vague",
            pipeline_id: "#2",
          },
        ],
      }),
    });
    assert.equal(ingestRes2.status, 200);
    const ingestData2 = await ingestRes2.json();
    assert.equal(ingestData2.accepted, 0);
    assert.equal(ingestData2.rejected, 1);

    // Verify candidate_rejected event emitted
    const rejectedEvt = mockLiveEvents.find((e) => e.type === "candidate_rejected" && e.pipelineId === "#2");
    assert.ok(rejectedEvt, "Must emit candidate_rejected event");
    assert.equal(rejectedEvt.reason, "validateDiscoveryCandidate:missing_address");

    // 4. Complete task -> area_completed event emitted
    const completeRes = await fetch(`${baseUrl}/tasks/${taskId}/complete`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${tokenUserA}`,
      },
      body: JSON.stringify({
        leaseToken,
        status: "completed",
        discovered: 2,
        accepted: 1,
        rejected: 1,
        duplicates: 0,
        exhausted: true,
      }),
    });
    assert.equal(completeRes.status, 200);

    const areaCompletedEvt = mockLiveEvents.find((e) => e.type === "area_completed");
    assert.ok(areaCompletedEvt, "Must emit area_completed event");
    assert.equal(areaCompletedEvt.areaOutcome.accepted, 1);
    assert.equal(areaCompletedEvt.areaOutcome.rejected, 1);

    // 5. Pass all captured live events through the canonical UI reducer
    let uiState = createInitialLiveDiscoveryState(target);
    for (const evt of mockLiveEvents) {
      uiState = reduceLiveDiscoveryEvent(uiState, evt);
    }

    // Verify UI state reflects truth:
    assert.equal(uiState.target, 5);
    assert.equal(uiState.delivered, 1);
    assert.equal(uiState.rejected, 1);
    assert.equal(uiState.progressPercent, 20); // 1 / 5 = 20%
    assert.equal(uiState.status, "discovering");
    assert.equal(uiState.scouts[1].status, "active");
    assert.equal(uiState.scouts[2].status, "idle", "Scout 2 truthfully reported as idle");
    assert.equal(uiState.scouts[3].status, "idle", "Scout 3 truthfully reported as idle");
  });

  // ── 11. Authoritative qualification, validation, and credit accounting ────────

  test("candidate qualification rejects invalid provenance and duplicate candidates without credit charge or lead delivery", async () => {
    const planId = randomUUID();
    const taskId = randomUUID();
    const leaseToken = randomUUID();

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
      city: "Chicago",
      niche: "dentists",
      status: "running",
      last_heartbeat_at: new Date().toISOString(),
      task_summary: { execution_target: "desktop", lease_token: leaseToken, scout_id: 1 },
    };

    const initialDeliverCalls = mockDeliverLeadCalls.length;

    // Ingest: 1 invalid provenance (not a google maps link), 1 duplicate lead
    const res = await fetch(`${baseUrl}/tasks/${taskId}/ingest`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${tokenUserA}`,
      },
      body: JSON.stringify({
        leaseToken,
        batchId: "batch-qual-1",
        candidates: [
          {
            name: "Untrusted Directory Lead",
            address: "123 Loop St, Chicago, IL",
            maps_link: "https://some-shady-scraper.com/entry/123", // invalid maps_link provenance
            phone: "312-555-0100",
            email: "info@untrusted.com",
            pipeline_id: "#qual-untrusted",
          },
          {
            name: "Duplicate Business", // mock deliverLead returns wasNewForUser: false
            address: "456 Michigan Ave, Chicago, IL",
            maps_link: "https://www.google.com/maps/place/dup",
            phone: "312-555-0101",
            email: "info@duplicate.com",
            pipeline_id: "#qual-dup",
          },
        ],
      }),
    });

    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.accepted, 0, "No leads should be accepted");
    assert.equal(data.rejected, 1, "Untrusted provenance should be rejected");
    assert.equal(data.duplicates, 1, "Duplicate business should be counted as duplicate");

    // deliverLead was only called for the candidate that passed validation (the duplicate),
    // and deliverLead returned wasNewForUser: false so it did not deliver or charge.
    // The candidate with invalid provenance was rejected BEFORE deliverLead.
    assert.equal(mockDeliverLeadCalls.length, initialDeliverCalls + 1);

    // Rejection event was published for untrusted provenance
    const rejectedEvt = mockLiveEvents.find((e) => e.type === "candidate_rejected" && e.pipelineId === "#qual-untrusted");
    assert.ok(rejectedEvt);
    assert.equal(rejectedEvt.reason, "validateDiscoveryCandidate:missing_maps_provenance");
  });

  // ── 12. Worker / engine failure results in visible terminal discovery_failed ───

  test("when all tasks fail, completePlanIfDrained terminates plan and scrape_job as failed with discovery_failed event", async () => {
    const planId = randomUUID();
    const jobId = randomUUID();
    const taskId1 = randomUUID();
    const taskId2 = randomUUID();

    mockScrapeJobs[jobId] = {
      id: jobId,
      user_id: userA,
      status: "running",
      results_count: 0,
    };

    mockDiscoveryPlans[planId] = {
      id: planId,
      user_id: userA,
      scrape_job_id: jobId,
      requested_count: 10,
      delivered_count: 0,
      status: "running",
      created_at: new Date().toISOString(),
    };

    mockDiscoveryTasks[taskId1] = {
      id: taskId1,
      plan_id: planId,
      user_id: userA,
      status: "failed",
      error: "Playwright browser launch failed: missing system dependency",
    };

    mockDiscoveryTasks[taskId2] = {
      id: taskId2,
      plan_id: planId,
      user_id: userA,
      status: "failed",
      error: "Playwright browser launch failed: missing system dependency",
    };

    const capturedEvents: any[] = [];
    const unsubscribe = subscribeToDiscoveryLiveEvents(planId, (evt) => {
      capturedEvents.push(evt);
    });

    try {
      await completePlanIfDrained(planId);

      assert.equal(mockDiscoveryPlans[planId].status, "failed", "Plan must be marked failed");
      assert.equal(mockScrapeJobs[jobId].status, "failed", "Parent scrape job must be marked failed");
      assert.equal(mockScrapeJobs[jobId].results_count, 0);

      const failedEvt = capturedEvents.find((e) => e.type === "discovery_failed");
      assert.ok(failedEvt, "Must emit discovery_failed live event");
      assert.equal(failedEvt.failureReason, "Playwright browser launch failed: missing system dependency");
    } finally {
      unsubscribe();
    }
  });

  // ── 13. Cancellation immediately marks plan terminal and publishes failure ───

  test("POST /v1/discover/:jobId/cancel terminates running plan and tasks and emits discovery_failed with reason cancelled", async () => {
    const jobId = randomUUID();
    const planId = randomUUID();
    const taskId = randomUUID();

    mockScrapeJobs[jobId] = {
      id: jobId,
      user_id: userA,
      status: "running",
    };

    mockDiscoveryPlans[planId] = {
      id: planId,
      scrape_job_id: jobId,
      user_id: userA,
      requested_count: 10,
      delivered_count: 2,
      status: "running",
    };

    mockDiscoveryTasks[taskId] = {
      id: taskId,
      plan_id: planId,
      user_id: userA,
      status: "queued",
      task_summary: { execution_target: "desktop" },
    };

    const cancelRes = await fetch(`${discoverBaseUrl}/${jobId}/cancel`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${tokenUserA}`,
      },
    });

    assert.equal(cancelRes.status, 200);
    const cancelData = await cancelRes.json();
    assert.equal(cancelData.status, "cancelled");

    assert.equal(mockScrapeJobs[jobId].status, "cancelled");
    assert.equal(mockDiscoveryPlans[planId].status, "cancelled");
    assert.equal(mockDiscoveryTasks[taskId].status, "cancelled");

    const cancelEvt = mockLiveEvents.find((e) => e.type === "discovery_failed" && e.failureReason === "cancelled");
    assert.ok(cancelEvt, "Must emit discovery_failed live event with reason 'cancelled'");
  });

  // ── 14. Security: No Supabase service-role key is required or exposed ─────────

  test("desktop endpoints and worker operate without requiring or exposing SUPABASE_SERVICE_ROLE_KEY", async () => {
    // 1. Claim a task and verify no service-role key or internal secrets are in payload
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
      city: "Phoenix",
      niche: "dentists",
      priority: 10,
      status: "queued",
      task_summary: { execution_target: "desktop" },
    };

    const claimRes = await fetch(`${baseUrl}/tasks/claim`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${tokenUserA}`,
      },
      body: JSON.stringify({ workerId: "worker-sec-test" }),
    });
    assert.equal(claimRes.status, 200);
    const claimData = await claimRes.json();
    const payloadStr = JSON.stringify(claimData);

    assert.ok(!payloadStr.includes("service_role"), "Service role key must never appear in claim response");
    assert.ok(!payloadStr.includes("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9"), "No raw admin JWTs in response");

    // 2. Verify that desktop worker only needs user auth token, not service-role key
    // Neither SUPABASE_SERVICE_ROLE_KEY nor SUPABASE_URL is needed by desktop coordinator client
    assert.ok(claimData.task.leaseToken, "Worker receives safe short-lived lease token");
    assert.ok(claimData.task.scoutId, "Worker receives scoutId");
    assert.ok(!claimData.task.supabase_service_role_key, "No database admin credentials forwarded to desktop worker");
  });

  // ── 15. Error propagation: Failed task propagates exact error to live event and recordTaskOutcome ─

  test("failed task preserves exact error in areaCompletedEvent and recordTaskOutcome", async () => {
    const planId = randomUUID();
    const taskId = randomUUID();
    const leaseToken = randomUUID();

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
      city: "Phoenix",
      niche: "dentists",
      priority: 10,
      status: "running",
      task_summary: { execution_target: "desktop", lease_token: leaseToken, scout_id: 2, area_label: "Phoenix Metro" },
    };

    const compRes = await fetch(`${baseUrl}/tasks/${taskId}/complete`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${tokenUserA}`,
      },
      body: JSON.stringify({
        leaseToken,
        status: "failed",
        discovered: 0,
        accepted: 0,
        rejected: 0,
        duplicates: 0,
        exhausted: false,
        error: "RuntimeError: Browser launch crashed with code -1073741819",
        completionReason: "failed",
        terminationReason: "FAILURE_RUNTIMEERROR",
      }),
    });
    assert.equal(compRes.status, 200);

    // Verify recordTaskOutcome received the exact error
    assert.equal(mockRecordOutcomeCalls.length, 1);
    const recordedOutcome = mockRecordOutcomeCalls[0].outcome;
    assert.equal(recordedOutcome.status, "failed");
    assert.equal(recordedOutcome.error, "RuntimeError: Browser launch crashed with code -1073741819");
    assert.equal(recordedOutcome.terminationReason, "FAILURE_RUNTIMEERROR");

    // Verify areaCompletedEvent was emitted with error and failed flag
    const areaEvt = mockLiveEvents.find((e) => e.type === "area_completed" && e.areaLabel === "Phoenix Metro");
    assert.ok(areaEvt, "Must emit area_completed event");
    assert.equal(areaEvt.areaOutcome.failed, true);
    assert.equal(areaEvt.areaOutcome.error, "RuntimeError: Browser launch crashed with code -1073741819");
  });

  // ── 16. Desktop concurrency cap permits at least 3 scouts and returns localized query ─

  test("desktop task claim enforces concurrency >= 3 and returns localized queryString", async () => {
    const planId = randomUUID();
    const taskIds = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];

    // userB is on 'free' plan
    mockDiscoveryPlans[planId] = {
      id: planId,
      user_id: userB,
      requested_count: 5,
      delivered_count: 0,
      status: "running",
      channels: ["email"],
      region: "United States",
      profession_slug: "dentists",
    };

    const areas = ["Lincoln Square", "Logan Square", "Lakeview", "Wicker Park"];
    for (let i = 0; i < taskIds.length; i++) {
      mockDiscoveryTasks[taskIds[i]] = {
        id: taskIds[i],
        plan_id: planId,
        user_id: userB,
        city: "Chicago",
        niche: "Coffee Shop",
        priority: 10 - i,
        status: "queued",
        task_summary: { execution_target: "desktop", area_label: areas[i] },
      };
    }

    // Free plan base concurrency is 2, but desktop mode guarantees at least 3 concurrent scouts
    const claims = [];
    for (let i = 0; i < 3; i++) {
      const res = await fetch(`${baseUrl}/tasks/claim`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${tokenUserB}`,
        },
        body: JSON.stringify({ workerId: `worker-scout-${i + 1}` }),
      });
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.ok(data.task, `Scout ${i + 1} must be able to claim a task`);
      claims.push(data.task);
    }

    // Verify localized queryString
    assert.equal(claims[0].queryString, "Coffee Shop in Lincoln Square, Chicago");
    assert.equal(claims[0].area, "Lincoln Square");

    // 4th claim should receive null because concurrency cap of 3 is reached
    const fourthRes = await fetch(`${baseUrl}/tasks/claim`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${tokenUserB}`,
      },
      body: JSON.stringify({ workerId: "worker-scout-4" }),
    });
    assert.equal(fourthRes.status, 200);
    const fourthData = await fourthRes.json();
    assert.equal(fourthData.task, null, "4th claim must be capped at 3 concurrent scouts");
  });

  // ── 17. Ingestion breakdown reports privacy-safe rejection reasons and candidate metadata ─

  test("ingestion returns rejectionReasons breakdown and emits candidateRejectedEvent with category and businessName", async () => {
    const planId = randomUUID();
    const taskId = randomUUID();
    const leaseToken = randomUUID();

    mockDiscoveryPlans[planId] = {
      id: planId,
      user_id: userA,
      requested_count: 5,
      delivered_count: 0,
      status: "running",
      channels: ["website"],
      region: "United States",
      profession_slug: "cafes",
    };

    mockDiscoveryTasks[taskId] = {
      id: taskId,
      plan_id: planId,
      user_id: userA,
      city: "Chicago",
      niche: "cafes",
      priority: 10,
      status: "running",
      task_summary: { execution_target: "desktop", lease_token: leaseToken, scout_id: 1, area_label: "Lincoln Square" },
    };

    // Ingest a batch with one duplicate lead and one lead missing required website
    const batchRes = await fetch(`${baseUrl}/tasks/${taskId}/ingest`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${tokenUserA}`,
      },
      body: JSON.stringify({
        leaseToken,
        batchId: "batch-rejections-1",
        candidates: [
          {
            name: "Duplicate Business",
            address: "123 Michigan Ave, Chicago, IL",
            maps_link: "https://www.google.com/maps/place/dup",
            website: "https://dup.example.com",
            phone: "+15555550100",
            city: "Chicago",
            country_code: "US",
            niche: "cafes",
          },
          {
            name: "No Website Business",
            address: "456 Michigan Ave, Chicago, IL",
            maps_link: "https://www.google.com/maps/place/noweb",
            phone: "+15555550101",
            city: "Chicago",
            country_code: "US",
            niche: "cafes",
          },
        ],
      }),
    });

    assert.equal(batchRes.status, 200);
    const batchData = await batchRes.json();
    assert.equal(batchData.accepted, 0);
    assert.equal(batchData.duplicates, 1);
    assert.equal(batchData.rejected, 1);
    assert.ok(batchData.rejectionReasons, "Must return rejectionReasons breakdown");
    assert.equal(batchData.rejectionReasons.duplicate, 1);
    assert.equal(batchData.rejectionReasons.missing_website, 1);

    // Verify live events include businessName and rejectionCategory
    const dupEvt = mockLiveEvents.find((e) => e.type === "candidate_rejected" && e.businessName === "Duplicate Business");
    assert.ok(dupEvt, "Must emit candidateRejectedEvent with businessName for duplicate");
    assert.equal(dupEvt.rejectionCategory, "duplicate");

    const noWebEvt = mockLiveEvents.find((e) => e.type === "candidate_rejected" && e.businessName === "No Website Business");
    assert.ok(noWebEvt, "Must emit candidateRejectedEvent with businessName for missing website");
    assert.equal(noWebEvt.rejectionCategory, "missing_website");
  });

  // ── 18. Claim strictly ignores stale/terminal plans and prioritizes newest active plan ──

  test("claim strictly ignores stale/terminal/satisfied plans and prioritizes newest active plan or preferredPlanId", async () => {
    const oldPlanId = randomUUID();
    const oldTaskId = randomUUID();
    mockDiscoveryPlans[oldPlanId] = {
      id: oldPlanId,
      user_id: userA,
      requested_count: 5,
      delivered_count: 5, // Already satisfied
      status: "completed",
      created_at: new Date(Date.now() - 3600_000).toISOString(),
    };
    mockDiscoveryTasks[oldTaskId] = {
      id: oldTaskId,
      plan_id: oldPlanId,
      user_id: userA,
      city: "Old City",
      niche: "dentists",
      priority: 10,
      status: "queued",
      task_summary: { execution_target: "desktop" },
      created_at: new Date(Date.now() - 3600_000).toISOString(),
    };

    const newPlanId = randomUUID();
    const newTaskId = randomUUID();
    mockDiscoveryPlans[newPlanId] = {
      id: newPlanId,
      user_id: userA,
      requested_count: 5,
      delivered_count: 0,
      status: "running",
      created_at: new Date().toISOString(),
    };
    mockDiscoveryTasks[newTaskId] = {
      id: newTaskId,
      plan_id: newPlanId,
      user_id: userA,
      city: "Fresh City",
      niche: "dentists",
      priority: 10,
      status: "queued",
      task_summary: { execution_target: "desktop" },
      created_at: new Date().toISOString(),
    };

    // Worker claims task without preferredPlanId: must claim newTaskId from fresh plan, ignoring oldTaskId
    const claimRes1 = await fetch(`${baseUrl}/tasks/claim`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${tokenUserA}`,
      },
      body: JSON.stringify({ workerId: "worker-test-priority" }),
    });
    assert.equal(claimRes1.status, 200);
    const data1 = await claimRes1.json();
    assert.ok(data1.task, "Must claim a task");
    assert.equal(data1.task.id, newTaskId, "Must claim new task from active plan, never old task from satisfied plan");
  });
});
