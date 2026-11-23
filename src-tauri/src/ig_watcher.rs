use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

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
    pub debug: Option<String>,
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
    pub last_debug: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IgWatcherUpdateEvent {
    pub status: IgWatcherStatus,
    pub events: Vec<IgObservedThread>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IgProfileCheckPayload {
    pub request_id: String,
    pub ok: bool,
    pub handle: String,
    pub last_post_days_ago: Option<i64>,
    pub last_post_at: Option<String>,
    pub last_post_caption: Option<String>,
    pub has_active_story: Option<bool>,
    pub followers_count: Option<i64>,
    pub posts_count: Option<i64>,
    pub is_private: Option<bool>,
    pub bio: Option<String>,
    pub note: Option<String>,
    #[serde(default)]
    pub needs_login: bool,
}

#[derive(Debug, Default)]
pub struct IgWatcherInner {
    pub enabled: bool,
    pub connected: bool,
    pub state: String,
    pub last_checked_ms: Option<u64>,
    pub last_error: Option<String>,
    pub last_debug: Option<String>,
    pub auto_hide_on_login: bool,
    pub force_close: bool,
}

#[derive(Clone)]
pub struct IgWatcherState {
    pub inner: Arc<Mutex<IgWatcherInner>>,
    pub pending_profile_checks: Arc<Mutex<HashMap<String, mpsc::Sender<IgProfileCheckPayload>>>>,
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
                last_debug: None,
                auto_hide_on_login: false,
                force_close: false,
            })),
            pending_profile_checks: Arc::new(Mutex::new(HashMap::new())),
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
            last_debug: guard.last_debug.clone(),
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

  function invokeReport(state, events, debug) {
    try {
      const internals = window.__TAURI_INTERNALS__;
      if (!internals || typeof internals.invoke !== "function") return;
      internals.invoke("report_ig_watcher_state", {
        payload: {
          state,
          events: Array.isArray(events) ? events : [],
          debug: typeof debug === "string" ? debug.slice(0, 260) : null
        }
      }).catch(() => {});
    } catch (_) {}
  }

  function getCookie(name) {
    const m = document.cookie.match(new RegExp("(?:^|;\\s*)" + name + "=([^;]*)"));
    return m ? decodeURIComponent(m[1]) : "";
  }

  function stripXssi(text) {
    return typeof text === "string" ? text.replace(/^for\s*\(\s*;\s*;\s*\)\s*;?\s*/, "") : "";
  }

  function extractThreadParticipants(node) {
    if (Array.isArray(node.users) && node.users.length > 0) {
      return node.users.map((u) => ({
        pk: u && (u.pk || u.id || u.pk_id) ? String(u.pk || u.id || u.pk_id) : null,
        username: u && u.username ? String(u.username).trim().toLowerCase() : null,
        fullName: u && (u.full_name || u.name) ? String(u.full_name || u.name).trim() : null,
      }));
    }
    const edges =
      (node.all_participants && node.all_participants.edges) ||
      (node.participants && node.participants.edges) ||
      [];
    if (Array.isArray(edges) && edges.length > 0) {
      return edges.map((e) => {
        const actor = (e && e.node && (e.node.messaging_actor || e.node)) || {};
        return {
          pk: actor.id || actor.pk ? String(actor.id || actor.pk) : null,
          username: actor.username ? String(actor.username).trim().toLowerCase() : null,
          fullName: actor.name || actor.full_name ? String(actor.name || actor.full_name).trim() : null,
        };
      });
    }
    return [];
  }

  function collectThreadsFromPayload(node, viewerPk, out, depth, forceUnread) {
    if (!node || typeof node !== "object" || depth > 9) return;
    if (Array.isArray(node)) {
      for (const item of node) collectThreadsFromPayload(item, viewerPk, out, depth + 1, forceUnread);
      return;
    }

    const participants = extractThreadParticipants(node);
    const tid = node.thread_id || node.thread_v2_id || (node.thread_key && node.thread_key.thread_fbid) || "";
    if (participants.length > 0 && tid) {
      const unreadCount = Number(node.unread_count || 0);
      const readState = Number(node.read_state || 0);
      const watermark = Number(node.read_watermark_timestamp_ms || 0);
      const lastActivity = Number(node.last_activity_timestamp_ms || 0);
      const isUnread =
        Boolean(forceUnread) ||
        readState === 1 ||
        unreadCount > 0 ||
        node.has_unread === true ||
        node.is_unread === true ||
        (watermark > 0 && lastActivity > watermark);

      const lastItem = node.last_permanent_item || node.last_message || null;
      const lastSenderPk =
        (lastItem && (lastItem.user_id || lastItem.sender_id)) ||
        (lastItem && lastItem.message_sender && lastItem.message_sender.id);
      const fromSelf = viewerPk && lastSenderPk && String(lastSenderPk) === String(viewerPk);

      if (isUnread && !fromSelf) {
        const other =
          participants.find((p) => (!viewerPk || p.pk !== String(viewerPk)) && (p.username || p.fullName)) ||
          participants[0];
        const handle = other && other.username ? other.username : null;
        const displayName =
          (other && other.fullName ? other.fullName : null) ||
          (node.thread_title ? String(node.thread_title).trim() : null);
        const previewText =
          (lastItem && (lastItem.text || lastItem.snippet) ? String(lastItem.text || lastItem.snippet).trim() : null) ||
          "Sent a message on Instagram";
        if (handle || displayName) {
          out.push({
            handle,
            displayName,
            previewText: previewText.slice(0, 300),
            threadUrl: `https://www.instagram.com/direct/t/${tid}/`,
            unread: true,
          });
        }
      }
    }

    for (const key of ["inbox", "data", "viewer", "threads", "edges", "node", "thread", "ig_direct_inbox", "xfb_fetch_inbox_threads"]) {
      if (node[key] && typeof node[key] === "object") {
        collectThreadsFromPayload(node[key], viewerPk, out, depth + 1, forceUnread);
      }
    }
  }

  function handleIgNetworkJson(url, rawText) {
    try {
      if (!url || (!url.includes("direct_v2") && !url.includes("graphql"))) return;
      const cleaned = stripXssi(rawText);
      if (!cleaned || (cleaned[0] !== "{" && cleaned[0] !== "[")) return;
      const json = JSON.parse(cleaned);
      const viewerPk =
        (json && json.viewer && (json.viewer.pk || json.viewer.id)) ||
        (json && json.inbox && json.inbox.viewer_id) ||
        getCookie("ds_user_id") ||
        null;
      const found = [];
      collectThreadsFromPayload(json, viewerPk, found, 0, url.includes("pending_inbox"));
      if (found.length === 0) return;

      const fresh = [];
      for (const ev of found) {
        const sig = `${ev.handle || ev.displayName}:${ev.threadUrl}:${ev.previewText}`;
        if (sentSignatures.has(sig)) continue;
        if (sentSignatures.size > 500) sentSignatures.clear();
        sentSignatures.add(sig);
        fresh.push(ev);
      }
      if (fresh.length > 0 && !isLoginOrChallenge() && !isAuthTransitionPage()) {
        lastReportedState = "watching";
        const labels = fresh.map((e) => e.handle ? `@${e.handle}` : e.displayName).slice(0, 3).join(", ");
        invokeReport("watching", fresh, `Net: ${fresh.length} unread (${labels})`);
      }
    } catch (_) {}
  }

  const origFetchRef = window.fetch ? window.fetch.bind(window) : null;

  // Passive read-only tap on IG's own fetch/XHR inbox responses (zero extra requests)
  try {
    if (typeof origFetchRef === "function") {
      window.fetch = function (...args) {
        const reqUrl = typeof args[0] === "string" ? args[0] : (args[0] && args[0].url) || "";
        return origFetchRef(...args).then((res) => {
          try {
            if (reqUrl.includes("direct_v2") || reqUrl.includes("graphql")) {
              res.clone().text().then((t) => handleIgNetworkJson(reqUrl, t)).catch(() => {});
            }
          } catch (_) {}
          return res;
        });
      };
    }

    const origOpen = XMLHttpRequest.prototype.open;
    const origSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (method, url, ...rest) {
      this.__mastUrl = typeof url === "string" ? url : "";
      return origOpen.call(this, method, url, ...rest);
    };
    XMLHttpRequest.prototype.send = function (...args) {
      this.addEventListener("load", function () {
        try {
          if (this.__mastUrl && (this.__mastUrl.includes("direct_v2") || this.__mastUrl.includes("graphql"))) {
            handleIgNetworkJson(this.__mastUrl, this.responseText);
          }
        } catch (_) {}
      });
      return origSend.apply(this, args);
    };
  } catch (_) {}

  function isLoginOrChallenge() {
    const path = (window.location.pathname || "").toLowerCase();
    if (
      path.startsWith("/accounts/login") ||
      path.startsWith("/accounts/signup") ||
      path.startsWith("/challenge") ||
      path.startsWith("/two_factor") ||
      path.startsWith("/accounts/suspended")
    ) {
      return true;
    }
    if (document.querySelector('input[name="username"], input[name="password"], form#loginForm')) {
      return true;
    }
    return false;
  }

  function isAuthTransitionPage() {
    const path = (window.location.pathname || "").toLowerCase();
    return (
      path.startsWith("/accounts/onetap") ||
      path.startsWith("/accounts/") ||
      path.startsWith("/consent") ||
      path.startsWith("/privacy")
    );
  }

  function hasLoggedInInboxDom() {
    if (document.querySelector('input[name="username"], input[name="password"], form#loginForm')) {
      return false;
    }
    // Verify IG actually rendered the signed-in app shell / DM view
    return Boolean(
      document.querySelector('[aria-label="Thread list"], [role="navigation"], [role="list"], a[href*="/direct/"]')
    );
  }

  function findRelayStoreRecords(startFiber) {
    let cur = startFiber;
    for (let step = 0; step < 50 && cur; step++) {
      let ctx = cur.dependencies && cur.dependencies.firstContext;
      while (ctx) {
        const mv = ctx.memoizedValue;
        const env = mv && typeof mv === "object"
          ? (typeof mv.getStore === "function" ? mv : mv.environment)
          : null;
        if (env && typeof env.getStore === "function") {
          const src = env.getStore().getSource();
          const recs = src && typeof src.toJSON === "function" ? src.toJSON() : (src && src._records) || null;
          if (recs && typeof recs === "object") return recs;
        }
        ctx = ctx.next;
      }
      cur = cur.return;
    }
    return null;
  }

  function isValidIgHandle(val) {
    return typeof val === "string" && /^[A-Za-z0-9_][A-Za-z0-9_.]{1,29}$/.test(val.trim());
  }

  function resolveRelayThreadInfo(row, cachedRecs) {
    const out = { handle: null, displayName: null, threadUrl: null, recs: cachedRecs || null };
    try {
      const fiberKey = Object.keys(row).find(
        (k) => k.startsWith("__reactFiber$") || k.startsWith("__reactProps$")
      );
      if (!fiberKey) return out;
      let node = row[fiberKey];
      let threadRecordId = null;
      let threadKey = null;
      let threadFbid = null;

      for (let step = 0; step < 18 && node; step++) {
        const props = node.memoizedProps || node;
        if (props && typeof props === "object") {
          const refObjs = [
            props.viewerThreadRef,
            props.threadRef,
            props.addOnEnd && props.addOnEnd.props && props.addOnEnd.props.threadRef,
            props.thread,
            props.item,
            props.user,
          ];
          for (const c of refObjs) {
            if (!c || typeof c !== "object") continue;
            if (!threadRecordId && typeof c.__id === "string" && c.__id.includes("ViewerThread")) {
              threadRecordId = c.__id;
            }
            if (!threadKey && c.thread_key) threadKey = String(c.thread_key);
            if (!threadFbid && (c.thread_fbid || c.id)) threadFbid = String(c.thread_fbid || c.id);
            const rawUser = c.username || c.ig_username;
            if (!out.handle && isValidIgHandle(rawUser)) {
              out.handle = rawUser.trim().toLowerCase();
            }
            if (!out.handle && Array.isArray(c.users) && c.users[0] && isValidIgHandle(c.users[0].username)) {
              out.handle = c.users[0].username.trim().toLowerCase();
            }
          }
        }
        if (!out.recs && step >= 3) {
          out.recs = findRelayStoreRecords(node);
        }
        node = node.return;
      }

      const recs = out.recs;
      if (recs) {
        let rec =
          (threadRecordId && recs[threadRecordId]) ||
          (threadFbid && recs[`XFBIGDirectViewerThread:${threadFbid}`]) ||
          null;
        if (!rec && (threadKey || threadFbid)) {
          for (const key of Object.keys(recs)) {
            const candidate = recs[key];
            if (!candidate || candidate.__typename !== "XFBIGDirectViewerThread") continue;
            if (
              (threadKey && String(candidate.thread_key || "") === threadKey) ||
              (threadFbid && String(candidate.thread_fbid || candidate.id || "") === threadFbid)
            ) {
              rec = candidate;
              break;
            }
          }
        }
        if (rec) {
          const resolvedKey = rec.thread_key || rec.thread_fbid || rec.id || threadKey || threadFbid;
          if (resolvedKey) {
            out.threadUrl = `https://www.instagram.com/direct/t/${resolvedKey}/`;
          }
          if (!out.displayName && typeof rec.thread_title === "string" && rec.thread_title.trim()) {
            out.displayName = rec.thread_title.trim();
          }
          const viewerId = rec.viewer_id ? String(rec.viewer_id) : null;
          const viewerRef = rec.viewer && rec.viewer.__ref ? rec.viewer.__ref : null;
          const userRefs = [
            ...((rec.users && Array.isArray(rec.users.__refs) && rec.users.__refs) || []),
            ...((rec.all_participants && Array.isArray(rec.all_participants.__refs) && rec.all_participants.__refs) || []),
            ...((rec.participants && Array.isArray(rec.participants.__refs) && rec.participants.__refs) || []),
          ];
          for (const ref of userRefs) {
            if (!ref || ref === viewerRef) continue;
            const u = recs[ref];
            if (!u || typeof u !== "object") continue;
            const uid = u.pk || u.id || u.pk_id;
            if (viewerId && uid && String(uid) === viewerId) continue;
            const uname = u.username || u.ig_username;
            if (!out.handle && isValidIgHandle(uname)) {
              out.handle = uname.trim().toLowerCase();
            }
            if (!out.displayName && (u.full_name || u.name)) {
              out.displayName = String(u.full_name || u.name).trim();
            }
            if (out.handle) break;
          }
        }
      } else if (threadKey || threadFbid) {
        out.threadUrl = `https://www.instagram.com/direct/t/${threadKey || threadFbid}/`;
      }
    } catch (_) {}
    return out;
  }

  function extractHandleFromElement(row, relayHandle) {
    if (isValidIgHandle(relayHandle)) return relayHandle.trim().toLowerCase();

    const links = row.querySelectorAll('a[href*="/direct/t/"], a[href^="/"]');
    for (const a of links) {
      const href = a.getAttribute("href") || "";
      if (href.startsWith("/") && !href.startsWith("/direct") && !href.startsWith("/explore") && !href.startsWith("/reels")) {
        const seg = href.replace(/^\/+/, "").split("/")[0];
        if (isValidIgHandle(seg)) {
          return seg.toLowerCase();
        }
      }
    }

    const text = (row.innerText || "").trim();
    const atMatch = text.match(/@([A-Za-z0-9_][A-Za-z0-9_.]{1,29})/);
    if (atMatch) return atMatch[1].toLowerCase();

    const firstLine = (text.split("\n")[0] || "").trim();
    if (isValidIgHandle(firstLine) && !firstLine.includes(" ")) {
      return firstLine.toLowerCase();
    }
    return null;
  }

  function looksUnread(row, lines) {
    if (Array.isArray(lines) && lines.some((l) => /^unread$/i.test(l))) {
      return true;
    }
    const aria = (row.getAttribute("aria-label") || "").toLowerCase();
    if (aria.includes("unread")) return true;
    if (row.querySelector('[aria-label*="Unread" i], [aria-label*="unread" i]')) return true;

    const inThreadList = Boolean(row.closest('[aria-label="Thread list"]'));
    const spans = row.querySelectorAll("span, div");
    for (const sp of spans) {
      if (sp.children && sp.children.length === 0) {
        try {
          const cs = window.getComputedStyle(sp);
          if (
            (cs.backgroundColor === "rgb(0, 149, 246)" || cs.backgroundColor === "rgb(0, 100, 224)") &&
            parseFloat(cs.width) <= 14 &&
            parseFloat(cs.height) <= 14
          ) {
            return true;
          }
        } catch (_) {}
      }
      if (inThreadList || !sp.textContent || !sp.textContent.trim()) continue;
      if (sp.style && (sp.style.fontWeight === "600" || sp.style.fontWeight === "700")) {
        return true;
      }
      try {
        const fw = Number(window.getComputedStyle(sp).fontWeight);
        if (fw >= 600 && sp.closest('[role="listitem"], [role="row"], [role="button"], a[href*="/direct/t/"]')) {
          return true;
        }
      } catch (_) {}
    }
    return false;
  }

  function buildPreviewText(lines) {
    const meaningful = lines.slice(1).filter((l) => {
      if (!l || l === "·" || l === "•") return false;
      if (/^unread$/i.test(l)) return false;
      if (/^\d+\s*[smhdwy]$/i.test(l) || /^just now$/i.test(l)) return false;
      return true;
    });
    if (meaningful.length > 0) {
      return meaningful.slice(0, 2).join(" · ").slice(0, 300);
    }
    return "Sent a message on Instagram";
  }

  async function scanVisibleThreads(forceReport = false) {
    if (isLoginOrChallenge()) {
      if (forceReport || lastReportedState !== "needs_login") {
        lastReportedState = "needs_login";
        invokeReport("needs_login", []);
      }
      return;
    }

    if (isAuthTransitionPage()) {
      // Wait for user/IG to finish "Save login info?" (onetap) or consent without
      // interrupting cookies or falsely marking connected yet.
      if (forceReport || lastReportedState !== "starting") {
        lastReportedState = "starting";
        invokeReport("starting", []);
      }
      return;
    }

    const path = (window.location.pathname || "").toLowerCase();
    if (!path.startsWith("/direct")) {
      if (forceReport || lastReportedState !== "starting") {
        lastReportedState = "starting";
        invokeReport("starting", []);
      }
      // Only navigate from feed/home to DM inbox once the signed-in nav shell is present
      if (!redirectedToInbox && document.querySelector('a[href*="/direct/"]')) {
        redirectedToInbox = true;
        setTimeout(() => {
          if (!isLoginOrChallenge() && !isAuthTransitionPage()) {
            window.location.href = "https://www.instagram.com/direct/inbox/";
          }
        }, 600);
      }
      return;
    }

    if (!hasLoggedInInboxDom()) {
      return;
    }

    const candidates = document.querySelectorAll(
      '[aria-label="Thread list"] [role="button"], [role="listitem"], [role="row"], [role="list"] [role="button"], a[href*="/direct/t/"]'
    );
    const seenContainers = new Set();
    const events = [];
    const unreadLabels = [];
    let cachedRelayRecs = null;
    let unreadRowCount = 0;

    for (const el of candidates) {
      const container = el.closest('[role="listitem"], [role="row"]') || el;
      if (!container || seenContainers.has(container)) continue;
      seenContainers.add(container);

      const text = (container.innerText || "").trim();
      if (!text) continue;
      const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
      if (lines.length < 2) continue;
      if (!looksUnread(container, lines)) continue;
      unreadRowCount += 1;

      const relayInfo = resolveRelayThreadInfo(container, cachedRelayRecs);
      if (relayInfo.recs && !cachedRelayRecs) cachedRelayRecs = relayInfo.recs;

      const handle = extractHandleFromElement(container, relayInfo.handle);
      const displayName = lines[0] || relayInfo.displayName || null;
      if (!handle && !displayName) continue;

      if (unreadLabels.length < 4) {
        unreadLabels.push(handle ? `@${handle}` : displayName);
      }

      const previewText = buildPreviewText(lines);
      const linkEl = container.querySelector('a[href*="/direct/t/"]') || (container.tagName === "A" ? container : null);
      const href = linkEl ? linkEl.getAttribute("href") : null;
      const threadUrl =
        relayInfo.threadUrl ||
        (href && href.startsWith("/") ? "https://www.instagram.com" + href : window.location.href);

      const sig = `${handle || displayName}:${threadUrl}:${previewText}`;
      if (!forceReport && sentSignatures.has(sig)) continue;
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

    if (forceReport || lastReportedState !== "watching" || events.length > 0) {
      lastReportedState = "watching";
      const labelSuffix = unreadLabels.length > 0 ? ` (${unreadLabels.join(", ")})` : "";
      const summary = `List: ${seenContainers.size} rows · ${unreadRowCount} unread${labelSuffix}`;
      invokeReport("watching", events, summary);
    }
  }

  window.__mastIgScanNow = (forceReport) => {
    scanVisibleThreads(Boolean(forceReport));
  };

  // On-demand profile + active Story check executed inside the user's real
  // logged-in Instagram WebView session (same-origin, residential IP).
  window.__mastIgCheckProfile = async (requestId, rawHandle) => {
    const cleanHandle = String(rawHandle || "").replace(/^@+/, "").trim().toLowerCase();
    const sendResult = (payload) => {
      try {
        const internals = window.__TAURI_INTERNALS__;
        if (!internals || typeof internals.invoke !== "function") return;
        internals.invoke("report_ig_profile_check", { payload }).catch(() => {});
      } catch (_) {}
    };

    if (!cleanHandle) {
      sendResult({
        requestId,
        ok: false,
        handle: "",
        note: "Invalid Instagram handle.",
        needsLogin: false,
      });
      return;
    }

    if (isLoginOrChallengePage()) {
      sendResult({
        requestId,
        ok: false,
        handle: cleanHandle,
        note: "Connect your Instagram account once to check posts & stories live.",
        needsLogin: true,
      });
      return;
    }

    try {
      const headers = {
        "x-ig-app-id": "936619743392459",
        "x-requested-with": "XMLHttpRequest",
        Accept: "application/json, text/plain, */*",
      };
      const profileRes = await fetch(
        `https://www.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(cleanHandle)}`,
        { method: "GET", credentials: "include", headers }
      );

      if (profileRes.status === 401 || profileRes.status === 403) {
        sendResult({
          requestId,
          ok: false,
          handle: cleanHandle,
          note: "Instagram session expired — click Connect IG to sign back in.",
          needsLogin: true,
        });
        return;
      }

      if (!profileRes.ok) {
        sendResult({
          requestId,
          ok: false,
          handle: cleanHandle,
          note: profileRes.status === 404
            ? "Instagram account not found (handle may have changed)."
            : `Instagram returned status ${profileRes.status}. Try again shortly.`,
          needsLogin: false,
        });
        return;
      }

      const json = await profileRes.json();
      const user = json && json.data && json.data.user;
      if (!user || typeof user !== "object") {
        sendResult({
          requestId,
          ok: false,
          handle: cleanHandle,
          note: "Could not read profile data from Instagram.",
          needsLogin: false,
        });
        return;
      }

      const isPrivate = typeof user.is_private === "boolean" ? user.is_private : null;
      const followersCount =
        user.edge_followed_by && typeof user.edge_followed_by.count === "number"
          ? user.edge_followed_by.count
          : null;
      const timeline = user.edge_owner_to_timeline_media;
      const postsCount = timeline && typeof timeline.count === "number" ? timeline.count : null;
      const edges = timeline && Array.isArray(timeline.edges) ? timeline.edges : [];

      // Pick the newest timestamp across the top 6 posts so pinned posts don't fool it
      let newestTsSec = null;
      let newestCaption = null;
      for (const edge of edges.slice(0, 6)) {
        const ts = edge && edge.node && edge.node.taken_at_timestamp;
        if (typeof ts === "number" && Number.isFinite(ts) && (newestTsSec === null || ts > newestTsSec)) {
          newestTsSec = ts;
          const cap =
            edge.node.edge_media_to_caption &&
            Array.isArray(edge.node.edge_media_to_caption.edges) &&
            edge.node.edge_media_to_caption.edges[0] &&
            edge.node.edge_media_to_caption.edges[0].node &&
            edge.node.edge_media_to_caption.edges[0].node.text;
          newestCaption = typeof cap === "string" && cap.trim()
            ? cap.trim().replace(/\s+/g, " ").slice(0, 140)
            : null;
        }
      }

      const nowMs = Date.now();
      const lastPostAt = newestTsSec ? new Date(newestTsSec * 1000).toISOString() : null;
      const lastPostDaysAgo = newestTsSec
        ? Math.max(0, Math.floor((nowMs - newestTsSec * 1000) / 86400000))
        : null;

      // Live Story check via authenticated Reels media endpoint
      let hasActiveStory = null;
      if (typeof user.latest_reel_media === "number" && user.latest_reel_media > 0) {
        const ageSec = Math.floor(nowMs / 1000) - user.latest_reel_media;
        hasActiveStory = ageSec >= 0 && ageSec <= 86400;
      }

      if (hasActiveStory === null && user.id) {
        try {
          const reelRes = await fetch(
            `https://www.instagram.com/api/v1/feed/reels_media/?reel_ids=${encodeURIComponent(String(user.id))}`,
            { method: "GET", credentials: "include", headers }
          );
          if (reelRes.ok) {
            const reelJson = await reelRes.json();
            const reelsArr = Array.isArray(reelJson && reelJson.reels_media)
              ? reelJson.reels_media
              : [];
            const firstReel = reelsArr[0] || (reelJson && reelJson.reels && reelJson.reels[String(user.id)]);
            const items = firstReel && Array.isArray(firstReel.items) ? firstReel.items : [];
            hasActiveStory = items.length > 0;
          }
        } catch (_) {
          // Leave hasActiveStory null if story endpoint unavailable
        }
      }

      const bio =
        typeof user.biography === "string" && user.biography.trim()
          ? user.biography.trim().slice(0, 220)
          : null;

      sendResult({
        requestId,
        ok: true,
        handle: cleanHandle,
        lastPostDaysAgo,
        lastPostAt,
        lastPostCaption: newestCaption,
        hasActiveStory,
        followersCount,
        postsCount,
        isPrivate,
        bio,
        note: null,
        needsLogin: false,
      });
    } catch (err) {
      sendResult({
        requestId,
        ok: false,
        handle: cleanHandle,
        note: "Could not check Instagram right now — try again.",
        needsLogin: false,
      });
    }
  };

  function scheduleScan() {
    if (scanTimer) clearTimeout(scanTimer);
    scanTimer = setTimeout(() => scanVisibleThreads(false), 1200);
  }

  function startObserver() {
    if (document.body) {
      const observer = new MutationObserver(scheduleScan);
      observer.observe(document.body, { childList: true, subtree: true });
    }
    setTimeout(() => scanVisibleThreads(false), 2200);
    setTimeout(() => scanVisibleThreads(true), 6000);
    setInterval(() => scanVisibleThreads(false), 15000);
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
        .inner_size(920.0, 720.0)
        .resizable(true)
        .center()
        .visible(visible)
        .focused(visible)
        .transparent(false)
        .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")
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
        if let Some(dbg) = payload.debug.as_ref().map(|s| s.trim()).filter(|s| !s.is_empty()) {
            guard.last_debug = Some(dbg.to_string());
        }

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
    if cfg!(debug_assertions) {
        eprintln!(
            "[IG WATCHER REPORT] state={} events={} debug={:?}",
            status.state,
            sanitized_events.len(),
            status.last_debug
        );
        for ev in &sanitized_events {
            eprintln!(
                "  -> thread handle={:?} display={:?} url={:?}",
                ev.handle, ev.display_name, ev.thread_url
            );
        }
    }
    let _ = app.emit(
        "ig-watcher-update",
        IgWatcherUpdateEvent {
            status: status.clone(),
            events: sanitized_events,
        },
    );

    status
}

pub fn handle_ig_profile_check_report(
    watcher_state: &IgWatcherState,
    payload: IgProfileCheckPayload,
) {
    if let Ok(mut pending) = watcher_state.pending_profile_checks.lock() {
        if let Some(tx) = pending.remove(&payload.request_id) {
            let _ = tx.send(payload);
        }
    }
}

pub async fn run_ig_profile_check(
    app: &AppHandle,
    watcher_state: &IgWatcherState,
    raw_handle: String,
) -> IgProfileCheckPayload {
    let clean_handle = raw_handle
        .trim()
        .trim_start_matches('@')
        .to_lowercase();

    let empty_err = |note: &str, needs_login: bool| IgProfileCheckPayload {
        request_id: String::new(),
        ok: false,
        handle: clean_handle.clone(),
        last_post_days_ago: None,
        last_post_at: None,
        last_post_caption: None,
        has_active_story: None,
        followers_count: None,
        posts_count: None,
        is_private: None,
        bio: None,
        note: Some(note.to_string()),
        needs_login,
    };

    if clean_handle.is_empty()
        || clean_handle.len() > 64
        || !clean_handle
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_')
    {
        return empty_err("Invalid Instagram handle.", false);
    }

    // Ensure background IG watcher window exists if user previously connected IG
    let (is_connected, is_enabled) = watcher_state
        .inner
        .lock()
        .map(|g| (g.connected, g.enabled))
        .unwrap_or((false, false));

    if app.get_webview_window(IG_WATCHER_LABEL).is_none() {
        if is_connected || is_enabled {
            let _ = create_or_show_watcher(app, watcher_state, false, false);
            // Give the background webview a brief moment to boot instagram.com
            let _ = tauri::async_runtime::spawn_blocking(|| {
                std::thread::sleep(Duration::from_millis(2200));
            })
            .await;
        } else {
            return empty_err(
                "Connect Instagram once to check last post & live stories.",
                true,
            );
        }
    }

    let Some(win) = app.get_webview_window(IG_WATCHER_LABEL) else {
        return empty_err(
            "Connect Instagram once to check last post & live stories.",
            true,
        );
    };

    let request_id = format!("igchk_{}_{}", now_epoch_ms(), clean_handle);
    let (tx, rx) = mpsc::channel::<IgProfileCheckPayload>();

    if let Ok(mut pending) = watcher_state.pending_profile_checks.lock() {
        pending.insert(request_id.clone(), tx);
    }

    let req_json = serde_json::to_string(&request_id).unwrap_or_else(|_| "\"\"".to_string());
    let handle_json = serde_json::to_string(&clean_handle).unwrap_or_else(|_| "\"\"".to_string());
    let js = format!(
        "if (typeof window.__mastIgCheckProfile === 'function') {{ window.__mastIgCheckProfile({}, {}); }} else {{ try {{ window.__TAURI_INTERNALS__.invoke('report_ig_profile_check', {{ payload: {{ requestId: {}, ok: false, handle: {}, note: 'Instagram session still loading — try clicking Check IG again in 2 seconds.', needsLogin: false }} }}); }} catch (_) {{}} }}",
        req_json, handle_json, req_json, handle_json
    );

    if win.eval(&js).is_err() {
        if let Ok(mut pending) = watcher_state.pending_profile_checks.lock() {
            pending.remove(&request_id);
        }
        return empty_err("Could not reach Instagram session — try again.", false);
    }

    let received = tauri::async_runtime::spawn_blocking(move || {
        rx.recv_timeout(Duration::from_secs(10))
    })
    .await;

    if let Ok(mut pending) = watcher_state.pending_profile_checks.lock() {
        pending.remove(&request_id);
    }

    match received {
        Ok(Ok(payload)) => payload,
        _ => empty_err(
            "Instagram check timed out — make sure Instagram is connected and try again.",
            !is_connected,
        ),
    }
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
