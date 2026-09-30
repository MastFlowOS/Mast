// Focus ↔ Daily Goals integration helpers (Phase 2): pure-logic tests.
// Force a non-UTC zone BEFORE any Date is built so "local day, not UTC day" is exercised.
process.env.TZ = "America/Los_Angeles";

import assert from "node:assert/strict";
import test from "node:test";
import type { FollowupWithLead, Lead } from "../api";
import {
  buildDailyGoalDrafts,
  localDateKey,
  type BuildDailyGoalsInput,
  type DailyGoalDraft,
  type DailyGoalInstance,
  type GoalEvidence,
} from "../dailyGoals.js";
import {
  distinctWindowStarts,
  isDailyGoalComplete,
  loadOrCreateDailyGoals,
  msUntilNextLocalMidnight,
  planProgressWrites,
  summarizeDailyGoals,
  toPriorityGoals,
  type DailyGoalsIo,
} from "../focusDailyGoals.js";
import { buildFocusSnapshot } from "../focus.js";

const NOW = new Date(2026, 8, 16, 10, 0, 0);
const iso = (d: Date) => d.toISOString();
const daysFromNow = (n: number) => {
  const d = new Date(NOW);
  d.setDate(d.getDate() + n);
  return d;
};
let seq = 1;
const lead = (over: Partial<Lead> = {}): Lead =>
  ({
    id: seq++,
    businessName: `Biz ${seq}`,
    status: "new",
    email: `b${seq}@example.com`,
    createdAt: iso(daysFromNow(-20)),
    updatedAt: iso(daysFromNow(-20)),
    source: "discover_live",
    businessId: `biz-${seq}`,
    opportunityScore: 60,
    ...over,
  }) as Lead;
const contacted = () => lead({ status: "email_sent", lastContactedAt: iso(daysFromNow(-8)) });

function rich(plan: BuildDailyGoalsInput["plan"] = "pro"): Omit<BuildDailyGoalsInput, "now"> {
  const untouched = Array.from({ length: 12 }, () => lead());
  const done = Array.from({ length: 6 }, contacted);
  const due = Array.from({ length: 3 }, contacted);
  const fu = (l: Lead, n: number) =>
    ({
      id: seq++,
      leadId: l.id,
      channel: "email",
      dueAt: iso(daysFromNow(n)),
      status: "pending",
      createdAt: iso(daysFromNow(-5)),
      updatedAt: iso(daysFromNow(-5)),
      completedAt: null,
      lead: l,
    }) as FollowupWithLead;
  return {
    plan,
    leads: [...untouched, ...done, ...due],
    followups: [fu(due[0], -2), fu(due[1], 0), fu(due[2], 3)],
    dailyDiscoverUsed: 0,
    dailyDiscoverLimit: 400,
    monthlyRemaining: 200,
  };
}

function makeIo() {
  const store = new Map<string, DailyGoalInstance[]>();
  const calls = { get: 0, ensure: 0 };
  const io: DailyGoalsIo = {
    getDailyGoals: async (d) => {
      calls.get++;
      return structuredClone(store.get(d) ?? []);
    },
    ensureDailyGoals: async (d: string, drafts: DailyGoalDraft[]) => {
      calls.ensure++;
      if (!store.has(d)) {
        // Persist in scrambled order to prove presentation is by slot.
        store.set(
          d,
          drafts
            .map((x, i) => ({
              ...x,
              id: `${d}#${i + 1}`,
              progress: 0,
              status: "active" as const,
              createdAt: "",
              completedAt: null,
              claimed: false,
            }))
            .reverse(),
        );
      }
      return structuredClone(store.get(d)!);
    },
  };
  return { io, calls, store };
}

const emptyEvidence = (over: Partial<GoalEvidence> = {}): GoalEvidence => ({
  leads: [],
  followups: [],
  genuineSends: [],
  priorSendLeadIds: new Set(),
  notes: [],
  discoveryJobs: [],
  priorSearchedCountryCodes: new Set(),
  ...over,
});

test("loadOrCreate: none exist → generates exactly 4 once, persisted rows returned in slot order", async () => {
  const { io, calls } = makeIo();
  const res = await loadOrCreateDailyGoals({ now: NOW, input: rich(), io });
  assert.equal(res.kind, "ready");
  if (res.kind !== "ready") return;
  assert.equal(res.goals.length, 4);
  assert.deepEqual(
    res.goals.map((g) => g.slot),
    [1, 2, 3, 4],
  );
  assert.equal(calls.ensure, 1);
});

test("loadOrCreate: existing set is reused — never regenerated (refresh / reopen)", async () => {
  const { io, calls } = makeIo();
  const first = await loadOrCreateDailyGoals({ now: NOW, input: rich(), io });
  // Different workspace state later the same day must NOT change today's four.
  const later = new Date(NOW.getTime() + 5 * 3_600_000);
  const second = await loadOrCreateDailyGoals({ now: later, input: rich("free"), io });
  assert.equal(calls.ensure, 1);
  assert.deepEqual(
    second.kind === "ready" && second.goals.map((g) => g.id),
    first.kind === "ready" && first.goals.map((g) => g.id),
  );
});

test("loadOrCreate: the LOCAL calendar day decides the set (not UTC)", async () => {
  const { io, calls } = makeIo();
  // 20:00 local on the 16th is already the 17th in UTC.
  const evening = new Date(2026, 8, 16, 20, 0, 0);
  const a = await loadOrCreateDailyGoals({ now: evening, input: rich(), io });
  assert.ok(a.kind === "ready" && a.goals.every((g) => g.goalDate === "2026-09-16"));
  const nextMorning = new Date(2026, 8, 17, 7, 0, 0);
  const b = await loadOrCreateDailyGoals({ now: nextMorning, input: rich(), io });
  assert.ok(b.kind === "ready" && b.goals.every((g) => g.goalDate === "2026-09-17"));
  assert.equal(calls.ensure, 2);
});

test("loadOrCreate: INSUFFICIENT_LEGITIMATE_GOALS persists nothing and never returns 1–3 goals", async () => {
  const { io, calls } = makeIo();
  const res = await loadOrCreateDailyGoals({
    now: NOW,
    input: {
      plan: "free",
      leads: [lead()],
      followups: [],
      dailyDiscoverUsed: 20,
      dailyDiscoverLimit: 20,
      monthlyRemaining: 200,
    },
    io,
  });
  assert.equal(res.kind, "insufficient");
  assert.equal(calls.ensure, 0);
});

test("loadOrCreate: a corrupt partial persisted set is an error, not a 1–3 goal board", async () => {
  const { io, store } = makeIo();
  await loadOrCreateDailyGoals({ now: NOW, input: rich(), io });
  const key = localDateKey(NOW);
  store.set(key, store.get(key)!.slice(0, 2));
  await assert.rejects(() => loadOrCreateDailyGoals({ now: NOW, input: rich(), io }));
});

test("planProgressWrites: uses each goal's own predicate on ONE shared evidence snapshot; only changed goals write", async () => {
  const { io } = makeIo();
  const res = await loadOrCreateDailyGoals({ now: NOW, input: rich(), io });
  assert.equal(res.kind, "ready");
  if (res.kind !== "ready") return;
  const goals = res.goals;
  const windows = distinctWindowStarts(goals);
  assert.equal(windows.length, 1); // all four share one window → one evidence fetch

  const ts = iso(new Date(NOW.getTime() + 60_000));
  const evidence = emptyEvidence({ notes: [1, 2, 3].map((leadId) => ({ leadId, timestamp: ts })) });
  const writes = planProgressWrites(goals, new Map([[windows[0], evidence]]));
  const context = goals.find((g) => g.definitionId === "workspace.add_context")!;
  assert.deepEqual(writes, [{ id: context.id, progress: 3 }]); // unrelated goals untouched

  // Idempotent / monotonic: once stored, no further write is planned.
  const applied = goals.map((g) =>
    g.id === context.id ? { ...g, progress: 3, status: "completed" as const } : g,
  );
  assert.deepEqual(planProgressWrites(applied, new Map([[windows[0], evidence]])), []);
});

test("planProgressWrites: a goal never moves backwards when evidence shrinks", async () => {
  const { io } = makeIo();
  const res = await loadOrCreateDailyGoals({ now: NOW, input: rich(), io });
  if (res.kind !== "ready") return assert.fail("expected ready");
  const g = res.goals.find((x) => x.definitionId === "workspace.add_context")!;
  const advanced = res.goals.map((x) => (x.id === g.id ? { ...x, progress: 2 } : x));
  const none = planProgressWrites(advanced, new Map([[g.metadata.windowStart, emptyEvidence()]]));
  assert.deepEqual(none, []);
});

test("summarizeDailyGoals: counts come from persisted rows; XP is the stored XP", async () => {
  const { io } = makeIo();
  const res = await loadOrCreateDailyGoals({ now: NOW, input: rich(), io });
  if (res.kind !== "ready") return assert.fail("expected ready");
  const [a, b, c, d] = res.goals;
  const goals = [
    { ...a, progress: a.target, status: "completed" as const, claimed: true },
    { ...b, progress: b.target, status: "completed" as const },
    c,
    d,
  ];
  const s = summarizeDailyGoals(goals);
  assert.equal(s.total, 4);
  assert.equal(s.completedCount, 2);
  assert.equal(s.claimedCount, 1);
  assert.equal(s.readyToClaimCount, 1);
  assert.equal(s.availableXp, b.xp + c.xp + d.xp);
  assert.ok(isDailyGoalComplete(goals[1]) && !isDailyGoalComplete(goals[2]));
});

test("toPriorityGoals + snapshot: hero routes with the goal's PERSISTED action, not a static category table", async () => {
  const { io } = makeIo();
  const res = await loadOrCreateDailyGoals({ now: NOW, input: rich("premium"), io });
  if (res.kind !== "ready") return assert.fail("expected ready");
  // Nearly finished 4/5 outreach goal whose persisted route differs from the legacy category table.
  const outreach = res.goals.find((g) => g.definitionId === "outreach.start_conversations")!;
  const goals = res.goals.map((g) =>
    g.id === outreach.id
      ? {
          ...g,
          progress: g.target - 1,
          metadata: { ...g.metadata, actionTo: "/dashboard/persisted-route" },
        }
      : { ...g, progress: 0 },
  );
  const adapted = toPriorityGoals(goals);
  assert.equal(adapted.goals.find((g) => g.id === outreach.id)!.to, "/dashboard/persisted-route");
  assert.deepEqual(adapted.claimedGoalIds, []);

  // FocusContext carries no legacy goal inputs at all; Daily Goals arrive only via `adapted`.
  const snap = buildFocusSnapshot(
    "Sam",
    {
      leads: [],
      followups: [],
      dailyDiscoverUsed: 20,
      dailyDiscoverLimit: 20,
      monthlyRemaining: 200,
      plan: "premium",
      xp: 0,
      goalsClaimedToday: 0,
      now: NOW,
    },
    adapted,
  );
  assert.equal(snap.primaryRecommendation?.id, "goal-near");
  assert.equal(snap.primaryRecommendation?.to, "/dashboard/persisted-route");
  assert.equal("goals" in snap, false); // no legacy goal list on the snapshot
});

test("toPriorityGoals: claimed persisted goals are excluded from the claim priority", async () => {
  const { io } = makeIo();
  const res = await loadOrCreateDailyGoals({ now: NOW, input: rich("premium"), io });
  if (res.kind !== "ready") return assert.fail("expected ready");
  const g = res.goals[0];
  const done = res.goals.map((x) =>
    x.id === g.id ? { ...x, progress: x.target, status: "completed" as const } : x,
  );
  const ctx = {
    leads: [],
    followups: [] as FollowupWithLead[],
    dailyDiscoverUsed: 20,
    dailyDiscoverLimit: 20,
    monthlyRemaining: 200,
    plan: "premium" as const,
    xp: 0,
    goalsClaimedToday: 0,
    now: NOW,
  };
  assert.equal(
    buildFocusSnapshot("S", ctx, toPriorityGoals(done)).primaryRecommendation?.id,
    "goal-claim",
  );
  const claimed = done.map((x) => (x.id === g.id ? { ...x, claimed: true } : x));
  assert.notEqual(
    buildFocusSnapshot("S", ctx, toPriorityGoals(claimed)).primaryRecommendation?.id,
    "goal-claim",
  );
});

test("msUntilNextLocalMidnight: local midnight, DST-safe, never negative", () => {
  assert.equal(msUntilNextLocalMidnight(new Date(2026, 8, 16, 23, 59, 0)), 60_000);
  assert.equal(msUntilNextLocalMidnight(new Date(2026, 8, 16, 0, 0, 0)), 24 * 3_600_000);
  // US DST ends Nov 1 2026: that local day is 25h long.
  assert.equal(msUntilNextLocalMidnight(new Date(2026, 10, 1, 0, 0, 0)), 25 * 3_600_000);
  // Local, not UTC: 20:00 in LA is 4h from local midnight even though UTC already rolled.
  assert.equal(msUntilNextLocalMidnight(new Date(2026, 8, 16, 20, 0, 0)), 4 * 3_600_000);
});

test("engine drafts are still exactly 4 for the fixture (guards the Focus fixtures)", () => {
  assert.equal(buildDailyGoalDrafts({ ...rich(), now: NOW }).length, 4);
});
