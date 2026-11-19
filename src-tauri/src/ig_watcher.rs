use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

pub const IG_WATCHER_LABEL: &str = "ig-watcher";
pub const IG_DIRECT_INBOX_URL: &str = "https://www.instagram.com/direct/inbox/";

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct IgWatcherConfig {
    pub enabled: bool,
    pub connected: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IgObservedThread {
    pub handle: Option<String>,
    pub display_name: Option<String>,
    pub preview_text: Option<String>,
    pub thread_url: Option<String>,
    pub unread: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IgWatcherReportPayload {
    pub state: String,
    #[serde(default)]
    pub events: Vec<IgObservedThread>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IgWatcherStatus {
    pub enabled: bool,
    pub connected: bool,
    pub window_open: bool,
    pub window_visible: bool,
    pub state: String,
    pub last_checked_ms: Option<u64>,
    pub last_error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IgWatcherUpdateEvent {
    pub status: IgWatcherStatus,
    pub events: Vec<IgObservedThread>,
}

#[derive(Debug, Default)]
pub struct IgWatcherInner {
    pub enabled: bool,
    pub connected: bool,
    pub state: String,
    pub last_checked_ms: Option<u64>,
    pub last_error: Option<String>,
    pub auto_hide_on_login: bool,
    pub force_close: bool,
}

#[derive(Clone)]
pub struct IgWatcherState {
    pub inner: Arc<Mutex<IgWatcherInner>>,
    pub data_dir: PathBuf,
}

impl IgWatcherState {
    pub fn load(data_dir: PathBuf) -> Self {
        let cfg = load_config_at(&config_path(&data_dir));
        let initial_state = if cfg.enabled { "starting" } else { "disabled" };
        Self {
            inner: Arc::new(Mutex::new(IgWatcherInner {
                enabled: cfg.enabled,
                connected: cfg.connected,
                state: initial_state.to_string(),
                last_checked_ms: None,
                last_error: None,
                auto_hide_on_login: false,
                force_close: false,
            })),
            data_dir,
        }
    }

    pub fn persist_config(&self, enabled: bool, connected: bool) {
        let _ = save_config_at(
            &config_path(&self.data_dir),
            &IgWatcherConfig { enabled, connected },
        );
    }

    pub fn snapshot(&self, app: &AppHandle) -> IgWatcherStatus {
        let guard = self.inner.lock().unwrap();
        let win = app.get_webview_window(IG_WATCHER_LABEL);
        let window_open = win.is_some();
        let window_visible = win
            .as_ref()
            .and_then(|w| w.is_visible().ok())
            .unwrap_or(false);

        IgWatcherStatus {
            enabled: guard.enabled,
            connected: guard.connected,
            window_open,
            window_visible,
            state: guard.state.clone(),
            last_checked_ms: guard.last_checked_ms,
            last_error: guard.last_error.clone(),
        }
    }
}

fn config_path(data_dir: &Path) -> PathBuf {
    data_dir.join("ig-watcher.json")
}

pub fn webview_data_dir(data_dir: &Path) -> PathBuf {
    data_dir.join("ig-webview")
}

fn load_config_at(path: &Path) -> IgWatcherConfig {
    let Ok(raw) = fs::read_to_string(path) else {
        return IgWatcherConfig::default();
    };
    serde_json::from_str::<IgWatcherConfig>(&raw).unwrap_or_default()
}

fn save_config_at(path: &Path, cfg: &IgWatcherConfig) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let body = serde_json::to_string_pretty(cfg).map_err(|e| e.to_string())?;
    fs::write(path, body).map_err(|e| e.to_string())
}

fn now_epoch_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn sanitize_handle(raw: Option<&str>) -> Option<String> {
    let trimmed = raw?.trim().trim_start_matches('@').to_lowercase();
    if trimmed.is_empty() || trimmed.len() > 30 {
        return None;
    }
    if trimmed
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '.')
    {
        Some(trimmed)
    } else {
        None
    }
}

fn sanitize_thread_url(raw: Option<&str>) -> Option<String> {
    let trimmed = raw?.trim();
    if trimmed.starts_with("https://www.instagram.com/") && trimmed.len() <= 500 {
        Some(trimmed.to_string())
    } else {
        None
    }
}

pub fn sanitize_events(events: Vec<IgObservedThread>) -> Vec<IgObservedThread> {
    events
        .into_iter()
        .take(30)
        .filter_map(|ev| {
            let handle = sanitize_handle(ev.handle.as_deref());
            let display_name = ev
                .display_name
                .map(|s| s.trim().chars().take(120).collect::<String>())
                .filter(|s| !s.is_empty());
            if handle.is_none() && display_name.is_none() {
                return None;
            }
            let preview_text = ev
                .preview_text
                .map(|s| s.trim().chars().take(400).collect::<String>())
                .filter(|s| !s.is_empty());
            let thread_url = sanitize_thread_url(ev.thread_url.as_deref());
            Some(IgObservedThread {
                handle,
                display_name,
                preview_text,
                thread_url,
                unread: Some(true),
            })
        })
        .collect()
}

pub const IG_WATCHER_INIT_SCRIPT: &str = r#"
(() => {
  if (window.__mastIgWatcherLoaded) return;
  window.__mastIgWatcherLoaded = true;

  const host = (window.location && window.location.hostname || "").toLowerCase();
  if (host !== "www.instagram.com" && host !== "instagram.com") return;

  const sentSignatures = new Set();
  let lastReportedState = "";
  let scanTimer = null;
  let redirectedToInbox = false;

  function invokeReport(state, events) {
    try {
      const internals = window.__TAURI_INTERNALS__;
      if (!internals || typeof internals.invoke !== "function") return;
      internals.invoke("report_ig_watcher_state", {
        payload: { state, events: Array.isArray(events) ? events : [] }
      }).catch(() => {});
    } catch (_) {}
  }

  function isLoginOrChallenge() {
    const path = (window.location.pathname || "").toLowerCase();
    if (
      path.startsWith("/accounts/login") ||
      path.startsWith("/accounts/signup") ||
      path.startsWith("/challenge") ||
      path.startsWith("/two_factor") ||
      path.startsWith("/accounts/suspended") ||
      path.startsWith("/consent")
    ) {
      return true;
    }
    if (document.querySelector('input[name="username"], form#loginForm')) {
      return true;
    }
    return false;
  }

  function extractHandleFromElement(row) {
    const links = row.querySelectorAll('a[href*="/direct/t/"], a[href^="/"]');
    for (const a of links) {
      const href = a.getAttribute("href") || "";
      if (href.startsWith("/") && !href.startsWith("/direct") && !href.startsWith("/explore") && !href.startsWith("/reels")) {
        const seg = href.replace(/^\/+/, "").split("/")[0];
        if (/^[A-Za-z0-9_][A-Za-z0-9_.]{1,29}$/.test(seg)) {
          return seg.toLowerCase();
        }
      }
    }
    const text = (row.innerText || "").trim();
    const atMatch = text.match(/@([A-Za-z0-9_][A-Za-z0-9_.]{1,29})/);
    if (atMatch) return atMatch[1].toLowerCase();

    const firstLine = (text.split("\n")[0] || "").trim();
    if (/^[A-Za-z0-9_][A-Za-z0-9_.]{1,29}$/.test(firstLine) && !firstLine.includes(" ")) {
      return firstLine.toLowerCase();
    }
    return null;
  }

  function looksUnread(row) {
    const aria = (row.getAttribute("aria-label") || "").toLowerCase();
    if (aria.includes("unread")) return true;
    if (row.querySelector('[aria-label*="Unread" i], [aria-label*="unread" i]')) return true;
    const spans = row.querySelectorAll("span");
    for (const sp of spans) {
      if (!sp.textContent || !sp.textContent.trim()) continue;
      if (sp.style && (sp.style.fontWeight === "600" || sp.style.fontWeight === "700")) {
        return true;
      }
      try {
        const fw = Number(window.getComputedStyle(sp).fontWeight);
        if (fw >= 600 && sp.closest('[role="listitem"], [role="row"], a[href*="/direct/t/"]')) {
          return true;
        }
      } catch (_) {}
    }
    return false;
  }

  function scanVisibleThreads() {
    if (isLoginOrChallenge()) {
      if (lastReportedState !== "needs_login") {
        lastReportedState = "needs_login";
        invokeReport("needs_login", []);
      }
      return;
    }

    const path = (window.location.pathname || "").toLowerCase();
    if (!path.startsWith("/direct")) {
      // Logged in on feed/home after auth — go straight to DM inbox once
      if (!redirectedToInbox) {
        redirectedToInbox = true;
        window.location.replace("https://www.instagram.com/direct/inbox/");
      }
      if (lastReportedState !== "watching") {
        lastReportedState = "watching";
        invokeReport("watching", []);
      }
      return;
    }

    const candidates = document.querySelectorAll(
      '[role="listitem"], [role="row"], [role="list"] [role="button"], a[href*="/direct/t/"]'
    );
    const seenContainers = new Set();
    const events = [];

    for (const el of candidates) {
      const container = el.closest('[role="listitem"], [role="row"]') || el;
      if (!container || seenContainers.has(container)) continue;
      seenContainers.add(container);

      const text = (container.innerText || "").trim();
      if (!text) continue;
      const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
      if (lines.length < 2) continue;
      if (!looksUnread(container)) continue;

      const handle = extractHandleFromElement(container);
      const displayName = lines[0] || null;
      if (!handle && !displayName) continue;

      const previewText = lines.slice(1, 3).join(" · ").slice(0, 300) || null;
      const linkEl = container.querySelector('a[href*="/direct/t/"]') || (container.tagName === "A" ? container : null);
      const href = linkEl ? linkEl.getAttribute("href") : null;
      const threadUrl = href && href.startsWith("/") ? "https://www.instagram.com" + href : window.location.href;

      const sig = `${handle || displayName}:${previewText || "unread"}`;
      if (sentSignatures.has(sig)) continue;
      if (sentSignatures.size > 500) sentSignatures.clear();
      sentSignatures.add(sig);

      events.push({
        handle,
        displayName,
        previewText,
        threadUrl,
        unread: true
      });
    }

    if (lastReportedState !== "watching" || events.length > 0) {
      lastReportedState = "watching";
      invokeReport("watching", events);
    }
  }

  function scheduleScan() {
    if (scanTimer) clearTimeout(scanTimer);
    scanTimer = setTimeout(scanVisibleThreads, 1200);
  }

  function startObserver() {
    if (document.body) {
      const observer = new MutationObserver(scheduleScan);
      observer.observe(document.body, { childList: true, subtree: true });
    }
    setTimeout(scanVisibleThreads, 1800);
    setInterval(scanVisibleThreads, 12000);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", startObserver, { once: true });
  } else {
    startObserver();
  }
})();
"#;

pub fn create_or_show_watcher(
    app: &AppHandle,
    watcher_state: &IgWatcherState,
    visible: bool,
    auto_hide_on_login: bool,
) -> Result<IgWatcherStatus, String> {
    {
        let mut guard = watcher_state.inner.lock().unwrap();
        guard.enabled = true;
        guard.force_close = false;
        guard.last_error = None;
        if auto_hide_on_login {
            guard.auto_hide_on_login = true;
        }
        if guard.state == "disabled" {
            guard.state = "starting".to_string();
        }
        watcher_state.persist_config(true, guard.connected);
    }

    if let Some(win) = app.get_webview_window(IG_WATCHER_LABEL) {
        if visible {
            let _ = win.show();
            let _ = win.unminimize();
            let _ = win.set_focus();
        }
        return Ok(watcher_state.snapshot(app));
    }

    let url = tauri::Url::parse(IG_DIRECT_INBOX_URL)
        .map_err(|e| format!("Invalid Instagram inbox URL: {}", e))?;
    let data_dir = webview_data_dir(&watcher_state.data_dir);
    let _ = fs::create_dir_all(&data_dir);

    WebviewWindowBuilder::new(app, IG_WATCHER_LABEL, WebviewUrl::External(url))
        .title("Instagram Reply Watcher — MAST")
        .inner_size(480.0, 720.0)
        .resizable(true)
        .center()
        .visible(visible)
        .data_directory(data_dir)
        .initialization_script(IG_WATCHER_INIT_SCRIPT)
        .build()
        .map_err(|e| {
            let msg = format!("Could not launch Instagram watcher window: {}", e);
            if let Ok(mut guard) = watcher_state.inner.lock() {
                guard.last_error = Some(msg.clone());
            }
            msg
        })?;

    Ok(watcher_state.snapshot(app))
}

pub fn handle_ig_watcher_report(
    app: &AppHandle,
    watcher_state: &IgWatcherState,
    payload: IgWatcherReportPayload,
) -> IgWatcherStatus {
    let normalized_state = match payload.state.as_str() {
        "watching" => "watching",
        "needs_login" => "needs_login",
        _ => "starting",
    };

    let should_hide = {
        let mut guard = watcher_state.inner.lock().unwrap();
        guard.state = normalized_state.to_string();
        guard.last_checked_ms = Some(now_epoch_ms());
        guard.last_error = None;

        if normalized_state == "watching" {
            guard.connected = true;
            watcher_state.persist_config(guard.enabled, true);
            if guard.auto_hide_on_login {
                guard.auto_hide_on_login = false;
                true
            } else {
                false
            }
        } else if normalized_state == "needs_login" {
            guard.connected = false;
            watcher_state.persist_config(guard.enabled, false);
            false
        } else {
            false
        }
    };

    if should_hide {
        if let Some(win) = app.get_webview_window(IG_WATCHER_LABEL) {
            let _ = win.hide();
        }
    }

    let status = watcher_state.snapshot(app);
    let sanitized_events = sanitize_events(payload.events);
    let _ = app.emit_to(
        "main",
        "ig-watcher-update",
        IgWatcherUpdateEvent {
            status: status.clone(),
            events: sanitized_events,
        },
    );

    status
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitize_events_drops_invalid_handles_and_non_ig_urls() {
        let out = sanitize_events(vec![
            IgObservedThread {
                handle: Some("  @Luna_Bakery ".to_string()),
                display_name: Some("Luna Bakery".to_string()),
                preview_text: Some("Yes let's chat".to_string()),
                thread_url: Some("https://www.instagram.com/direct/t/12345/".to_string()),
                unread: Some(true),
            },
            IgObservedThread {
                handle: Some("bad handle with spaces!".to_string()),
                display_name: None,
                preview_text: Some("ignored".to_string()),
                thread_url: Some("javascript:alert(1)".to_string()),
                unread: Some(true),
            },
        ]);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].handle.as_deref(), Some("luna_bakery"));
        assert_eq!(
            out[0].thread_url.as_deref(),
            Some("https://www.instagram.com/direct/t/12345/")
        );
    }

    #[test]
    fn ig_watcher_config_roundtrip() {
        let dir = std::env::temp_dir().join(format!("mast-ig-cfg-{}", now_epoch_ms()));
        let path = config_path(&dir);
        save_config_at(&path, &IgWatcherConfig { enabled: true, connected: true }).unwrap();
        let loaded = load_config_at(&path);
        assert!(loaded.enabled);
        assert!(loaded.connected);
        let _ = fs::remove_dir_all(&dir);
    }
}
