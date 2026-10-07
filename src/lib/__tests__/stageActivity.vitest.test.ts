import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * getStageActivity must join on lead_activities.lead_id (never business name), must not be
 * limited to a global newest-N before filtering, and must stay exact when ids are chunked.
 * The fake client below behaves like PostgREST for the calls this function makes.
 */

type Row = { id: string; lead_id: number; user_id: string; type: string; content: string; channel: string | null; created_at: string };
const h = vi.hoisted(() => ({ rows: [] as Row[], calls: [] as { table: string; inCol?: string; ids?: number[]; limit?: number }[] }));

vi.mock("@/lib/supabase", () => {
  const from = (table: string) => {
    const state: { eq: Record<string, unknown>; inCol?: string; ids?: number[]; limit?: number } = { eq: {} };
    const b: Record<string, unknown> = {};
    b.select = () => b;
    b.eq = (c: string, v: unknown) => ((state.eq[c] = v), b);
    b.in = (c: string, v: number[]) => ((state.inCol = c), (state.ids = v), b);
    b.order = () => b;
    b.limit = (n: number) => ((state.limit = n), b);
    b.then = (resolve: (v: unknown) => void) => {
      h.calls.push({ table, inCol: state.inCol, ids: state.ids, limit: state.limit });
      const data = h.rows
        .filter((r) => r.user_id === state.eq["user_id"] && (state.ids ? state.ids.includes(r.lead_id) : true))
        .sort((a, c) => +new Date(c.created_at) - +new Date(a.created_at))
        .slice(0, state.limit ?? 1000);
      resolve({ data, error: null });
    };
    return b;
  };
  return { supabase: { from, auth: { getSession: async () => ({ data: { session: { user: { id: "u1" } } } }) } } };
});

import { getStageActivity } from "@/lib/api";

const row = (n: number, leadId: number, daysAgo: number, user = "u1"): Row => ({
  id: `r${n}`,
  lead_id: leadId,
  user_id: user,
  type: "note_added",
  content: `c${n}`,
  channel: null,
  created_at: new Date(Date.UTC(2026, 9, 1) - daysAgo * 86_400_000).toISOString(),
});

describe("getStageActivity", () => {
  beforeEach(() => {
    h.rows = [];
    h.calls = [];
  });

  it("returns [] without querying when the stage has no opportunities", async () => {
    expect(await getStageActivity([])).toEqual([]);
    expect(h.calls).toHaveLength(0);
  });

  it("queries lead_activities by lead_id IN (...) only", async () => {
    h.rows = [row(1, 5, 1)];
    await getStageActivity([5, 6]);
    expect(h.calls).toEqual([{ table: "lead_activities", inCol: "lead_id", ids: [5, 6], limit: 5 }]);
  });

  it("a quiet stage still returns its real (old) activity even when other leads have far newer rows", async () => {
    // 50 very recent rows for OTHER leads (would fill a global newest-20), one old row for ours.
    h.rows = [...Array.from({ length: 50 }, (_, i) => row(i, 900 + i, 0)), row(999, 7, 120)];
    const res = await getStageActivity([7]);
    expect(res.map((r) => r.id)).toEqual(["r999"]);
    expect(res[0].leadId).toBe(7);
  });

  it("never returns another user's or another stage's rows", async () => {
    h.rows = [row(1, 7, 1), row(2, 8, 1), row(3, 7, 1, "someone-else")];
    const res = await getStageActivity([7]);
    expect(res.map((r) => r.id)).toEqual(["r1"]);
  });

  it("is exact across chunks: merged newest-5 equals the true newest-5 of all stage leads", async () => {
    const ids = Array.from({ length: 250 }, (_, i) => i + 1); // 3 chunks of <=100
    // newest rows deliberately live in different chunks
    h.rows = ids.map((id) => row(id, id, id % 97)); // days ago 0..96, spread across chunks
    const expected = [...h.rows].sort((a, b) => +new Date(b.created_at) - +new Date(a.created_at)).slice(0, 5).map((r) => r.id);
    const res = await getStageActivity(ids, 5);
    expect(h.calls).toHaveLength(3);
    expect(h.calls.every((c) => (c.ids?.length ?? 0) <= 100)).toBe(true);
    expect(res).toHaveLength(5);
    expect(new Set(res.map((r) => r.id))).toEqual(new Set(expected));
    // newest first
    const times = res.map((r) => +new Date(r.createdAt));
    expect([...times].sort((a, b) => b - a)).toEqual(times);
  });
});
