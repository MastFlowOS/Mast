import type { ChildProcess } from "node:child_process";

/**
 * The in-memory half of a durable discovery request's lifecycle.  The
 * database is the cross-worker source of truth; this registry is deliberately
 * process-local and gives a worker an immediate way to stop every child it
 * owns when that durable state becomes terminal.
 */
export type RequestTerminalReason =
  | "USER_CANCELLED"
  | "TARGET_REACHED"
  | "WATCHDOG_TIMEOUT"
  | "SCRAPER_FAILURE"
  | "EXHAUSTED";

type ActiveEngineProcess = {
  child: ChildProcess;
  stop: () => void;
};

type RequestRuntime = {
  terminalReason?: RequestTerminalReason;
  controllers: Set<AbortController>;
  processes: Set<ActiveEngineProcess>;
};

const runtimes = new Map<string, RequestRuntime>();

/**
 * PROCESS REGISTRY EXPLOSION FIX (root cause 1 of 2 — the actual "stale/
 * duplicate process handle" source): `removeIfEmpty` refused to delete a
 * runtime entry once `terminalReason` was set, even after every controller
 * /process belonging to it had unregistered. Because `runtimes` is a
 * process-local Map that lives for the lifetime of the worker, and a
 * long-running Railway worker serves thousands of discovery requests, every
 * completed request left a permanent, empty `{controllers: Set(0),
 * processes: Set(0), terminalReason: "..."}` entry behind it — an unbounded
 * memory leak that grows for as long as the worker process runs.
 *
 * That's a leak, not directly a "PIDs receive extra aborts" bug on its own
 * (`terminateRequest`'s process/controller loops only ever iterate the
 * CURRENT Set contents, and a drained Set has nothing in it to
 * double-abort) — but it is exactly the kind of unbounded, never-reclaimed
 * per-request bookkeeping an audit flags as "stale handles", and left
 * unbounded it will eventually degrade the process (Map lookup/iteration
 * cost, memory pressure) under sustained production traffic. Combined with
 * the STOP REASON RACE fix below — which depends on a terminal runtime
 * staying queryable slightly LONGER than before (so a late `getRequestTerminalReason()`
 * read sees an upgrade rather than a stale first-write) — deleting the
 * entry the instant it drains would be wrong too. Instead: a terminal,
 * fully-drained runtime is kept queryable for a short, bounded grace
 * window (`TERMINAL_RUNTIME_RETENTION_MS`) — long enough for every
 * still-in-flight sibling's __done__/exit reconciliation (pythonBridge.ts)
 * to finish reading it — and then reclaimed on a timer instead of never.
 * A non-terminal runtime (cancelled mid-registration, or simply idle) is
 * still removed immediately, exactly as before.
 */
const TERMINAL_RUNTIME_RETENTION_MS = 5 * 60_000;

function removeIfEmpty(requestId: string, runtime: RequestRuntime): void {
  if (runtime.controllers.size !== 0 || runtime.processes.size !== 0) return;
  if (!runtime.terminalReason) {
    runtimes.delete(requestId);
    return;
  }
  const timer = setTimeout(() => {
    const current = runtimes.get(requestId);
    // Only reclaim if nothing re-registered in the meantime (a late area
    // worker for a retried task, etc.) — re-check emptiness, don't just
    // blindly delete on the old reference.
    if (current === runtime && runtime.controllers.size === 0 && runtime.processes.size === 0) {
      runtimes.delete(requestId);
    }
  }, TERMINAL_RUNTIME_RETENTION_MS);
  timer.unref?.();
}

function runtimeFor(requestId: string): RequestRuntime {
  let runtime = runtimes.get(requestId);
  if (!runtime) {
    runtime = { controllers: new Set(), processes: new Set() };
    runtimes.set(requestId, runtime);
  }
  return runtime;
}

/**
 * STOP REASON RACE FIX (root cause 2 of 2 — the actual cause of "some
 * children receive TARGET_REACHED, others receive reason=undefined, then
 * report CANCELLED"): `terminateRequest()` used to be strict first-write-
 * wins — whichever caller happened to reach it first permanently decided
 * `runtime.terminalReason` for every child under that request, with no
 * regard for which reason was actually the MORE AUTHORITATIVE one.
 *
 * Under Worker Pools B (the Google Maps area worker pool) and any
 * multi-city/multi-area concurrent run, more than one code path can reach
 * its own, independent terminal conclusion for the SAME request at nearly
 * the same instant — e.g. one area worker's `runOneAreaAttempt` sees its
 * own search exhaust (`EXHAUSTED`) in the same tick that a sibling area
 * worker's delivered lead pushes `delivered_count >= requested_count`
 * (`TARGET_REACHED`). Whichever call won that race — a pure event-loop
 * scheduling accident — became the ONE reason every other child's
 * `pythonBridge.ts` __done__/exit reconciliation checked via
 * `getRequestTerminalReason()`. If EXHAUSTED won even though the request
 * in fact reached its target, every other child's own CANCELLED __done__
 * (from the redundant SIGTERM `terminateRequest` still sends them) was
 * never reconciled to `SUCCESS_TARGET_REACHED` — it was reported as a
 * genuine cancellation/failure instead, even though the request as a whole
 * succeeded.
 *
 * Fix: reasons now have an explicit priority, and a LATER call can upgrade
 * an already-set reason to a higher-priority one. TARGET_REACHED is always
 * the most authoritative outcome (the request got everything it asked
 * for, full stop) and always wins regardless of arrival order; USER_CANCELLED
 * is next (an explicit user action should not be masked by an
 * incidental EXHAUSTED/WATCHDOG_TIMEOUT/SCRAPER_FAILURE race); EXHAUSTED
 * ranks above the two failure-ish reasons, which are equivalent to each
 * other. Every already-registered controller/process still only gets
 * ONE `stop()`/`abort()` call each (idempotent — see below), but every
 * LATER reader of `getRequestTerminalReason()` — including a child whose
 * __done__/exit is still in flight — sees the upgraded, correct reason.
 */
const REASON_PRIORITY: Record<RequestTerminalReason, number> = {
  TARGET_REACHED: 0,
  USER_CANCELLED: 1,
  EXHAUSTED: 2,
  WATCHDOG_TIMEOUT: 3,
  SCRAPER_FAILURE: 3,
};

export function isRequestActive(requestId: string): boolean {
  const runtime = runtimes.get(requestId);
  if (!runtime) return false;
  return runtime.controllers.size > 0 || runtime.processes.size > 0;
}

export function getRequestTerminalReason(requestId: string | undefined): RequestTerminalReason | undefined {
  if (!requestId) return undefined;
  return runtimes.get(requestId)?.terminalReason;
}

export function registerRequestAbortController(requestId: string, controller: AbortController): () => void {
  const runtime = runtimeFor(requestId);
  runtime.controllers.add(controller);
  if (runtime.terminalReason) controller.abort(runtime.terminalReason);
  return () => {
    runtime.controllers.delete(controller);
    removeIfEmpty(requestId, runtime);
  };
}

/** Registers a spawned Python process under its durable discovery-plan id. */
export function registerRequestEngineProcess(
  requestId: string | undefined,
  child: ChildProcess,
  stop: () => void,
): () => void {
  if (!requestId) return () => {};
  const runtime = runtimeFor(requestId);
  const process = { child, stop };
  runtime.processes.add(process);
  if (runtime.terminalReason) stop();
  return () => {
    runtime.processes.delete(process);
    removeIfEmpty(requestId, runtime);
  };
}

/**
 * Idempotently stops all local work belonging to one request.
 *
 * Not strictly idempotent on the *reason* — see REASON_PRIORITY's doc
 * comment above. A second call with a higher-priority reason than the one
 * already recorded upgrades `runtime.terminalReason` (so subsequent
 * `getRequestTerminalReason()` reads — the ones pythonBridge.ts's __done__/
 * exit reconciliation actually depends on — see the correct, authoritative
 * reason) but does NOT re-abort/re-stop anything: every controller and
 * process here is already idempotent to a second signal (AbortController
 * ignores a second `.abort()`; `process.stop` is only invoked while
 * `exitCode`/`signalCode` are still null), so nothing double-fires.
 */
export function terminateRequest(requestId: string, reason: RequestTerminalReason): void {
  const runtime = runtimeFor(requestId);
  if (runtime.terminalReason) {
    if (REASON_PRIORITY[reason] < REASON_PRIORITY[runtime.terminalReason]) {
      const previous = runtime.terminalReason;
      runtime.terminalReason = reason;
      console.info(`[discovery-lifecycle] request=${requestId} terminal reason upgraded ${previous} -> ${reason}`);
    }
    return;
  }
  runtime.terminalReason = reason;
  console.info(`[discovery-lifecycle] request=${requestId} terminal=${reason} controllers=${runtime.controllers.size} processes=${runtime.processes.size}`);
  for (const controller of runtime.controllers) controller.abort(reason);
  for (const process of runtime.processes) {
    if (process.child.exitCode === null && process.child.signalCode === null) process.stop();
  }
}

export const __testing = {
  activeProcessCount: (requestId: string) => runtimes.get(requestId)?.processes.size ?? 0,
  reset: () => runtimes.clear(),
};
