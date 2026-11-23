import { describe, it, expect, vi } from "vitest";
import {
  computeBusinessActivity,
  fetchLiveInstagramActivity,
  formatDaysAgoLabel,
  parseDaysAgoFromText,
} from "../businessActivity";

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
