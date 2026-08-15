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

function runtimeFor(requestId: string): RequestRuntime {
  let runtime = runtimes.get(requestId);
  if (!runtime) {
    runtime = { controllers: new Set(), processes: new Set() };
    runtimes.set(requestId, runtime);
  }
  return runtime;
}

function removeIfEmpty(requestId: string, runtime: RequestRuntime): void {
  if (!runtime.terminalReason && runtime.controllers.size === 0 && runtime.processes.size === 0) {
    runtimes.delete(requestId);
  }
}

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

/** Idempotently stops all local work belonging to one request. */
export function terminateRequest(requestId: string, reason: RequestTerminalReason): void {
  const runtime = runtimeFor(requestId);
  if (runtime.terminalReason) return;
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
