// Daily-goals engine tests (Phase 1.5: expanded + hardened goal pool).
// Asserting the exact-4 contract, real-feature integrity, and strict isolation.
//
// Force a non-UTC zone BEFORE any Date is built so "local day, not UTC day" is
// actually exercised (20:00 in LA on the 16th is already the 17th in UTC).
process.env.TZ = "America/Los_Angeles";

import assert from "node:assert/strict";
import test from "node:test";
import type { FollowupWithLead, Lead } from "../api";
import {
  DAILY_GOAL_COUNT,
  DAILY_GOAL_DEFINITIONS,
  LEGACY_GOAL_AUDIT,
  PAIRABLE,
  buildDailyGoalDrafts,
  canUseGoalDefinition,
  computeGoalProgress,
  discoverTarget,
  addRelationshipTarget,
  generateDailyGoals,
  DailyGoalGenerationError,
  localDateKey,
  planMatrix,
  reconcileDailyGoals,
  type BuildDailyGoalsInput,
  type DailyGoalDraft,
  type DailyGoalInstance,
  type GoalEvidence,
} from "../dailyGoals.js";
import { GOAL_DEFINITIONS, XP_BY_DIFFICULTY } from "../progression.js";
import { getCurrentMilestone } from "../focus.js";
import type { PlanId } from "../plans";

const PLANS: PlanId[] = ["free", "starter", "pro", "premium"];
const NOW = new Date(2026, 8, 16, 10, 0, 0); // local 10:00, Sep 16
const iso = (d: Date) => d.toISOString();
const daysFromNow = (n: number, base = NOW) => {
  const d = new Date(base);
  d.setDate(d.getDate() + n);
  return d;
};

let seq = 1;
function lead(over: Partial<Lead> = {}): Lead {
  const id = seq++;
  return {
    id,
    businessName: `Biz ${id}`,
    status: "new",
    email: `b${id}@example.com`,
    createdAt: iso(daysFromNow(-20)),
    updatedAt: iso(daysFromNow(-20)),
    source: "discover_live",
    businessId: `biz-${id}`,
    ...over,
  } as Lead;
}
const contacted = (over: Partial<Lead> = {}) =>
  lead({ status: "email_sent", lastContactedAt: iso(daysFromNow(-8)), ...over });

let fid = 1;
function followup(l: Lead, dueInDays: number, over: Partial<FollowupWithLead> = {}): FollowupWithLead {
  return {
    id: fid++,
    leadId: l.id,
    channel: "email",
    dueAt: iso(daysFromNow(dueInDays)),
    status: "pending",
    createdAt: iso(daysFromNow(-5)),
    updatedAt: iso(daysFromNow(-5)),
    completedAt: null,
    lead: l,
    ...over,
  } as FollowupWithLead;
}

const many = (n: number, f: () => Lead) => Array.from({ length: n }, f);

function input(over: Partial<BuildDailyGoalsInput> = {}): BuildDailyGoalsInput {
  return {
    plan: "free",
    now: NOW,
    leads: [],
    followups: [],
    dailyDiscoverUsed: 0,
    dailyDiscoverLimit: 20,
    monthlyRemaining: 200,
    ...over,
  };
}

/** A rich workspace: untouched leads, contacted leads, due + overdue follow-ups. */
function richState(plan: PlanId): BuildDailyGoalsInput {
  const untouched = many(12, () => lead({ opportunityScore: 40 + (seq % 50) }));
  const done = many(6, () => contacted());
  const dueLeads = many(3, () => contacted());
  return input({
    plan,
    leads: [...untouched, ...done, ...dueLeads],
    followups: [followup(dueLeads[0], -2), followup(dueLeads[1], 0), followup(dueLeads[2], 3)],
    dailyDiscoverLimit: { free: 20, starter: 100, pro: 400, premium: 1000 }[plan],
  });
}

function emptyEvidence(over: Partial<GoalEvidence> = {}): GoalEvidence {
  return {
    leads: [],
    followups: [],
    genuineSends: [],
    priorSendLeadIds: new Set(),
    notes: [],
    discoveryJobs: [],
    priorSearchedCountryCodes: new Set(),
    ...over,
  };
}

/** In-memory model of the persisted-set contract. */
class SetStore {
  private rows = new Map<string, DailyGoalInstance[]>();
  ensure(date: string, drafts: DailyGoalDraft[]): DailyGoalInstance[] {
    if (drafts.length !== DAILY_GOAL_COUNT) {
      throw new Error(`ensure requires exactly ${DAILY_GOAL_COUNT} goals, got ${drafts.length}`);
    }
    if (!this.rows.has(date)) {
      this.rows.set(
        date,
        drafts.map((d, i) => ({ ...d, id: `${date}#${i}`, progress: 0, status: "active", createdAt: "", completedAt: null })),
      );
    }
    return this.rows.get(date)!;
  }
  get(date: string) {
    return this.rows.get(date) ?? [];
  }
}

const draftFor = (over: Partial<BuildDailyGoalsInput> = {}) => buildDailyGoalDrafts(input(over));
const instance = (d: DailyGoalDraft, over: Partial<DailyGoalInstance> = {}): DailyGoalInstance => ({
  ...d, id: `g-${d.slot}`, progress: 0, status: "active", createdAt: "", completedAt: null, ...over,
});

// ─── 1. Every valid user gets exactly 4 goals ─────────────────────────────────
test("1. every valid user gets exactly 4 goals across all plans", () => {
  for (const plan of PLANS) {
    const drafts = buildDailyGoalDrafts(richState(plan));
    assert.equal(drafts.length, 4, `${plan} must have exactly 4`);
  }
});

// ─── 2. No more than 4 ────────────────────────────────────────────────────────
test("2. never generates more than 4 goals", () => {
  for (const plan of PLANS) {
    const drafts = buildDailyGoalDrafts(richState(plan));
    assert.equal(drafts.length, 4);
    assert.deepEqual(drafts.map((d) => d.slot), [1, 2, 3, 4]);
    assert.equal(new Set(drafts.map((d) => d.definitionId)).size, 4);
  }
});

// ─── 3. No fewer than 4 in normal supported states ────────────────────────────
test("3. never generates fewer than 4 in normal supported states", () => {
  // Cold start (0 leads, fresh account)
  for (const plan of PLANS) {
    const cold = buildDailyGoalDrafts(input({ plan }));
    assert.equal(cold.length, 4, `Cold start ${plan} must get 4`);
  }
  // Active with backlog
  for (const plan of PLANS) {
    const active = buildDailyGoalDrafts(input({ plan, leads: many(5, () => lead()) }));
    assert.equal(active.length, 4, `Active ${plan} must get 4`);
  }
});

// ─── 4. Refresh returns the same 4 ───────────────────────────────────────────
test("4. refresh returns the same 4 persisted goals even if workspace changes", () => {
  const store = new SetStore();
  const key = localDateKey(NOW);
  const first = store.ensure(key, buildDailyGoalDrafts(richState("starter")));
  // Workspace changes drastically:
  const changed = buildDailyGoalDrafts(input({ plan: "starter" }));
  assert.notDeepEqual(changed.map((d) => d.definitionId), first.map((d) => d.definitionId));
  // Persisted set must win:
  const second = store.ensure(key, changed);
  assert.deepEqual(second.map((g) => g.id), first.map((g) => g.id));
  assert.equal(second.length, 4);
});

// ─── 5. Completion does not create Goal #5 ────────────────────────────────────
test("5. completion does not create Goal #5", () => {
  const store = new SetStore();
  const key = localDateKey(NOW);
  const goals = store.ensure(key, buildDailyGoalDrafts(richState("starter")));
  goals[0].progress = goals[0].target;
  goals[0].status = "completed";
  assert.equal(store.ensure(key, buildDailyGoalDrafts(richState("starter"))).length, 4);
  assert.equal(store.get(key).length, 4);
});

// ─── 6. Completed goals remain ────────────────────────────────────────────────
test("6. completed goals remain visible as completed", () => {
  const store = new SetStore();
  const key = localDateKey(NOW);
  const goals = store.ensure(key, buildDailyGoalDrafts(richState("free")));
  goals[1].status = "completed";
  const visible = store.get(key);
  assert.equal(visible.length, 4);
  assert.equal(visible.filter((g) => g.status === "completed").length, 1);
});

// ─── 7. New local day creates a new set ───────────────────────────────────────
test("7. new local day uses local calendar, not UTC, and yields a new set", () => {
  const eveningLA = new Date(2026, 8, 16, 20, 0, 0); // 03:00Z on the 17th
  assert.equal(eveningLA.toISOString().slice(0, 10), "2026-09-17", "precondition: UTC is already next day");
  assert.equal(localDateKey(eveningLA), "2026-09-16", "goal date must stay local day");

  const store = new SetStore();
  const today = store.ensure(localDateKey(NOW), buildDailyGoalDrafts(richState("free")));
  const nextNow = daysFromNow(1);
  const tomorrow = store.ensure(localDateKey(nextNow), buildDailyGoalDrafts({ ...richState("free"), now: nextNow }));
  assert.equal(tomorrow.length, 4);
  assert.ok(tomorrow.every((g) => g.goalDate === "2026-09-17"));
  assert.ok(tomorrow.every((g) => new Date(g.metadata.windowStart) >= new Date(nextNow)));
  assert.equal(store.get(localDateKey(NOW)).length, today.length, "yesterday untouched");
});

// ─── 8. Plan-ineligible goals never appear ─────────────────────────────────────
test("8. plan-ineligible goals never appear", () => {
  const has = (plan: PlanId, id: string) => buildDailyGoalDrafts(richState(plan)).some((d) => d.definitionId === id);
  // Free: no regional country search or mission follow-through
  for (const id of ["discovery.explore_country", "follow_through.clear_due", "follow_through.schedule_next_steps"]) {
    assert.equal(has("free", id), false, `free must not get ${id}`);
  }
  // Definitions respect plan gating
  const defMap = new Map(DAILY_GOAL_DEFINITIONS.map((d) => [d.id, d]));
  assert.equal(canUseGoalDefinition("free", defMap.get("discovery.explore_country")!), false);
  assert.equal(canUseGoalDefinition("free", defMap.get("follow_through.clear_due")!), false);
  assert.equal(canUseGoalDefinition("starter", defMap.get("discovery.explore_country")!), true);
});

// ─── 9. Impossible goals never appear ─────────────────────────────────────────
test("9. impossible goals are excluded", () => {
  const ids = (s: BuildDailyGoalsInput) => {
    const res = generateDailyGoals(s);
    const drafts = res.ok ? res.goals : res.drafts;
    return drafts.map((d) => d.definitionId);
  };

  // Allowance exhausted -> discover_new and explore_country are impossible
  const capped = ids(input({ plan: "starter", dailyDiscoverLimit: 100, dailyDiscoverUsed: 99, leads: many(8, () => lead()) }));
  assert.ok(!capped.includes("discovery.discover_new"));
  assert.ok(!capped.includes("discovery.explore_country"));

  // Instagram-only leads are not reachable on Free (no instagramChannel capability)
  const igOnly = many(6, () => lead({ email: null, phone: null, instagramHandle: "@shop" }));
  const freeIg = ids(input({ plan: "free", dailyDiscoverUsed: 20, leads: igOnly }));
  assert.ok(!freeIg.includes("outreach.start_conversations"));

  // Dead leads are excluded
  const dead = many(5, () => lead({ status: "dead" }));
  const deadIds = ids(input({ plan: "free", dailyDiscoverUsed: 20, leads: dead }));
  assert.ok(!deadIds.includes("workspace.add_context") && !deadIds.includes("outreach.start_conversations"));
});

// ─── 10. Due-follow-up goal never appears without due/overdue work ───────────
test("10. clear-due exists ONLY when follow-ups are due or overdue today", () => {
  const L = many(6, () => contacted());
  const has = (fu: FollowupWithLead[]) => {
    const res = generateDailyGoals({ plan: "starter", dailyDiscoverLimit: 100, leads: L, followups: fu, now: NOW });
    const drafts = res.ok ? res.goals : res.drafts;
    return drafts.some((d) => d.definitionId === "follow_through.clear_due");
  };

  assert.equal(has([]), false, "no follow-ups");
  assert.equal(has([followup(L[0], 3), followup(L[1], 1)]), false, "only future follow-ups");
  assert.equal(has([followup(L[0], -1, { status: "completed", completedAt: iso(daysFromNow(-1)) })]), false, "already completed");
  assert.equal(has([followup(L[0], 0)]), true, "due today");
  assert.equal(has([followup(L[0], -4)]), true, "overdue");
});

// ─── 11. Future follow-ups cannot satisfy today's completion ─────────────────
test("11. future follow-ups cannot satisfy today's completion", () => {
  const def = DAILY_GOAL_DEFINITIONS.find((d) => d.id === "follow_through.clear_due")!;
  const W = iso(daysFromNow(0, new Date(2026, 8, 16, 9, 0)));
  const meta = { windowStart: W, actionTo: "", actionLabel: "", completionExplanation: "", snapshotIds: ["101"] };

  // Followup 102 was NOT snapshotted as due today
  const futureFu = followup(contacted(), 3, { id: 102, status: "completed", completedAt: iso(new Date(2026, 8, 16, 11, 0)) });
  assert.equal(def.progress({ target: 1, metadata: meta }, emptyEvidence({ followups: [futureFu] })), 0);

  // Followup 101 was snapshotted as due today
  const snapFu = followup(contacted(), 0, { id: 101, status: "completed", completedAt: iso(new Date(2026, 8, 16, 11, 0)) });
  assert.equal(def.progress({ target: 1, metadata: meta }, emptyEvidence({ followups: [snapFu] })), 1);
});

// ─── 12. One action does not advance unrelated goals ─────────────────────────
test("12. one user action advances only its own goal", () => {
  const W = iso(daysFromNow(0, new Date(2026, 8, 16, 9, 0)));
  const at = iso(new Date(2026, 8, 16, 11, 0));
  const meta = { windowStart: W, actionTo: "", actionLabel: "", completionExplanation: "", snapshotIds: ["77"] };
  const target = 5;
  const progressOf = (ev: GoalEvidence) =>
    Object.fromEntries(DAILY_GOAL_DEFINITIONS.map((d) => [d.id, d.progress({ target, metadata: meta }, ev)]));
  const onlyMoved = (p: Record<string, number>, ...ids: string[]) => {
    const moved = Object.keys(p).filter((k) => p[k] > 0).sort();
    assert.deepEqual(moved, [...ids].sort());
  };

  // Discover delivers leads -> only discover_new
  const delivered = many(6, () => lead({ createdAt: at, source: "discover_instant_pool" }));
  onlyMoved(progressOf(emptyEvidence({ leads: delivered })), "discovery.discover_new");

  // Country search job -> only explore_country
  const job = { createdAt: at, region: "Canada", resultsCount: 8, status: "completed" };
  onlyMoved(progressOf(emptyEvidence({ discoveryJobs: [job] })), "discovery.explore_country");

  // Manual Add Relationship -> only add_relationship
  onlyMoved(progressOf(emptyEvidence({ leads: [lead({ createdAt: at, source: "manual" })] })), "relationships.add_relationship");

  // Note saved -> only add_context
  onlyMoved(progressOf(emptyEvidence({ notes: [{ leadId: 5, timestamp: at }] })), "workspace.add_context");

  // First send -> only start_conversations
  onlyMoved(
    progressOf(emptyEvidence({ genuineSends: [{ leadId: 77, type: "email_sent", timestamp: at }] })),
    "outreach.start_conversations",
  );

  // Reconnect send (lead 99 had prior send) -> only reconnect
  onlyMoved(
    progressOf(emptyEvidence({ genuineSends: [{ leadId: 99, type: "email_sent", timestamp: at }], priorSendLeadIds: new Set(["99"]) })),
    "outreach.reconnect",
  );

  // Scheduling a follow-up -> only schedule_next_steps
  const cLead = contacted();
  const scheduled = followup(cLead, 2, { createdAt: at });
  onlyMoved(progressOf(emptyEvidence({ leads: [cLead], followups: [scheduled] })), "follow_through.schedule_next_steps");

  // Completing snapshotted follow-up -> only clear_due
  const dueFu = followup(cLead, -1, { id: 77, status: "completed", completedAt: at });
  onlyMoved(progressOf(emptyEvidence({ leads: [cLead], followups: [dueFu] })), "follow_through.clear_due");
});

// ─── 13. Same objective cannot appear twice under different wording ──────────
test("13. same objective cannot appear twice under different wording", () => {
  const drafts = buildDailyGoalDrafts(richState("starter"));
  const families = drafts.map((d) => d.family);
  const dupes = families.filter((f, i) => families.indexOf(f) !== i);
  for (const f of new Set(dupes)) {
    const pair = drafts.filter((d) => d.family === f).map((d) => d.definitionId).sort();
    const isAllowed = PAIRABLE.some(([a, b]) => [a, b].sort().join("|") === pair.join("|"));
    assert.ok(isAllowed, `Unallowed double-up in family ${f}: ${pair.join(", ")}`);
  }
  assert.equal(new Set(drafts.map((d) => d.title)).size, 4);
});

// ─── 14. Discovery does not automatically satisfy Explore Country ─────────────
test("14. discovery does not automatically satisfy explore country", () => {
  const at = iso(new Date(2026, 8, 16, 11, 0));
  const def = DAILY_GOAL_DEFINITIONS.find((d) => d.id === "discovery.explore_country")!;
  const meta = { windowStart: iso(new Date(2026, 8, 16, 9, 0)), actionTo: "", actionLabel: "", completionExplanation: "" };

  // Normal discover delivered leads without country job -> 0
  const ev = emptyEvidence({ leads: [lead({ createdAt: at, source: "discover_live" })] });
  assert.equal(def.progress({ target: 1, metadata: meta }, ev), 0);
});

// ─── 15. Discovery does not satisfy Add Relationship ──────────────────────────
test("15. discovery does not satisfy add relationship", () => {
  const at = iso(new Date(2026, 8, 16, 11, 0));
  const def = DAILY_GOAL_DEFINITIONS.find((d) => d.id === "relationships.add_relationship")!;
  const meta = { windowStart: iso(new Date(2026, 8, 16, 9, 0)), actionTo: "", actionLabel: "", completionExplanation: "" };

  const ev = emptyEvidence({ leads: [lead({ createdAt: at, source: "discover_live" })] });
  assert.equal(def.progress({ target: 2, metadata: meta }, ev), 0);
});

// ─── 16. Add Relationship does not satisfy Discovery ──────────────────────────
test("16. add relationship does not satisfy discovery", () => {
  const at = iso(new Date(2026, 8, 16, 11, 0));
  const def = DAILY_GOAL_DEFINITIONS.find((d) => d.id === "discovery.discover_new")!;
  const meta = { windowStart: iso(new Date(2026, 8, 16, 9, 0)), actionTo: "", actionLabel: "", completionExplanation: "" };

  const ev = emptyEvidence({ leads: [lead({ createdAt: at, source: "manual" })] });
  assert.equal(def.progress({ target: 10, metadata: meta }, ev), 0);
});

// ─── 17. Start Conversations and Reconnect have independent predicates ────────
test("17. start conversations and reconnect have independent predicates", () => {
  const at = iso(new Date(2026, 8, 16, 11, 0));
  const W = iso(new Date(2026, 8, 16, 9, 0));
  const meta = { windowStart: W, actionTo: "", actionLabel: "", completionExplanation: "" };

  const startDef = DAILY_GOAL_DEFINITIONS.find((d) => d.id === "outreach.start_conversations")!;
  const reconnectDef = DAILY_GOAL_DEFINITIONS.find((d) => d.id === "outreach.reconnect")!;

  // Send to untouched lead (not in priorSendLeadIds)
  const firstSendEv = emptyEvidence({
    genuineSends: [{ leadId: 50, type: "email_sent", timestamp: at }],
    priorSendLeadIds: new Set(["99"]),
  });
  assert.equal(startDef.progress({ target: 3, metadata: meta }, firstSendEv), 1);
  assert.equal(reconnectDef.progress({ target: 3, metadata: meta }, firstSendEv), 0);

  // Send to prior-contacted lead (in priorSendLeadIds)
  const reconnectSendEv = emptyEvidence({
    genuineSends: [{ leadId: 99, type: "email_sent", timestamp: at }],
    priorSendLeadIds: new Set(["99"]),
  });
  assert.equal(startDef.progress({ target: 3, metadata: meta }, reconnectSendEv), 0);
  assert.equal(reconnectDef.progress({ target: 3, metadata: meta }, reconnectSendEv), 1);
});

// ─── 18. Daily targets never exceed realistic available capacity ──────────────
test("18. daily targets never exceed realistic available capacity", () => {
  const s = input({ plan: "free", dailyDiscoverLimit: 12, dailyDiscoverUsed: 0 });
  const dTarget = discoverTarget(s);
  const aTarget = addRelationshipTarget(s);
  assert.ok(dTarget !== null && aTarget !== null);
  assert.ok(dTarget + aTarget <= 12, `Target sum ${dTarget + aTarget} cannot exceed available 12`);
});

// ─── 19. Free cannot receive global-country goals ─────────────────────────────
test("19. free cannot receive global-country goals", () => {
  const drafts = buildDailyGoalDrafts(richState("free"));
  assert.ok(!drafts.some((d) => d.definitionId === "discovery.explore_country"));
});

// ─── 20. Starter+ can receive global-country goals when eligible ──────────────
test("20. starter+ can receive global-country goals when eligible", () => {
  const def = DAILY_GOAL_DEFINITIONS.find((d) => d.id === "discovery.explore_country")!;
  assert.equal(canUseGoalDefinition("starter", def), true);
  assert.equal(canUseGoalDefinition("pro", def), true);
  assert.equal(canUseGoalDefinition("premium", def), true);
});

// ─── 21. Daily selection is deterministic for given user/day/state ────────────
test("21. daily selection is deterministic for given user/day/state", () => {
  const state = richState("starter");
  const drafts1 = buildDailyGoalDrafts(state);
  const drafts2 = buildDailyGoalDrafts(state);
  assert.deepEqual(drafts1, drafts2);
});

// ─── 22. Four persisted goals survive reload ──────────────────────────────────
test("22. four persisted goals survive reload", () => {
  const store = new SetStore();
  const key = localDateKey(NOW);
  const drafts = buildDailyGoalDrafts(richState("starter"));
  store.ensure(key, drafts);
  const reloaded = store.get(key);
  assert.equal(reloaded.length, 4);
  assert.deepEqual(reloaded.map((g) => g.definitionId), drafts.map((d) => d.definitionId));
});

// ─── 23. Goal XP is awarded exactly once ──────────────────────────────────────
test("23. goal XP awarded within milestone limits", () => {
  const allowed = new Set(Object.values(XP_BY_DIFFICULTY));
  for (const d of DAILY_GOAL_DEFINITIONS) {
    assert.ok(allowed.has(d.xp), `${d.id} xp ${d.xp} not valid difficulty tier`);
  }
  for (const plan of PLANS) {
    const total = buildDailyGoalDrafts(richState(plan)).reduce((n, d) => n + d.xp, 0);
    assert.ok(total <= 4 * 50, `Day total XP ${total} must not exceed 200`);
  }
});

// ─── 24. No fallback goal is a fake feature ───────────────────────────────────
test("24. no fallback goal is a fake feature", () => {
  for (const d of DAILY_GOAL_DEFINITIONS) {
    assert.ok(["discovery", "outreach", "relationships", "workspace", "follow_through"].includes(d.family));
  }
});

// ─── 25. Import/Export/AI are never injected merely as filler ─────────────────
test("25. import/export/ai counters are never injected as filler", () => {
  const banned = ["exports_completed", "ai_actions", "import_list", "data.import_list"];
  for (const b of banned) {
    assert.ok(!DAILY_GOAL_DEFINITIONS.some((d) => d.id.includes(b)));
  }
});

// ─── 26. Empty/cold-start states are handled explicitly ───────────────────────
test("26. empty/cold-start states are handled explicitly", () => {
  const drafts = buildDailyGoalDrafts(input({ plan: "free" }));
  assert.equal(drafts.length, 4);
  assert.deepEqual(drafts.map((d) => d.family).sort(), ["discovery", "outreach", "relationships", "workspace"]);
  const projected = drafts.filter((d) => d.metadata.projected).map((d) => d.definitionId).sort();
  assert.deepEqual(projected, ["outreach.start_conversations", "workspace.add_context"]);
});

// ─── Diagnostics on Degenerate States (Section 16) ───────────────────────────
test("Section 16: degenerate states report structured machine-readable diagnostics rather than persisting fewer than 4", () => {
  const diag = generateDailyGoals(input({ plan: "free", dailyDiscoverUsed: 20, leads: [] }));
  assert.equal(diag.ok, false);
  if (!diag.ok) {
    assert.equal(diag.code, "INSUFFICIENT_LEGITIMATE_GOALS");
    assert.ok(diag.availableCount < 4);
    assert.ok(diag.exhaustedFamilies.length > 0);
    assert.ok(diag.missingMechanics.length > 0);
  }
  // buildDailyGoalDrafts throws rather than returning an incomplete set
  assert.throws(
    () => buildDailyGoalDrafts(input({ plan: "free", dailyDiscoverUsed: 20, leads: [] })),
    DailyGoalGenerationError,
  );
});

// ─── Section 25: Mutation / Regression Validation ─────────────────────────────
test("25-mutation: breaking exact 4 contract is caught by SetStore", () => {
  const store = new SetStore();
  const key = localDateKey(NOW);
  const badDrafts = buildDailyGoalDrafts(richState("free")).slice(0, 3);
  assert.throws(() => store.ensure(key, badDrafts), /ensure requires exactly 4 goals/);
});

test("25-mutation: plan matrix accurately reflects all 8 definitions", () => {
  const matrix = planMatrix();
  assert.equal(matrix.length, 8);
  const byId = Object.fromEntries(matrix.map((r) => [r.goal, r.plans]));
  assert.deepEqual(byId["discovery.discover_new"], { free: true, starter: true, pro: true, premium: true });
  assert.deepEqual(byId["discovery.explore_country"], { free: false, starter: true, pro: true, premium: true });
  assert.deepEqual(byId["outreach.start_conversations"], { free: true, starter: true, pro: true, premium: true });
  assert.deepEqual(byId["outreach.reconnect"], { free: true, starter: true, pro: true, premium: true });
  assert.deepEqual(byId["relationships.add_relationship"], { free: true, starter: true, pro: true, premium: true });
  assert.deepEqual(byId["workspace.add_context"], { free: true, starter: true, pro: true, premium: true });
  assert.deepEqual(byId["follow_through.clear_due"], { free: false, starter: true, pro: true, premium: true });
  assert.deepEqual(byId["follow_through.schedule_next_steps"], { free: false, starter: true, pro: true, premium: true });
});

test("25-mutation: all 15 legacy definitions audited; none silently active", () => {
  assert.equal(GOAL_DEFINITIONS.length, 15);
  assert.deepEqual(
    LEGACY_GOAL_AUDIT.map((a) => a.key).sort(),
    GOAL_DEFINITIONS.map((d) => d.key).sort(),
  );
  const ids = new Set(DAILY_GOAL_DEFINITIONS.map((d) => d.id));
  for (const a of LEGACY_GOAL_AUDIT) {
    if (a.disposition === "transformed" || a.disposition === "retained") {
      assert.ok(a.becomes && ids.has(a.becomes), `${a.key} → ${a.becomes}`);
    } else {
      assert.equal(a.becomes, null);
    }
  }
});
