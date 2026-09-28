import assert from "node:assert/strict";
import test from "node:test";
import type { FollowupWithLead, Lead } from "../api";
import {
  collectFocusPriorities,
  selectFocusStack,
  type FocusGoalInput,
  type FocusPriorityInput,
} from "../focus-priorities.js";
import {
  isDiscoveredLead,
  isEngagedRelationship,
  isUntouchedDiscoveredLead,
} from "../lead-provenance.js";

// Fixed clock: Wed 2026-09-16 12:00 local.
const NOW = new Date(2026, 8, 16, 12, 0, 0);

function daysAgo(n: number) {
  const d = new Date(NOW);
  d.setDate(d.getDate() - n);
  return d.toISOString();
}

let nextId = 1;
function lead(over: Partial<Lead> = {}): Lead {
  const id = over.id ?? nextId++;
  return {
    id,
    businessName: `Business ${id}`,
    status: "new",
    createdAt: daysAgo(1),
    updatedAt: daysAgo(1),
    source: "discover_live",
    businessId: `biz-${id}`,
    ...over,
  } as Lead;
}

function followup(
  leadRow: Lead,
  dueDaysAgo: number,
  over: Partial<FollowupWithLead> = {},
): FollowupWithLead {
  return {
    id: `f-${leadRow.id}-${dueDaysAgo}`,
    leadId: leadRow.id,
    channel: "email",
    dueAt: daysAgo(dueDaysAgo),
    status: "pending",
    createdAt: daysAgo(10),
    updatedAt: daysAgo(10),
    lead: leadRow,
    ...over,
  } as FollowupWithLead;
}

function input(over: Partial<FocusPriorityInput> = {}): FocusPriorityInput {
  return {
    leads: [],
    followups: [],
    goals: [],
    claimedGoalIds: [],
    xp: 0,
    nextTier: { name: "Prospector", xpRequired: 100 },
    dailyRemaining: 10,
    monthlyRemaining: 100,
    followupsAvailable: true,
    now: NOW,
    ...over,
  };
}

function goal(over: Partial<FocusGoalInput> = {}): FocusGoalInput {
  return {
    id: "contact:18",
    label: "Contact 18 businesses",
    target: 18,
    current: 2,
    xp: 50,
    category: "outreach",
    ...over,
  };
}

const kinds = (i: FocusPriorityInput) => collectFocusPriorities(i).map((p) => p.kind);

// ── CASE 1 ───────────────────────────────────────────────────────────────────
test("overdue follow-up is the primary focus and names the business", () => {
  const acme = lead({
    businessName: "Acme Bakery",
    status: "email_sent",
    lastContactedAt: daysAgo(6),
  });
  const beta = lead({
    businessName: "Beta Cafe",
    status: "email_sent",
    lastContactedAt: daysAgo(4),
  });
  const untouched = lead();
  const list = collectFocusPriorities(
    input({
      leads: [acme, beta, untouched],
      followups: [followup(beta, 1), followup(acme, 3)],
    }),
  );
  const top = list[0];
  assert.equal(top.kind, "followup_overdue");
  assert.equal(top.hero.headline, "Follow up with Acme Bakery");
  assert.match(top.hero.description, /3 days overdue/);
  assert.match(top.hero.description, /1 more follow-up is overdue/);
  assert.equal(top.hero.to, "/dashboard/follow-ups");
});

test("follow-ups on dead leads and completed follow-ups are ignored", () => {
  const dead = lead({ status: "dead", lastContactedAt: daysAgo(9) });
  const done = lead({ status: "email_sent", lastContactedAt: daysAgo(9) });
  const list = collectFocusPriorities(
    input({
      leads: [dead, done],
      followups: [followup(dead, 5), followup(done, 5, { status: "completed" })],
    }),
  );
  assert.ok(!list.some((p) => p.kind === "followup_overdue"));
});

test("a follow-up due today wins only when nothing is overdue", () => {
  const a = lead({
    businessName: "Due Today Co",
    status: "email_sent",
    lastContactedAt: daysAgo(2),
  });
  const list = collectFocusPriorities(input({ leads: [a], followups: [followup(a, 0)] }));
  assert.equal(list[0].kind, "followup_due_today");
  assert.match(list[0].hero.description, /due today/);
});

// ── CASE 2 ───────────────────────────────────────────────────────────────────
test("contacted lead with no follow-up becomes primary when nothing is overdue", () => {
  const contacted = lead({
    businessName: "Nova Studio",
    status: "email_sent",
    lastContactedAt: daysAgo(2),
  });
  const untouched = lead();
  const list = collectFocusPriorities(input({ leads: [contacted, untouched] }));
  assert.equal(list[0].kind, "schedule_followup");
  assert.match(
    list[0].hero.description,
    /You contacted Nova Studio, but no follow-up is scheduled\./,
  );
  assert.equal(list[0].hero.to, `/dashboard/leads/${contacted.id}`);
});

test("a contacted lead that already has a pending follow-up is not flagged", () => {
  const contacted = lead({ status: "email_sent", lastContactedAt: daysAgo(2) });
  const list = collectFocusPriorities(
    input({ leads: [contacted], followups: [followup(contacted, -3)] }),
  );
  assert.ok(!list.some((p) => p.kind === "schedule_followup" || p.kind === "silent_contact"));
});

test("Free plan (no follow-ups feature) never asks to schedule a follow-up", () => {
  const contacted = lead({ status: "email_sent", lastContactedAt: daysAgo(2) });
  const list = collectFocusPriorities(input({ leads: [contacted], followupsAvailable: false }));
  assert.ok(!list.some((p) => p.kind === "schedule_followup"));
});

// ── CASE 3 ───────────────────────────────────────────────────────────────────
test("contacted lead with no recorded reply for 7+ days gives a silent-contact recommendation", () => {
  const quiet = lead({
    businessName: "Quiet Co",
    status: "email_sent",
    lastContactedAt: daysAgo(9),
  });
  const list = collectFocusPriorities(input({ leads: [quiet], followupsAvailable: false }));
  assert.equal(list[0].kind, "silent_contact");
  assert.match(
    list[0].hero.description,
    /Quiet Co has had no recorded reply for 9 days since your last contact\./,
  );
  // It must not claim the business replied or went silent on its own.
  assert.doesNotMatch(list[0].hero.description, /replied\b(?! )/);
});

test("replied, meeting and closed leads are never treated as silent", () => {
  const leads = ["replied", "meeting_booked", "closed", "dead"].map((status) =>
    lead({ status, lastContactedAt: daysAgo(20) }),
  );
  assert.ok(
    !kinds(input({ leads })).some((k) => k === "silent_contact" || k === "schedule_followup"),
  );
});

test("a lead marked contacted without a contact date cannot be called silent", () => {
  const unknown = lead({ status: "email_sent", lastContactedAt: null });
  assert.ok(!kinds(input({ leads: [unknown] })).includes("silent_contact"));
});

// ── CASE 4 + the original bug ────────────────────────────────────────────────
test("untouched discovered leads yield a review recommendation, not discovery", () => {
  const leads = [lead(), lead(), lead()];
  const list = collectFocusPriorities(input({ leads, dailyRemaining: 15 }));
  assert.equal(list[0].kind, "review_opportunities");
  assert.equal(list[0].hero.headline, "Review 3 discovered opportunities");
  assert.ok(
    !list.some((p) => p.kind === "discover"),
    "discovery must not appear while a backlog exists",
  );
});

test("scored discovered leads are ranked by score and expose the top score", () => {
  const leads = [
    lead({ opportunityScore: 61.4 }),
    lead({ opportunityScore: 88.2 }),
    lead({ opportunityScore: null }),
  ];
  const top = collectFocusPriorities(input({ leads }))[0];
  assert.equal(top.kind, "review_opportunities");
  assert.match(top.hero.description, /2 of 3 have an opportunity score; the highest is 88/);
  assert.deepEqual(
    top.hero.metrics.find((m) => m.label === "top score"),
    { label: "top score", value: "88" },
  );
});

test("a single untouched lead is named and linked directly", () => {
  const only = lead({ businessName: "Solo Salon" });
  const top = collectFocusPriorities(input({ leads: [only] }))[0];
  assert.equal(top.hero.headline, "Review Solo Salon");
  assert.equal(top.hero.to, `/dashboard/leads/${only.id}`);
});

// ── CASE 5 ───────────────────────────────────────────────────────────────────
test("nearly-complete goal becomes the recommendation when there is no lead priority", () => {
  const list = collectFocusPriorities(
    input({ goals: [goal({ current: 15 })], leads: [], dailyRemaining: 10 }),
  );
  assert.equal(list[0].kind, "goal_near");
  assert.equal(list[0].hero.headline, 'Finish "Contact 18 businesses"');
  assert.match(list[0].hero.description, /You're 15\/18\./);
});

test("a completed, unclaimed goal is offered for claiming; a claimed one is not", () => {
  const done = goal({ current: 18 });
  const claim = collectFocusPriorities(input({ goals: [done] }))[0];
  assert.equal(claim.kind, "goal_claim");
  assert.equal(claim.hero.hash, "focus-goals");
  const claimed = collectFocusPriorities(input({ goals: [done], claimedGoalIds: [done.id] }));
  assert.ok(!claimed.some((p) => p.kind === "goal_claim"));
});

test("a goal barely started is not surfaced", () => {
  assert.ok(!kinds(input({ goals: [goal({ current: 1 })] })).includes("goal_near"));
});

// ── CASE 6 ───────────────────────────────────────────────────────────────────
test("XP close to the next tier drives a progression recommendation and mentions no reward", () => {
  const list = collectFocusPriorities(
    input({
      xp: 60,
      goals: [goal({ current: 3, xp: 50 })],
      nextTier: { name: "Closer", xpRequired: 100 },
    }),
  );
  assert.equal(list[0].kind, "xp_milestone");
  assert.equal(list[0].hero.headline, "You're 40 XP from Closer");
  assert.match(list[0].hero.description, /Finishing "Contact 18 businesses" is worth \+50 XP\./);
  assert.doesNotMatch(JSON.stringify(list[0]), /unlock|reward/i);
});

test("XP far from the next tier is not surfaced", () => {
  assert.ok(!kinds(input({ xp: 10 })).includes("xp_milestone"));
});

// ── CASE 7 ───────────────────────────────────────────────────────────────────
test("nothing meaningful yields an empty priority list (clear state)", () => {
  const list = collectFocusPriorities(
    input({
      leads: [lead({ status: "closed", lastContactedAt: daysAgo(30) })],
      dailyRemaining: 0,
      xp: 5,
    }),
  );
  assert.deepEqual(list, []);
});

test("discovery is only recommended when the backlog is empty and capacity exists", () => {
  assert.equal(collectFocusPriorities(input({ xp: 5 }))[0].kind, "discover");
  assert.deepEqual(kinds(input({ xp: 5, dailyRemaining: 0 })), []);
  assert.deepEqual(kinds(input({ xp: 5, monthlyRemaining: 0 })), []);
});

test("an empty workspace is invited to discover its first opportunities", () => {
  const top = collectFocusPriorities(input({ xp: 5 }))[0];
  assert.equal(top.hero.headline, "Discover your first opportunities");
});

// ── CASE 8 ───────────────────────────────────────────────────────────────────
test("a single meaningful priority does not fabricate a second or third", () => {
  const list = collectFocusPriorities(input({ leads: [lead()] }));
  assert.equal(list.length, 1);
  assert.deepEqual(selectFocusStack(list), []);
});

test("the stack prefers diversity and never repeats a family", () => {
  const acme = lead({ businessName: "Acme", status: "email_sent", lastContactedAt: daysAgo(3) });
  const beta = lead({ businessName: "Beta", status: "email_sent", lastContactedAt: daysAgo(10) });
  const gamma = lead({ businessName: "Gamma", status: "email_sent", lastContactedAt: daysAgo(4) });
  const fresh = lead();
  const list = collectFocusPriorities(
    input({
      leads: [acme, beta, gamma, fresh],
      followups: [followup(acme, 3), followup(gamma, 2)],
      goals: [goal({ current: 16 })],
    }),
  );
  const stack = selectFocusStack(list);
  const families = [list[0], ...stack].map((p) => p.family);
  assert.equal(new Set(families).size, families.length, "one item per family");
  assert.ok(stack.length <= 3);
  // Two overdue follow-ups collapse into ONE follow-up entry (the hero).
  assert.equal(list.filter((p) => p.family === "followup").length, 1);
  // Discovery never shows up while other work is waiting.
  assert.ok(!list.some((p) => p.kind === "discover"));
});

// ── CASE 9 ───────────────────────────────────────────────────────────────────
test("without opportunity scores Focus never claims a numeric score", () => {
  const leads = [lead({ opportunityScore: null }), lead({ opportunityScore: undefined })];
  const top = collectFocusPriorities(input({ leads, followupsAvailable: false }))[0];
  assert.equal(top.kind, "review_opportunities");
  const text = JSON.stringify(top);
  assert.doesNotMatch(text, /score is|highest is|top score/);
  assert.deepEqual(
    top.hero.metrics.find((m) => m.label === "opportunity score"),
    { label: "opportunity score", value: "Not available" },
  );
});

// ── CASE 10 ──────────────────────────────────────────────────────────────────
test("manual and CSV leads are not discovered opportunities", () => {
  const manual = lead({ source: "manual", businessId: null });
  const csv = lead({ source: "csv_import", businessId: null });
  assert.equal(isDiscoveredLead(manual), false);
  assert.equal(isDiscoveredLead(csv), false);
  assert.equal(isUntouchedDiscoveredLead(manual), false);
  assert.equal(isUntouchedDiscoveredLead(csv), false);
  assert.deepEqual(kinds(input({ leads: [manual, csv], dailyRemaining: 0, xp: 5 })), []);
});

test("provenance recognises every backend delivery source", () => {
  for (const source of ["discover_live", "discover_instant_pool", "discover_instant_pool_ranked"]) {
    assert.equal(isDiscoveredLead({ source, businessId: null }), true, source);
  }
  assert.equal(isDiscoveredLead({ source: null, businessId: "abc" }), true);
  assert.equal(isDiscoveredLead({ source: null, businessId: null }), false);
  assert.equal(isDiscoveredLead({ source: "manual", businessId: "abc" }), false);
});

test("'Save N relationships' no longer counts untouched discovered leads", () => {
  const untouched = lead();
  const contacted = lead({ status: "email_sent", lastContactedAt: daysAgo(1) });
  const manual = lead({ source: "manual", businessId: null });
  assert.equal(isEngagedRelationship(untouched), false);
  assert.equal(isEngagedRelationship(contacted), true);
  assert.equal(isEngagedRelationship(manual), true);
});
