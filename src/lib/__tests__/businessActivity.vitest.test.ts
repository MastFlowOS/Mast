import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  computeBusinessActivity,
  fetchLiveInstagramActivity,
  formatDaysAgoLabel,
  parseDaysAgoFromText,
} from "../businessActivity";
import {
  canAutoCheckIgHandle,
  IG_MAX_PER_HOUR,
  IG_MIN_GAP_MS,
  recordIgCheckAttempt,
  resetIgSafetyStoreForTests,
} from "../igActivitySafety";

describe("businessActivity", () => {
  it("parses stored last-post strings and formats labels accurately", () => {
    expect(parseDaysAgoFromText("3d ago")).toBe(3);
    expect(parseDaysAgoFromText("2 weeks ago")).toBe(14);
    expect(parseDaysAgoFromText("Yesterday")).toBe(1);
    expect(formatDaysAgoLabel(0)).toBe("Today");
    expect(formatDaysAgoLabel(2)).toBe("2 days ago");
    expect(formatDaysAgoLabel(120)).toBe("4 months ago");
  });

  it("recommends Instagram DM when business posted recently on IG", () => {
    const report = computeBusinessActivity({
      email: "hello@bakery.com",
      phone: "+15551234567",
      instagramHandle: "@freshbakery",
      igLastPostDays: 2,
    });

    expect(report.mostActiveOn).toBe("instagram");
    expect(report.instagram.status).toBe("very_active");
    expect(report.instagram.worthDming).toBe(true);
    expect(report.instagram.lastPostLabel).toBe("2 days ago");
  });

  it("warns against DMing and recommends Email when IG is inactive (>90 days)", () => {
    const report = computeBusinessActivity({
      email: "owner@plumbingco.com",
      phone: "+15551234567",
      instagramHandle: "plumbingco",
      igLastPostDays: 145,
    });

    expect(report.mostActiveOn).toBe("email");
    expect(report.instagram.status).toBe("inactive");
    expect(report.instagram.worthDming).toBe(false);
    expect(report.instagram.lastPostLabel).toBe("4 months ago");
  });

  it("picks the newest post across pinned posts and detects active story when exposed", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const twoYearsAgo = nowSec - 700 * 86_400;
    const twoDaysAgo = nowSec - 2 * 86_400;
    const twoHoursAgo = nowSec - 2 * 3600;

    const mockFetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        data: {
          user: {
            is_private: false,
            biography: "Fresh sourdough daily",
            latest_reel_media: twoHoursAgo,
            edge_followed_by: { count: 4820 },
            edge_owner_to_timeline_media: {
              count: 112,
              edges: [
                { node: { taken_at_timestamp: twoYearsAgo } }, // old pinned post
                { node: { taken_at_timestamp: twoDaysAgo } }, // actual newest post
              ],
            },
          },
        },
      }),
    })) as unknown as typeof fetch;

    const res = await fetchLiveInstagramActivity("@sourdough_house", mockFetch);
    expect(res.ok).toBe(true);
    expect(res.lastPostDaysAgo).toBe(2);
    expect(res.hasActiveStory).toBe(true);
    expect(res.followersCount).toBe(4820);
    expect(res.postsCount).toBe(112);
  });

  it("stays honest when Instagram hides story status from unauthenticated checks", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const mockFetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        data: {
          user: {
            is_private: false,
            edge_followed_by: { count: 920 },
            edge_owner_to_timeline_media: {
              count: 34,
              edges: [{ node: { taken_at_timestamp: nowSec - 5 * 86_400 } }],
            },
          },
        },
      }),
    })) as unknown as typeof fetch;

    const res = await fetchLiveInstagramActivity("local_cafe", mockFetch);
    expect(res.ok).toBe(true);
    expect(res.lastPostDaysAgo).toBe(5);
    expect(res.hasActiveStory).toBeNull();
    expect(res.note).toMatch(/login/i);
  });
});

describe("igActivitySafety (anti-ban guardrails)", () => {
  beforeEach(() => {
    resetIgSafetyStoreForTests();
  });

  it("caches a checked handle for 24h and enforces 8s cooldown between different handles", () => {
    const t0 = 1_700_000_000_000;
    expect(canAutoCheckIgHandle("bakery_one", t0)).toEqual({ allowed: true });

    recordIgCheckAttempt("bakery_one", { ok: true, nowMs: t0 });

    // Same handle is cached for 24h
    expect(canAutoCheckIgHandle("bakery_one", t0 + 60_000)).toEqual({
      allowed: false,
      reason: "cached",
    });

    // Different handle blocked during 8s cooldown
    const duringCooldown = canAutoCheckIgHandle("bakery_two", t0 + 3_000);
    expect(duringCooldown.allowed).toBe(false);
    if (!duringCooldown.allowed) {
      expect(duringCooldown.reason).toBe("cooldown");
    }

    // Different handle allowed after 8s cooldown
    expect(canAutoCheckIgHandle("bakery_two", t0 + IG_MIN_GAP_MS + 500)).toEqual({
      allowed: true,
    });
  });

  it("enforces hourly cap and triggers 1-hour backoff on rate limit", () => {
    let now = 1_700_000_000_000;
    for (let i = 0; i < IG_MAX_PER_HOUR; i++) {
      recordIgCheckAttempt(`shop_${i}`, { ok: true, nowMs: now });
      now += IG_MIN_GAP_MS + 1000;
    }

    expect(canAutoCheckIgHandle("shop_extra", now)).toEqual({
      allowed: false,
      reason: "hourly_cap",
    });

    resetIgSafetyStoreForTests();
    recordIgCheckAttempt("shop_rl", { ok: false, rateLimited: true, nowMs: now });
    const afterRl = canAutoCheckIgHandle("another_shop", now + 60_000);
    expect(afterRl.allowed).toBe(false);
    if (!afterRl.allowed) {
      expect(afterRl.reason).toBe("backoff");
    }
  });
});
