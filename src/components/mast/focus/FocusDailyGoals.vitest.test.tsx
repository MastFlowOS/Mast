/**
 * Focus ↔ Daily Goals integration (Phase 2).
 *
 * Renders the REAL FocusDashboard with the REAL Daily Goals hooks and engine.
 * Only the network layer is replaced: `@/lib/api` daily-goal calls hit a tiny
 * in-memory "server" that behaves like the SQL functions (ensure once,
 * monotonic progress, claim once with the stored XP), and the workspace query
 * hooks return fixtures.
 */
import React from "react";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { FollowupWithLead, Lead } from "@/lib/api";
import {
  buildDailyGoalDrafts,
  localDateKey,
  type BuildDailyGoalsInput,
  type DailyGoalDraft,
  type DailyGoalInstance,
  type GoalEvidence,
} from "@/lib/dailyGoals";

// ─── Mocks ───────────────────────────────────────────────────────────────────

const api = vi.hoisted(() => ({
  getDailyGoals: vi.fn(),
  ensureDailyGoals: vi.fn(),
  setDailyGoalProgress: vi.fn(),
  claimDailyGoal: vi.fn(),
  getDailyGoalEvidence: vi.fn(),
}));
vi.mock("@/lib/api", () => ({ ...api, ApiError: class ApiError extends Error {} }));

const hooks = vi.hoisted(() => ({
  useMe: vi.fn(),
  useAccount: vi.fn(),
  useLeads: vi.fn(),
  useFollowups: vi.fn(),
}));
const server = vi.hoisted(() => ({ xp: 0 }));

vi.mock("@/hooks/use-mast-api", async () => {
  const { useQuery } = await import("@tanstack/react-query");
  return {
    ...hooks,
    queryKeys: { xp: ["mast", "xp"] },
    useXp: () =>
      useQuery({ queryKey: ["mast", "xp"], queryFn: async () => server.xp, staleTime: Infinity }),
  };
});

vi.mock("@tanstack/react-router", () => ({
  Link: ({
    to,
    hash: _hash,
    children,
    ...rest
  }: Record<string, unknown> & { to: string; children: React.ReactNode }) => (
    <a href={to} {...rest}>
      {children}
    </a>
  ),
}));

vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }) }));
vi.mock("@/lib/notifications", () => ({ addNotification: vi.fn() }));

import { FocusDashboard } from "@/components/mast/focus/FocusDashboard";

// ─── Fixtures ────────────────────────────────────────────────────────────────

const NOW = new Date(2026, 8, 16, 10, 0, 0); // local 10:00
const iso = (d: Date) => d.toISOString();
const daysFromNow = (n: number) => {
  const d = new Date(NOW);
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
    opportunityScore: 60,
    ...over,
  } as Lead;
}
const contacted = () => lead({ status: "email_sent", lastContactedAt: iso(daysFromNow(-8)) });
let fid = 1;
const followup = (l: Lead, dueInDays: number): FollowupWithLead =>
  ({
    id: fid++,
    leadId: l.id,
    channel: "email",
    dueAt: iso(daysFromNow(dueInDays)),
    status: "pending",
    createdAt: iso(daysFromNow(-5)),
    updatedAt: iso(daysFromNow(-5)),
    completedAt: null,
    lead: l,
  }) as FollowupWithLead;

/** Rich workspace: real engine yields clear_due, start_conversations, add_context, explore_country. */
function richWorkspace() {
  const untouched = Array.from({ length: 12 }, () => lead());
  const done = Array.from({ length: 6 }, contacted);
  const dueLeads = Array.from({ length: 3 }, contacted);
  return {
    leads: [...untouched, ...done, ...dueLeads],
    followups: [followup(dueLeads[0], -2), followup(dueLeads[1], 0), followup(dueLeads[2], 3)],
  };
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

// ─── In-memory "server" behaving like migration 035 ──────────────────────────

let rows = new Map<string, DailyGoalInstance[]>();
let evidence: GoalEvidence = emptyEvidence();
const clone = <T,>(v: T): T => structuredClone(v);

function installServer() {
  rows = new Map();
  server.xp = 100;
  api.getDailyGoals.mockImplementation(async (date: string) => clone(rows.get(date) ?? []));
  api.ensureDailyGoals.mockImplementation(async (date: string, drafts: DailyGoalDraft[]) => {
    if (!rows.has(date)) {
      rows.set(
        date,
        drafts.map((d, i) => ({
          ...d,
          id: `${date}#${i + 1}`,
          progress: 0,
          status: "active" as const,
          createdAt: iso(NOW),
          completedAt: null,
          claimed: false,
        })),
      );
    }
    return clone(rows.get(date)!);
  });
  api.setDailyGoalProgress.mockImplementation(async (id: string, progress: number) => {
    const row = [...rows.values()].flat().find((g) => g.id === id)!;
    row.progress = Math.max(row.progress, Math.min(row.target, progress));
    if (row.progress >= row.target) {
      row.status = "completed";
      row.completedAt = iso(NOW);
    }
    return clone(row);
  });
  api.claimDailyGoal.mockImplementation(async (id: string) => {
    const row = [...rows.values()].flat().find((g) => g.id === id)!;
    if (row.status !== "completed") throw new Error("not completed");
    if (row.claimed) return { xp: server.xp, awarded: false };
    row.claimed = true;
    server.xp += row.xp; // XP comes from the persisted row
    return { xp: server.xp, awarded: true };
  });
  api.getDailyGoalEvidence.mockImplementation(async () => clone(evidence));
}

type Setup = {
  plan?: "free" | "starter" | "pro" | "premium";
  leads?: Lead[];
  followups?: FollowupWithLead[];
  dailyUsed?: number;
};

function setWorkspace({ plan = "pro", leads, followups, dailyUsed = 0 }: Setup = {}) {
  const ws = richWorkspace();
  const leadsData = leads ?? ws.leads;
  const followupsData = followups ?? ws.followups;
  hooks.useMe.mockReturnValue({
    data: { user: { fullName: "Sam Rivera", plan, dailyLeadsUsed: dailyUsed } },
    isLoading: false,
  });
  hooks.useAccount.mockReturnValue({
    data: {
      subscription: { plan },
      dailyUsage: {
        used: dailyUsed,
        limit: { free: 20, starter: 100, pro: 400, premium: 1000 }[plan],
      },
      monthlyUsage: { remaining: 200 },
    },
    isLoading: false,
  });
  hooks.useLeads.mockReturnValue({ data: leadsData, isLoading: false, isSuccess: true });
  // Free has no follow-up capability: that query legitimately fails there.
  hooks.useFollowups.mockReturnValue(
    plan === "free"
      ? { data: undefined, isLoading: false, isSuccess: false, isError: true }
      : { data: followupsData, isLoading: false, isSuccess: true },
  );
}

function renderFocus() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  const utils = render(
    <QueryClientProvider client={qc}>
      <FocusDashboard />
    </QueryClientProvider>,
  );
  return { qc, ...utils };
}

const rowsEl = () => screen.queryAllByTestId("daily-goal-row");
const rowIds = () => rowsEl().map((r) => r.getAttribute("data-goal-id"));
const rowByDefinition = (defId: string) => {
  const all = [...rows.values()].flat();
  const id = all.find((g) => g.definitionId === defId)?.id;
  return rowsEl().find((r) => r.getAttribute("data-goal-id") === id)!;
};
async function waitForFour() {
  await waitFor(() => expect(rowsEl()).toHaveLength(4));
}
/** Evidence that completes `workspace.add_context` (3 distinct notes after the window opens). */
function noteEvidence() {
  const ts = iso(new Date(NOW.getTime() + 60_000));
  return emptyEvidence({ notes: [1, 2, 3].map((leadId) => ({ leadId, timestamp: ts })) });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], now: NOW });
  evidence = emptyEvidence();
  Object.values(api).forEach((m) => m.mockClear());
  installServer();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("Focus · Today's Goals (persisted Daily Goals)", () => {
  it("1. renders exactly 4 Daily Goals, with an X / 4 COMPLETE header", async () => {
    setWorkspace();
    renderFocus();
    await waitForFour();
    expect(rowsEl()).toHaveLength(4);
    expect(screen.getByTestId("goals-complete-count").textContent).toBe("0 / 4 COMPLETE");
    expect(screen.getByRole("heading", { name: "TODAY'S GOALS" })).toBeTruthy();
    expect(rowsEl().map((r) => r.getAttribute("data-slot"))).toEqual(["1", "2", "3", "4"]);
  });

  it("2. today's four survive a refresh (same rows, generated and persisted only once)", async () => {
    setWorkspace();
    const first = renderFocus();
    await waitForFour();
    const before = rowIds();
    expect(api.ensureDailyGoals).toHaveBeenCalledTimes(1);

    first.unmount();
    cleanup();
    renderFocus(); // brand new QueryClient == full page refresh
    await waitForFour();

    expect(rowIds()).toEqual(before);
    expect(api.ensureDailyGoals).toHaveBeenCalledTimes(1); // never re-generated
    expect(api.getDailyGoals).toHaveBeenCalledTimes(2);
  });

  it("3+4+5+13. a completed goal stays put until claimed, then sinks to the bottom; still 4 rows", async () => {
    setWorkspace();
    evidence = noteEvidence();
    renderFocus();
    await waitForFour();
    const orderBefore = rowIds();

    const done = rowByDefinition("workspace.add_context");
    const doneId = done.getAttribute("data-goal-id");
    await waitFor(() => expect(done.getAttribute("data-state")).toBe("complete"));
    expect(within(done).getByText("3 / 3")).toBeTruthy();
    expect(screen.getByTestId("goals-complete-count").textContent).toBe("1 / 4 COMPLETE");

    // Completed but unclaimed: it must NOT move, however long we wait.
    await new Promise((r) => setTimeout(r, 1200));
    expect(rowIds()).toEqual(orderBefore);
    expect(within(done).getByRole("button", { name: /CLAIM \+25 XP/ })).toBeTruthy();

    // Claim: dims, then travels to the very bottom.
    fireEvent.click(within(done).getByRole("button", { name: /CLAIM \+25 XP/ }));
    await waitFor(() => expect(done.getAttribute("data-state")).toBe("claimed"));
    expect(within(done).getByText("CLAIMED")).toBeTruthy();
    await waitFor(() => expect(rowIds().at(-1)).toBe(doneId), { timeout: 3000 });
    expect(rowsEl()).toHaveLength(4); // no Goal #5
    expect(rowIds().slice(0, 3)).toEqual(orderBefore.filter((id) => id !== doneId));
  });

  it("6+15. progress comes from Daily Goal evidence, fetched ONCE for all four goals", async () => {
    setWorkspace();
    evidence = noteEvidence();
    renderFocus();
    await waitForFour();
    const target = rowByDefinition("workspace.add_context");
    await waitFor(() => expect(within(target).getByText("3 / 3")).toBeTruthy());

    const goalId = target.getAttribute("data-goal-id");
    expect(api.setDailyGoalProgress).toHaveBeenCalledTimes(1); // only the changed goal
    expect(api.setDailyGoalProgress).toHaveBeenCalledWith(goalId, 3);

    const windowStart = [...rows.values()].flat()[0].metadata.windowStart;
    expect(api.getDailyGoalEvidence).toHaveBeenCalledTimes(1); // one snapshot, not one per goal
    expect(api.getDailyGoalEvidence.mock.calls[0][0]).toBe(windowStart);

    // Re-rendering / settling must not cause an evidence refetch storm.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(api.getDailyGoalEvidence).toHaveBeenCalledTimes(1);
    // Untouched goals never wrote progress.
    expect(api.setDailyGoalProgress.mock.calls.every(([id]) => id === goalId)).toBe(true);
  });

  it("7+8+9. claiming uses claimDailyGoal with only the goal id; duplicate claims are prevented; XP comes from the row", async () => {
    setWorkspace();
    evidence = noteEvidence();
    renderFocus();
    await waitForFour();
    const row = rowByDefinition("workspace.add_context");
    const button = await waitFor(() => within(row).getByRole("button", { name: /CLAIM \+25 XP/ }));

    // Double-click before the first claim resolves.
    fireEvent.click(button);
    fireEvent.click(button);
    await waitFor(() => expect(within(row).getByText("CLAIMED")).toBeTruthy());

    expect(api.claimDailyGoal).toHaveBeenCalledTimes(1);
    expect(api.claimDailyGoal).toHaveBeenCalledWith(row.getAttribute("data-goal-id")); // id only — no client XP
    expect(server.xp).toBe(125); // 100 + the persisted goal's 25
    expect(within(row).queryByRole("button", { name: /CLAIM/ })).toBeNull(); // nothing left to claim
    expect(row.getAttribute("data-state")).toBe("claimed");
  });

  it("10. plan-ineligible goals do not render (no locked / upgrade placeholders)", async () => {
    setWorkspace({ plan: "free" });
    renderFocus();
    await waitForFour();
    const persisted = [...rows.values()].flat();
    expect(persisted).toHaveLength(4);
    expect(persisted.some((g) => g.family === "follow_through")).toBe(false); // Free has no follow-ups
    const board = screen.getByRole("heading", { name: "TODAY'S GOALS" }).closest("section")!;
    expect(within(board).queryByText(/upgrade|locked|unlock/i)).toBeNull();
    expect(rowsEl()).toHaveLength(4);
  });

  it("11. a new local day loads a NEW set of four without a reload", async () => {
    setWorkspace();
    renderFocus();
    await waitForFour();
    const today = rowIds();
    const todayKey = localDateKey(new Date());

    // Local midnight passes while Focus stays open.
    vi.setSystemTime(new Date(2026, 8, 17, 0, 0, 5));
    await act(async () => {
      window.dispatchEvent(new Event("focus")); // tab wake-up path
    });

    await waitFor(() => expect(rowIds()).not.toEqual(today));
    expect(rowsEl()).toHaveLength(4);
    const tomorrowKey = localDateKey(new Date());
    expect(tomorrowKey).not.toBe(todayKey);
    expect(rowIds().every((id) => id!.startsWith(tomorrowKey))).toBe(true);
    expect(api.ensureDailyGoals).toHaveBeenCalledTimes(2);
    expect(api.ensureDailyGoals.mock.calls[1][0]).toBe(tomorrowKey); // LOCAL date, not UTC
    expect(rows.get(todayKey)).toHaveLength(4); // yesterday's set is untouched
  });

  it("12. LEGACY GOAL GENERATOR IS NOT USED ANYWHERE IN FOCUS (one Daily Goal lifecycle)", async () => {
    // Runtime: the single persisted lifecycle drives Focus end to end
    // (ensure -> evidence -> progress -> claim -> profiles.xp).
    setWorkspace();
    evidence = noteEvidence();
    renderFocus();
    await waitForFour();
    await waitFor(() => expect(api.setDailyGoalProgress).toHaveBeenCalled());
    const row = rowByDefinition("workspace.add_context");
    fireEvent.click(await waitFor(() => within(row).getByRole("button", { name: /CLAIM \+25 XP/ })));
    await waitFor(() => expect(within(row).getByText("CLAIMED")).toBeTruthy());
    expect(api.claimDailyGoal).toHaveBeenCalledTimes(1);
    expect(server.xp).toBe(125);

    // Static: the legacy machinery does not exist anywhere in the app source.
    const srcRoot = path.resolve(process.cwd(), "src");
    expect(fs.existsSync(path.join(srcRoot, "lib", "progression.ts"))).toBe(false);

    const files: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== "node_modules") walk(full);
        } else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\.(ts|tsx)$/.test(entry.name)) {
          if (entry.name !== "database.types.ts") files.push(full); // generated schema types
        }
      }
    };
    walk(srcRoot);
    expect(files.length).toBeGreaterThan(50); // the scan actually ran

    const forbidden: Array<[string, RegExp]> = [
      ["legacy generator", /\b(generateProgressionGoals|buildProgressionCounters|progressionGoalProgress|isProgressionGoalComplete)\b/],
      ["legacy 15-goal catalog", /\bGOAL_DEFINITIONS\b/], // DAILY_GOAL_DEFINITIONS is a different token
      ["legacy metric/event types", /\b(ProgressionMetric|ProgressionEventType|ProgressionEventTotals)\b/],
      ["legacy claim API/hook", /\b(awardGoalXp|useAwardGoalXp)\b/],
      ["legacy completed/claims queries", /\b(getCompletedGoalIds|useCompletedGoalIds|getGoalClaims|useGoalClaims)\b/],
      ["legacy event writers/readers", /\b(recordProgressionEvent|useRecordProgressionEvent|getProgressionEventTotals|useProgressionEventTotals)\b/],
      ["import of the deleted module", /from\s+["'][^"']*\/progression(\.js)?["']/],
      ["legacy RPC call", /\.rpc\(\s*["']award_goal_xp["']/],
      ["legacy table access", /\.from\(\s*["']progression_events["']/],
    ];
    const violations: string[] = [];
    for (const file of files) {
      const text = fs.readFileSync(file, "utf8");
      for (const [label, re] of forbidden) {
        if (re.test(text)) violations.push(`${label}: ${path.relative(srcRoot, file)}`);
      }
    }
    expect(violations).toEqual([]);

    // The claim hook Focus uses is the Daily Goal claim path.
    const claimHook = fs.readFileSync(path.join(srcRoot, "hooks", "use-focus-progress.ts"), "utf8");
    expect(claimHook).toMatch(/useClaimDailyGoal/);
  });

  it("14. insufficient goals render a clean human state (no 1–3 goals, no filler, no diagnostics)", async () => {
    // Free workspace with one lead and today's discovery allowance already
    // spent: only 2 legitimate goals exist, so the engine reports INSUFFICIENT.
    setWorkspace({ plan: "free", leads: [lead()], dailyUsed: 20 });
    renderFocus();
    const board = await waitFor(() => {
      const el = document.getElementById("focus-goals");
      if (!el) throw new Error("goals module not rendered");
      return el;
    });
    await waitFor(() =>
      expect(within(board).getByText(/needs a little more activity/i)).toBeTruthy(),
    );

    expect(rowsEl()).toHaveLength(0);
    expect(api.ensureDailyGoals).not.toHaveBeenCalled(); // never persist a partial set
    const visible = board.cloneNode(true) as HTMLElement;
    visible.querySelectorAll("style").forEach((el) => el.remove()); // CSS is not user-visible copy
    const text = visible.textContent ?? "";
    expect(text).not.toMatch(
      /INSUFFICIENT|LEGITIMATE|ensure_daily|rpc|exhausted|missingMechanics|[{}]/i,
    );
    expect(within(board).queryByTestId("goals-complete-count")).toBeNull();
    // Only a real, available action is offered.
    const links = within(board).getAllByRole("link");
    expect(links).toHaveLength(1);
    expect(links[0].getAttribute("href")).toBe("/dashboard/relationships");
  });
});
