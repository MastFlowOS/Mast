import { beforeEach, describe, expect, it } from "vitest";
import {
  clearDailyCreditResetNotificationCache,
  dedupeDailyResetNotifications,
  maybeNotifyDailyCreditReset,
} from "@/lib/notifications";

describe("maybeNotifyDailyCreditReset", () => {
  beforeEach(() => {
    localStorage.clear();
    clearDailyCreditResetNotificationCache();
  });

  it("emits at most once per expired reset cycle across reloads", () => {
    const expiredReset = "2026-11-14T10:00:00.000Z";
    const nowMs = new Date("2026-11-15T06:00:00.000Z").getTime();

    const first = maybeNotifyDailyCreditReset({
      userId: "user-1",
      previousResetAt: expiredReset,
      dailyLeadsUsed: 12,
      nowMs,
    });
    expect(first).toBe(true);

    // Same session repeat
    expect(
      maybeNotifyDailyCreditReset({
        userId: "user-1",
        previousResetAt: expiredReset,
        dailyLeadsUsed: 12,
        nowMs: nowMs + 60_000,
      }),
    ).toBe(false);

    // Simulated full page reload (in-memory Set cleared, localStorage kept)
    clearDailyCreditResetNotificationCache();
    expect(
      maybeNotifyDailyCreditReset({
        userId: "user-1",
        previousResetAt: expiredReset,
        dailyLeadsUsed: 12,
        nowMs: nowMs + 120_000,
      }),
    ).toBe(false);

    // Even if user clears notifications list, same stale DB reset must not re-fire
    localStorage.setItem("mast_notifications", JSON.stringify([]));
    clearDailyCreditResetNotificationCache();
    expect(
      maybeNotifyDailyCreditReset({
        userId: "user-1",
        previousResetAt: expiredReset,
        dailyLeadsUsed: 12,
        nowMs: nowMs + 180_000,
      }),
    ).toBe(false);

    const stored = JSON.parse(localStorage.getItem("mast_notifications") || "[]");
    expect(stored).toHaveLength(0);
  });

  it("does not emit when zero daily leads were used or reset is in the future", () => {
    const nowMs = new Date("2026-11-15T06:00:00.000Z").getTime();

    expect(
      maybeNotifyDailyCreditReset({
        userId: "user-2",
        previousResetAt: "2026-11-14T10:00:00.000Z",
        dailyLeadsUsed: 0,
        nowMs,
      }),
    ).toBe(false);

    expect(
      maybeNotifyDailyCreditReset({
        userId: "user-2",
        previousResetAt: "2026-11-15T10:00:00.000Z",
        dailyLeadsUsed: 5,
        nowMs,
      }),
    ).toBe(false);
  });

  it("emits again when a genuinely new reset cycle expires after cooldown, replacing older reset card", () => {
    const first = maybeNotifyDailyCreditReset({
      userId: "user-3",
      previousResetAt: "2026-11-14T10:00:00.000Z",
      dailyLeadsUsed: 8,
      nowMs: new Date("2026-11-15T06:00:00.000Z").getTime(),
    });
    expect(first).toBe(true);

    // Within 20h cooldown, even a changed previousResetAt timestamp must not re-fire
    clearDailyCreditResetNotificationCache();
    expect(
      maybeNotifyDailyCreditReset({
        userId: "user-3",
        previousResetAt: "2026-11-15T06:10:00.000Z",
        dailyLeadsUsed: 4,
        nowMs: new Date("2026-11-15T06:22:00.000Z").getTime(),
      }),
    ).toBe(false);

    // After 20h+ on a genuinely new reset cycle, emits once and keeps only 1 reset card
    clearDailyCreditResetNotificationCache();
    const second = maybeNotifyDailyCreditReset({
      userId: "user-3",
      previousResetAt: "2026-11-16T10:00:00.000Z",
      dailyLeadsUsed: 4,
      nowMs: new Date("2026-11-16T11:00:00.000Z").getTime(),
    });
    expect(second).toBe(true);

    const saved = JSON.parse(localStorage.getItem("mast_notifications") || "[]");
    expect(saved).toHaveLength(1);
    expect(saved[0].title).toBe("Daily Credits Reset");
    expect(saved[0].createdAt).toBe("2026-11-16T11:00:00.000Z");
  });

  it("dedupeDailyResetNotifications collapses stacked duplicates down to one while keeping other alerts", () => {
    const cleaned = dedupeDailyResetNotifications([
      { id: "r1", title: "Daily Credits Reset", createdAt: "2026-11-15T07:22:00Z" },
      { id: "other", title: "Export complete", createdAt: "2026-11-15T07:10:00Z" },
      { id: "r2", title: "Daily Credits Reset", createdAt: "2026-11-15T07:04:00Z" },
      { id: "r3", title: "Daily Credits Reset", createdAt: "2026-11-15T06:55:00Z" },
    ]);
    expect(cleaned.map((x) => x.id)).toEqual(["r1", "other"]);
  });

  it("suppresses immediately when a reset notification was already recorded in mast_notifications during that cycle", () => {
    const expiredReset = "2026-11-14T10:00:00.000Z";
    localStorage.setItem(
      "mast_notifications",
      JSON.stringify([
        {
          id: 1,
          title: "Daily Credits Reset",
          body: "Your daily lead generation limit has been reset. Start acquiring new clients!",
          createdAt: "2026-11-15T05:00:00.000Z",
          unread: true,
        },
      ]),
    );

    const emitted = maybeNotifyDailyCreditReset({
      userId: "user-4",
      previousResetAt: expiredReset,
      dailyLeadsUsed: 10,
      nowMs: new Date("2026-11-15T06:00:00.000Z").getTime(),
    });
    expect(emitted).toBe(false);
  });
});
