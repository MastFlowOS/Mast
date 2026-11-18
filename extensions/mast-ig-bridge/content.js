/* global chrome */
/**
 * MAST IG Reply Bridge — Passive Content Script
 *
 * Strictly read-only: observes visible thread items inside
 * https://www.instagram.com/direct/* while the user has IG open normally.
 * Never clicks buttons, never sends messages, never touches credentials.
 */
(() => {
  const sentSignatures = new Set();
  let scanTimer = null;

  function extractHandleFromElement(row) {
    const links = row.querySelectorAll('a[href*="/direct/t/"], a[href^="/"]');
    for (const a of links) {
      const href = a.getAttribute("href") || "";
      if (href.startsWith("/") && !href.startsWith("/direct") && !href.startsWith("/explore")) {
        const seg = href.replace(/^\/+/, "").split("/")[0];
        if (/^[A-Za-z0-9_][A-Za-z0-9_.]{1,29}$/.test(seg)) {
          return seg.toLowerCase();
        }
      }
    }

    const text = (row.innerText || "").trim();
    const atMatch = text.match(/@([A-Za-z0-9_][A-Za-z0-9_.]{1,29})/);
    if (atMatch) return atMatch[1].toLowerCase();

    // Fallback: first short handle-like line in thread row
    const firstLine = text.split("\n")[0]?.trim() || "";
    if (/^[A-Za-z0-9_][A-Za-z0-9_.]{1,29}$/.test(firstLine)) {
      return firstLine.toLowerCase();
    }
    return null;
  }

  function looksUnread(row) {
    const aria = (row.getAttribute("aria-label") || "").toLowerCase();
    if (aria.includes("unread")) return true;
    if (row.querySelector('[aria-label*="Unread" i], [aria-label*="unread" i]')) return true;
    const boldSpan = row.querySelector('span[style*="font-weight: 600"], span[style*="font-weight: 700"]');
    return Boolean(boldSpan);
  }

  function scanVisibleThreads() {
    const rows = document.querySelectorAll('[role="listitem"], [role="row"], a[href*="/direct/t/"]');
    const events = [];

    for (const el of rows) {
      const container = el.closest('[role="listitem"], [role="row"]') || el;
      if (!looksUnread(container)) continue;

      const handle = extractHandleFromElement(container);
      if (!handle) continue;

      const lines = (container.innerText || "")
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean);
      const previewText = lines.slice(1, 3).join(" · ").slice(0, 300) || null;
      const linkEl = container.querySelector('a[href*="/direct/t/"]') || (container.tagName === "A" ? container : null);
      const href = linkEl?.getAttribute("href");
      const threadUrl = href ? `https://www.instagram.com${href}` : window.location.href;

      const sig = `${handle}:${previewText || "unread"}`;
      if (sentSignatures.has(sig)) continue;
      sentSignatures.add(sig);

      events.push({
        handle,
        previewText,
        threadUrl,
        unread: true,
        observedAt: new Date().toISOString(),
      });
    }

    if (events.length > 0) {
      chrome.runtime.sendMessage({ type: "MAST_IG_SYNC_EVENTS", events });
    }
  }

  function scheduleScan() {
    if (scanTimer) clearTimeout(scanTimer);
    scanTimer = setTimeout(scanVisibleThreads, 1500);
  }

  const observer = new MutationObserver(scheduleScan);
  observer.observe(document.body, { childList: true, subtree: true });
  setTimeout(scanVisibleThreads, 2500);
})();
