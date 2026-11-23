/**
 * Anti-ban safety guardrails for automatic Instagram activity checks on Mast Desktop.
 *
 * Keeps profile lookups strictly within normal human browsing behavior:
 * - 24-hour cache per IG handle (never checks the same handle twice in a day)
 * - Minimum 8-second gap between any two IG requests
 * - Hard cap of 20 auto-checks per rolling hour
 * - Automatic 60-minute pause if Instagram ever returns a 429 / rate-limit signal
 */

export const IG_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
export const IG_MIN_GAP_MS = 8_000;
export const IG_MAX_PER_HOUR = 20;
export const IG_RATE_LIMIT_BACKOFF_MS = 60 * 60 * 1000;
export const IG_AUTO_CHECK_DWELL_MS = 2_200;

const STORAGE_KEY = "mast_ig_activity_safety_v1";

interface IgSafetyStore {
  lastAttemptMs: number;
  recentAttemptsMs: number[];
  backoffUntilMs: number;
  checkedHandles: Record<string, number>; // handle -> checkedAtMs
}

function normalizeKey(handle: string): string {
  return handle.trim().replace(/^@+/, "").toLowerCase();
}

function readStore(): IgSafetyStore {
  const empty: IgSafetyStore = {
    lastAttemptMs: 0,
    recentAttemptsMs: [],
    backoffUntilMs: 0,
    checkedHandles: {},
  };
  if (typeof localStorage === "undefined") return empty;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return empty;
    const parsed = JSON.parse(raw) as Partial<IgSafetyStore>;
    return {
      lastAttemptMs: typeof parsed.lastAttemptMs === "number" ? parsed.lastAttemptMs : 0,
      recentAttemptsMs: Array.isArray(parsed.recentAttemptsMs)
        ? parsed.recentAttemptsMs.filter((n) => typeof n === "number")
        : [],
      backoffUntilMs: typeof parsed.backoffUntilMs === "number" ? parsed.backoffUntilMs : 0,
      checkedHandles:
        parsed.checkedHandles && typeof parsed.checkedHandles === "object"
          ? parsed.checkedHandles
          : {},
    };
  } catch {
    return empty;
  }
}

function writeStore(store: IgSafetyStore): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
  } catch {
    // ignore storage quota errors
  }
}

export type IgAutoCheckDecision =
  | { allowed: true }
  | { allowed: false; reason: "cached" | "cooldown" | "hourly_cap" | "backoff"; waitMs?: number };

export function canAutoCheckIgHandle(
  handle: string,
  nowMs: number = Date.now(),
): IgAutoCheckDecision {
  const key = normalizeKey(handle);
  if (!key) return { allowed: false, reason: "cached" };

  const store = readStore();

  if (store.backoffUntilMs > nowMs) {
    return { allowed: false, reason: "backoff", waitMs: store.backoffUntilMs - nowMs };
  }

  const lastCheckedHandle = store.checkedHandles[key];
  if (typeof lastCheckedHandle === "number" && nowMs - lastCheckedHandle < IG_CACHE_TTL_MS) {
    return { allowed: false, reason: "cached" };
  }

  if (store.lastAttemptMs > 0 && nowMs - store.lastAttemptMs < IG_MIN_GAP_MS) {
    return {
      allowed: false,
      reason: "cooldown",
      waitMs: IG_MIN_GAP_MS - (nowMs - store.lastAttemptMs),
    };
  }

  const oneHourAgo = nowMs - 60 * 60 * 1000;
  const recentInHour = store.recentAttemptsMs.filter((ts) => ts > oneHourAgo);
  if (recentInHour.length >= IG_MAX_PER_HOUR) {
    return { allowed: false, reason: "hourly_cap" };
  }

  return { allowed: true };
}

export function recordIgCheckAttempt(
  handle: string,
  options?: { ok?: boolean; rateLimited?: boolean; nowMs?: number },
): void {
  const nowMs = options?.nowMs ?? Date.now();
  const key = normalizeKey(handle);
  const store = readStore();

  const oneHourAgo = nowMs - 60 * 60 * 1000;
  store.recentAttemptsMs = [...store.recentAttemptsMs.filter((ts) => ts > oneHourAgo), nowMs];
  store.lastAttemptMs = nowMs;

  if (options?.rateLimited) {
    store.backoffUntilMs = nowMs + IG_RATE_LIMIT_BACKOFF_MS;
  }

  // Prune expired handles and record this handle if check succeeded
  const pruned: Record<string, number> = {};
  for (const [h, ts] of Object.entries(store.checkedHandles)) {
    if (nowMs - ts < IG_CACHE_TTL_MS) {
      pruned[h] = ts;
    }
  }
  if (key && options?.ok) {
    pruned[key] = nowMs;
  }
  store.checkedHandles = pruned;

  writeStore(store);
}

export function isRateLimitNote(note: string | null | undefined): boolean {
  if (!note) return false;
  return /429|rate.?limit|challenge|too many/i.test(note);
}

export function resetIgSafetyStoreForTests(): void {
  if (typeof localStorage !== "undefined") {
    localStorage.removeItem(STORAGE_KEY);
  }
}
