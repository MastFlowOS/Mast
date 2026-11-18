/* global chrome */
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "MAST_IG_SYNC_EVENTS" || !Array.isArray(message.events)) {
    return false;
  }

  chrome.storage.local.get(["apiBaseUrl", "token"], async (cfg) => {
    const apiBaseUrl = (cfg.apiBaseUrl || "").trim().replace(/\/+$/, "");
    const token = (cfg.token || "").trim();
    if (!apiBaseUrl || !token) {
      sendResponse({ ok: false, reason: "not_configured" });
      return;
    }

    try {
      const res = await fetch(`${apiBaseUrl}/v1/inbox/ig-sync`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ events: message.events.slice(0, 50) }),
      });
      const data = await res.json().catch(() => ({}));
      await chrome.storage.local.set({
        lastSyncAt: new Date().toISOString(),
        lastSyncStatus: res.ok ? `Synced (${data.recorded ?? 0} new)` : `Error ${res.status}`,
      });
      sendResponse({ ok: res.ok, data });
    } catch (err) {
      await chrome.storage.local.set({
        lastSyncAt: new Date().toISOString(),
        lastSyncStatus: `Network error: ${err?.message || "failed"}`,
      });
      sendResponse({ ok: false, error: String(err) });
    }
  });

  return true;
});
