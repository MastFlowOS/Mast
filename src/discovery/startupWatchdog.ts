/**
 * MAST — Discovery Startup Watchdog.
 *
 * Evaluates whether a live discovery run is making active progress,
 * has successfully started/delivered, or has timed out.
 *
 * Differentiates between:
 * 1. Active preflight / street inventory initialization (resets/defers timeout on progress).
 * 2. Genuinely stalled initialization (no heartbeat/progress for >= 45s, or exceeding overall ceiling).
 * 3. Scout startup (scouts must start within 45s of initialization finishing, or 45s of discovery start).
 * 4. Satisfied runs (any scout active, leads delivered, or discovering status).
 */

export const STARTUP_WATCHDOG_TIMEOUT_MS = 45_000;
export const MAX_INITIALIZATION_CEILING_MS = 180_000;

export type StartupWatchdogEvaluation =
  | { status: "satisfied" }
  | { status: "active_progress"; nextCheckDelayMs: number; phase: "initialization" | "startup" }
  | {
      status: "timed_out";
      reason: "no_scouts_started" | "initialization_stalled" | "initialization_ceiling";
      title: string;
      description: string;
    };

export function evaluateStartupWatchdog(params: {
  now: number;
  searchStartedAt: number;
  state: {
    scouts?: Record<string | number, { status?: string }>;
    status?: string;
    delivered?: number;
    initialization?: {
      active: boolean;
      stage?: string;
      message?: string;
      lastHeartbeatAt: number;
      startedAt?: number;
    };
    initializationCompletedAt?: number;
  } | null;
  seenLeadsCount: number;
  hasActiveJob: boolean;
  watchdogTimeoutMs?: number;
  maxInitializationCeilingMs?: number;
}): StartupWatchdogEvaluation {
  const timeoutMs = params.watchdogTimeoutMs ?? STARTUP_WATCHDOG_TIMEOUT_MS;
  const ceilingMs = params.maxInitializationCeilingMs ?? MAX_INITIALIZATION_CEILING_MS;

  if (!params.hasActiveJob) {
    return { status: "satisfied" };
  }

  // If any lead delivered or seen in UI, discovery has produced real results -> satisfied
  if (params.seenLeadsCount > 0 || (params.state?.delivered ?? 0) > 0) {
    return { status: "satisfied" };
  }

  // If status is discovering or any scout is active -> satisfied
  const scouts = params.state?.scouts ? Object.values(params.state.scouts) : [];
  const anyScoutActive = scouts.some((s) => s?.status === "active") || params.state?.status === "discovering";
  if (anyScoutActive) {
    return { status: "satisfied" };
  }

  // Check if initialization / preflight is actively running
  const init = params.state?.initialization;
  if (init && init.active) {
    const initStartedAt = init.startedAt ?? params.searchStartedAt;
    const totalInitDuration = params.now - initStartedAt;

    // Hard ceiling check
    if (totalInitDuration > ceilingMs) {
      return {
        status: "timed_out",
        reason: "initialization_ceiling",
        title: "Discovery startup timed out",
        description: `Street inventory initialization exceeded maximum limit (${Math.round(ceilingMs / 1000)}s). Terminating discovery run.`,
      };
    }

    // Inactivity / stalled check
    const lastActivity = init.lastHeartbeatAt || initStartedAt;
    const inactiveDuration = params.now - lastActivity;

    if (inactiveDuration >= timeoutMs) {
      return {
        status: "timed_out",
        reason: "initialization_stalled",
        title: "Discovery startup timed out",
        description: `Street inventory initialization stalled (no progress for ${Math.round(timeoutMs / 1000)}s). Terminating discovery run.`,
      };
    }

    // Active initialization is making progress!
    const nextCheck = Math.max(1_000, timeoutMs - inactiveDuration);
    return {
      status: "active_progress",
      nextCheckDelayMs: Math.min(nextCheck, 10_000),
      phase: "initialization",
    };
  }

  // Initialization is not active (either completed or not needed).
  // The scout-startup window begins at either initializationCompletedAt or searchStartedAt.
  const startupWindowStart = params.state?.initializationCompletedAt ?? params.searchStartedAt;
  const elapsedSinceStartupWindow = params.now - startupWindowStart;

  if (elapsedSinceStartupWindow >= timeoutMs) {
    return {
      status: "timed_out",
      reason: "no_scouts_started",
      title: "Discovery startup timed out",
      description: `No scouts started within ${Math.round(timeoutMs / 1000)} seconds. Terminating discovery run.`,
    };
  }

  return {
    status: "active_progress",
    nextCheckDelayMs: Math.max(1_000, timeoutMs - elapsedSinceStartupWindow),
    phase: "startup",
  };
}
