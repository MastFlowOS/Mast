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
    | "notifyAnnouncements";
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

export function addNotification(payload: NotificationPayload) {
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
    const notifications = saved ? JSON.parse(saved) : [];
    const nowIso = new Date().toISOString();
    const newNotif = {
      id: Date.now() + Math.random(),
      icon: payload.icon,
      iconColor: payload.iconColor,
      iconBg: payload.iconBg,
      title: payload.title,
      body: payload.body,
      createdAt: nowIso,
      time: formatNotificationTimestamp(nowIso),
      unread: true,
    };
    const updated = [newNotif, ...notifications].slice(0, 50);
    localStorage.setItem("mast_notifications", JSON.stringify(updated));
    window.dispatchEvent(new CustomEvent("mast_notifications_update"));
  } catch (err) {
    console.warn("[addNotification] failed to save notification", err);
  }
}
