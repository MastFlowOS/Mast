/* global chrome */
const pasteJson = document.getElementById("pasteJson");
const apiInput = document.getElementById("apiBaseUrl");
const tokenInput = document.getElementById("token");
const statusEl = document.getElementById("status");

chrome.storage.local.get(["apiBaseUrl", "token", "lastSyncStatus", "lastSyncAt"], (cfg) => {
  if (cfg.apiBaseUrl) apiInput.value = cfg.apiBaseUrl;
  if (cfg.token) tokenInput.value = cfg.token;
  if (cfg.lastSyncStatus) {
    statusEl.textContent = `${cfg.lastSyncStatus}${cfg.lastSyncAt ? ` · ${new Date(cfg.lastSyncAt).toLocaleTimeString()}` : ""}`;
  }
});

pasteJson.addEventListener("input", () => {
  try {
    const parsed = JSON.parse(pasteJson.value);
    if (parsed.apiBaseUrl) apiInput.value = parsed.apiBaseUrl;
    if (parsed.token) tokenInput.value = parsed.token;
  } catch {
    // ignore partial JSON while typing
  }
});

document.getElementById("saveBtn").addEventListener("click", () => {
  const apiBaseUrl = apiInput.value.trim().replace(/\/+$/, "");
  const token = tokenInput.value.trim();
  chrome.storage.local.set({ apiBaseUrl, token }, () => {
    statusEl.textContent = "Saved! Open instagram.com/direct/inbox/ to sync.";
  });
});
