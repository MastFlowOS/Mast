/**
 * Exercises the REAL subscribeToDiscoverJob() (src/lib/api.ts) against a fake
 * Supabase client. (discoverJobCompletionRace.test.ts re-implements the logic
 * inline, so it cannot catch regressions in the shipped function.)
 *
 * Proves:
 *  - a job reported `completed` whose leads are not all visible reconciles
 *    ONCE and then reports terminal — it no longer refetches forever;
 *  - progress does not depend on realtime INSERT events arriving (poll
 *    fallback), and polling stops once terminal;
 *  - duplicate / overlapping deliveries surface each lead once.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, any>;

const h = vi.hoisted(() => {
  const state = {
    leads: [] as Row[],
    job: { status: "streaming", results_count: 0, query: { quantity: 5 } } as Row | null,
    leadFetches: 0,
    jobFetches: 0,
    insertCb: null as null | ((p: { new: Row }) => void),
    updateCb: null as null | ((p: { new: Row }) => void),
    subscribeCb: null as null | ((s: string) => void),
    removed: 0,
  };
  const fake = {
    channel: () => {
      const ch: any = {
        on: (_type: string, filter: { event: string }, cb: any) => {
          if (filter.event === "INSERT") state.insertCb = cb;
          if (filter.event === "UPDATE") state.updateCb = cb;
          return ch;
        },
        subscribe: (cb: (s: string) => void) => {
          state.subscribeCb = cb;
          return ch;
        },
      };
      return ch;
    },
    removeChannel: () => {
      state.removed += 1;
    },
    from: (table: string) => {
      if (table === "leads") {
        return {
          select: () => ({
            eq: () => ({
              order: async () => {
                state.leadFetches += 1;
                return { data: [...state.leads], error: null };
              },
            }),
          }),
        };
      }
      if (table === "scrape_jobs") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => {
                state.jobFetches += 1;
                return { data: state.job ? { ...state.job } : null, error: null };
              },
            }),
          }),
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
  };
  return { state, fake };
});

vi.mock("./supabase", () => ({ supabase: h.fake }));

import { subscribeToDiscoverJob, DISCOVER_RECONCILE_POLL_MS } from "./api";

const leadRow = (id: number): Row => ({ id, business_name: `Biz ${id}`, status: "discovered", created_at: "2026-01-01T00:00:00Z" });
const flush = async () => {
  for (let i = 0; i < 8; i++) await vi.advanceTimersByTimeAsync(0);
};

beforeEach(() => {
  vi.useFakeTimers();
  Object.assign(h.state, {
    leads: [],
    job: { status: "streaming", results_count: 0, query: { quantity: 5 } },
    leadFetches: 0,
    jobFetches: 0,
    insertCb: null,
    updateCb: null,
    subscribeCb: null,
    removed: 0,
  });
});
afterEach(() => {
  vi.useRealTimers();
});

describe("subscribeToDiscoverJob", () => {
  it("completed + a lead missing from the DB: reconciles once, then reports terminal (never an endless refetch loop)", async () => {
    const onLead = vi.fn();
    const onStatusChange = vi.fn();
    h.state.leads = [1, 2, 3, 4].map(leadRow); // job will claim 5, only 4 are visible
    subscribeToDiscoverJob("job-1", { onLead, onStatusChange }, { requestedQuantity: 5 });
    h.state.subscribeCb!("SUBSCRIBED");
    await flush();

    h.state.job = { status: "completed", results_count: 5, query: { quantity: 5 } };
    h.state.updateCb!({ new: h.state.job });
    await flush();

    const terminal = onStatusChange.mock.calls.filter(([s]) => s === "completed");
    expect(terminal).toHaveLength(1);
    expect(terminal[0][1]).toBe(4); // truthful: what is actually visible, not the claimed 5
    expect(onLead).toHaveBeenCalledTimes(4);
    expect(h.state.leadFetches).toBeLessThanOrEqual(3); // initial + at most one terminal reconcile (+1 slack)
  });

  it("does not depend on realtime INSERT events: the poll fallback surfaces leads and progress", async () => {
    const onLead = vi.fn();
    const onStatusChange = vi.fn();
    subscribeToDiscoverJob("job-2", { onLead, onStatusChange }, { requestedQuantity: 5 });
    h.state.subscribeCb!("SUBSCRIBED");
    await flush();
    expect(onLead).not.toHaveBeenCalled();

    // leads land in the DB but NO realtime event is ever delivered
    h.state.leads = [1, 2, 3].map(leadRow);
    h.state.job = { status: "streaming", results_count: 3, query: { quantity: 5 } };
    await vi.advanceTimersByTimeAsync(DISCOVER_RECONCILE_POLL_MS);
    await flush();

    expect(onLead).toHaveBeenCalledTimes(3);
    expect(onStatusChange).toHaveBeenCalledWith("streaming", 3);
  });

  it("unchanged non-terminal state is not re-announced on every poll", async () => {
    const onStatusChange = vi.fn();
    subscribeToDiscoverJob("job-3", { onLead: vi.fn(), onStatusChange }, { requestedQuantity: 5 });
    h.state.subscribeCb!("SUBSCRIBED");
    await flush();
    await vi.advanceTimersByTimeAsync(DISCOVER_RECONCILE_POLL_MS * 3);
    await flush();
    expect(onStatusChange).toHaveBeenCalledTimes(1);
  });

  it("a partial run terminates with the real count; polling stops after the terminal state and on unsubscribe", async () => {
    const onStatusChange = vi.fn();
    const stop = subscribeToDiscoverJob("job-4", { onLead: vi.fn(), onStatusChange }, { requestedQuantity: 5 });
    h.state.subscribeCb!("SUBSCRIBED");
    await flush();

    h.state.leads = [1, 2].map(leadRow);
    h.state.job = { status: "completed_partial", results_count: 2, query: { quantity: 5 } };
    h.state.updateCb!({ new: h.state.job });
    await flush();

    expect(onStatusChange).toHaveBeenLastCalledWith("completed_partial", 2);
    const fetchesAfterTerminal = h.state.leadFetches;
    await vi.advanceTimersByTimeAsync(DISCOVER_RECONCILE_POLL_MS * 4);
    expect(h.state.leadFetches).toBe(fetchesAfterTerminal);
    stop();
    expect(h.state.removed).toBe(1);
  });

  it("a failed job reports failed (with whatever was delivered) instead of staying silent", async () => {
    const onStatusChange = vi.fn();
    subscribeToDiscoverJob("job-5", { onLead: vi.fn(), onStatusChange }, { requestedQuantity: 5 });
    h.state.subscribeCb!("SUBSCRIBED");
    await flush();
    h.state.job = { status: "failed", results_count: 0, query: { quantity: 5 } };
    h.state.updateCb!({ new: h.state.job });
    await flush();
    expect(onStatusChange).toHaveBeenLastCalledWith("failed", 0);
  });

  it("duplicate realtime INSERTs and an overlapping reconcile surface each lead exactly once", async () => {
    const onLead = vi.fn();
    subscribeToDiscoverJob("job-6", { onLead, onStatusChange: vi.fn() }, { requestedQuantity: 5 });
    h.state.leads = [leadRow(1)];
    h.state.subscribeCb!("SUBSCRIBED"); // reconcile will also read lead 1
    h.state.insertCb!({ new: leadRow(1) });
    h.state.insertCb!({ new: leadRow(1) });
    h.state.insertCb!({ new: leadRow(2) });
    await flush();
    expect(onLead).toHaveBeenCalledTimes(2);
  });
});
