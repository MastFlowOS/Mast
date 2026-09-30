import assert from "node:assert/strict";
import test from "node:test";
import type { FollowupWithLead, Lead } from "../api";
import {
  buildFocusSnapshot,
  getCurrentMilestone,
  getNextMilestone,
  type FocusContext,
} from "../focus.js";

const NOW = new Date(2026, 8, 16, 12, 0, 0);

function daysAgo(n: number) {
  const d = new Date(NOW);
  d.setDate(d.getDate() - n);
  return d.toISOString();
}

let nextId = 1000;
function lead(over: Partial<Lead> = {}): Lead {
  const id = nextId++;
  return {
    id,
    businessName: `Lead ${id}`,
    status: "new",
    createdAt: daysAgo(30),
    updatedAt: daysAgo(30),
    source: "discover_live",
    businessId: `biz-${id}`,
    ...over,
  } as Lead;
}

function ctx(over: Partial<FocusContext> = {}): FocusContext {
  return {
    leads: [],
    followups: [],
    dailyDiscoverUsed: 0,
    dailyDiscoverLimit: 10,
    monthlyRemaining: 100,
    plan: "starter",
    xp: 5,
    goalsClaimedToday: 0,
    now: NOW,
    ...over,
  };
}

test("primary recommendation and stack follow the deterministic waterfall", () => {
  const late = lead({ businessName: "Late Co", status: "email_sent", lastContactedAt: daysAgo(6) });
  const fresh = [lead(), lead()];
  const followups = [
    {
      id: "f1",
      leadId: late.id,
      channel: "email",
      dueAt: daysAgo(2),
      status: "pending",
      createdAt: daysAgo(8),
      updatedAt: daysAgo(8),
      lead: late,
    } as FollowupWithLead,
  ];
  const snap = buildFocusSnapshot("Sam", ctx({ leads: [late, ...fresh], followups }));
  assert.equal(snap.primaryRecommendation?.headline, "Follow up with Late Co");
  assert.equal(snap.isClear, false);
  assert.equal(snap.focusStack[0].title, "Review 2 discovered opportunities");
  assert.equal(snap.focusStack[0].number, "01");
  assert.match(snap.greeting.subtitle, /overdue/i);
});

test("a user with untouched leads and free discovery capacity is NOT sent to discovery", () => {
  const leads = Array.from({ length: 200 }, () => lead());
  const snap = buildFocusSnapshot("Sam", ctx({ leads, plan: "free", dailyDiscoverUsed: 0 }));
  assert.match(snap.primaryRecommendation?.headline ?? "", /^Review 200 discovered opportunities$/);
  assert.notEqual(snap.primaryRecommendation?.id, "discover-window");
});

test("clear state: no primary, no stack, quiet signal", () => {
  const snap = buildFocusSnapshot(
    "Sam",
    ctx({
      leads: [lead({ status: "closed", lastContactedAt: daysAgo(30) })],
      dailyDiscoverUsed: 10,
    }),
  );
  assert.equal(snap.isClear, true);
  assert.equal(snap.primaryRecommendation, null);
  assert.deepEqual(snap.focusStack, []);
  assert.equal(snap.greeting.subtitle, "You're all caught up.");
});

test("MAST Signal is an honest quiet state with no fabricated numbers or action", () => {
  const snap = buildFocusSnapshot("Sam", ctx());
  assert.equal(snap.signal.isQuiet, true);
  assert.equal(snap.signal.headline, "NO NOTABLE SIGNAL");
  assert.equal(snap.signal.detail, "No meaningful pattern detected yet.");
  assert.equal(snap.signal.to, null);
  assert.doesNotMatch(JSON.stringify(snap.signal), /\d/);
});

test("recent activity only reports events with a real timestamp in a stated window", () => {
  const leads = [
    lead({ createdAt: daysAgo(2) }), // discovered this week
    lead({ createdAt: daysAgo(20), status: "email_sent", lastContactedAt: daysAgo(3) }), // contacted this week
    lead({ source: "manual", businessId: null, createdAt: daysAgo(1) }), // manual: not "discovered"
  ];
  const followups = [
    {
      id: "f",
      leadId: leads[1].id,
      channel: "email",
      dueAt: daysAgo(4),
      completedAt: daysAgo(2),
      status: "completed",
      createdAt: daysAgo(9),
      updatedAt: daysAgo(2),
    } as FollowupWithLead,
  ];
  const snap = buildFocusSnapshot("Sam", ctx({ leads, followups, goalsClaimedToday: 2 }));
  const byId = Object.fromEntries(snap.momentum.map((e) => [e.id, e]));
  assert.equal(byId["activity-goals-today"].delta, "+2");
  assert.equal(byId["activity-contacted"].delta, "+1");
  assert.equal(byId["activity-followups"].delta, "+1");
  assert.equal(byId["activity-discovered"].delta, "+1"); // manual lead excluded
  assert.ok(snap.momentum.every((e) => !/streak|replied/i.test(`${e.label} ${e.detail}`)));
});

test("recent activity is empty (no baseline filler) for a fresh account", () => {
  assert.deepEqual(buildFocusSnapshot("Sam", ctx()).momentum, []);
});

test("weekly pulse states its basis and omits replies and meetings", () => {
  const leads = [
    lead({ createdAt: daysAgo(2) }),
    lead({ source: "csv_import", businessId: null, createdAt: daysAgo(3) }),
    lead({ createdAt: daysAgo(40), status: "email_sent", lastContactedAt: daysAgo(1) }),
  ];
  const pulse = buildFocusSnapshot("Sam", ctx({ leads })).weeklyPulse;
  assert.equal(pulse.basisLabel, "Last 7 days");
  const tiles = Object.fromEntries(pulse.tiles.map((t) => [t.label, t.value]));
  assert.deepEqual(tiles, { Discovered: 1, Added: 1, Contacted: 1, "Follow-ups done": 0 });
  assert.ok(!pulse.tiles.some((t) => /repl|meeting/i.test(t.label)));
});

test("Free plan pulse has no follow-up tile", () => {
  const pulse = buildFocusSnapshot("Sam", ctx({ plan: "free" })).weeklyPulse;
  assert.ok(!pulse.tiles.some((t) => t.label === "Follow-ups done"));
});

test("milestone maths uses XP against MILESTONE_TIERS", () => {
  assert.equal(getCurrentMilestone(120).name, "Prospector");
  const next = getNextMilestone(120);
  assert.equal(next?.name, "Closer");
  assert.equal((next?.xpRequired ?? 0) - 120, 130);
});

