export interface NotificationPayload {
  icon: string;
  iconColor: string;
  iconBg: string;
  title: string;
  body: string;
  category:
    | "notifyNewLead"
    | "notifyCreditLimit"
    | "notifyCreditsReset"
    | "notifyPlanChanges"
    | "notifyBilling"
    | "notifyAnnouncements";
}

export function addNotification(payload: NotificationPayload) {
  let allowed = true;
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

  if (!allowed) {
    console.log(`[Notification] blocked category ${payload.category}`);
    return;
  }

  try {
    const saved = localStorage.getItem("mast_notifications");
    const notifications = saved ? JSON.parse(saved) : [];
    const newNotif = {
      id: Date.now() + Math.random(),
      icon: payload.icon,
      iconColor: payload.iconColor,
      iconBg: payload.iconBg,
      title: payload.title,
      body: payload.body,
      time: "Just now",
      unread: true,
    };
    const updated = [newNotif, ...notifications];
    localStorage.setItem("mast_notifications", JSON.stringify(updated));
    window.dispatchEvent(new CustomEvent("mast_notifications_update"));
  } catch (err) {
    console.warn("[addNotification] failed to save notification", err);
  }
}
