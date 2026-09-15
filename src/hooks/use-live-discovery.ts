import { useEffect, useRef, useState } from "react";
import type { RealtimeChannel } from "@supabase/supabase-js";
import { supabase } from "@/lib/supabase";
import { createInitialLiveDiscoveryState, reduceLiveDiscoveryEvents, type DiscoveryLiveState } from "@/discovery/liveDiscoveryState";
import type { DiscoveryLiveEvent } from "@/discovery/liveDiscoveryEvent";
import { rowToDiscoveryLiveEvent, type DiscoveryLiveEventRow } from "@/discovery/liveDiscoveryEventRow";

/**
 * MAST — Live Discovery UI (Task 3 of 3).
 *
 * Subscribes to one discovery plan's real live events and turns them into
 * the DiscoveryLiveState Task 2's reducer defines — the ONLY state this
 * screen renders from. See migrations/033_discovery_live_events.sql's doc
 * comment for why this goes through Supabase Realtime (`postgres_changes`
 * on `discovery_live_events`, filtered by plan_id) rather than a
 * gateway-hosted SSE endpoint: the publisher (handleDiscoveryPlanJob) only
 * ever runs in the separate worker process, so a browser->gateway SSE
 * stream would have nothing in-process to read from. This is the exact
 * pattern src/lib/api.ts's subscribeToDiscoverJob() already uses for
 * `leads`/`scrape_jobs` — reused here, not reinvented.
 *
 * Owns transport + subscription only. Every count/sentence/status comes
 * from reduceLiveDiscoveryEvent(s) (liveDiscoveryState.ts) — this file
 * never computes progress, a sentence, or a delivered/rejected count
 * itself.
 */

const TERMINAL_STATUSES: DiscoveryLiveState["status"][] = ["completed", "exhausted", "failed"];

/**
 * `planId` is null until the backend has actually created a discovery plan
 * — Free tier's Live Discovery, or a paid-tier Instant Discovery request
 * whose pool lookup fell short and is now backfilling live (see
 * dashboard.leads.tsx). Returns null until then; the caller renders its
 * own truthful pre-plan state.
 *
 * `initialDelivered` (default 0) seeds the running delivered count — see
 * createInitialLiveDiscoveryState()'s doc comment. Used by the paid-tier
 * backfill case, where some results may already have been delivered
 * synchronously (from the pool) before this plan/event stream existed;
 * Free's Live Discovery always starts at 0 since nothing has been
 * delivered yet by the time its plan is created.
 */
export function useLiveDiscoveryState(planId: string | null, target: number, initialDelivered = 0): DiscoveryLiveState | null {
  const [state, setState] = useState<DiscoveryLiveState | null>(() => (planId ? createInitialLiveDiscoveryState(target, initialDelivered) : null));

  // Applied-id guard: independent of the reducer's own internal dedup
  // (which only covers counted event types — see liveDiscoveryState.ts),
  // this stops a reconciliation fetch from re-applying an event already
  // delivered live, and stops a duplicate Realtime delivery from ever
  // reaching the reducer twice.
  const appliedIdsRef = useRef<Set<string>>(new Set());
  const channelRef = useRef<RealtimeChannel | null>(null);

  useEffect(() => {
    appliedIdsRef.current = new Set();

    if (!planId) {
      setState(null);
      return;
    }
    setState(createInitialLiveDiscoveryState(target, initialDelivered));

    if (!supabase) return; // matches every other subscribeTo*'s `if (!supabase) return () => {}` guard

    let cancelled = false;

    const applyEvents = (events: DiscoveryLiveEvent[]) => {
      const unseen = events.filter((e) => !appliedIdsRef.current.has(e.id));
      if (unseen.length === 0) return;
      for (const e of unseen) appliedIdsRef.current.add(e.id);
      setState((prev) => (prev ? reduceLiveDiscoveryEvents(prev, unseen) : prev));
    };

    // Reconciliation fetch — covers events that landed between plan
    // creation and this subscription's SUBSCRIBED callback, or any missed
    // Realtime delivery. Ordered by the event's own timestamp so
    // reduceLiveDiscoveryEvents' batch aggregation (consecutive
    // candidate_discovered from the same scout) sees the real order.
    const reconcile = async () => {
      const { data, error } = await supabase!
        .from("discovery_live_events")
        .select("*")
        .eq("plan_id", planId)
        .order("event_timestamp", { ascending: true });
      if (cancelled) return;
      if (error) {
        console.warn("[useLiveDiscoveryState] reconciliation fetch failed (non-fatal):", error);
        return;
      }
      applyEvents((data ?? []).map((row) => rowToDiscoveryLiveEvent(row as unknown as DiscoveryLiveEventRow)));
    };

    const stopListening = () => {
      if (channelRef.current) {
        supabase?.removeChannel(channelRef.current);
        channelRef.current = null;
      }
    };

    const channel = supabase
      .channel(`discovery-live-${planId}`)
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "discovery_live_events", filter: `plan_id=eq.${planId}` },
        (payload) => {
          applyEvents([rowToDiscoveryLiveEvent(payload.new as unknown as DiscoveryLiveEventRow)]);
        },
      )
      .subscribe((status) => {
        if (status === "SUBSCRIBED") void reconcile();
      });
    channelRef.current = channel;

    return () => {
      cancelled = true;
      stopListening();
    };
    // Re-subscribe only when the plan identity changes — never on
    // reducer-derived state changing, which would tear down and recreate
    // the subscription on every incoming event.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [planId]);

  // Once the plan reaches a terminal status, there is nothing more to
  // stream — stop listening rather than hold an idle subscription open
  // until the component unmounts.
  useEffect(() => {
    if (state && TERMINAL_STATUSES.includes(state.status) && channelRef.current) {
      supabase?.removeChannel(channelRef.current);
      channelRef.current = null;
    }
  }, [state?.status]);

  return state;
}
