export interface NotificationPayload {
  icon: string;
  iconColor: string;
  iconBg: string;
  title: string;
  body: string;
  category?:
    | "notifyNewLead"
    | "notifyCreditLimit"
    | "notifyCreditsReset"
    | "notifyPlanChanges"
    | "notifyBilling"
    | "notifyAnnouncements"
    | "notifyOutreachReplies";
}

export function formatNotificationTimestamp(
  createdAt?: string | number,
  fallbackTime?: string,
  nowMs: number = Date.now(),
): string {
  if (!createdAt) {
    return fallbackTime || "Just now";
  }

  const date = new Date(createdAt);
  const ts = date.getTime();
  if (Number.isNaN(ts)) {
    return fallbackTime || "Just now";
  }

  const diffSec = Math.max(0, Math.floor((nowMs - ts) / 1000));
  let relative: string;
  if (diffSec < 45) {
    relative = "Just now";
  } else if (diffSec < 3600) {
    relative = `${Math.floor(diffSec / 60)}m ago`;
  } else if (diffSec < 86400) {
    relative = `${Math.floor(diffSec / 3600)}h ago`;
  } else {
    relative = `${Math.floor(diffSec / 86400)}d ago`;
  }

  const clock = date.toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });

  const nowDate = new Date(nowMs);
  const sameDay =
    date.getFullYear() === nowDate.getFullYear() &&
    date.getMonth() === nowDate.getMonth() &&
    date.getDate() === nowDate.getDate();

  if (sameDay) {
    return `${relative} · ${clock}`;
  }

  const dayStr = date.toLocaleDateString([], {
    month: "short",
    day: "numeric",
  });
  return `${dayStr}, ${clock}`;
}

export const DAILY_CREDITS_RESET_TITLE = "Daily Credits Reset";
const DAILY_RESET_COOLDOWN_MS = 20 * 60 * 60 * 1000;

/**
 * Keeps at most one (the newest) "Daily Credits Reset" entry in stored
 * notifications so repeated reset notifications never stack up.
 */
export function dedupeDailyResetNotifications<
  T extends { title?: unknown; createdAt?: unknown },
>(list: T[]): T[] {
  let seenReset = false;
  return list.filter((item) => {
    if (item?.title !== DAILY_CREDITS_RESET_TITLE) return true;
    if (seenReset) return false;
    seenReset = true;
    return true;
  });
}

export function addNotification(payload: NotificationPayload, nowMs: number = Date.now()) {
  let allowed = true;
  if (payload.category) {
    try {
      const prefsStr = localStorage.getItem("mast_notification_preferences");
      if (prefsStr) {
        const prefs = JSON.parse(prefsStr);
        if (prefs[payload.category] === "false" || prefs[payload.category] === false) {
          allowed = false;
        }
      }
    } catch (err) {
      console.warn("[addNotification] failed to parse preferences", err);
    }
  }

  if (!allowed) {
    return;
  }

  try {
    const saved = localStorage.getItem("mast_notifications");
    const parsed = saved ? JSON.parse(saved) : [];
    const notifications = Array.isArray(parsed)
      ? payload.title === DAILY_CREDITS_RESET_TITLE
        ? parsed.filter((n: { title?: unknown }) => n?.title !== DAILY_CREDITS_RESET_TITLE)
        : parsed
      : [];
    const nowIso = new Date(nowMs).toISOString();
    const newNotif = {
      id: nowMs + Math.random(),
      icon: payload.icon,
      iconColor: payload.iconColor,
      iconBg: payload.iconBg,
      title: payload.title,
      body: payload.body,
      createdAt: nowIso,
      time: formatNotificationTimestamp(nowIso, undefined, nowMs),
      unread: true,
    };
    const updated = dedupeDailyResetNotifications([newNotif, ...notifications]).slice(0, 50);
    localStorage.setItem("mast_notifications", JSON.stringify(updated));
    window.dispatchEvent(new CustomEvent("mast_notifications_update"));
  } catch (err) {
    console.warn("[addNotification] failed to save notification", err);
  }
}

const notifiedDailyResetCycles = new Set<string>();

export function clearDailyCreditResetNotificationCache(): void {
  notifiedDailyResetCycles.clear();
}

/**
 * Emits the "Daily Credits Reset" notification at most once per expired
 * `next_daily_reset` cycle AND never more than once within 20 hours
 * (and only when daily credits were actually used).
 */
export function maybeNotifyDailyCreditReset(params: {
  userId?: string | null;
  previousResetAt?: string | null;
  dailyLeadsUsed?: number | null;
  nowMs?: number;
}): boolean {
  const { userId, previousResetAt, dailyLeadsUsed, nowMs = Date.now() } = params;
  if (!previousResetAt || (dailyLeadsUsed ?? 0) <= 0) {
    return false;
  }

  const resetMs = new Date(previousResetAt).getTime();
  if (Number.isNaN(resetMs) || resetMs > nowMs) {
    return false;
  }

  const userKey = userId || "anon";
  const cycleKey = `${userKey}:${previousResetAt}`;
  if (notifiedDailyResetCycles.has(cycleKey)) {
    return false;
  }

  const storageKey = `mast_daily_reset_notified_${userKey}`;
  const lastAtKey = `mast_daily_reset_last_at_${userKey}`;
  try {
    if (typeof localStorage !== "undefined") {
      if (localStorage.getItem(storageKey) === previousResetAt) {
        notifiedDailyResetCycles.add(cycleKey);
        return false;
      }

      const lastAtRaw = Number(localStorage.getItem(lastAtKey));
      if (!Number.isNaN(lastAtRaw) && lastAtRaw > 0 && nowMs - lastAtRaw < DAILY_RESET_COOLDOWN_MS) {
        localStorage.setItem(storageKey, previousResetAt);
        notifiedDailyResetCycles.add(cycleKey);
        return false;
      }

      const saved = localStorage.getItem("mast_notifications");
      if (saved) {
        const list = JSON.parse(saved);
        if (
          Array.isArray(list) &&
          list.some((n) => {
            if (n?.title !== DAILY_CREDITS_RESET_TITLE || !n?.createdAt) return false;
            const createdMs = new Date(n.createdAt).getTime();
            if (Number.isNaN(createdMs)) return false;
            return createdMs >= resetMs || nowMs - createdMs < DAILY_RESET_COOLDOWN_MS;
          })
        ) {
          localStorage.setItem(storageKey, previousResetAt);
          notifiedDailyResetCycles.add(cycleKey);
          return false;
        }
      }

      localStorage.setItem(storageKey, previousResetAt);
      localStorage.setItem(lastAtKey, String(nowMs));
    }
  } catch (err) {
    console.warn("[maybeNotifyDailyCreditReset] storage check failed", err);
  }

  notifiedDailyResetCycles.add(cycleKey);
  addNotification(
    {
      icon: "CheckCircle2",
      iconColor: "text-emerald-400",
      iconBg: "bg-emerald-400/10 border-emerald-400/20",
      title: DAILY_CREDITS_RESET_TITLE,
      body: "Your daily lead generation limit has been reset. Start acquiring new clients!",
      category: "notifyCreditsReset",
    },
    nowMs,
  );
  return true;
}
