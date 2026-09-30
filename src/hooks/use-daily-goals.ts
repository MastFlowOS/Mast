import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  claimDailyGoal,
  ensureDailyGoals,
  getDailyGoalEvidence,
  getDailyGoals,
  setDailyGoalProgress,
  type FollowupWithLead,
  type Lead,
} from "@/lib/api";
import { queryKeys } from "@/hooks/use-mast-api";
import {
  localDateKey,
  type DailyGoalInstance,
  type GoalEvidence,
  type InsufficientGoalsDiagnostic,
} from "@/lib/dailyGoals";
import {
  distinctWindowStarts,
  isDailyGoalComplete,
  loadOrCreateDailyGoals,
  msUntilNextLocalMidnight,
  planProgressWrites,
  replaceGoal,
  type DailyGoalsLoadResult,
} from "@/lib/focusDailyGoals";
import type { PlanId } from "@/lib/plans";

/**
 * Focus Daily Goals — the ONLY data source for "Today's Goals".
 *
 *   dailyGoals(dateKey)          getDailyGoals → (none?) generateDailyGoals →
 *                                ensureDailyGoals → authoritative rows.
 *                                Runs once per local day; the same 4 rows are
 *                                reloaded on every refresh/reopen.
 *   dailyGoalEvidence(...)       ONE shared evidence snapshot for the goal
 *                                window (not one request per goal).
 *   progress sync                each goal's own predicate runs against that
 *                                snapshot; only changed goals are written via
 *                                setDailyGoalProgress (monotonic, server-side).
 *   claim                        claimDailyGoal(id) — XP is read from the
 *                                persisted row on the server.
 *
 * Nothing here reads progression events, legacy counters, or `profiles.xp`.
 */

export const dailyGoalKeys = {
  all: ["mast", "dailyGoals"] as const,
  day: (dateKey: string) => ["mast", "dailyGoals", dateKey] as const,
  evidenceAll: ["mast", "dailyGoalEvidence"] as const,
  evidence: (dateKey: string, windows: string) =>
    ["mast", "dailyGoalEvidence", dateKey, windows] as const,
};

// ─── Local date (rolls over at LOCAL midnight, no reload needed) ─────────────

const MAX_TIMEOUT_MS = 2_147_483_647;

/** Current local calendar date key. Re-evaluated at local midnight and when the tab wakes up. */
export function useLocalDateKey(): string {
  const [dateKey, setDateKey] = useState(() => localDateKey(new Date()));

  useEffect(() => {
    let timer: number | undefined;
    const sync = () => {
      const next = localDateKey(new Date());
      setDateKey((prev) => (prev === next ? prev : next));
    };
    const schedule = () => {
      timer = window.setTimeout(
        () => {
          sync();
          schedule();
        },
        Math.min(msUntilNextLocalMidnight(new Date()) + 250, MAX_TIMEOUT_MS),
      );
    };
    const onWake = () => {
      if (document.visibilityState === "visible") sync();
    };
    schedule();
    document.addEventListener("visibilitychange", onWake);
    window.addEventListener("focus", onWake);
    return () => {
      if (timer !== undefined) window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onWake);
      window.removeEventListener("focus", onWake);
    };
  }, []);

  return dateKey;
}

// ─── Main hook ───────────────────────────────────────────────────────────────

export type UseDailyGoalsInput = {
  /** True once plan, usage, leads and follow-ups have settled. Never generate on a half-loaded workspace. */
  ready: boolean;
  plan: PlanId;
  leads: Lead[];
  followups: FollowupWithLead[];
  dailyUsed: number;
  dailyLimit: number;
  monthlyRemaining: number | null;
};

export type DailyGoalsStatus = "loading" | "ready" | "insufficient" | "error";

export function useDailyGoals(input: UseDailyGoalsInput) {
  const queryClient = useQueryClient();
  const dateKey = useLocalDateKey();

  // The query functions read the latest workspace snapshot from a ref so the
  // workspace data is NOT part of the query key (no refetch storm on every
  // lead/follow-up change).
  const inputRef = useRef(input);
  inputRef.current = input;

  const goalsQuery = useQuery<DailyGoalsLoadResult>({
    queryKey: dailyGoalKeys.day(dateKey),
    enabled: input.ready,
    staleTime: 30_000,
    refetchOnWindowFocus: false,
    retry: (count) => count < 1,
    queryFn: () => {
      const cur = inputRef.current;
      return loadOrCreateDailyGoals({
        now: new Date(),
        input: {
          plan: cur.plan,
          leads: cur.leads,
          followups: cur.followups,
          dailyDiscoverUsed: cur.dailyUsed,
          dailyDiscoverLimit: cur.dailyLimit,
          monthlyRemaining: cur.monthlyRemaining,
        },
        io: { getDailyGoals, ensureDailyGoals },
      });
    },
  });

  const loaded = goalsQuery.data;
  const goals: DailyGoalInstance[] = useMemo(
    () => (loaded?.kind === "ready" ? loaded.goals : []),
    [loaded],
  );
  const diagnostic: InsufficientGoalsDiagnostic | null =
    loaded?.kind === "insufficient" ? loaded.diagnostic : null;

  // ── Shared evidence (one snapshot serves all four goals) ──────────────────
  const windows = useMemo(() => distinctWindowStarts(goals), [goals]);
  const windowsKey = windows.join("|");
  const hasOpenGoals = goals.some((g) => !isDailyGoalComplete(g));

  const evidenceQuery = useQuery<Map<string, GoalEvidence>>({
    queryKey: dailyGoalKeys.evidence(dateKey, windowsKey),
    enabled: input.ready && windows.length > 0 && hasOpenGoals,
    staleTime: 15_000,
    refetchOnWindowFocus: false,
    queryFn: async () => {
      const cur = inputRef.current;
      const entries = await Promise.all(
        windows.map(
          async (w) => [w, await getDailyGoalEvidence(w, cur.leads, cur.followups)] as const,
        ),
      );
      return new Map(entries);
    },
  });

  // Fresh leads/follow-ups (a new object only when the data really changed —
  // React Query shares structure) mean the evidence is out of date: refetch
  // the ONE evidence query once. First load is skipped.
  const seenWorkspace = useRef<{ leads: Lead[]; followups: FollowupWithLead[] } | null>(null);
  useEffect(() => {
    if (!input.ready) return;
    const prev = seenWorkspace.current;
    seenWorkspace.current = { leads: input.leads, followups: input.followups };
    if (!prev) return;
    if (prev.leads !== input.leads || prev.followups !== input.followups) {
      void queryClient.invalidateQueries({ queryKey: dailyGoalKeys.evidenceAll });
    }
  }, [input.ready, input.leads, input.followups, queryClient]);

  // ── Progress sync: each goal's own predicate, monotonic writes only ───────
  const writtenRef = useRef(new Map<string, number>());
  const evidence = evidenceQuery.data;
  useEffect(() => {
    if (!evidence || goals.length === 0) return;
    const pending = planProgressWrites(goals, evidence).filter(
      (w) => writtenRef.current.get(w.id) !== w.progress,
    );
    for (const write of pending) {
      writtenRef.current.set(write.id, write.progress);
      setDailyGoalProgress(write.id, write.progress)
        .then((updated) => {
          queryClient.setQueryData<DailyGoalsLoadResult>(dailyGoalKeys.day(dateKey), (prev) =>
            prev?.kind === "ready"
              ? { kind: "ready", goals: replaceGoal(prev.goals, updated) }
              : prev,
          );
        })
        .catch(() => {
          // Let a later evidence refresh retry this write.
          writtenRef.current.delete(write.id);
        });
    }
  }, [goals, evidence, dateKey, queryClient]);

  const { refetch: refetchGoals } = goalsQuery;
  const refetch = useCallback(() => {
    void refetchGoals();
  }, [refetchGoals]);

  let status: DailyGoalsStatus;
  if (loaded?.kind === "ready") status = "ready";
  else if (loaded?.kind === "insufficient") status = "insufficient";
  else if (goalsQuery.isError) status = "error";
  else status = "loading";

  return { dateKey, status, goals, diagnostic, refetch };
}

// ─── Claim ───────────────────────────────────────────────────────────────────

/**
 * Claim XP for a completed Daily Goal. The client sends ONLY the goal id — the
 * XP amount comes from the persisted row on the server, and repeat claims are
 * no-ops (`awarded: false`).
 */
export function useClaimDailyGoal(dateKey: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (goal: Pick<DailyGoalInstance, "id">) => claimDailyGoal(goal.id),
    onSuccess: (result, goal) => {
      queryClient.setQueryData(queryKeys.xp, result.xp);
      queryClient.setQueryData<DailyGoalsLoadResult>(dailyGoalKeys.day(dateKey), (prev) =>
        prev?.kind === "ready"
          ? {
              kind: "ready",
              goals: prev.goals.map((g) => (g.id === goal.id ? { ...g, claimed: true } : g)),
            }
          : prev,
      );
    },
  });
}
