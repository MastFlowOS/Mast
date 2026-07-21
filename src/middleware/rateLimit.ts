import type { NextFunction, Request, Response } from "express";

/**
 * In-memory sliding-window rate limiter.
 *
 * Why in-memory: the gateway runs as a single Railway service (see
 * railway.json — one Dockerfile, one `node dist/server.js` process; the
 * worker fleet that actually executes discovery jobs is a separate
 * service and never handles HTTP requests). There is exactly one process
 * holding limiter state at any time, so there's no cross-instance state
 * to coordinate and no reason to reach for Redis or any other shared
 * store. If the gateway is ever horizontally scaled behind a load
 * balancer, this would need to move to a shared store — until then it
 * matches the current deployment model exactly, per the sprint
 * constraints.
 *
 * Why sliding window (not fixed window): a fixed window lets a client
 * burst up to 2x the limit across a window boundary (e.g. max requests at
 * 0:59 and again at 1:00). Tracking actual request timestamps per key and
 * pruning anything older than `windowMs` on every check avoids that.
 *
 * This is entirely independent of the credits/usage system in
 * try_increment_lead_usage / profiles.daily_leads_used /
 * profiles.monthly_leads_used. It never reads or writes any billing
 * table, never touches Supabase, and has no notion of plans or credit
 * balances — it only counts requests-per-window per identity. A user who
 * still has credits left can still get 429'd here if they're firing
 * requests faster than the endpoint's rate limit, and a user with zero
 * credits left is still rate-limited the same as anyone else (credits are
 * checked separately, downstream, inside the route handler). The two
 * systems can't desync because neither one reads the other's state.
 */

export interface RateLimiterOptions {
  /** Size of the sliding window, in milliseconds. */
  windowMs: number;
  /** Max requests allowed per identity within the window. */
  max: number;
}

/**
 * Creates one independent rate limiter instance with its own bucket
 * store. Each call site should create (and reuse, at module scope) its
 * own limiter with numbers that fit that specific endpoint — there's no
 * shared "tier" vocabulary to pick from, so adding a new endpoint class
 * six months from now never means inventing a "strict2" or squeezing it
 * into a bucket named for something else. Two endpoints can even use the
 * exact same numbers without any risk of colliding: each createRateLimiter()
 * call gets its own private Map, so limits are naturally scoped to
 * wherever the returned middleware is mounted.
 *
 * Identifies callers by `req.user.id` (set by `requireAuth`, which every
 * protected route already runs before this) so limits are per-account,
 * not per-IP — this matters because legitimate users can share IPs
 * (offices, mobile carriers) and because it's the identity credits are
 * already tracked against. Falls back to `req.ip` only if this middleware
 * is ever mounted ahead of `requireAuth` on some route, so it fails safe
 * instead of throwing.
 */
export function createRateLimiter({ windowMs, max }: RateLimiterOptions) {
  // key -> sorted ascending list of request timestamps (ms) within the
  // current window for that identity. Entries are pruned lazily on
  // access, and a key is deleted entirely once its list empties out, so
  // memory only ever holds identities that have made a request in the
  // last `windowMs` — it cannot grow unbounded over time. Scoped to this
  // closure, so it never shares state with any other limiter instance.
  const buckets = new Map<string, number[]>();

  function pruneAndGet(key: string, now: number): number[] {
    const existing = buckets.get(key);
    if (!existing) return [];
    const cutoff = now - windowMs;
    const kept = existing.filter((ts) => ts > cutoff);
    if (kept.length === 0) {
      buckets.delete(key);
    } else if (kept.length !== existing.length) {
      buckets.set(key, kept);
    }
    return kept;
  }

  return function rateLimitMiddleware(req: Request, res: Response, next: NextFunction) {
    const key = req.user?.id ?? req.ip ?? "unknown";
    const now = Date.now();

    const recent = pruneAndGet(key, now);

    if (recent.length >= max) {
      const retryAfterMs = windowMs - (now - recent[0]);
      res.setHeader("Retry-After", Math.max(1, Math.ceil(retryAfterMs / 1000)).toString());
      return res.status(429).json({
        code: "rate_limited",
        message: `Too many requests to this endpoint. Limit is ${max} per ${Math.round(windowMs / 1000)}s — try again shortly.`,
      });
    }

    recent.push(now);
    buckets.set(key, recent);
    next();
  };
}
