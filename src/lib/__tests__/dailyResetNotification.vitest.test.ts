import { beforeEach, describe, expect, it } from "vitest";
import {
  clearDailyCreditResetNotificationCache,
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

  it("emits again when a genuinely new reset cycle expires", () => {
    const first = maybeNotifyDailyCreditReset({
      userId: "user-3",
      previousResetAt: "2026-11-14T10:00:00.000Z",
      dailyLeadsUsed: 8,
      nowMs: new Date("2026-11-15T06:00:00.000Z").getTime(),
    });
    expect(first).toBe(true);

    clearDailyCreditResetNotificationCache();
    const second = maybeNotifyDailyCreditReset({
      userId: "user-3",
      previousResetAt: "2026-11-16T10:00:00.000Z",
      dailyLeadsUsed: 4,
      nowMs: new Date("2026-11-16T11:00:00.000Z").getTime(),
    });
    expect(second).toBe(true);

    const saved = JSON.parse(localStorage.getItem("mast_notifications") || "[]");
    expect(saved).toHaveLength(2);
    expect(saved[0].title).toBe("Daily Credits Reset");
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
