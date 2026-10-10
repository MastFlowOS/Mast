/**
 * Pure decision logic for Discover progress/completion so the UI, the realtime
 * subscription and the tests all agree on one definition of "what happened".
 *
 * Four counts are kept distinct everywhere:
 *   requested  — what the run was asked for (server-clamped, not the slider)
 *   delivered  — leads actually saved to the user's workspace
 *   shortfall  — requested - delivered (never negative)
 *   failed     — set only when the run itself failed/was interrupted
 */

export type DiscoverRunStatus =
  | "queued"
  | "streaming"
  | "completed"
  | "completed_partial"
  | "failed"
  | "cancelled";

export type ShortfallReason =
  | "pool_exhausted"
  | "plan_limit_reached"
  | "pool_delivery_interrupted"
  | "live_exhausted"
  | null;

/** Mirrors PoolRanking in poolLookup.ts (kept separate so the UI never imports server code). */
export type PoolRankingInfo = {
  requested: boolean;
  status: "not_requested" | "full" | "partial" | "unavailable";
  scored: number;
  unscored: number;
  policy: "unscored_last";
  reason: "no_profession_focus" | null;
};

export type OutcomeKind = "complete" | "partial" | "empty" | "failed" | "cancelled";

export type DiscoverOutcome = {
  kind: OutcomeKind;
  requested: number;
  delivered: number;
  shortfall: number;
  headline: string;
  detail: string | null;
  /** toast severity — success is ONLY used when delivered >= requested */
  toast: "success" | "info" | "error";
};

const plural = (n: number) => (n === 1 ? "opportunity" : "opportunities");

export function describeDiscoverOutcome(input: {
  requested: number;
  delivered: number;
  status: DiscoverRunStatus;
  shortfallReason?: ShortfallReason;
  source: "pool" | "live";
}): DiscoverOutcome {
  const requested = Math.max(0, Math.floor(input.requested));
  const delivered = Math.max(0, Math.floor(input.delivered));
  const shortfall = Math.max(0, requested - delivered);
  const base = { requested, delivered, shortfall };

  if (input.status === "cancelled") {
    return {
      ...base,
      kind: "cancelled",
      headline: delivered > 0 ? `Stopped — ${delivered} ${plural(delivered)} kept` : "Search stopped",
      detail: delivered > 0 ? "Opportunities already delivered stay in your pipeline." : null,
      toast: "info",
    };
  }
  if (input.status === "failed") {
    return {
      ...base,
      kind: "failed",
      headline: delivered > 0 ? `Run interrupted — ${delivered} of ${requested} delivered` : "Discovery failed",
      detail:
        delivered > 0
          ? "The run stopped early. Opportunities already delivered were saved and counted; nothing else was charged."
          : "No opportunities were delivered and no credits were used.",
      toast: "error",
    };
  }
  if (delivered >= requested && requested > 0) {
    return {
      ...base,
      kind: "complete",
      headline: `${delivered} ${plural(delivered)} prepared`,
      detail: null,
      toast: "success",
    };
  }

  const why =
    input.shortfallReason === "plan_limit_reached"
      ? "You reached your plan's lead limit before the request could be filled."
      : input.shortfallReason === "pool_delivery_interrupted"
        ? "The pool search was interrupted before it could deliver everything it found."
        : input.source === "pool"
          ? "The pool did not contain enough qualifying matches for this search. No filters were loosened to fill the request."
          : "Live Discovery could not find more businesses that qualify for this search.";

  if (delivered === 0) {
    return {
      ...base,
      kind: "empty",
      headline: "No qualifying opportunities found",
      detail: why,
      toast: "info",
    };
  }
  return {
    ...base,
    kind: "partial",
    headline: `${delivered} of ${requested} ${plural(requested)} delivered`,
    detail: `${shortfall} short. ${why}`,
    toast: "info",
  };
}

/**
 * Decision for the realtime subscription once the job row reports a terminal
 * status. Previously the `completed` branch had no "already reconciled" guard,
 * so a job whose results_count exceeded the visible leads re-fetched forever
 * and never reported completion.
 *   emit      — report the terminal state now (with the leads actually seen)
 *   reconcile — fetch the lead rows once, then decide again
 *   wait      — a reconciliation fetch is in flight
 */
export function decideTerminalEmission(input: {
  terminalStatus: string | null;
  terminalResultsCount: number;
  requestedQuantity?: number;
  seenCount: number;
  reconciled: boolean;
  isReconciling: boolean;
}): "emit" | "reconcile" | "wait" | "none" {
  if (!input.terminalStatus) return "none";
  if (input.isReconciling) return "wait";
  const reported = input.terminalResultsCount;
  const target =
    input.requestedQuantity && input.requestedQuantity > 0
      ? Math.min(input.requestedQuantity, reported || input.requestedQuantity)
      : reported;
  if (input.seenCount >= target) return "emit";
  return input.reconciled ? "emit" : "reconcile";
}
