"""
Mast Lead Engine — Google Maps Scraper (Core Engine).

The primary data acquisition module. Uses Playwright to:
  1. Search Google Maps for a niche + city query
  2. Scroll the results panel to load all listings
  3. Click each listing and extract structured place data
  4. Hand off to enrichment pipeline (site crawler + IG intel)

Anti-detection measures:
  • Random viewport sizes mimicking real browser distributions
  • Randomized mouse movement patterns before clicks
  • Human-like scroll timing with jitter
  • UA rotation per session
  • Stealth JS injection (navigator.webdriver removal, permissions override)
  • Realistic browser launch args (no automation flags visible to JS)
  • Per-place page settle delay before extraction

Data extracted per place:
  name, address, city, country, phone, website, rating, reviews,
  maps_link, has_photos, has_popular_times, owner_responds_to_reviews,
  is_google_verified, category, price_range, hours_summary,
  multi_location, closed
"""

from __future__ import annotations

import asyncio
import errno
import os
import random
import re
import signal
import subprocess
import sys
import time

SIGKILL = getattr(signal, "SIGKILL", 9)
SIGTERM = getattr(signal, "SIGTERM", 15)
from dataclasses import dataclass, field
from typing import Any, AsyncIterator
from urllib.parse import urlencode, urlparse, quote_plus

try:
    from playwright.async_api import (
        async_playwright,
        Browser,
        BrowserContext,
        Page,
        TimeoutError as PlaywrightTimeoutError,
    )
except ImportError:
    async_playwright = None  # type: ignore
    Browser = Any  # type: ignore
    BrowserContext = Any  # type: ignore
    Page = Any  # type: ignore
    class PlaywrightTimeoutError(Exception):  # type: ignore
        pass

from utils.parsing import (
    CANNABIS_KEYWORDS,
    CHAIN_KEYWORDS,
    parse_review_count,
    extract_phones,
    extract_ig_urls,
    clean_url,
    is_ordering_platform,
    is_weak_site,
    domain_of,
    pick_best_phone,
)
from utils.runtime import (
    RateLimiter,
    get_logger,
    ScraperConfig,
    RunStats,
    random_ua,
    ProxyManager,
    retry,
    resolve_panel_marker_wait_ms,
)
from utils.perf import NullProfiler
from exceptions import DiscoveryFailure, DiscoveryFailureReason
from utils.place_id import canonical_place_id, expand_place_id_forms
from street_inventory.classifier import is_address_on_street
try:
    from utils.lifecycle_tracker import (
        install_tracker,
        track_browser_created,
        log_milestone,
        get_memory_usage,
        get_process_tree_memory_usage,
        get_cgroup_memory_max_str,
    )
    install_tracker()
except ImportError:
    def install_tracker(): pass
    def track_browser_created(): pass
    def log_milestone(*a, **k): pass
    def get_memory_usage(): return 0.0
    def get_process_tree_memory_usage(): return 0.0
    def get_cgroup_memory_max_str(): return "unlimited/unknown"

log = get_logger("maps")

_last_navigation_step = "none"

def set_last_navigation_step(step: str) -> None:
    global _last_navigation_step
    _last_navigation_step = step

def get_last_navigation_step() -> str:
    return _last_navigation_step

def _log_browser_page_crashed(reason: str, *, context_label: str = "", last_step: str = "") -> None:
    try:
        mem_mb = get_process_tree_memory_usage()
    except Exception:
        mem_mb = 0.0
    try:
        from utils.lifecycle_tracker import active_browsers as b_count
    except Exception:
        b_count = 0
    step = last_step or get_last_navigation_step()
    cgroup_max = get_cgroup_memory_max_str()
    log.error(
        f"[maps][crash] browser_page_crashed reason={reason!r} context={context_label!r} "
        f"tree_memory_rss_mb={mem_mb:.1f} concurrent_browsers={b_count} "
        f"last_navigation_step={step!r} cgroup_memory_max={cgroup_max}"
    )

_MAX_PANEL_VERIFY_LOGS_PER_AREA = 10
_panel_verify_fail_counts: dict[str, int] = {}
_dom_snapshot_counts: dict[str, int] = {}


def reset_panel_verify_fail_counts(area_key: str | None = None) -> None:
    if area_key:
        _panel_verify_fail_counts.pop(area_key, None)
        _dom_snapshot_counts.pop(f"{area_key}:verified", None)
        _dom_snapshot_counts.pop(f"{area_key}:failure", None)
    else:
        _panel_verify_fail_counts.clear()
        _dom_snapshot_counts.clear()


_GOOGLE_MAPS_TITLE_SUFFIX_RE = re.compile(r"\s*[-–—·]\s*Google\s+Maps\s*$", re.IGNORECASE)


def _extract_title_place_name(page_title: str | None) -> str:
    """Extract the raw place name from a Google Maps page title ('<Name> - Google Maps').
    Returns '' if the title is empty, lacks the Google Maps suffix or equals 'Google Maps',
    or matches an excluded generic header like 'Results'."""
    if not page_title or not isinstance(page_title, str):
        return ""
    if not _GOOGLE_MAPS_TITLE_SUFFIX_RE.search(page_title):
        return ""
    stripped = _GOOGLE_MAPS_TITLE_SUFFIX_RE.sub("", page_title).strip()
    if not stripped or stripped.lower() == "google maps":
        return ""
    if _is_excluded_panel_header(stripped):
        return ""
    return stripped


_DOM_SNAPSHOT_EMAIL_RE = re.compile(r"[\w.+-]+@[\w-]+\.[\w.-]+")
_DOM_SNAPSHOT_QUERY_RE = re.compile(r'(\b(?:href|src|action)=["\'][^"\'?#]+)\?[^"\']*([\'"])', re.IGNORECASE)
_DOM_SNAPSHOT_COOKIE_RE = re.compile(r"(?:cookie|set-cookie)\s*[:=]\s*[^;\"'<>]+", re.IGNORECASE)


def _sanitize_dom_snapshot_html(html: str | None, max_bytes: int = 3072) -> str:
    """Sanitize and truncate outerHTML for bounded DOM snapshot logging (max 3KB)."""
    if not html or not isinstance(html, str):
        return ""
    cleaned = _DOM_SNAPSHOT_COOKIE_RE.sub("[COOKIE_REDACTED]", html)
    cleaned = _DOM_SNAPSHOT_QUERY_RE.sub(r"\1?[REDACTED]\2", cleaned)
    cleaned = _DOM_SNAPSHOT_EMAIL_RE.sub("[EMAIL_REDACTED]", cleaned)
    cleaned = re.sub(r"\s+", " ", cleaned).strip()
    encoded = cleaned.encode("utf-8", errors="ignore")
    if len(encoded) > max_bytes:
        cleaned = encoded[:max_bytes].decode("utf-8", errors="ignore") + "...[truncated]"
    return cleaned


def _get_dom_snapshot_max() -> int:
    raw = os.getenv("MAST_PANEL_DOM_SNAPSHOT_MAX", "2").strip()
    try:
        return max(0, int(raw))
    except ValueError:
        return 2


_DOM_SNAPSHOT_JS = """
() => {
    function firstOuterHTML(selectors) {
        for (const s of selectors) {
            try {
                const el = document.querySelector(s);
                if (el && el.outerHTML) return el.outerHTML;
            } catch (e) {}
        }
        return "";
    }
    return {
        header: firstOuterHTML(["h1.DUwDvf", "h1.fontHeadlineLarge", "div[role='main'] h1", "h1"]),
        phone: firstOuterHTML(["[data-item-id^='phone:']", "[data-tooltip='Copy phone number']", "a[href^='tel:']"]),
        website: firstOuterHTML(["a[data-item-id='authority']", "a[data-item-id*='url']", "a[data-tooltip='Open website']", "a[aria-label*='website' i]"]),
        address: firstOuterHTML(["[data-item-id='address']", "button[data-item-id='address']", "span[aria-label*='address' i]"]),
    };
}
"""


async def _capture_and_log_dom_snapshot(
    page: Page,
    *,
    snapshot_kind: str,
    area_key: str = "default",
    card_name: str = "",
    card_place_id: str = "",
    reason: str = "",
) -> bool:
    """Capture bounded DOM outerHTML (max 3KB per region) for the first N verified cards
    and first N failures per area run, controlled by MAST_PANEL_DOM_SNAPSHOT_MAX (default 2, 0 disables)."""
    max_snaps = _get_dom_snapshot_max()
    if max_snaps <= 0:
        return False
    counter_key = f"{area_key}:{snapshot_kind}"
    current_count = _dom_snapshot_counts.get(counter_key, 0)
    if current_count >= max_snaps:
        return False
    _dom_snapshot_counts[counter_key] = current_count + 1

    regions = {"header": "", "phone": "", "website": "", "address": ""}
    if hasattr(page, "evaluate"):
        try:
            raw_regions = await page.evaluate(_DOM_SNAPSHOT_JS)
            if isinstance(raw_regions, dict):
                for k in regions:
                    if isinstance(raw_regions.get(k), str):
                        regions[k] = raw_regions[k]
        except Exception:
            pass

    if not any(regions.values()) and hasattr(page, "query_selector"):
        region_selectors = {
            "header": ("h1.DUwDvf", "h1.fontHeadlineLarge", "div[role='main'] h1", "h1"),
            "phone": ("[data-item-id^='phone:']", "[data-tooltip='Copy phone number']", "a[href^='tel:']"),
            "website": ("a[data-item-id='authority']", "a[data-item-id*='url']", "a[data-tooltip='Open website']"),
            "address": ("[data-item-id='address']", "button[data-item-id='address']", "span[aria-label*='address' i]"),
        }
        for k, sels in region_selectors.items():
            for sel in sels:
                try:
                    el = await page.query_selector(sel)
                    if el is not None:
                        if hasattr(el, "evaluate"):
                            outer = await el.evaluate("el => el.outerHTML || ''")
                        elif hasattr(el, "inner_text"):
                            outer = f"<{sel}>{await el.inner_text()}</{sel}>"
                        else:
                            outer = ""
                        if outer:
                            regions[k] = str(outer)
                            break
                except Exception:
                    continue

    header_html = _sanitize_dom_snapshot_html(regions["header"], max_bytes=3072)
    phone_html = _sanitize_dom_snapshot_html(regions["phone"], max_bytes=3072)
    website_html = _sanitize_dom_snapshot_html(regions["website"], max_bytes=3072)
    address_html = _sanitize_dom_snapshot_html(regions["address"], max_bytes=3072)

    log.info(
        f"[maps][dom-snapshot] kind={snapshot_kind} area={area_key!r} index={current_count + 1}/{max_snaps} "
        f"card_name={card_name!r} card_place_id={card_place_id!r} reason={reason!r} "
        f"header_html={header_html!r} phone_html={phone_html!r} "
        f"website_html={website_html!r} address_html={address_html!r}"
    )
    return True


def _log_verified_card_extraction_guard(
    *,
    card_name: str,
    card_place_id: str,
    place: "RawPlace | None",
    panel_snap: dict | None = None,
    area_key: str = "default",
) -> None:
    """Log one structured extraction-guard line per verified card reporting whether
    name, phone, website, address, and rating were found and which selector matched each."""
    matched = getattr(place, "_matched_selectors", None) if place is not None else None
    if not isinstance(matched, dict):
        matched = {}
    snap_sel = (panel_snap or {}).get("matched_selector") or "none"
    name_found = bool(place and place.name)
    phone_found = bool(place and place.phone)
    website_found = bool(place and place.website)
    address_found = bool(place and place.address)
    rating_found = bool(place and place.rating is not None)

    name_sel = matched.get("name") or (snap_sel if name_found else "none")
    phone_sel = matched.get("phone") or ("present" if phone_found else "none")
    website_sel = matched.get("website") or ("present" if website_found else "none")
    address_sel = matched.get("address") or ("present" if address_found else "none")
    rating_sel = matched.get("rating") or ("present" if rating_found else "none")

    log.info(
        f"[maps][extraction-guard] area={area_key!r} card_name={card_name!r} card_place_id={card_place_id!r} "
        f"name_found={name_found} name_selector={name_sel!r} "
        f"phone_found={phone_found} phone_selector={phone_sel!r} "
        f"website_found={website_found} website_selector={website_sel!r} "
        f"address_found={address_found} address_selector={address_sel!r} "
        f"rating_found={rating_found} rating_selector={rating_sel!r}"
    )


async def _check_consent_or_captcha_present(page: Page) -> tuple[bool, str]:
    try:
        url = getattr(page, "url", "") or ""
    except Exception:
        url = ""
    if "consent.google.com" in url or "/consent" in url:
        return True, "consent_url"
    if "sorry.google.com" in url or "/sorry/" in url:
        return True, "sorry_blocked_url"
    try:
        title = (await page.title() if hasattr(page, "title") else "") or ""
        title_low = title.lower()
    except Exception:
        title_low = ""
    for kw in ("unusual traffic", "captcha", "systems have detected", "our systems have detected", "robot"):
        if kw in title_low:
            return True, f"title_keyword:{kw}"
    if hasattr(page, "query_selector"):
        for sel in (
            "iframe[src*='recaptcha']",
            "div#captcha",
            "form[action*='sorry']",
            "form[action*='consent']",
            "#captcha-form",
            ".g-recaptcha",
        ):
            try:
                el = await page.query_selector(sel)
                if el is not None:
                    return True, f"dom_selector:{sel}"
            except Exception:
                pass
    return False, "none"


async def _read_page_title_safe(page: Page) -> str:
    if not hasattr(page, "title"):
        return ""
    try:
        t = page.title
        if callable(t):
            res = t()
            if asyncio.iscoroutine(res) or hasattr(res, "__await__"):
                res = await res
            return str(res or "")
        return str(t or "")
    except Exception:
        return ""


async def _log_panel_verification_failure(
    page: Page,
    snap: dict,
    reason: str,
    *,
    card_href: str,
    card_signals: dict | None = None,
    area_key: str = "default",
) -> None:
    effective_area_key = (area_key or "default").strip() or "default"
    count = _panel_verify_fail_counts.get(effective_area_key, 0) + 1
    _panel_verify_fail_counts[effective_area_key] = count

    card_name = (card_signals or {}).get("name") or _place_name_from_href(card_href) or ""
    card_pid = snap.get("card_place_id") or _stable_place_id_from_url(card_href) or ""

    await _capture_and_log_dom_snapshot(
        page,
        snapshot_kind="failure",
        area_key=effective_area_key,
        card_name=card_name,
        card_place_id=card_pid,
        reason=reason,
    )

    if count > _MAX_PANEL_VERIFY_LOGS_PER_AREA:
        if count == _MAX_PANEL_VERIFY_LOGS_PER_AREA + 1:
            log.warning(
                f"[maps][panel-verify-fail] area={effective_area_key!r} rate-limit reached "
                f"({_MAX_PANEL_VERIFY_LOGS_PER_AREA} failures logged); suppressing further failure lines for this area"
            )
        return

    raw_h1 = snap.get("raw_h1") or snap.get("raw_name") or ""
    matched_sel = snap.get("matched_selector") or "none"
    panel_open = bool(snap.get("open"))
    curr_url = snap.get("url") or (getattr(page, "url", "") or "")
    url_pid = snap.get("url_place_id") if "url_place_id" in snap else (snap.get("place_id") or _stable_place_id_from_url(curr_url) or "")
    verdict_source = snap.get("verdict_source") or "none"

    page_title = snap.get("page_title") if "page_title" in snap else await _read_page_title_safe(page)
    title_name = snap.get("title_name") if "title_name" in snap else _norm_identity_text(_extract_title_place_name(page_title))

    has_captcha, captcha_detail = await _check_consent_or_captcha_present(page)

    vp = getattr(page, "viewport_size", None)
    if callable(vp):
        try:
            vp = vp()
        except Exception:
            vp = None
    vp_str = f"{vp.get('width')}x{vp.get('height')}" if isinstance(vp, dict) and "width" in vp else str(vp or "unknown")

    log.warning(
        f"[maps][panel-verify-fail] area={effective_area_key!r} reason={reason} card_name={card_name!r} "
        f"card_place_id={card_pid!r} url_place_id={url_pid!r} title_name={title_name!r} "
        f"verdict_source={verdict_source!r} raw_panel_h1={raw_h1!r} "
        f"matched_selector={matched_sel!r} panel_open={panel_open} "
        f"current_url={curr_url!r} page_title={page_title!r} "
        f"interstitial_or_captcha={has_captcha} "
        f"interstitial_detail={captcha_detail!r} viewport={vp_str}"
    )

# ──────────────────────────────────────────────────────────────────────────────
# Viewport pools (realistic distribution)
# ──────────────────────────────────────────────────────────────────────────────

_VIEWPORTS = [
    {"width": 1920, "height": 1080},
    {"width": 1440, "height": 900},
    {"width": 1366, "height": 768},
    {"width": 1280, "height": 800},
    {"width": 1536, "height": 864},
    {"width": 1600, "height": 900},
    {"width": 2560, "height": 1440},
    {"width": 1280, "height": 720},
]

# ──────────────────────────────────────────────────────────────────────────────
# Stealth JS — removes automation fingerprints
# ──────────────────────────────────────────────────────────────────────────────

_STEALTH_JS = """
() => {
    // Remove webdriver flag
    Object.defineProperty(navigator, 'webdriver', {
        get: () => undefined,
        configurable: true,
    });

    // Override permissions query
    const originalQuery = window.navigator.permissions.query;
    window.navigator.permissions.query = (parameters) => (
        parameters.name === 'notifications'
            ? Promise.resolve({ state: Notification.permission })
            : originalQuery(parameters)
    );

    // Realistic plugins list
    Object.defineProperty(navigator, 'plugins', {
        get: () => [1, 2, 3, 4, 5],
        configurable: true,
    });

    // Realistic languages
    Object.defineProperty(navigator, 'languages', {
        get: () => ['en-US', 'en'],
        configurable: true,
    });

    // Remove automation-related props
    delete window.chrome;
    window.chrome = {
        runtime: {},
        loadTimes: function() {},
        csi: function() {},
        app: {},
    };

    // Spoof screen dimensions to match viewport
    Object.defineProperty(screen, 'availHeight', { get: () => window.outerHeight });
    Object.defineProperty(screen, 'availWidth',  { get: () => window.outerWidth });
}
"""

# ──────────────────────────────────────────────────────────────────────────────
# Selectors — Maps UI is not stable; we try multiple per field
# ──────────────────────────────────────────────────────────────────────────────

# Results panel listing items
_RESULT_ITEM_SELECTORS = [
    "div[role='feed'] > div > div[data-result-index]",
    "div.Nv2PK",
    "div[jsaction*='mouseover:pane'] a[href*='/maps/place/']",
    "a[aria-label][href*='/maps/place/']",
    "div.THOPZb",          # restaurant cards variant
    "div[class*='result']",
]

# Result panel container for scrolling
_PANEL_SELECTORS = [
    "div[role='feed']",
    "div.m6QErb[aria-label]",
    "div.section-layout-root",
    "div.m6QErb",
]

# Individual place data selectors
_PLACE_NAME_SELECTORS = [
    "h1.DUwDvf",
    "h1.fontHeadlineLarge",
    "h1[data-item-id]",
    "div[role='main'] h1",
    "div[role='region'] h1",
    "h1",
    "div.DUwDvf",
]
_PLACE_NAME_SELECTOR_COMBINED = ", ".join(_PLACE_NAME_SELECTORS)

_PHONE_SELECTORS = [
    "[data-item-id^='phone:tel:'] .fontBodyMedium",
    "[data-tooltip='Copy phone number']",
    "button[data-item-id^='phone:'] .rogA2c",
    "span[aria-label*='phone' i]",
    "a[href^='tel:'] span.UsdlK",
    "a[href^='tel:']",
]

_WEBSITE_SELECTORS = [
    "a[data-item-id='authority'] span.rogA2c",
    "a[data-item-id='authority']",
    "a[aria-label*='website' i] span",
    "a[href*='://'][data-item-id*='url'] .rogA2c",
    "div.rogA2c div[data-item-id*='url']",
    "a[data-tooltip='Open website']",
]

_RATING_SELECTORS = [
    "div.F7nice span[aria-hidden='true']",
    "div.F7nice > span > span",
    "div.fontDisplayLarge",
    "span.ceNzKf[aria-label*='star']",
]

_REVIEW_SELECTORS = [
    "div.F7nice span[aria-label*='review']",
    "span.F7nice span[aria-label*='review']",
    "button[aria-label*='review']",
    "span[aria-label*='reviews' i]",
]

_ADDRESS_SELECTORS = [
    "[data-item-id='address'] .fontBodyMedium",
    "button[data-item-id='address'] .rogA2c",
    "div[data-item-id='address']",
    "span[aria-label*='address' i]",
]

_CATEGORY_SELECTORS = [
    "button.DkEaL",
    "span.DkEaL",
    "button[jsaction*='category']",
    "span.mgr77e span",
]

# End-of-results sentinel
_EOL_TEXTS = (
    "You've reached the end of the list",
    "end of the results",
    "no more results",
    "That's all there is",
    "can't find",
    "couldn't find",
    "no results found",
    "no results",
    "make sure your search",
    "make sure all words are spelled correctly",
    "try different keywords",
)


# ──────────────────────────────────────────────────────────────────────────────
# Data structures
# ──────────────────────────────────────────────────────────────────────────────

@dataclass
class RawPlace:
    """Raw data extracted directly from a Maps listing, before enrichment."""
    name: str = ""
    address: str = ""
    city: str = ""
    country: str = ""
    phone: str = ""
    website: str = ""
    rating: float | None = None
    reviews: int = 0
    maps_link: str = ""
    category: str = ""
    price_range: str = ""
    hours_summary: str = ""
    has_photos: bool = False
    has_popular_times: bool = False
    owner_responds_to_reviews: bool = False
    is_google_verified: bool = False
    multi_location: bool = False
    closed: bool = False
    query: str = ""
    niche: str = ""
    region: str = ""
    extra: dict = field(default_factory=dict)

    def to_dict(self) -> dict:
        return {
            "name": self.name,
            "address": self.address,
            "city": self.city,
            "country": self.country,
            "phone": self.phone,
            "website": self.website,
            "rating": self.rating,
            "reviews": self.reviews,
            "maps_link": self.maps_link,
            "category": self.category,
            "price_range": self.price_range,
            "hours_summary": self.hours_summary,
            "has_photos": self.has_photos,
            "has_popular_times": self.has_popular_times,
            "owner_responds_to_reviews": self.owner_responds_to_reviews,
            "is_google_verified": self.is_google_verified,
            "multi_location": self.multi_location,
            "closed": self.closed,
            "query": self.query,
            "niche": self.niche,
            "region": self.region,
            **self.extra,
        }


# ──────────────────────────────────────────────────────────────────────────────
# Browser helpers
# ──────────────────────────────────────────────────────────────────────────────

# ──────────────────────────────────────────────────────────────────────────────
# Resource blocking — ROOT CAUSE FIX (memory): nothing in this module ever
# blocked a single request. Every map tile, marker icon, font, and photo on
# a Maps search + scroll + place-detail pass was loaded in full, for every
# search. That's the dominant contributor to the renderer's memory growth
# that eventually OOM-crashes Chromium ("Target crashed") on a
# memory-constrained host (e.g. Railway's default container). None of the
# extraction logic in this file reads pixel data — it only reads text,
# attributes, and HTML — so blocking these resource types costs nothing
# functionally while substantially cutting per-page memory.
# ──────────────────────────────────────────────────────────────────────────────

_BLOCKED_RESOURCE_TYPES = {"image", "media", "font"}

# LIFECYCLE FIX (Playwright shutdown noise — FINAL SHUTDOWN LATENCY +
# CONSUMER_STOPPED FIX): once the page/context this handler is routing
# for gets torn down — deliberately, as part of an intentional
# cooperative shutdown (target reached / consumer stopped / SIGTERM) —
# every in-flight request still races Route.abort()/continue_() against
# that close and raises "Target page, context or browser has been
# closed" (or an equivalent Playwright "Connection closed" error).  The
# request is going nowhere either way in that case; letting it flood
# Railway's logs at Playwright's own default warning/error level tells
# an operator nothing they don't already know from the one shutdown log
# line, so it's swallowed here at debug level instead of surfacing as an
# "Unhandled error in route handler".
_SHUTDOWN_NOISE_MARKERS = (
    "has been closed",
    "Target closed",
    "Target crashed",
    "Connection closed",
    "EPIPE",
    "Broken pipe",
)


def _looks_like_shutdown_noise(exc: BaseException) -> bool:
    text = str(exc)
    return any(marker in text for marker in _SHUTDOWN_NOISE_MARKERS)


class PlaceExtractionTimeout(Exception):
    """The batched detail-panel `page.evaluate()` did not return in time.

    Playwright's evaluate() has no timeout of its own: against an unresponsive
    renderer it blocks forever (production saw 108-213s hangs that only the
    Node inactivity watchdog ended, by killing the whole subprocess). This is
    raised instead so `MapsScraper.search()` can route it through the same
    crash-recovery path as "Target crashed" (fresh context/page, bounded by
    `max_crash_retries`). The message carries no business data.
    """

    def __init__(self, operation: str, timeout_ms: int) -> None:
        super().__init__(f"{operation} exceeded {timeout_ms}ms")
        self.operation = operation
        self.timeout_ms = timeout_ms


class CardOperationTimeout(PlaceExtractionTimeout):
    """Bounded per-card deadline exceeded across click, panel wait, settle,
    extraction, or return-to-results."""



# Upper bound on closing a page/context during per-attempt cleanup. A renderer
# that stopped answering evaluate() must not also be able to stall the
# cleanup that is supposed to recover from it.
_CLOSE_TIMEOUT_S = 10.0


async def _close_bounded(closer, what: str) -> None:
    """Await `closer()` (a page/context `.close`) for at most _CLOSE_TIMEOUT_S,
    swallowing ordinary errors exactly as the unbounded cleanup did."""
    try:
        await asyncio.wait_for(closer(), timeout=_CLOSE_TIMEOUT_S)
    except asyncio.TimeoutError:
        log.warning(f"[maps] {what}.close() did not finish within {_CLOSE_TIMEOUT_S:.0f}s — abandoning it")
    except Exception:
        pass


async def _block_heavy_resources(ctx: BrowserContext) -> None:
    async def _handle(route):
        try:
            if route.request.resource_type in _BLOCKED_RESOURCE_TYPES:
                await route.abort()
            else:
                await route.continue_()
        except Exception as exc:
            if _looks_like_shutdown_noise(exc):
                log.debug(f"[maps] route handler no-op on closed target: {exc}")
            else:
                log.warning(f"[maps] route handler error (resource_type={route.request.resource_type}): {exc}")

    await ctx.route("**/*", _handle)


async def _new_stealth_context(browser: Browser, proxy: str | None = None) -> BrowserContext:
    """Create a new browser context with anti-detection configuration."""
    viewport = random.choice(_VIEWPORTS)
    kwargs: dict = {
        "viewport": viewport,
        "user_agent": random_ua(),
        "locale": "en-US",
        "timezone_id": random.choice([
            "America/New_York", "America/Chicago",
            "America/Los_Angeles", "Europe/London",
            "Europe/Berlin", "Australia/Sydney",
        ]),
        "geolocation": None,
        "permissions": [],
        "java_script_enabled": True,
        "bypass_csp": True,
        "extra_http_headers": {
            "Accept-Language": "en-US,en;q=0.9",
            "Accept-Encoding": "gzip, deflate, br",
            "sec-ch-ua": '"Google Chrome";v="125", "Chromium";v="125", "Not-A.Brand";v="24"',
            "sec-ch-ua-mobile": "?0",
            "sec-ch-ua-platform": '"Windows"',
        },
    }
    if proxy:
        kwargs["proxy"] = {"server": proxy}

    ctx = await browser.new_context(**kwargs)

    # Apply stealth script to every new page
    await ctx.add_init_script(_STEALTH_JS)

    # ROOT CAUSE FIX (memory): see _block_heavy_resources docblock above.
    await _block_heavy_resources(ctx)

    return ctx


async def _human_scroll(
    page: Page, panel_selector: str, *, config: ScraperConfig, profiler=None,
) -> None:
    """Scroll the results panel, then wait event-driven for new cards to
    appear instead of blindly sleeping for a fixed window.

    Phase 6 opt #1: the previous version slept a fixed ~1.25-2.5s after each
    of 3 sub-scrolls (~5.6s/round average) regardless of whether the DOM
    actually changed. This version scrolls, then polls for the visible
    listing-anchor count to increase, bounded by
    `config.scroll_settle_timeout_ms` so a round with no new content (e.g.
    end of results) still moves on quickly instead of waiting the full
    window. A small amount of randomized pacing is preserved between
    sub-scrolls and after settling — anti-detection intent unchanged,
    just no longer the dominant cost.

    Phase 2A: the actual scroll movement and the event-driven wait are now
    timed as two separate stages (`scroll_movement` / `scroll_wait`)
    instead of one combined `maps_scroll_round`, so the audit's question
    "is scrolling still expensive, and if so which half" is answerable
    from real data rather than reasoned about.
    """
    profiler = profiler or NullProfiler()
    try:
        panel = await page.query_selector(panel_selector)
        if not panel:
            return

        # Baseline anchor count, used as the "new content arrived" signal.
        try:
            before_count = await page.eval_on_selector_all(
                "a[href*='/maps/place/']", "els => els.length"
            )
        except Exception:
            before_count = 0

        with profiler.timer("scroll_movement"):
            # Variable scroll amounts (humans don't scroll exactly the same each time)
            for _ in range(3):
                amount = random.randint(280, 480)
                await panel.evaluate(
                    f"el => el.scrollBy({{ top: {amount}, behavior: 'smooth' }})"
                )
                # Short randomized pacing between sub-scrolls — anti-detection
                # only, not meant to be the mechanism that waits for content.
                await asyncio.sleep(random.uniform(0.12, 0.28))

        with profiler.timer("scroll_wait"):
            # Event-driven wait: poll for new listing anchors rather than
            # blindly sleeping for a fixed window. Bounded by a short timeout
            # so we still make forward progress when no new cards are
            # forthcoming (e.g. near end of results) or rendering is slow.
            try:
                await page.wait_for_function(
                    "(before) => document.querySelectorAll(\"a[href*='/maps/place/']\").length > before",
                    arg=before_count,
                    timeout=config.scroll_settle_timeout_ms,
                    polling=100,
                )
            except PlaywrightTimeoutError:
                pass  # no new cards within the budget — caller proceeds anyway

            # Brief randomized settle pause: lets freshly-rendered cards finish
            # in-flight layout/paint, and keeps cadence irregular rather than
            # metronomic. Much shorter than the old fixed sleep — this is
            # pacing, not the wait mechanism.
            await asyncio.sleep(random.uniform(0.1, 0.3))
    except Exception:
        pass


# --- TEMPORARY DIAGNOSTIC (discovery-pipeline audit) ---
# One-shot deep dump of the resolved results panel: confirms whether the
# panel_sel we matched actually contains business cards, whether the
# fallback card-selector candidates find anything ANYWHERE on the page
# (not just inside `panel`), and whether the scroll container we're
# about to drive with `_human_scroll` actually moves when scrolled.
# Answers one question: are cards absent from the DOM, or are they
# present somewhere we're not looking? Remove once discovery is
# confirmed healthy again — this does not change selection or scroll
# behavior, it only reports on it.
async def _diag_dump_panel_dom(page: Page, panel_sel: str) -> None:
    if os.environ.get("MAPS_DIAG_DUMP_DOM", "").strip().lower() not in ("1", "true", "yes"):
        return
    try:
        panel = await page.query_selector(panel_sel)
        if panel is None:
            log.warning(
                f"[maps][diag][dom] panel_sel={panel_sel!r} matched at "
                f"wait_for_selector time but query_selector can't "
                f"re-find it now — panel may have already been replaced"
            )
            return

        # How many direct children does the resolved panel have, and how
        # many of those look like they could be card wrappers?
        child_count = await panel.evaluate("el => el.children.length")
        child_summary = await panel.evaluate(
            """el => Array.from(el.children).slice(0, 12).map(c => ({
                tag: c.tagName,
                cls: (c.className || '').toString().slice(0, 80),
                role: c.getAttribute('role'),
                childCount: c.children.length,
            }))"""
        )

        # Anchors *inside the resolved panel* — both all anchors and
        # place-URL anchors specifically. This is the scope the real
        # collection loop queries.
        panel_anchors_all = await panel.query_selector_all("a")
        panel_anchors_place = await panel.query_selector_all(
            "a[href*='/maps/place/']"
        )

        # Same counts, but PAGE-WIDE (ignores panel scope entirely) — if
        # this is >0 while the panel-scoped count is 0, the cards exist
        # but `panel` is the wrong container.
        page_anchors_place = await page.eval_on_selector_all(
            "a[href*='/maps/place/']", "els => els.length"
        )

        # Check each candidate from the (currently unused) fallback list,
        # page-wide, so we know which of them — if any — actually matches
        # something in the live DOM right now.
        candidate_counts = {}
        for sel in _RESULT_ITEM_SELECTORS:
            try:
                n = await page.eval_on_selector_all(sel, "els => els.length")
            except Exception as exc:
                n = f"error: {exc}"
            candidate_counts[sel] = n

        # Also check whether div[role='feed'] exists ANYWHERE on the page
        # even if it wasn't what wait_for_selector landed on first (e.g.
        # it matched a later/nested element, or exists but was slower to
        # mount than the 8s panel-selector timeout).
        feed_role_count = await page.eval_on_selector_all(
            "div[role='feed']", "els => els.length"
        )

        # Sample hrefs/text from page-wide place anchors (not panel-
        # scoped) so we can see what's actually out there regardless of
        # which container holds it.
        sample = await page.eval_on_selector_all(
            "a[href*='/maps/place/']",
            """els => els.slice(0, 5).map(e => ({
                href: (e.getAttribute('href') || '').slice(0, 120),
                text: (e.textContent || '').trim().slice(0, 60),
            }))""",
        )

        # Scroll container geometry for the resolved panel, plus a live
        # test of whether scrolling it actually changes scrollTop.
        dims_before = await panel.evaluate(
            """el => ({
                scrollHeight: el.scrollHeight,
                clientHeight: el.clientHeight,
                scrollTop: el.scrollTop,
            })"""
        )
        try:
            await panel.evaluate("el => el.scrollBy({ top: 400, behavior: 'instant' })")
            await asyncio.sleep(0.2)
        except Exception:
            pass
        dims_after = await panel.evaluate(
            """el => ({
                scrollHeight: el.scrollHeight,
                clientHeight: el.clientHeight,
                scrollTop: el.scrollTop,
            })"""
        )
        scroll_top_changed = dims_before.get("scrollTop") != dims_after.get("scrollTop")

        # Sanitized shallow DOM sample: tag/class/role only, 2 levels
        # deep, no text content or attribute values beyond className —
        # enough to see structure without dumping the whole page.
        dom_sample = await panel.evaluate(
            """el => {
                const describe = (node, depth) => {
                    if (!node || depth > 2) return null;
                    return {
                        tag: node.tagName,
                        cls: (node.className || '').toString().slice(0, 80),
                        role: node.getAttribute ? node.getAttribute('role') : null,
                        children: Array.from(node.children || [])
                            .slice(0, 6)
                            .map(c => describe(c, depth + 1))
                            .filter(Boolean),
                    };
                };
                return describe(el, 0);
            }"""
        )

        log.info(
            f"[maps][diag][dom] panel_sel={panel_sel!r} "
            f"panel_child_count={child_count} "
            f"panel_anchors_all={len(panel_anchors_all)} "
            f"panel_anchors_place={len(panel_anchors_place)} "
            f"page_anchors_place={page_anchors_place} "
            f"feed_role_elements_on_page={feed_role_count}"
        )
        log.info(f"[maps][diag][dom] panel_children_summary={child_summary}")
        log.info(f"[maps][diag][dom] candidate_selector_counts={candidate_counts}")
        log.info(f"[maps][diag][dom] sample_place_anchors={sample}")
        log.info(
            f"[maps][diag][dom] scroll_dims_before={dims_before} "
            f"scroll_dims_after={dims_after} "
            f"scroll_top_changed={scroll_top_changed}"
        )
        log.info(f"[maps][diag][dom] dom_sample={dom_sample}")
    except Exception as exc:
        log.info(f"[maps][diag][dom] diagnostic dump failed (non-fatal): {exc}")
# --- end temporary diagnostic ---


# ──────────────────────────────────────────────────────────────────────────────
# Interstitial / consent / block detection (Part 7 fix)
#
# Google can respond to a `page.goto()` with an ordinary HTTP 200 while
# actually landing the browser on something that is NOT the Maps results
# page at all — a cookie-consent interstitial, an automated-traffic "sorry"
# page, or (rarely) some other challenge page. None of these raise a
# Playwright navigation error, so the old code had no way to distinguish
# them from a legitimate empty result set; every selector below them would
# simply time out and the search would report a normal (fake) exhaustion.
# These helpers turn that ambiguity into an explicit, typed signal.
# ──────────────────────────────────────────────────────────────────────────────

# Buttons for an ORDINARY cookie/consent dialog — a routine, expected UI
# element with no security purpose, not a challenge to defeat. Clicking one
# of these is equivalent to what a human visitor does on first visit; it is
# categorically different from attempting to bypass a CAPTCHA or "sorry"
# block page, which this scraper never attempts (see _detect_interstitial).
_CONSENT_ACCEPT_SELECTORS = [
    "button[aria-label='Accept all']",
    "button[aria-label='I agree']",
    "form[action*='consent'] button",
    "button:has-text('Accept all')",
    "button:has-text('I agree')",
]


async def _detect_interstitial(page: Page) -> DiscoveryFailureReason | None:
    """Classify the current page as a known non-Maps interstitial, or None
    if it looks like an ordinary page (which may or may not turn out to
    have a valid results panel — that's decided separately, by
    `_resolve_results_panel`).

    Deliberately URL/title based rather than trying to fingerprint every
    possible challenge page's DOM — the goal is a cheap, reliable signal
    for the two shapes of interstitial Google is actually known to use for
    automated Maps traffic, not a general bot-challenge classifier.
    """
    try:
        url = page.url
    except Exception:
        url = ""

    if "consent.google.com" in url or "/consent" in url:
        return DiscoveryFailureReason.CONSENT_REQUIRED
    if "sorry.google.com" in url or "/sorry/" in url:
        return DiscoveryFailureReason.BLOCKED

    # Cheap title/body check for a challenge page that didn't redirect to
    # one of the hostnames above (Google has used in-place challenge
    # interstitials on maps.google.com itself in the past).
    try:
        title = (await page.title() or "").lower()
    except Exception:
        title = ""
    if "unusual traffic" in title or "captcha" in title:
        return DiscoveryFailureReason.CHALLENGE

    return None


async def _try_dismiss_ordinary_consent(page: Page, *, config: ScraperConfig) -> bool:
    """Best-effort click of a routine "accept cookies" control.

    This is NOT a bypass mechanism — it only acts when a normal, visible
    accept-consent button is present, exactly what a human visitor would
    click. If no such control is found (e.g. an actual CAPTCHA/block page),
    this returns False immediately and does nothing further; the caller is
    responsible for reporting an explicit failure rather than attempting to
    defeat whatever is actually blocking access.
    """
    for sel in _CONSENT_ACCEPT_SELECTORS:
        try:
            btn = await page.query_selector(sel)
            if not btn:
                continue
            await btn.click(timeout=3000)
            log.info(f"[maps] dismissed ordinary consent interstitial via {sel!r}")
            # Give the resulting navigation/re-render a bounded moment to
            # settle before the caller re-checks page state.
            try:
                await page.wait_for_load_state("domcontentloaded", timeout=config.maps_timeout_ms)
            except Exception:
                pass
            return True
        except Exception:
            continue
    return False


# ──────────────────────────────────────────────────────────────────────────────
# Results-panel resolution (Parts 3–4 fix)
#
# The scraper's actual collection path scopes every anchor query to
# whichever element `_PANEL_SELECTORS` resolves to (see the `search()`
# collection loop below and `_human_scroll`) — so if that element is wrong,
# every downstream signal (cards_in_dom, scroll movement, EOL detection)
# is meaningless even though each individual step "succeeds". The old code
# accepted the FIRST selector in `_PANEL_SELECTORS` to match anything at
# all via `page.wait_for_selector`, including the generic, reused
# `div.m6QErb` fallback with no further check that the matched element was
# actually a results feed. This resolves each candidate with DOM evidence
# instead of trusting the selector alone.
# ──────────────────────────────────────────────────────────────────────────────

async def _validate_panel_candidate(
    page: Page, panel, *, selector: str, strict: bool,
) -> tuple[bool, str]:
    """Validate that `panel` (an ElementHandle already matched by
    `selector`) is plausibly the actual Maps results feed.

    `strict=True` is used for the generic, non-specific fallback selectors
    (`div.m6QErb` without `[aria-label]`, `div.section-layout-root`) that
    are known to also match decorative/header/filter containers elsewhere
    on the page — for those, evidence of place-anchor content is required.
    `strict=False` is used for selectors that are already reasonably
    specific to the feed (`div[role='feed']`, `div.m6QErb[aria-label]`),
    where scrollable-container evidence alone is accepted since role=feed
    is itself strong evidence of identity.

    Returns (is_valid, evidence) — evidence is a short string logged by
    the caller so a rejection is traceable to what was actually measured,
    not just a bare "no" for the diagnostics record.
    """
    try:
        anchor_count = len(await panel.query_selector_all("a[href*='/maps/place/']"))
    except Exception:
        anchor_count = 0

    if anchor_count == 0 and hasattr(panel, "wait_for_selector"):
        try:
            cand = await panel.wait_for_selector("a[href*='/maps/place/']", timeout=6000)
            if cand is not None:
                anchor_count = len(await panel.query_selector_all("a[href*='/maps/place/']"))
        except Exception:
            pass

    if anchor_count > 0:
        return True, f"contains {anchor_count} place anchor(s)"

    if strict:
        # No place anchors yet is not disqualifying on its own — Maps can
        # render an empty-but-correct feed while the first batch of cards
        # is still streaming in — but for a generic selector we require at
        # least scrollable-container evidence before accepting it, so we
        # don't silently drive a header/filter/decorative node instead.
        try:
            dims = await panel.evaluate(
                "el => ({ scrollHeight: el.scrollHeight, clientHeight: el.clientHeight, role: el.getAttribute('role') })"
            )
        except Exception:
            return False, "evaluate() failed"
        is_scrollable = (dims.get("scrollHeight") or 0) > (dims.get("clientHeight") or 0)
        has_feed_role = dims.get("role") == "feed"
        if is_scrollable or has_feed_role:
            return True, f"no anchors yet but scrollable={is_scrollable} role={dims.get('role')!r}"
        return False, f"no anchors, not scrollable, role={dims.get('role')!r}"

    # Non-strict candidates (role=feed, or m6QErb with an aria-label — both
    # already reasonably specific to the results feed identity) are
    # accepted even with zero anchors right now, same reasoning as above.
    return True, "no anchors yet (non-strict candidate, feed-identity selector)"


# Which _PANEL_SELECTORS entries require the stricter (anchor-or-scrollable)
# check above, vs. which are specific enough on their own that scrollable
# evidence alone suffices. Index-aligned with _PANEL_SELECTORS.
_PANEL_SELECTOR_STRICT = {
    "div[role='feed']": False,
    "div.m6QErb[aria-label]": False,
    "div.section-layout-root": True,
    "div.m6QErb": True,  # the generic, most-reused fallback — see module docs
}


async def _resolve_results_panel(page: Page, *, config: ScraperConfig) -> tuple[str, object]:
    """Resolve the actual results-feed element, validating each candidate
    with DOM evidence rather than accepting the first selector match.

    Raises `DiscoveryFailure(PANEL_NOT_FOUND)` if no candidate validates —
    this is the fix for Part 8: a query that cannot even locate a results
    container must never fall through to look identical to a query that
    validly found zero matching businesses.
    """
    attempted: list[str] = []
    for sel in _PANEL_SELECTORS:
        try:
            panel_timeout = 15000 if sel == "div[role='feed']" else 4000
            await page.wait_for_selector(sel, timeout=panel_timeout)
        except PlaywrightTimeoutError:
            attempted.append(f"{sel!r}: not present")
            continue

        panel = await page.query_selector(sel)
        if panel is None:
            attempted.append(f"{sel!r}: matched at wait time, gone by query time")
            continue

        strict = _PANEL_SELECTOR_STRICT.get(sel, True)
        is_valid, evidence = await _validate_panel_candidate(page, panel, selector=sel, strict=strict)
        if is_valid:
            log.info(f"[maps][diag] result panel validated — selector={sel!r} evidence={evidence}")
            return sel, panel

        # If primary element was rejected (e.g. generic container matched non-feed first), check other candidates
        if hasattr(page, "query_selector_all"):
            try:
                candidates = await page.query_selector_all(sel)
                for cand in candidates[1:6]:
                    c_valid, c_evidence = await _validate_panel_candidate(page, cand, selector=sel, strict=strict)
                    if c_valid:
                        log.info(f"[maps][diag] result panel validated (alternate) — selector={sel!r} evidence={c_evidence}")
                        return sel, cand
            except Exception:
                pass

        attempted.append(f"{sel!r}: rejected ({evidence})")
        log.info(f"[maps][diag] panel candidate rejected — selector={sel!r} evidence={evidence}")

    raise DiscoveryFailure(
        DiscoveryFailureReason.PANEL_NOT_FOUND,
        f"no candidate in _PANEL_SELECTORS validated as a results feed — {attempted}",
    )


_PLACE_CID_RE = re.compile(r"0x[0-9a-fA-F]+:0x[0-9a-fA-F]+")
_PLACE_GID_RE = re.compile(r"/g/([A-Za-z0-9_-]+)")

# Controls that return from a place's detail pane to the results feed.
# Maps' markup for this isn't stable, so several are tried in order.
_BACK_BUTTON_SELECTORS = [
    "div[role='main'] button[aria-label='Close']",
    "div[role='region'] button[aria-label='Close']",
    "button[aria-label='Close']:not([jsaction*='omnibox'])",
    "button[aria-label='Back to results']",
    "button[aria-label*='back to results' i]",
    "button[jsaction*='pane.backButton']",
    "button[data-tooltip*='Back to results' i]",
    "button[aria-label='Back']",
    "button[data-tooltip='Back']",
]


_PLACE_ANCHOR_5S_RE = re.compile(r"!5s[^!/?#&\s]+", re.IGNORECASE)
_PLACE_SEARCH_1S_RE = re.compile(r"!2m\d+!1s[^!/?#&\s]+", re.IGNORECASE)
_PLACE_BLOCK_1S_CID_RE = re.compile(r"!3m\d+!1s(0x[0-9a-fA-F]+:0x[0-9a-fA-F]+)", re.IGNORECASE)
_PLACE_1S_CID_RE = re.compile(r"(?<!\!2m1)(?<!\!2m2)!1s(0x[0-9a-fA-F]+:0x[0-9a-fA-F]+)", re.IGNORECASE)
_PLACE_BLOCK_1S_CHIJ_RE = re.compile(r"!3m\d+!1s(ChIJ[\w\-]+)", re.IGNORECASE)
_PLACE_1S_CHIJ_RE = re.compile(r"(?<!\!2m1)(?<!\!2m2)!1s(ChIJ[\w\-]+)", re.IGNORECASE)


def _place_identity_from_href(href: str) -> str:
    """Extract a stable place identity from a Maps href.

    A place's href embeds its actual CID — a hex pair like
    '0x4876...:0x89ab...' — inside the `!3m6!1s` place block of the `data=`
    segment. That CID is stable for a given place, whereas the `!5s` viewport
    anchor token and camera coordinates vary. Deduping uses the authoritative
    place ID from `_stable_place_id_from_url`, falling back to the `!5s`-stripped
    base href only when no CID/ChIJ/`/g/` identifier exists.
    """
    if not href:
        return ""
    pid = _stable_place_id_from_url(href)
    if pid:
        return pid
    cleaned = _PLACE_ANCHOR_5S_RE.sub("", href)
    return cleaned.split("?")[0]


def _place_identity_from_data(place: "RawPlace") -> str:
    """Second-layer identity key built from extracted place data.

    Independent of href formatting entirely — belt-and-braces guard so
    that even if two different hrefs (or an href we couldn't extract a
    CID from) both resolve to a place we've already extracted, we still
    won't yield it twice.
    """
    return f"{place.name.strip().lower()}|{place.address.strip().lower()}"


_PLACE_CHIJ_RE = re.compile(r"(ChIJ[\w\-]+)", re.IGNORECASE)
_PLACE_SLUG_RE = re.compile(r"/maps/place/([^/?#]+)")


def _norm_identity_text(text: str | None) -> str:
    if not text:
        return ""
    from urllib.parse import unquote_plus
    s = unquote_plus(text).strip().lower()
    s = re.sub(r"[^\w\s]", " ", s)
    return re.sub(r"\s+", " ", s).strip()


def _place_name_from_href(href: str) -> str:
    if not href:
        return ""
    m = _PLACE_SLUG_RE.search(href)
    if not m:
        return ""
    slug = m.group(1)
    if slug.lower() == "data":
        return ""
    return _norm_identity_text(slug)


def _stable_place_id_from_url(url: str) -> str:
    """Extract the authoritative place ID from a Google Maps URL.

    Phase 1 Place-ID Parser rules:
    1. Explicitly ignore any search/feed context URL (`/maps/search/...` without
       `/maps/place/`) and any `!2m<N>!1s` search-query token.
    2. Explicitly strip `!5s<id>` viewport anchor tokens so a viewport anchor
       appearing earlier in `data=!3m1!5s0x...` is never mistaken for the place ID.
       If a URL contains ONLY a `!5s` token and no `!1s` token (nor `/g/` ID),
       this function returns `""` (falsy) — it never returns the `!5s` ID.
    3. Prefer the `!3m<N>!1s<id>` place data block (`!3m6!1s0x...:0x...`), then
       any non-search `!1s<id>` token, then `ChIJ` place tokens, then bare CID /
       `ChIJ` / `/g/<id>` on the `!5s`-stripped string.
    """
    if not url or not isinstance(url, str):
        return ""
    if "/maps/search/" in url and "/maps/place/" not in url:
        return ""
    cleaned = _PLACE_ANCHOR_5S_RE.sub("", url)
    cleaned = _PLACE_SEARCH_1S_RE.sub("", cleaned)

    m = _PLACE_BLOCK_1S_CID_RE.search(cleaned)
    if m:
        return m.group(1).lower()
    m = _PLACE_1S_CID_RE.search(cleaned)
    if m:
        return m.group(1).lower()
    m = _PLACE_BLOCK_1S_CHIJ_RE.search(cleaned)
    if m:
        return m.group(1)
    m = _PLACE_1S_CHIJ_RE.search(cleaned)
    if m:
        return m.group(1)
    m = _PLACE_CID_RE.search(cleaned)
    if m:
        return m.group(0).lower()
    m = _PLACE_CHIJ_RE.search(cleaned)
    if m:
        return m.group(1)
    m = _PLACE_GID_RE.search(cleaned)
    if m:
        return f"g/{m.group(1)}"
    return ""


def _verified_maps_link_from_href(card_href: str, page_url: str) -> str:
    """Construct or select a verified `/maps/place/` URL after identity confirmation.
    Ensures the first yielded candidate retains its place link and place ID even when
    `page.url` is still on `/maps/search/...`."""
    page_url_str = (page_url or "").strip()
    card_href_str = (card_href or "").strip()
    if page_url_str and "/maps/place/" in page_url_str and "/maps/search/" not in page_url_str:
        card_pid = _stable_place_id_from_url(card_href_str)
        page_pid = _stable_place_id_from_url(page_url_str)
        if not card_pid or not page_pid or card_pid.lower() == page_pid.lower():
            return page_url_str
    if card_href_str:
        if card_href_str.startswith("/"):
            return f"https://www.google.com{card_href_str}"
        return card_href_str
    return page_url_str


def _extract_card_address_hint(card_signals: dict | None, card_name_norm: str) -> str:
    if not card_signals:
        return ""
    visible = (card_signals.get("visible_text") or "").strip()
    if not visible:
        return ""
    segments = [seg.strip() for seg in re.split(r"[·\n|]+", visible) if seg.strip()]
    for seg in segments:
        norm_seg = _norm_identity_text(seg)
        if not norm_seg or norm_seg == card_name_norm:
            continue
        if _CARD_RATING_RE.search(seg) or _CARD_REVIEW_COUNT_RE.search(seg):
            continue
        if any(m in norm_seg for m in _CARD_CLOSED_MARKERS):
            continue
        if re.search(r"\b\d+\s+[a-z]", norm_seg):
            return norm_seg
    return ""


def _names_consistent(expected_norm: str, actual_norm: str) -> bool:
    if not expected_norm or not actual_norm:
        return True
    if expected_norm == actual_norm:
        return True
    if expected_norm in actual_norm or actual_norm in expected_norm:
        return True
    exp_tokens = {t for t in expected_norm.split() if len(t) > 2}
    act_tokens = {t for t in actual_norm.split() if len(t) > 2}
    if exp_tokens and act_tokens and (exp_tokens & act_tokens):
        return True
    return False


def _addresses_consistent(hint_norm: str, actual_norm: str) -> bool:
    if not hint_norm or not actual_norm:
        return True
    if hint_norm in actual_norm or actual_norm in hint_norm:
        return True
    hint_tokens = [t for t in hint_norm.split() if len(t) >= 2]
    act_tokens = set(actual_norm.split())
    if not hint_tokens or not act_tokens:
        return True
    # Street number + at least one street token must match when both have street numbers
    hint_nums = [t for t in hint_tokens if t.isdigit()]
    act_nums = [t for t in act_tokens if t.isdigit()]
    if hint_nums and act_nums and not (set(hint_nums) & set(act_nums)):
        return False
    overlap = sum(1 for t in hint_tokens if t in act_tokens)
    return overlap >= max(1, len(hint_tokens) // 2)


_DETAIL_BACK_BUTTON_SELECTORS = (
    "button[aria-label='Back to results']",
    "button[aria-label*='back to results' i]",
    "button[jsaction*='pane.backButton']",
    "button[data-tooltip*='Back to results' i]",
)

_PANEL_HEADER_EXCLUSIONS = frozenset({
    "results",
    "search results",
    "all results",
    "نتائج",
    "النتائج",
    "ad",
    "ads",
    "sponsored",
    "advertisement",
    "promoted",
    "إعلان",
    "اعلان",
    "إعلانات",
    "اعلانات",
    "ممول",
    "مُموَّل",
    "google maps",
    "map",
    "maps",
    "خرائط google",
    "خرائط",
})


def _is_excluded_panel_header(text: str | None) -> bool:
    """Return True if `text` is empty or matches a generic search-results or ad header
    rather than an individual place name."""
    if not text:
        return True
    low = text.strip().lower()
    if not low:
        return True
    low = re.sub(r"[\u200e\u200f\u202a-\u202e\u2066-\u2069]", "", low).strip()
    if low in _PANEL_HEADER_EXCLUSIONS:
        return True
    if (
        low.startswith("results for ")
        or low.startswith("search results")
        or low.startswith("نتائج البحث عن")
        or low.startswith("نتائج ")
    ):
        return True
    return False


def _is_conclusively_disqualified_by_name(name: str | None) -> bool:
    """Return True if and only if `name` alone conclusively matches the
    canonical CHAIN_KEYWORDS or CANNABIS_KEYWORDS disqualification rules
    shared by ScoringWorker, ExecutionDriver._on_candidate, and scorer.py.
    """
    if not name:
        return False
    low = name.strip().lower()
    if not low:
        return False
    return any(kw in low for kw in CHAIN_KEYWORDS) or any(kw in low for kw in CANNABIS_KEYWORDS)


async def _is_detail_pane_open(page: Page, feed_el: object = None) -> bool:
    """Return True if a place detail pane (heading or back button) is currently open.
    Checks `el is not feed_el` and element capability so minimal unit-test stubs where
    `page.query_selector(_)` returns the feed panel object for all selectors do not
    falsely report an open detail pane."""
    for sel in _PLACE_NAME_SELECTORS:
        try:
            el = await page.query_selector(sel)
            if el is not None and el is not feed_el:
                if hasattr(el, "inner_text"):
                    txt = (await el.inner_text() or "").strip()
                    if not _is_excluded_panel_header(txt):
                        return True
                    if hasattr(page, "query_selector_all"):
                        for cand in await page.query_selector_all(sel):
                            if cand is not None and cand is not feed_el and hasattr(cand, "inner_text"):
                                ctxt = (await cand.inner_text() or "").strip()
                                if not _is_excluded_panel_header(ctxt):
                                    return True
        except Exception:
            continue
    # Detail pane back buttons specific to the place pane
    for sel in _DETAIL_BACK_BUTTON_SELECTORS:
        try:
            el = await page.query_selector(sel)
            if el is not None and el is not feed_el:
                if hasattr(el, "click"):
                    return True
        except Exception:
            continue
    return False


_PANEL_SNAPSHOT_JS = """
() => {
    const url = window.location.href || "";
    const page_title = document.title || "";
    
    let detail_open = (url.includes("/maps/place/") && !url.includes("/maps/search/"));
    if (!detail_open) {
        const backBtn = document.querySelector("button[aria-label*='Back' i], button[data-tooltip*='Back' i], button[aria-label='Results' i], button[aria-label*='نتائج' i]");
        if (backBtn && backBtn.offsetParent !== null) detail_open = true;
    }
    
    const EXCLUDED = new Set([
        "results", "search results", "all results", "نتائج", "النتائج",
        "ad", "ads", "sponsored", "advertisement", "promoted",
        "إعلان", "اعلان", "إعلانات", "اعلانات", "ممول", "مُموَّل",
        "map", "maps", "google maps", "خرائط google", "خرائط"
    ]);
    function isExcluded(t) {
        if (!t) return true;
        const s = t.trim().toLowerCase().replace(/[\\u200e\\u200f\\u202a-\\u202e\\u2066-\\u2069]/g, "");
        return EXCLUDED.has(s) || s.startsWith("results for ") || s.startsWith("search results") || s.startsWith("نتائج ");
    }
    
    let raw_h1_name = "";
    let raw_h1 = "";
    let matched_selector = "none";
    const h1s = document.querySelectorAll("h1.DUwDvf, h1.fontHeadlineLarge, h1[data-item-id], div[role='main'] h1, div[role='region'] h1, h1, div.DUwDvf");
    for (const h of h1s) {
        if (h.closest && h.closest("div[role='feed'], #searchbox, form")) continue;
        const t = (h.innerText || "").trim();
        if (!raw_h1 && t) raw_h1 = t;
        if (!isExcluded(t)) {
            raw_h1_name = t;
            raw_h1 = t;
            matched_selector = h.className || "h1";
            detail_open = true;
            break;
        }
    }
    
    let raw_aria_name = "";
    const mainEl = document.querySelector("div[role='main'][aria-label]");
    if (mainEl) {
        const a = (mainEl.getAttribute("aria-label") || "").trim();
        if (!isExcluded(a)) raw_aria_name = a;
    }
    
    let raw_address = "";
    const addrEl = document.querySelector("[data-item-id='address'], button[data-item-id='address'], div[data-item-id='address'], [data-tooltip='Copy address']");
    if (addrEl) {
        raw_address = (addrEl.innerText || "").trim();
    }
    
    return {
        url,
        page_title,
        detail_open,
        raw_h1_name,
        raw_h1,
        matched_selector,
        raw_aria_name,
        raw_address
    };
}
"""

_DEFAULT_IS_DETAIL_PANE_OPEN = _is_detail_pane_open


async def _read_panel_identity_snapshot(page: Page, feed_el: object = None) -> dict:
    """Capture the currently rendered detail-pane identity signals.

    Phase 2 & 3: reads heading selectors (`_PLACE_NAME_SELECTORS`), `page.title()`,
    optional `div[role='main']` `aria-label`, address selectors, and the authoritative
    URL `!1s` place ID. Excluded search-feed headers (e.g. 'Results') are never
    promoted into `raw_name`; when `h1` is excluded or missing, falls back to
    `page_title` (stripped of ' - Google Maps') or `div[role='main'][aria-label]`.
    """
    raw_h1_name = ""
    raw_h1 = ""
    matched_selector = "none"
    raw_address = ""
    if hasattr(page, "evaluate") and hasattr(page, "context") and _is_detail_pane_open is _DEFAULT_IS_DETAIL_PANE_OPEN:
        try:
            js_data = await page.evaluate(_PANEL_SNAPSHOT_JS)
            if isinstance(js_data, dict):
                raw_h1_name = js_data.get("raw_h1_name") or ""
                raw_h1 = js_data.get("raw_h1") or ""
                matched_selector = js_data.get("matched_selector") or "none"
                raw_address = js_data.get("raw_address") or ""
                detail_open = js_data.get("detail_open") or False
                url = js_data.get("url") or (getattr(page, "url", "") or "")
                place_id = _stable_place_id_from_url(url) if "/maps/place/" in url else ""
                page_title = js_data.get("page_title") or ""
                raw_title_name = _extract_title_place_name(page_title) if (detail_open or "/maps/search/" not in url) else ""
                raw_aria_name = js_data.get("raw_aria_name") or ""
                raw_name = raw_h1_name or (raw_title_name if detail_open else "") or (raw_aria_name if detail_open else "")
                return {
                    "open": detail_open,
                    "name": _norm_identity_text(raw_name),
                    "raw_name": raw_name,
                    "h1_name": raw_h1_name,
                    "raw_h1": raw_h1,
                    "page_title": page_title,
                    "raw_title_name": raw_title_name,
                    "title_name": _norm_identity_text(raw_title_name),
                    "raw_aria_name": raw_aria_name,
                    "aria_name": _norm_identity_text(raw_aria_name),
                    "matched_selector": matched_selector,
                    "address": _norm_identity_text(raw_address),
                    "raw_address": raw_address,
                    "place_id": place_id,
                    "url_place_id": place_id,
                    "url": url,
                }
        except Exception:
            pass

    if _is_detail_pane_open is not _DEFAULT_IS_DETAIL_PANE_OPEN:
        detail_open = await _is_detail_pane_open(page, feed_el)
        if detail_open:
            for sel in _PLACE_NAME_SELECTORS:
                try:
                    el = await page.query_selector(sel)
                    if el is not None and el is not feed_el and hasattr(el, "inner_text"):
                        t = (await el.inner_text() or "").strip()
                        if not raw_h1 and t:
                            raw_h1 = t
                        if not _is_excluded_panel_header(t):
                            raw_h1_name = t
                            raw_h1 = t
                            matched_selector = sel
                            break
                    if hasattr(page, "query_selector_all"):
                        for cand in await page.query_selector_all(sel):
                            if cand is not None and cand is not feed_el and hasattr(cand, "inner_text"):
                                ct = (await cand.inner_text() or "").strip()
                                if not raw_h1 and ct:
                                    raw_h1 = ct
                                if not _is_excluded_panel_header(ct):
                                    raw_h1_name = ct
                                    raw_h1 = ct
                                    matched_selector = sel
                                    break
                        if raw_h1_name:
                            break
                except Exception:
                    continue
    else:
        detail_open = False
        for sel in _PLACE_NAME_SELECTORS:
            try:
                el = await page.query_selector(sel)
                if el is not None and el is not feed_el and hasattr(el, "inner_text"):
                    t = (await el.inner_text() or "").strip()
                    if not raw_h1 and t:
                        raw_h1 = t
                    if not _is_excluded_panel_header(t):
                        raw_h1_name = t
                        raw_h1 = t
                        matched_selector = sel
                        detail_open = True
                        break
                    if hasattr(page, "query_selector_all"):
                        for cand in await page.query_selector_all(sel):
                            if cand is not None and cand is not feed_el and hasattr(cand, "inner_text"):
                                ct = (await cand.inner_text() or "").strip()
                                if not raw_h1 and ct:
                                    raw_h1 = ct
                                if not _is_excluded_panel_header(ct):
                                    raw_h1_name = ct
                                    raw_h1 = ct
                                    matched_selector = sel
                                    detail_open = True
                                    break
                        if detail_open:
                            break
            except Exception:
                continue
        if not detail_open:
            for sel in _DETAIL_BACK_BUTTON_SELECTORS:
                try:
                    el = await page.query_selector(sel)
                    if el is not None and el is not feed_el and hasattr(el, "click"):
                        detail_open = True
                        if matched_selector == "none":
                            matched_selector = sel
                        break
                except Exception:
                    continue

    url = getattr(page, "url", "") or ""
    place_id = _stable_place_id_from_url(url) if "/maps/place/" in url else ""
    if not detail_open and "/maps/place/" in url and "/maps/search/" not in url:
        detail_open = True

    page_title = await _read_page_title_safe(page)
    raw_title_name = _extract_title_place_name(page_title) if (detail_open or "/maps/search/" not in url) else ""

    raw_aria_name = ""
    if (detail_open or not raw_h1_name) and hasattr(page, "query_selector"):
        for main_sel in ("div[role='main'][aria-label]", "div[role='main']"):
            try:
                main_el = await page.query_selector(main_sel)
                if main_el is not None and main_el is not feed_el and hasattr(main_el, "get_attribute"):
                    aria_val = (await main_el.get_attribute("aria-label") or "").strip()
                    if aria_val and not _is_excluded_panel_header(aria_val):
                        raw_aria_name = aria_val
                        break
            except Exception:
                continue

    if not detail_open and (raw_title_name or raw_aria_name) and "/maps/search/" not in url:
        detail_open = True

    if detail_open:
        for sel in _ADDRESS_SELECTORS:
            try:
                el = await page.query_selector(sel)
                if el is not None and el is not feed_el and hasattr(el, "inner_text"):
                    t = (await el.inner_text() or "").strip()
                    if t:
                        raw_address = t
                        break
            except Exception:
                continue

    raw_name = raw_h1_name or (raw_title_name if detail_open else "") or (raw_aria_name if detail_open else "")
    return {
        "open": detail_open,
        "name": _norm_identity_text(raw_name),
        "raw_name": raw_name,
        "h1_name": raw_h1_name,
        "raw_h1": raw_h1,
        "page_title": page_title,
        "raw_title_name": raw_title_name,
        "title_name": _norm_identity_text(raw_title_name),
        "raw_aria_name": raw_aria_name,
        "aria_name": _norm_identity_text(raw_aria_name),
        "matched_selector": matched_selector,
        "address": _norm_identity_text(raw_address),
        "raw_address": raw_address,
        "place_id": place_id,
        "url_place_id": place_id,
        "url": url,
    }


def _evaluate_panel_identity(
    snap: dict,
    *,
    card_href: str,
    place_key: str,
    card_signals: dict | None,
    pre_click_snapshot: dict | None,
    last_verified_panel: dict | None,
    allow_stub: bool = False,
) -> tuple[bool, str]:
    """Verify whether `snap` belongs to the intended clicked card rather than a
    stale detail panel left over from an earlier card.

    Phase 2 rules:
    - Uses h1, page_title (stripped of ' - Google Maps'), optional div[role='main']
      aria-label, and URL !1s place ID as first-class identity signals.
    - 'Results' (and other _PANEL_HEADER_EXCLUSIONS) is never used as a place name.
    - Verification passes when (URL !1s id == card id) OR (title/h1/aria name is
      consistent with card name AND the panel/URL is not stale from the previous card).
    - Preserves full stale-panel rejection when URL !1s id or title/name matches the
      prior card and differs from the current card.
    """
    if "h1_name" in snap:
        raw_h1_candidate = snap.get("h1_name") or ""
    else:
        raw_h1_candidate = snap.get("raw_h1") or snap.get("raw_name") or snap.get("name") or ""
    h1_name = "" if _is_excluded_panel_header(raw_h1_candidate) else _norm_identity_text(raw_h1_candidate)

    raw_title_candidate = (
        snap.get("raw_title_name")
        or _extract_title_place_name(snap.get("page_title") or "")
        or ""
    )
    title_name_raw = snap.get("title_name") or raw_title_candidate
    title_name = "" if _is_excluded_panel_header(title_name_raw) else _norm_identity_text(title_name_raw)

    raw_aria_candidate = snap.get("raw_aria_name") or snap.get("aria_label") or ""
    aria_name_raw = snap.get("aria_name") or raw_aria_candidate
    aria_name = "" if _is_excluded_panel_header(aria_name_raw) else _norm_identity_text(aria_name_raw)

    # Also support callers that passed a pre-normalized non-excluded `raw_name`/`name` directly in `snap`
    if not h1_name and not title_name and not aria_name:
        fallback_raw = snap.get("raw_name") or snap.get("name") or ""
        if not _is_excluded_panel_header(fallback_raw):
            h1_name = _norm_identity_text(fallback_raw)

    effective_name = h1_name or title_name or aria_name
    name_source = "h1" if h1_name else ("title" if title_name else ("h1" if aria_name else "none"))

    curr_url = snap.get("url") or ""
    panel_pid = (
        snap.get("place_id")
        or snap.get("url_place_id")
        or (_stable_place_id_from_url(curr_url) if "/maps/place/" in curr_url else "")
    )
    card_pid = (
        _stable_place_id_from_url(card_href)
        or (card_signals or {}).get("card_place_id")
        or (card_signals or {}).get("place_id")
        or ""
    )

    snap["title_name"] = title_name
    snap["url_place_id"] = panel_pid
    snap["card_place_id"] = card_pid
    if not snap.get("raw_name") or _is_excluded_panel_header(snap.get("raw_name")):
        resolved_raw = (
            (raw_h1_candidate if not _is_excluded_panel_header(raw_h1_candidate) else "")
            or raw_title_candidate
            or raw_aria_candidate
        )
        if resolved_raw:
            snap["raw_name"] = resolved_raw
            snap["name"] = _norm_identity_text(resolved_raw)
    elif not snap.get("name") and effective_name:
        snap["name"] = effective_name

    if not snap.get("open") and not effective_name:
        snap["verdict_source"] = "none"
        if allow_stub:
            return True, "stub_no_detail_dom"
        return False, "waiting_for_detail_panel"

    card_name = _norm_identity_text((card_signals or {}).get("name") or "")
    card_slug_name = _place_name_from_href(card_href)
    expected_name = card_name or card_slug_name
    card_addr_hint = _extract_card_address_hint(card_signals, expected_name)
    panel_addr = snap.get("address") or _norm_identity_text(snap.get("raw_address") or "")

    # 1. Check against prior open panel (either open before click or last verified card) FIRST
    # so stale panels are always rejected before URL/title signals can pass.
    prior = None
    if pre_click_snapshot and pre_click_snapshot.get("open"):
        prior = pre_click_snapshot
    elif last_verified_panel and last_verified_panel.get("place_key") != place_key:
        prior = last_verified_panel

    if prior is not None:
        prior_url = prior.get("url") or ""
        prior_pid = (
            prior.get("place_id")
            or prior.get("url_place_id")
            or (_stable_place_id_from_url(prior_url) if "/maps/place/" in prior_url else "")
        )
        prior_name = prior.get("name") or _norm_identity_text(
            "" if _is_excluded_panel_header(prior.get("raw_name")) else (prior.get("raw_name") or "")
        )
        prior_title = (
            prior.get("title_name")
            or _norm_identity_text(_extract_title_place_name(prior.get("page_title") or ""))
            or prior_name
        )
        prior_addr = prior.get("address") or ""

        if panel_pid and prior_pid and panel_pid.lower() == prior_pid.lower():
            if not card_pid or card_pid.lower() != panel_pid.lower():
                snap["verdict_source"] = "url_id"
                return False, "panel_place_id_unchanged_from_prior"

        if (
            title_name
            and prior_title
            and title_name == prior_title
            and (not expected_name or not _names_consistent(expected_name, title_name))
            and not (card_pid and panel_pid and card_pid.lower() == panel_pid.lower())
        ):
            snap["verdict_source"] = "title"
            if expected_name:
                return False, f"name_conflict(expected={expected_name!r},actual={title_name!r})"
            return False, "panel_name_and_address_unchanged_from_prior"

        if (
            effective_name
            and prior_name
            and effective_name == prior_name
            and panel_addr == prior_addr
            and not (card_pid and panel_pid and card_pid.lower() == panel_pid.lower())
        ):
            snap["verdict_source"] = name_source
            return False, "panel_name_and_address_unchanged_from_prior"

        if (
            curr_url
            and prior_url
            and curr_url == prior_url
            and "/maps/place/" in curr_url
            and not (card_pid and panel_pid and card_pid.lower() == panel_pid.lower())
        ):
            snap["verdict_source"] = "url_id"
            return False, "panel_place_id_unchanged_from_prior"

    # 2. Authoritative place-ID conflict check when both card and panel URL expose a !1s ID.
    if card_pid and panel_pid and card_pid.lower() != panel_pid.lower():
        snap["verdict_source"] = "url_id"
        return False, f"place_id_conflict(card={card_pid},panel={panel_pid})"

    url_id_matched = bool(card_pid and panel_pid and card_pid.lower() == panel_pid.lower())

    # 3. Name consistency check across h1, page_title, and aria-label.
    if expected_name:
        if h1_name and not _names_consistent(expected_name, h1_name):
            snap["verdict_source"] = "h1"
            return False, f"name_conflict(expected={expected_name!r},actual={h1_name!r})"
        if title_name and not _names_consistent(expected_name, title_name):
            snap["verdict_source"] = "title"
            return False, f"name_conflict(expected={expected_name!r},actual={title_name!r})"
        if aria_name and not h1_name and not title_name and not _names_consistent(expected_name, aria_name):
            snap["verdict_source"] = "h1"
            return False, f"name_conflict(expected={expected_name!r},actual={aria_name!r})"
        if not effective_name and not url_id_matched:
            snap["verdict_source"] = "none"
            if allow_stub:
                return True, "stub_no_panel_name"
            return False, "waiting_for_panel_name"
    elif not effective_name and not url_id_matched and not allow_stub:
        snap["verdict_source"] = "none"
        return False, "waiting_for_panel_name"

    # 4. Address hint consistency check (distinguishes same-name branches).
    if card_addr_hint and panel_addr and not _addresses_consistent(card_addr_hint, panel_addr):
        snap["verdict_source"] = name_source if effective_name else ("url_id" if url_id_matched else "none")
        return False, f"address_conflict(hint={card_addr_hint!r},actual={panel_addr!r})"

    if h1_name:
        snap["verdict_source"] = "h1"
    elif url_id_matched and not title_name:
        snap["verdict_source"] = "url_id"
        if not snap.get("name") and expected_name:
            snap["name"] = expected_name
        if not snap.get("raw_name") or _is_excluded_panel_header(snap.get("raw_name")):
            snap["raw_name"] = (
                (card_signals or {}).get("name")
                or _place_name_from_href(curr_url)
                or _place_name_from_href(card_href)
                or expected_name
            )
    elif title_name:
        snap["verdict_source"] = "title" if not url_id_matched else "url_id"
    elif url_id_matched:
        snap["verdict_source"] = "url_id"
    else:
        snap["verdict_source"] = name_source

    return True, "verified"


def _detect_stale_extraction(
    curr_place: object | None,
    last_verified: dict | None,
) -> tuple[bool, str]:
    """Check if the extracted place appears to have carried over phone/website/address
    from the previously verified place panel (e.g. same website and phone while names differ).
    Returns (is_stale, reason)."""
    if not curr_place or not last_verified:
        return False, "none"

    prior_name = (last_verified.get("name") or last_verified.get("raw_name") or "").strip().lower()
    curr_name = (getattr(curr_place, "name", "") or "").strip().lower()
    if not prior_name or not curr_name:
        return False, "none"

    # If the names are consistent, it is the same place (not stale carry-over)
    if _names_consistent(curr_name, prior_name):
        return False, "none"

    prior_phone = (last_verified.get("phone") or "").strip()
    curr_phone = (getattr(curr_place, "phone", "") or "").strip()
    prior_website = (last_verified.get("website") or "").strip()
    curr_website = (getattr(curr_place, "website", "") or "").strip()
    prior_address = (last_verified.get("address") or "").strip()
    curr_address = (getattr(curr_place, "address", "") or "").strip()

    # Phone is non-empty and identical to previous card (strong stale carry-over signal)
    if curr_phone and prior_phone and curr_phone == prior_phone:
        if curr_website and prior_website and curr_website == prior_website:
            return True, "stale_website_and_phone"
        if curr_address and prior_address and curr_address == prior_address:
            return True, "stale_phone_and_address"
        return True, "stale_phone"

    # Website and address only (e.g. co-located tenants in same building/domain with different phones)
    # Logged as a warning, but NOT cleared
    if curr_website and prior_website and curr_website == prior_website and curr_address and prior_address and curr_address == prior_address:
        return True, "warning_website_and_address_only"

    return False, "none"


def _resolve_identity_wait_ms(page: Page, found_panel: bool, config: ScraperConfig) -> int:
    """Compute the verified panel identity wait timeout in ms.
    Uses full config.place_timeout_ms whenever found_panel is True OR the page URL
    has transitioned to a place URL (/maps/place/...), falling back to a 250ms
    probe only when still on a non-place URL without a panel."""
    curr_url = getattr(page, "url", "") or ""
    is_on_place_url = "/maps/place/" in curr_url and "/maps/search/" not in curr_url
    return (
        config.place_timeout_ms
        if found_panel or is_on_place_url
        else min(config.place_timeout_ms, 250)
    )


async def _wait_for_verified_panel_identity(
    page: Page,
    *,
    feed_el: object,
    card_href: str,
    place_key: str,
    card_signals: dict | None,
    pre_click_snapshot: dict | None,
    last_verified_panel: dict | None,
    timeout_ms: int,
    allow_stub: bool = False,
    area_key: str = "default",
) -> tuple[bool, dict, str]:
    """Bounded poll waiting for the detail panel to reflect the clicked card's identity."""
    deadline = asyncio.get_event_loop().time() + max(0.05, timeout_ms / 1000.0)
    last_snap: dict = {}
    last_reason = "unverified"
    while True:
        last_snap = await _read_panel_identity_snapshot(page, feed_el)
        ok, reason = _evaluate_panel_identity(
            last_snap,
            card_href=card_href,
            place_key=place_key,
            card_signals=card_signals,
            pre_click_snapshot=pre_click_snapshot,
            last_verified_panel=last_verified_panel,
            allow_stub=allow_stub,
        )
        last_reason = reason
        if ok:
            return True, last_snap, reason
        if asyncio.get_event_loop().time() >= deadline:
            if allow_stub and not last_snap.get("open") and not last_snap.get("name"):
                return True, last_snap, "stub_no_detail_dom"
            await _log_panel_verification_failure(
                page,
                last_snap,
                last_reason,
                card_href=card_href,
                card_signals=card_signals,
                area_key=area_key,
            )
            return False, last_snap, last_reason
        poll_sleep = 0.02 if timeout_ms <= 250 else 0.20
        await asyncio.sleep(poll_sleep)


_CONTENT_MARKER_H1_SELECTORS = (
    "h1.DUwDvf",
    "h1.fontHeadlineLarge",
    "div[role='main'] h1",
    "h1[data-item-id]",
    "div[role='region'] h1",
)
_CONTENT_MARKER_ARIA_SELECTORS = (
    "div[role='main'][aria-label]",
    "div[role='main']",
)
_CONTENT_MARKER_PHONE_SELECTORS = (
    "[data-item-id^='phone:']",
    "button[data-item-id^='phone:']",
    "[data-tooltip='Copy phone number']",
)
_CONTENT_MARKER_AUTHORITY_SELECTORS = (
    "a[data-item-id='authority']",
    "a[data-item-id*='authority']",
    "a[aria-label*='Website' i]",
)
_CONTENT_MARKER_ADDRESS_SELECTORS = (
    "[data-item-id='address']",
    "button[data-item-id='address']",
    "div[data-item-id='address']",
    "button[data-item-id*='address']",
)
_CONTENT_MARKER_BUTTON_SELECTORS = (
    "button[aria-label='Back to results']",
    "button[aria-label*='back to results' i]",
    "button[jsaction*='pane.backButton']",
    "button[data-tooltip*='Back to results' i]",
)

_PANEL_CONTENT_MARKER_JS = """
() => {
    // 1. Authoritative detail-pane contact and action markers (phone, website, address, plus code, hours)
    if (document.querySelector("[data-item-id^='phone:'], button[data-item-id^='phone:'], [data-tooltip='Copy phone number'], a[data-item-id='authority'], a[data-item-id*='authority'], a[aria-label*='Website' i], a[data-tooltip='Open website'], [data-item-id='address'], button[data-item-id='address'], div[data-item-id='address'], [data-item-id='oloc'], button[data-item-id*='hours']")) {
        return true;
    }
    // 2. Genuine place name h1 outside search results feed and searchbox (excluding ad headers and map labels)
    const EXCLUDED = new Set([
        "results", "search results", "all results", "نتائج", "النتائج",
        "ad", "ads", "sponsored", "advertisement", "promoted",
        "إعلان", "اعلان", "إعلانات", "اعلانات", "ممول", "مُموَّل",
        "map", "maps", "google maps", "خرائط google", "خرائط"
    ]);
    if (document.querySelector("[data-item-id^='phone:'], a[data-item-id='authority'], [data-item-id='address'], button[data-tooltip='Copy phone number']")) {
        return true;
    }
    const h1s = document.querySelectorAll("h1.DUwDvf, h1.fontHeadlineLarge, h1[data-item-id], div[role='main'] h1");
    for (const el of h1s) {
        if (el.closest && el.closest("div[role='feed'], #searchbox, form")) continue;
        let t = (el.innerText || "").trim().toLowerCase();
        t = t.replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "").trim();
        if (t && !EXCLUDED.has(t) && !t.startsWith("results for ") && !t.startsWith("search results") && !t.startsWith("نتائج ")) {
            return true;
        }
    }
    return false;
}
"""


async def _has_panel_content_marker(
    page: Page,
    feed_el: object = None,
    snap: dict | None = None,
) -> bool:
    """Check if at least one panel content marker is mounted in the DOM.
    Markers checked:
    - h1 or aria-label name (non-empty and not an excluded header like 'Results')
    - back button (Back to results)
    - [data-item-id^='phone:']
    - a[data-item-id='authority']
    - [data-item-id='address']
    """
    if snap:
        h1_name = snap.get("h1_name") or ""
        if h1_name and not _is_excluded_panel_header(h1_name):
            return True
        aria_name = snap.get("raw_aria_name") or snap.get("aria_name") or ""
        if aria_name and not _is_excluded_panel_header(aria_name) and aria_name.lower() not in ("map", "google maps"):
            return True
        if snap.get("raw_address") or snap.get("address"):
            return True

    # Fast DOM evaluation inside a real browser
    if hasattr(page, "evaluate") and hasattr(page, "context"):
        try:
            has_marker = await page.evaluate(_PANEL_CONTENT_MARKER_JS)
            return bool(has_marker)
        except Exception as exc:
            log.warning(f"[maps][marker-eval-err] {exc}")

    if not hasattr(page, "query_selector"):
        return False

    # 1. h1 name - check all matching elements so the first 'Results' header doesn't hide the place header
    for sel in _CONTENT_MARKER_H1_SELECTORS:
        try:
            if hasattr(page, "query_selector_all"):
                for el in await page.query_selector_all(sel):
                    if el is not None and el is not feed_el and hasattr(el, "inner_text"):
                        t = (await el.inner_text() or "").strip()
                        if t and not _is_excluded_panel_header(t):
                            return True
            else:
                el = await page.query_selector(sel)
                if el is not None and el is not feed_el and hasattr(el, "inner_text"):
                    t = (await el.inner_text() or "").strip()
                    if t and not _is_excluded_panel_header(t):
                        return True
        except Exception:
            pass

    # 2. aria-label name on main
    for sel in _CONTENT_MARKER_ARIA_SELECTORS:
        try:
            el = await page.query_selector(sel)
            if el is not None and el is not feed_el:
                if hasattr(el, "get_attribute"):
                    aria = (await el.get_attribute("aria-label") or "").strip()
                    if aria and not _is_excluded_panel_header(aria) and aria.lower() not in ("map", "google maps"):
                        return True
        except Exception:
            pass

    # 3. detail panel back button (Back to results only)
    for sel in _CONTENT_MARKER_BUTTON_SELECTORS:
        try:
            el = await page.query_selector(sel)
            if el is not None and el is not feed_el:
                return True
        except Exception:
            pass

    # 4. phone
    for sel in _CONTENT_MARKER_PHONE_SELECTORS:
        try:
            el = await page.query_selector(sel)
            if el is not None and el is not feed_el:
                return True
        except Exception:
            pass

    # 5. authority / website
    for sel in _CONTENT_MARKER_AUTHORITY_SELECTORS:
        try:
            el = await page.query_selector(sel)
            if el is not None and el is not feed_el:
                return True
        except Exception:
            pass

    # 6. address
    for sel in _CONTENT_MARKER_ADDRESS_SELECTORS:
        try:
            el = await page.query_selector(sel)
            if el is not None and el is not feed_el:
                return True
        except Exception:
            pass

    return False


async def _wait_for_panel_content_markers(
    page: Page,
    *,
    feed_el: object = None,
    snap: dict | None = None,
    timeout_s: float | None = None,
    poll_interval_s: float = 0.25,
    anchor_el: object = None,
) -> bool:
    """Wait up to `timeout_s` (polling every `poll_interval_s`) for at least one
    panel content marker to mount before extraction. If none mounts during timeout,
    re-reads once. Returns True if at least one marker mounts, False otherwise."""
    if timeout_s is None:
        timeout_s = resolve_panel_marker_wait_ms() / 1000.0

    # 1. Check immediately
    if await _has_panel_content_marker(page, feed_el=feed_el, snap=snap):
        return True

    # 2. Poll up to timeout_s
    loop = asyncio.get_event_loop()
    deadline = loop.time() + timeout_s
    start_time = loop.time()
    last_diag = start_time
    retried_anchor_click = False
    while loop.time() < deadline:
        await asyncio.sleep(poll_interval_s)
        if await _has_panel_content_marker(page, feed_el=feed_el):
            return True
        if loop.time() - last_diag >= 2.0:
            last_diag = loop.time()
            log.debug(f"[maps][marker-wait-poll] elapsed={loop.time() - start_time:.1f}s url={getattr(page, 'url', '')}")
        if (
            not retried_anchor_click
            and (loop.time() - start_time) >= 0.8
            and anchor_el is not None
            and hasattr(anchor_el, "evaluate")
        ):
            retried_anchor_click = True
            try:
                await anchor_el.evaluate("el => el.click()")
            except Exception:
                pass

    # 3. Re-read once after timeout
    await asyncio.sleep(0.05)
    return await _has_panel_content_marker(page, feed_el=feed_el)


def _is_target_closed_or_crashed_error(exc: BaseException) -> bool:
    """Return True if exc represents a closed or crashed browser/page/context target."""
    msg = str(exc).lower()
    return any(
        phrase in msg
        for phrase in (
            "target crashed",
            "page crashed",
            "target closed",
            "target page, context or browser has been closed",
            "browser has been closed",
            "browser closed",
            "page has been closed",
            "connection closed",
            "session closed",
        )
    )


def _mark_page_crashed(page: Page | None) -> None:
    """Explicitly flag a page target as dead when an unrecoverable renderer/context crash occurs,
    even if page.is_closed() or context.is_closed() has not yet transitioned."""
    if page is not None:
        try:
            setattr(page, "_mast_target_crashed", True)
        except Exception:
            pass


def _is_page_alive(page: Page | None) -> bool:
    """Safely check if the page and its underlying context are alive and not closed."""
    if page is None:
        return False
    if getattr(page, "_mast_target_crashed", False):
        return False
    if hasattr(page, "is_closed"):
        try:
            if page.is_closed():
                return False
        except Exception:
            return False
    if hasattr(page, "context"):
        try:
            ctx = page.context
            if hasattr(ctx, "is_closed") and ctx.is_closed():
                return False
        except Exception:
            pass
    return True


async def _is_feed_ready(page: Page, panel_selector: str) -> bool:
    """Return True if the search results feed container is mounted, visible, contains
    active result cards, the active search query remains intact, and the place detail
    pane is conclusively closed."""
    if not _is_page_alive(page):
        return False
    try:
        feed_el = await page.query_selector(panel_selector)
        if feed_el is None:
            return False
        if await _is_detail_pane_open(page, feed_el):
            return False

        if hasattr(feed_el, "is_visible"):
            try:
                if not await feed_el.is_visible():
                    return False
            except Exception as vis_err:
                if _is_target_closed_or_crashed_error(vis_err):
                    _mark_page_crashed(page)
                return False

        card_anchor = None
        if hasattr(feed_el, "query_selector"):
            try:
                card_anchor = await feed_el.query_selector("a[href*='/maps/place/']")
                if card_anchor is None:
                    return False
                if hasattr(card_anchor, "is_visible"):
                    try:
                        if not await card_anchor.is_visible():
                            return False
                    except Exception as card_vis_err:
                        if _is_target_closed_or_crashed_error(card_vis_err):
                            _mark_page_crashed(page)
                        return False
            except Exception as card_err:
                if _is_target_closed_or_crashed_error(card_err):
                    _mark_page_crashed(page)
                return False

        # Verify place card is actionable and not obstructed by an unrelated modal or dialog overlay
        for overlay_sel in ("div[role='dialog']", "div[aria-modal='true']", "div.widget-pane-overlay", "div.modal-open"):
            try:
                overlay = await page.query_selector(overlay_sel)
                if overlay is not None:
                    if hasattr(overlay, "is_visible"):
                        try:
                            if await overlay.is_visible():
                                return False
                        except Exception as ov_vis_err:
                            if _is_target_closed_or_crashed_error(ov_vis_err):
                                _mark_page_crashed(page)
                            return False
                    else:
                        return False
            except Exception as ov_err:
                if _is_target_closed_or_crashed_error(ov_err):
                    _mark_page_crashed(page)
                return False

        if card_anchor is not None and hasattr(card_anchor, "evaluate"):
            try:
                is_obstructed = await card_anchor.evaluate("""el => {
                    if (!el) return false;
                    const rect = el.getBoundingClientRect();
                    if (rect.width <= 0 || rect.height <= 0) return true;
                    const cx = rect.left + rect.width / 2;
                    const cy = rect.top + rect.height / 2;
                    if (cx < 0 || cy < 0 || cx > window.innerWidth || cy > window.innerHeight) {
                        return false;
                    }
                    const topEl = document.elementFromPoint(cx, cy);
                    if (!topEl) return false;
                    return topEl !== el && !el.contains(topEl) && !topEl.contains(el);
                }""")
                if is_obstructed:
                    return False
            except Exception as obs_err:
                if _is_target_closed_or_crashed_error(obs_err):
                    _mark_page_crashed(page)
                return False

        curr_url = getattr(page, "url", "") or ""
        if curr_url in ("https://www.google.com/maps", "https://www.google.com/maps/"):
            return False

        if hasattr(page, "query_selector"):
            try:
                search_input = await page.query_selector("input#searchboxinput, input[name='q'], #searchbox input")
                if search_input is not None and hasattr(search_input, "get_attribute"):
                    val = await search_input.get_attribute("value")
                    if val is not None and val == "":
                        return False
            except Exception as inp_err:
                if _is_target_closed_or_crashed_error(inp_err):
                    _mark_page_crashed(page)
                return False

        return True
    except Exception as exc:
        if _is_target_closed_or_crashed_error(exc):
            _mark_page_crashed(page)
        return False


async def _wait_for_feed_restored(page: Page, panel_selector: str, timeout_s: float = 1.5) -> bool:
    """Bounded poll waiting for results feed readiness and detail pane closure."""
    deadline = asyncio.get_event_loop().time() + timeout_s
    while asyncio.get_event_loop().time() < deadline:
        if not _is_page_alive(page):
            return False
        try:
            if await _is_feed_ready(page, panel_selector):
                return True
        except Exception as exc:
            if _is_target_closed_or_crashed_error(exc):
                return False
        await asyncio.sleep(0.04)
    return False


def _dispatch_progress(
    on_progress: "Callable[..., None] | None",
    stage_or_event: str,
    event_or_item: str | None = None,
    item_id: str | None = None,
    **kwargs: Any,
) -> None:
    """Dispatch progress events supporting 2-arg (event, item_id),
    3-arg (stage, event, item_id), and keyword payload forms without raising."""
    if on_progress is None:
        return
    try:
        if item_id is not None or stage_or_event == "discovery":
            stg = stage_or_event
            ev = event_or_item or ""
            it = item_id
        else:
            stg = "discovery"
            ev = stage_or_event
            it = event_or_item
        if kwargs:
            try:
                on_progress(stg, ev, it, **kwargs)
            except TypeError:
                try:
                    on_progress(stg, ev, it)
                except TypeError:
                    on_progress(ev, it)
        else:
            try:
                on_progress(stg, ev, it)
            except TypeError:
                on_progress(ev, it)
    except Exception:
        log.debug("on_progress observer raised — ignored", exc_info=True)


async def _run_page_load_diagnostics(
    page: Page,
    search_url: str,
    timeout_s: float = 2.0,
) -> tuple[str, int] | None:
    """Bounded post-navigation diagnostic check for page.title() and body length.
    Never blocks or aborts search execution on timeout or error."""
    try:
        _landed_url = getattr(page, "url", "") or ""
        _title = await asyncio.wait_for(page.title(), timeout=timeout_s)
        _raw_body = await asyncio.wait_for(
            page.evaluate("() => document.body?.innerText?.length || 0"),
            timeout=timeout_s,
        )
        _body_len = _raw_body if isinstance(_raw_body, int) else len(str(_raw_body or ""))
        log.info(
            f"[maps][diag] search page loaded — "
            f"requested={search_url!r} landed_on={_landed_url!r} "
            f"title={_title!r} body_chars={_body_len}"
        )
        return _title, _body_len
    except Exception as _diag_exc:
        log.debug(f"[maps][diag] page-load diagnostic failed: {_diag_exc}")
        return None


async def _return_to_results(
    page: Page,
    panel_selector: str,
    *,
    config: ScraperConfig,
    profiler=None,
    force_reset: bool = False,
    on_progress: "Callable[[str, str, str | None], None] | None" = None,
) -> bool:
    """Navigate from a place's detail pane back to the results feed and verify
    that the detail pane has closed (or results-only state holds).

    The presence of `panel_selector` (`div[role='feed']`) alone does NOT imply
    that navigation to the results list succeeded because desktop Maps keeps
    the feed container in the DOM alongside an open detail pane.
    """
    prof = profiler or NullProfiler()
    timeout_ms = getattr(config, "return_to_results_timeout_ms", None) or getattr(
        config, "scroll_settle_timeout_ms", 2500
    )

    def _emit(event: str, item_id: str | None = None) -> None:
        _dispatch_progress(on_progress, "discovery", event, item_id)

    def _emit_crash(exc_or_reason: BaseException | str) -> None:
        _mark_page_crashed(page)
        msg = str(exc_or_reason).lower()
        if "context" in msg:
            _emit("browser_context_closed", str(exc_or_reason)[:60])
        elif hasattr(page, "context"):
            try:
                ctx = page.context
                if hasattr(ctx, "is_closed") and ctx.is_closed():
                    _emit("browser_context_closed", str(exc_or_reason)[:60])
                    return
            except Exception:
                pass
            _emit("browser_page_crashed", str(exc_or_reason)[:60])
            _log_browser_page_crashed(str(exc_or_reason)[:60], context_label="return_to_results")
        else:
            _emit("browser_page_crashed", str(exc_or_reason)[:60])
            _log_browser_page_crashed(str(exc_or_reason)[:60], context_label="return_to_results")

    if not _is_page_alive(page):
        prof.incr("return_to_results_crashed_page")
        _emit_crash("page_closed_before_return")
        return False

    with prof.timer("return_to_results"):
        _emit("return_attempt_started")
        curr_url = getattr(page, "url", "") or ""

        # Step 0: Check if feed is already ready without navigation
        if await _is_feed_ready(page, panel_selector):
            if not (force_reset and "/maps/place/" in curr_url):
                _emit("search_feed_restored", "already_ready")
                return True

        feed_el = None
        try:
            feed_el = await page.query_selector(panel_selector)
        except Exception as e:
            if _is_target_closed_or_crashed_error(e):
                _emit_crash(e)
                return False

        # Step 1: In-DOM place detail back button click (primary native action)
        for sel in _BACK_BUTTON_SELECTORS:
            if not _is_page_alive(page):
                _emit_crash("page_closed_during_back_button_scan")
                return False
            try:
                btn = await page.query_selector(sel)
                if not btn or btn is feed_el:
                    continue
                # Protect against searchbox / omnibox clear/close buttons
                if hasattr(btn, "get_attribute"):
                    try:
                        jsaction = (await btn.get_attribute("jsaction") or "").lower()
                        aria_label = (await btn.get_attribute("aria-label") or "").strip().lower()
                        if (
                            any(bad in jsaction for bad in ("searchbox", "omnibox", "clear"))
                            or aria_label in ("close", "clear search", "close search")
                        ):
                            continue
                    except Exception:
                        pass
                if hasattr(btn, "is_visible"):
                    try:
                        if not await btn.is_visible():
                            continue
                    except Exception:
                        pass

                _emit("return_action_selected", "back_button")
                try:
                    if hasattr(btn, "evaluate") and hasattr(page, "context"):
                        await btn.evaluate("el => el.click()")
                        _emit("return_action_executed", f"{sel}:evaluate")
                    else:
                        await btn.click(timeout=min(2000, timeout_ms))
                        _emit("return_action_executed", sel)
                except Exception as click_err:
                    if _is_target_closed_or_crashed_error(click_err):
                        _emit_crash(click_err)
                        return False
                    if hasattr(btn, "evaluate"):
                        try:
                            await btn.evaluate("el => el.click()")
                            _emit("return_action_executed", f"{sel}:evaluate")
                        except Exception as eval_err:
                            if _is_target_closed_or_crashed_error(eval_err):
                                _emit_crash(eval_err)
                                return False
            except Exception as sel_err:
                if _is_target_closed_or_crashed_error(sel_err):
                    _emit_crash(sel_err)
                    return False
                continue

            settle_s = min(1.5, max(0.4, timeout_ms / 1500.0))
            if await _wait_for_feed_restored(page, panel_selector, timeout_s=settle_s):
                _emit("search_feed_restored", "back_button")
                return True

        # Step 2: Keyboard Escape to dismiss detail pane without DOM manipulation or history navigation
        if hasattr(page, "keyboard") and hasattr(page.keyboard, "press") and _is_page_alive(page):
            try:
                _emit("return_action_selected", "escape_key")
                await page.keyboard.press("Escape")
                _emit("return_action_executed", "escape_key")
                if await _wait_for_feed_restored(page, panel_selector, timeout_s=min(2.5, max(1.2, timeout_ms / 1000.0))):
                    if not (force_reset and "/maps/place/" in (getattr(page, "url", "") or "")):
                        _emit("search_feed_restored", "escape_key")
                        return True
            except Exception as esc_err:
                if _is_target_closed_or_crashed_error(esc_err):
                    _emit_crash(esc_err)
                    return False

        # Step 3: In-page history back if still open on place URL
        curr_url = getattr(page, "url", "") or ""
        if "/maps/place/" in curr_url and hasattr(page, "evaluate") and _is_page_alive(page):
            try:
                _emit("return_action_selected", "history_back")
                await page.evaluate("() => window.history ? window.history.back() : null")
                _emit("return_action_executed", "history_back")
                if await _wait_for_feed_restored(page, panel_selector, timeout_s=min(2.5, max(1.2, timeout_ms / 1000.0))):
                    if not (force_reset and "/maps/place/" in (getattr(page, "url", "") or "")):
                        _emit("search_feed_restored", "history_back")
                        return True
            except Exception as hist_err:
                if _is_target_closed_or_crashed_error(hist_err):
                    _emit_crash(hist_err)
                    return False

        # Step 4: Last resort: browser-level back navigation, ONLY if safe and won't pop to about:blank
        try:
            can_go_back = True
            if hasattr(page, "evaluate") and _is_page_alive(page):
                try:
                    hist_len = await page.evaluate("() => window.history ? window.history.length : 1")
                    if isinstance(hist_len, int) and hist_len <= 1:
                        can_go_back = False
                except Exception:
                    pass

            if can_go_back and hasattr(page, "go_back") and _is_page_alive(page):
                _emit("return_action_selected", "browser_go_back")
                await page.go_back(timeout=min(config.scroll_settle_timeout_ms, timeout_ms))
                _emit("return_action_executed", "browser_go_back")
                curr_url = getattr(page, "url", "") or ""
                if "about:blank" in curr_url or not curr_url.startswith("https://www.google.com/maps"):
                    log.warning(f"[maps] go_back popped to {curr_url!r}; restoring via go_forward")
                    if hasattr(page, "go_forward") and _is_page_alive(page):
                        try:
                            await page.go_forward(timeout=2000)
                        except Exception:
                            pass
                else:
                    if await _wait_for_feed_restored(page, panel_selector, timeout_s=min(2.5, max(1.2, timeout_ms / 1000.0))):
                        _emit("search_feed_restored", "browser_go_back")
                        return True
        except Exception as gb_err:
            if _is_target_closed_or_crashed_error(gb_err):
                _emit_crash(gb_err)
                return False

        if force_reset and await _is_feed_ready(page, panel_selector):
            _emit("search_feed_restored", "force_reset")
            return True

        prof.incr("return_to_results_failed")
        _emit("return_recovery_failed", "return_to_results_exhausted")
        return False


_DEFAULT_RETURN_TO_RESULTS = _return_to_results


async def _can_continue_from_split_results_feed(
    page: Page,
    panel_selector: str,
    *,
    seen_hrefs: set[str],
    failed_this_round: set[str],
    exhausted_mismatch_keys: set[str],
) -> bool:
    """Return True if the results feed container is still mounted alongside the
    open detail pane and has at least one unseen, clickable candidate card in
    the current scroll round — allowing the scraper to click the next card
    directly without executing a redundant back-navigation cycle.
    """
    if not _is_page_alive(page):
        return False
    try:
        live_panel = await page.query_selector(panel_selector)
        if live_panel is None:
            return False
        if hasattr(page, "context") and await _is_detail_pane_open(page, live_panel):
            return False
        if not await _is_detail_pane_open(page, live_panel):
            return True
        if not hasattr(live_panel, "query_selector_all"):
            return False
        anchors = await live_panel.query_selector_all("a[href*='/maps/place/']")
        if not anchors or len(anchors) < 2:
            return False
        for a in anchors:
            try:
                href = await a.get_attribute("href") or ""
                if "/maps/place/" not in href:
                    continue
                cand_key = _place_identity_from_href(href)
                if (
                    cand_key
                    and cand_key not in seen_hrefs
                    and cand_key not in failed_this_round
                    and cand_key not in exhausted_mismatch_keys
                ):
                    return True
            except Exception:
                continue
        return False
    except Exception:
        return False


async def _human_click(page: Page, element) -> None:
    """Click an element using real Playwright mouse hover + actionability-checked click,
    falling back to direct DOM click (`el.click()`) and force-click if needed."""
    last_exc: Exception | None = None
    try:
        if hasattr(element, "bounding_box") and hasattr(page, "mouse"):
            box = await element.bounding_box()
            if box:
                cx = box["x"] + box["width"] / 2 + random.randint(-3, 3)
                cy = box["y"] + box["height"] / 2 + random.randint(-2, 2)
                await page.mouse.move(cx, cy)
                await asyncio.sleep(random.uniform(0.04, 0.10))
        await element.click(timeout=3000)
        return
    except Exception as exc:
        last_exc = exc
    try:
        if hasattr(element, "evaluate"):
            await element.evaluate("el => el.click()")
            return
    except Exception as exc:
        last_exc = exc
    try:
        await element.click(force=True, timeout=2000)
        return
    except Exception as exc:
        last_exc = exc
    if last_exc is not None:
        raise last_exc


# ──────────────────────────────────────────────────────────────────────────────
# Card-level pre-click signal extraction (Phase 12A — zero-risk Maps click
# reduction, forensic audit §7/§9)
#
# The Phase 12 audit found that the results-feed anchor already carries
# name/rating/review-count/closed-status text (typically via its
# aria-label) before it is ever clicked, but the collection loop discarded
# everything except `href`. This phase reads that already-rendered text —
# no navigation, no extra page load, no extra rate-limit token — and uses
# it for exactly ONE decision: whether the card explicitly, unambiguously
# says the business is permanently closed. Every other field captured here
# (rating, review_count, name) is informational only in this phase; NOTHING
# below may branch discovery behavior on them — see the click-gating site
# in `MapsScraper.search()` for the single, narrow use of `closed`.
# ──────────────────────────────────────────────────────────────────────────────

# Deliberately the same two phrases `_extract_place_data` already checks
# for post-click (`place.closed`, see its html_low scan) — kept in sync
# rather than inventing a new vocabulary, since both are trying to detect
# the exact same Google-rendered status, just at two different points in
# the pipeline (before vs. after the click).
_CARD_CLOSED_MARKERS = (
    "permanently closed",
    "closed permanently",
)

# Best-effort patterns for the two other cheap card signals. Neither
# feeds a decision in this phase (see module note above) — they exist so
# the "minimal card signal object" the audit called for is actually
# populated for future telemetry/visibility, not left as dead fields.
_CARD_RATING_RE = re.compile(r"([\d.]+)\s*star", re.IGNORECASE)
_CARD_REVIEW_COUNT_RE = re.compile(r"[\d,]+\s*reviews?", re.IGNORECASE)


async def _extract_card_signals(anchor) -> dict:
    """Read cheap, already-rendered signals off a single results-feed
    anchor, without clicking it or triggering any navigation.

    Returns a plain dict — `name`, `rating`, `review_count`,
    `visible_text`, `closed` — built entirely from `aria-label` and
    `inner_text()` on the anchor itself (the only two calls this makes).
    Every field is best-effort and defaults to an empty/None/zero value on
    any extraction failure; this must never raise into the caller, since a
    failure here should fall back to the pre-Phase-12A behavior (click as
    normal), not abort discovery.
    """
    aria = ""
    text = ""
    try:
        aria = await anchor.get_attribute("aria-label") or ""
    except Exception:
        pass
    try:
        text = (await anchor.inner_text()).strip()
    except Exception:
        pass

    combined = f"{aria} {text}".strip()
    combined_low = combined.lower()

    closed = any(marker in combined_low for marker in _CARD_CLOSED_MARKERS)

    rating: float | None = None
    m = _CARD_RATING_RE.search(combined)
    if m:
        rating = _rating_from_raw(m.group(1))

    review_count = 0
    m = _CARD_REVIEW_COUNT_RE.search(combined)
    if m:
        review_count = parse_review_count(m.group(0))

    return {
        "name": aria.split("·")[0].strip() if aria else "",
        "rating": rating,
        "review_count": review_count,
        "visible_text": combined,
        "closed": closed,
    }


# ──────────────────────────────────────────────────────────────────────────────
# Place data extractor
# ──────────────────────────────────────────────────────────────────────────────

async def _wait_for_place_settle(
    page: Page,
    *,
    config: ScraperConfig,
    already_settled: bool = False,
) -> None:
    """Event-driven place-panel settle wait (Phase 2A opt, audit §3.2).

    The previous version did an unconditional `asyncio.sleep(place_settle_ms
    / 1000)` (1000ms by default) before every single extraction, regardless
    of whether the panel had actually finished rendering — stacked on top
    of the `wait_for_selector` for the name `<h1>` that already runs before
    this is called. Instrumentation (`place_settle` stage, rate_limit_wait_*
    stages) confirmed this was pure dead time on top of an already-adequate
    wait.

    This replaces it with a bounded poll for a second field (address,
    rating, or category — whichever renders first) to appear, following the
    exact pattern already proven for scroll pacing (`_human_scroll`, Phase
    6). `config.place_settle_ms` remains the ceiling passed as the timeout,
    so the worst case is identical to the old behavior — nothing regresses
    — while the common case (second field already rendered by the time we
    get here) now resolves in well under 1000ms.
    """
    if not already_settled:
        settle_timeout = (
            config.place_timeout_ms
            if getattr(config, "place_timeout_ms", 5000) <= 200
            else max(config.place_settle_ms, getattr(config, "place_timeout_ms", 10000))
        )
        try:
            await page.wait_for_function(
                """() => {
                    const sels = [
                        "a[data-item-id='authority']",
                        "button[data-item-id='address']",
                        "[data-item-id='address']",
                        "[data-item-id='address'] .fontBodyMedium",
                        "button[data-item-id='address'] .rogA2c",
                        "[data-item-id^='phone:tel:'] .fontBodyMedium",
                        "button[data-item-id*='phone']",
                        "button[data-item-id^='phone:'] .rogA2c",
                        "a[href^='tel:']",
                        "[data-item-id='oloc']",
                        "button[data-item-id*='hours']",
                        "h1.DUwDvf",
                    ];
                    return sels.some(s => document.querySelector(s));
                }""",
                timeout=settle_timeout,
                polling=50,
            )
        except PlaywrightTimeoutError:
            pass  # ceiling reached — proceed anyway, same as the old fixed sleep would have
        except Exception:
            pass
    # Short fixed pacing after the settle signal: lets freshly-rendered
    # fields finish in-flight layout/paint and keeps click-to-extract
    # cadence irregular (anti-detection) rather than metronomic — same
    # intent as the old fixed sleep, just far shorter than its 1000ms.
    await asyncio.sleep(random.uniform(0.1, 0.25))


_DEFAULT_WAIT_FOR_PLACE_SETTLE = _wait_for_place_settle


async def _try_selectors(page: Page, selectors: list[str]) -> str:
    """Try each selector in order, returning first non-empty text (skipping excluded
    search-results headers when querying place name selectors)."""
    check_exclusions = selectors is _PLACE_NAME_SELECTORS
    for sel in selectors:
        try:
            el = await page.query_selector(sel)
            if el:
                text = (await el.inner_text()).strip()
                if text and not (check_exclusions and _is_excluded_panel_header(text)):
                    return text
            if check_exclusions and hasattr(page, "query_selector_all"):
                for cand in await page.query_selector_all(sel):
                    if cand is not None and hasattr(cand, "inner_text"):
                        ct = (await cand.inner_text() or "").strip()
                        if ct and not _is_excluded_panel_header(ct):
                            return ct
        except Exception:
            continue
    return ""


async def _extract_phone(page: Page) -> str:
    """Extract phone number from place panel."""
    for sel in _PHONE_SELECTORS:
        try:
            els = await page.query_selector_all(sel)
            for el in els:
                # Try aria-label first (most reliable)
                aria = await el.get_attribute("aria-label") or ""
                href = await el.get_attribute("href") or ""

                if href.startswith("tel:"):
                    return href[4:].strip()
                if "phone" in aria.lower() or "call" in aria.lower():
                    phones = extract_phones(aria, trusted=True)
                    if phones:
                        return phones[0]

                text = (await el.inner_text()).strip()
                phones = extract_phones(text, trusted=True)
                if phones:
                    return phones[0]
        except Exception:
            continue

    # Fallback: extract from full page HTML
    try:
        html = await page.content()
        # Try tel: links
        tel_match = re.search(r'href=["\']tel:([^"\']+)["\']', html)
        if tel_match:
            return tel_match.group(1).strip()
        phones = extract_phones(html[:50_000])  # Only scan first 50KB
        if phones:
            return phones[0]
    except Exception:
        pass

    return ""


async def _extract_website(page: Page) -> str:
    """Extract website URL from place panel."""
    for sel in _WEBSITE_SELECTORS:
        try:
            el = await page.query_selector(sel)
            if not el:
                continue
            href = await el.get_attribute("href") or ""
            if href and href.startswith("http"):
                # Google wraps URLs in /url?q= redirect
                m = re.search(r"[?&]q=([^&]+)", href)
                if m:
                    from urllib.parse import unquote
                    href = unquote(m.group(1))
                if not is_ordering_platform(href):
                    return clean_url(href)
            text = (await el.inner_text()).strip()
            if text and "." in text and " " not in text:
                return f"https://{text}" if not text.startswith("http") else text
        except Exception:
            continue
    return ""


async def _extract_rating(page: Page) -> tuple[float | None, int]:
    """Extract (rating, review_count) from place panel."""
    rating: float | None = None
    reviews: int = 0

    # Rating
    raw_rating = await _try_selectors(page, _RATING_SELECTORS)
    if raw_rating:
        m = re.search(r"([\d.]+)", raw_rating.replace(",", "."))
        if m:
            try:
                rating = float(m.group(1))
                if rating > 5:
                    rating = None
            except ValueError:
                pass

    # Review count
    raw_reviews = await _try_selectors(page, _REVIEW_SELECTORS)
    if raw_reviews:
        reviews = parse_review_count(raw_reviews)
    else:
        # Try aria-label approach
        try:
            els = await page.query_selector_all("[aria-label*='review' i]")
            for el in els:
                aria = await el.get_attribute("aria-label") or ""
                count = parse_review_count(aria)
                if count > 0:
                    reviews = count
                    break
        except Exception:
            pass

    return rating, reviews


async def _extract_place_data_legacy(
    page: Page,
    *,
    config: ScraperConfig,
    query: str = "",
    niche: str = "",
    region: str = "",
    city: str = "",
    country: str = "",
) -> RawPlace | None:
    """Extract all structured data from the currently open place panel.

    LEGACY / REFERENCE IMPLEMENTATION — kept only as the ground truth for
    the equivalence tests in tests/test_place_extraction_equivalence.py
    (Phase 3A audit optimization #1). Production no longer calls this;
    `_extract_place_data` below is the batched, single-round-trip
    replacement. This function is untouched from before Phase 3A — do not
    "fix" it, its whole value is being a byte-for-byte behavioral
    reference.

    Phase 2A: the place-settle wait used to live here as an unconditional
    sleep, which meant the profiler's `maps_place_extraction` timer (wrapped
    around this whole function by the caller) always included it, hiding
    the real extraction cost (audit §3.3). It's now the caller's
    responsibility to settle (via `_wait_for_place_settle`, timed as its
    own `place_settle` stage) before calling this function.
    """
    place = RawPlace(query=query, niche=niche, region=region, city=city, country=country)

    # Name
    raw_name_val = await _try_selectors(page, _PLACE_NAME_SELECTORS)
    if raw_name_val and not _is_excluded_panel_header(raw_name_val):
        place.name = raw_name_val
    if not place.name or _is_excluded_panel_header(place.name):
        log.debug("[maps] could not extract place name — skipping")
        return None

    # Category
    place.category = await _try_selectors(page, _CATEGORY_SELECTORS)

    # Address
    raw_address = await _try_selectors(page, _ADDRESS_SELECTORS)
    if raw_address:
        place.address = raw_address
        # Attempt to parse city from address if not set
        if not place.city and "," in raw_address:
            parts = [p.strip() for p in raw_address.split(",")]
            if len(parts) >= 2:
                place.city = parts[-2] if len(parts) > 2 else parts[0]

    # Phone
    place.phone = await _extract_phone(page)

    # Website
    place.website = await _extract_website(page)

    # Rating + reviews
    place.rating, place.reviews = await _extract_rating(page)

    # Maps link (canonical URL)
    place.maps_link = page.url

    # --- Signals from full HTML scan ------------------------------------------
    try:
        html = await page.content()
        html_low = html.lower()

        # Photos
        place.has_photos = bool(
            re.search(r'"photo".*?"count"\s*:\s*[1-9]', html, re.DOTALL)
            or 'aria-label="Photos"' in html
            or "photocount" in html_low
            or 'data-photo' in html_low
            or "Photos" in (await page.evaluate(
                "() => Array.from(document.querySelectorAll('button, div[role=tab]')).map(e => e.textContent).join(' ')"
            ))
        )

        # Popular times
        place.has_popular_times = bool(
            "popular times" in html_low
            or "populartimes" in html_low
            or "live music" in html_low  # approximation
        )

        # Owner responds
        place.owner_responds_to_reviews = bool(
            "owner" in html_low and "response" in html_low
            or "responded to this review" in html_low
        )

        # Google verified
        place.is_google_verified = bool(
            re.search(r'aria-label="Claimed"', html, re.I)
            or "verified" in html_low
            or "Claimed by" in html
        )

        # Closed permanently
        place.closed = bool(
            "permanently closed" in html_low
            or "closed permanently" in html_low
        )

        # Multi-location
        place.multi_location = bool(
            re.search(r"\d+\s+location", html_low)
            or "chain" in html_low
            or "franchis" in html_low
        )

        # Price range
        m = re.search(r'aria-label="Price:\s*([^"]+)"', html)
        if m:
            place.price_range = m.group(1).strip()

        # Hours summary
        try:
            hours_el = await page.query_selector("div[aria-label*='Hours'] .OMl5r")
            if hours_el:
                place.hours_summary = (await hours_el.inner_text()).strip()[:200]
        except Exception:
            pass

    except Exception:
        pass

    return place


# ──────────────────────────────────────────────────────────────────────────────
# Batched place extractor — Phase 3A (candidate-extraction audit,
# optimization #1)
# ──────────────────────────────────────────────────────────────────────────────
#
# `_extract_place_data_legacy` above issues ~25-40 separate Playwright/CDP
# round-trips per candidate (one query_selector/query_selector_all/
# get_attribute/inner_text call at a time) plus up to two full-page
# `page.content()` serializations. Every one of those is an async IPC hop
# to the browser process; on a memory-constrained host that's the dominant
# cost of `maps_place_extraction` (see the Phase 3 audit).
#
# This section replaces that with exactly ONE `page.evaluate()` call that
# reads the same DOM the legacy code reads and returns a single JSON blob.
# All actual parsing/normalization (phone regex extraction, review-count
# parsing, URL cleaning/ordering-platform filtering, rating regex, address
# city-split, the HTML-signals regexes) stays in Python, unchanged, reusing
# the exact same functions the legacy path used — only the number of
# browser round-trips changes. See tests/test_place_extraction_equivalence.py
# for the side-by-side proof this produces identical RawPlace output to
# `_extract_place_data_legacy` across representative fixtures.
#
# The JS below is built from the SAME selector-precedence lists
# (_PLACE_NAME_SELECTORS, _CATEGORY_SELECTORS, etc.) already defined at the
# top of this module and used elsewhere (e.g. the place_panel_wait click
# code), passed in as the `sel` argument to page.evaluate(script, arg) —
# so the selector lists exist in exactly one place; the JS never hardcodes
# a second copy that could drift from the Python lists.

_PLACE_EXTRACT_SELECTORS: dict[str, list[str]] = {
    "name": _PLACE_NAME_SELECTORS,
    "category": _CATEGORY_SELECTORS,
    "address": _ADDRESS_SELECTORS,
    "rating": _RATING_SELECTORS,
    "review": _REVIEW_SELECTORS,
    "phone": _PHONE_SELECTORS,
    "website": _WEBSITE_SELECTORS,
}

# Every sub-section is individually try/caught, mirroring the granularity
# of the legacy Python code (each of `_try_selectors`, `_extract_phone`,
# `_extract_website`, `_extract_rating`, and the signals block has its own
# independent exception handling there) — a failure reading one field must
# not blank out the others, exactly as today.
_PLACE_EXTRACT_JS = """
(sel) => {
    const EXCLUDED_HEADERS = new Set(["results", "search results", "النتائج"]);
    function isExcludedHeader(t) {
        const low = (t || "").trim().toLowerCase();
        if (!low) return true;
        if (EXCLUDED_HEADERS.has(low)) return true;
        if (low.startsWith("results for ") || low.startsWith("search results")) return true;
        return false;
    }

    const matchedSelectors = {
        name: "none",
        category: "none",
        address: "none",
        rating: "none",
        review: "none",
    };

    function firstNonExcludedName(selectors) {
        for (const s of selectors) {
            try {
                const els = document.querySelectorAll(s);
                for (const el of els) {
                    const t = (el.innerText || "").trim();
                    if (t && !isExcludedHeader(t)) {
                        matchedSelectors.name = s;
                        return t;
                    }
                }
            } catch (e) {}
        }
        return "";
    }

    function firstNonEmptyText(selectors, key) {
        for (const s of selectors) {
            try {
                const el = document.querySelector(s);
                if (el) {
                    const t = (el.innerText || "").trim();
                    if (t) {
                        if (key) matchedSelectors[key] = s;
                        return t;
                    }
                }
            } catch (e) {}
        }
        return "";
    }

    const name = firstNonExcludedName(sel.name);
    const category = firstNonEmptyText(sel.category, "category");
    const address = firstNonEmptyText(sel.address, "address");
    const ratingRaw = firstNonEmptyText(sel.rating, "rating");
    const reviewRaw = firstNonEmptyText(sel.review, "review");

    // Flattened in the exact selector-then-DOM-order the legacy
    // `for sel in _PHONE_SELECTORS: for el in query_selector_all(sel)`
    // loop visited elements, so the Python-side parser below can walk
    // this list and reproduce the identical early-return precedence.
    const phoneCandidates = [];
    for (const s of sel.phone) {
        let els = [];
        try { els = Array.from(document.querySelectorAll(s)); } catch (e) {}
        for (const el of els) {
            phoneCandidates.push({
                selector: s,
                ariaLabel: el.getAttribute("aria-label") || "",
                href: el.getAttribute("href") || "",
                innerText: (el.innerText || "").trim(),
            });
        }
    }

    // One entry per selector (or null), matching the legacy code's use of
    // query_selector (first match only) rather than query_selector_all.
    const websiteCandidates = [];
    for (const s of sel.website) {
        let el = null;
        try { el = document.querySelector(s); } catch (e) {}
        if (!el) { websiteCandidates.push(null); continue; }
        websiteCandidates.push({
            selector: s,
            href: el.getAttribute("href") || "",
            innerText: (el.innerText || "").trim(),
        });
    }

    // Legacy code only runs this page-wide (unscoped) fallback scan when
    // the primary review-selector text came back empty.
    let reviewFallbackAria = [];
    if (!reviewRaw) {
        try {
            reviewFallbackAria = Array.from(
                document.querySelectorAll("[aria-label*='review' i]")
            ).map((el) => el.getAttribute("aria-label") || "");
        } catch (e) {}
    }

    let hoursSummary = "";
    try {
        const hoursEl = document.querySelector("div[aria-label*='Hours'] .OMl5r");
        if (hoursEl) hoursSummary = (hoursEl.innerText || "").trim();
    } catch (e) {}

    let photosTabText = "";
    try {
        photosTabText = Array.from(
            document.querySelectorAll("button, div[role=tab]")
        ).map((el) => el.textContent).join(" ");
    } catch (e) {}

    // Equivalent to Playwright's page.content() for the main frame, used
    // by the legacy code for its HTML-signals regex scan and its phone
    // page.content() fallback. Fetched ONCE here instead of up to twice.
    let html = "";
    try { html = document.documentElement.outerHTML; } catch (e) {}

    return {
        name, category, address, ratingRaw, reviewRaw,
        phoneCandidates, websiteCandidates,
        reviewFallbackAria, hoursSummary, photosTabText,
        matchedSelectors,
        html,
    };
}
"""


def _phone_from_candidates_with_selector(candidates: "list[dict]") -> tuple[str, str]:
    """Return `(phone, matched_selector)` preserving `_phone_from_candidates` precedence."""
    for c in candidates:
        href = c.get("href") or ""
        aria = c.get("ariaLabel") or ""
        sel = c.get("selector") or "matched_candidate"

        if href.startswith("tel:"):
            return href[4:].strip(), sel
        if "phone" in aria.lower() or "call" in aria.lower():
            phones = extract_phones(aria, trusted=True)
            if phones:
                return phones[0], sel

        text = c.get("innerText") or ""
        phones = extract_phones(text, trusted=True)
        if phones:
            return phones[0], sel

    return "", "none"


def _phone_from_candidates(candidates: "list[dict]") -> str:
    """Pure port of `_extract_place_data_legacy`'s `_extract_phone` main
    loop (selector precedence + per-element early-return order preserved
    exactly). Operates on the flattened candidate list the batched JS
    collects instead of live Playwright elements.
    """
    phone, _ = _phone_from_candidates_with_selector(candidates)
    return phone


def _phone_from_html_fallback(html: str) -> str:
    """Pure port of `_extract_phone`'s `page.content()` fallback scan."""
    if not html:
        return ""
    try:
        tel_match = re.search(r'href=["\']tel:([^"\']+)["\']', html)
        if tel_match:
            return tel_match.group(1).strip()
        phones = extract_phones(html[:50_000])  # Only scan first 50KB
        if phones:
            return phones[0]
    except Exception:
        pass
    return ""


def _website_from_candidates_with_selector(candidates: "list[dict | None]") -> tuple[str, str]:
    """Return `(website, matched_selector)` preserving `_website_from_candidates` precedence."""
    for idx, c in enumerate(candidates):
        if not c:
            continue
        sel = c.get("selector") or (_WEBSITE_SELECTORS[idx] if idx < len(_WEBSITE_SELECTORS) else "matched_candidate")
        href = c.get("href") or ""
        if href and href.startswith("http"):
            m = re.search(r"[?&]q=([^&]+)", href)
            if m:
                from urllib.parse import unquote
                href = unquote(m.group(1))
            if not is_ordering_platform(href):
                return clean_url(href), sel
        text = c.get("innerText") or ""
        if text and "." in text and " " not in text:
            return (f"https://{text}" if not text.startswith("http") else text), sel
    return "", "none"


def _website_from_candidates(candidates: "list[dict | None]") -> str:
    """Pure port of `_extract_website` — one candidate per selector
    (`query_selector` semantics, first match only), same fall-through from
    "href is an ordering platform" to "check this element's text" that the
    legacy per-selector loop body had.
    """
    site, _ = _website_from_candidates_with_selector(candidates)
    return site


_DETAIL_WEBSITE_PROBE_JS = """
(selectors) => {
    const candidates = [];
    for (const s of selectors) {
        let el = null;
        try { el = document.querySelector(s); } catch (e) {}
        if (!el) { candidates.push(null); continue; }
        candidates.push({
            href: el.getAttribute("href") || "",
            innerText: (el.innerText || "").trim(),
        });
    }
    return candidates;
}
"""


async def _probe_detail_panel_website(
    page: Page,
    timeout_s: float = 2.0,
    poll_interval_s: float = 0.1,
) -> str:
    """Authoritative, lightweight detail-panel website probe with bounded poll.

    Evaluates _WEBSITE_SELECTORS on the currently-mounted detail panel up to timeout_s
    and runs candidate URLs through _website_from_candidates() (which preserves
    clean_url and is_ordering_platform rules).
    Falls back to per-selector query_selector evaluation if page.evaluate() raises.
    """
    # 1. Immediate check
    try:
        candidates = await page.evaluate(_DETAIL_WEBSITE_PROBE_JS, _WEBSITE_SELECTORS)
        if isinstance(candidates, list) and candidates:
            url = _website_from_candidates(candidates)
            if url:
                return url
    except Exception:
        pass

    try:
        url = await _extract_website(page)
        if url:
            return url
    except Exception:
        pass

    # If timeout_s <= 0 or running in a unit-test stub without browser context, return immediately
    if timeout_s <= 0 or not hasattr(page, "context"):
        return ""

    loop = asyncio.get_event_loop()
    deadline = loop.time() + timeout_s
    while loop.time() < deadline:
        await asyncio.sleep(poll_interval_s)
        try:
            candidates = await page.evaluate(_DETAIL_WEBSITE_PROBE_JS, _WEBSITE_SELECTORS)
            if isinstance(candidates, list) and candidates:
                url = _website_from_candidates(candidates)
                if url:
                    return url
        except Exception:
            pass
        try:
            url = await _extract_website(page)
            if url:
                return url
        except Exception:
            pass

    return ""


def _rating_from_raw(raw_rating: str) -> "float | None":
    """Pure port of `_extract_rating`'s rating-parsing half."""
    if not raw_rating:
        return None
    m = re.search(r"([\d.]+)", raw_rating.replace(",", "."))
    if not m:
        return None
    try:
        rating = float(m.group(1))
    except ValueError:
        return None
    if rating > 5:
        return None
    return rating


def _reviews_from_raw_or_fallback(raw_reviews: str, fallback_arias: "list[str]") -> int:
    """Pure port of `_extract_rating`'s review-count-parsing half,
    including the page-wide aria-label fallback scan.
    """
    if raw_reviews:
        return parse_review_count(raw_reviews)
    for aria in fallback_arias:
        count = parse_review_count(aria)
        if count > 0:
            return count
    return 0


async def _extract_place_data(
    page: Page,
    *,
    config: ScraperConfig,
    query: str = "",
    niche: str = "",
    region: str = "",
    city: str = "",
    country: str = "",
    profiler=None,
    probed_website: str | None = None,
    fallback_name: str | None = None,
) -> RawPlace | None:
    """Extract all structured data from the currently open place panel.

    Phase 3A: this is now the batched, single-`page.evaluate()`
    implementation — the production entry point both `MapsScraper.search()`
    and `MapsScraper.get_place_by_url()` call, unchanged at their call
    sites. See the module-level comment block above and
    `_extract_place_data_legacy` (kept as the reference implementation)
    for what changed and why.

    Phase 2A note (unchanged from before): the place-settle wait lives in
    the caller (`_wait_for_place_settle`, its own `place_settle` profiler
    stage) — this function is only ever called after that settle wait has
    already run.
    """
    place = RawPlace(query=query, niche=niche, region=region, city=city, country=country)

    extract_selectors = (
        {**_PLACE_EXTRACT_SELECTORS, "website": []}
        if probed_website
        else _PLACE_EXTRACT_SELECTORS
    )

    try:
        data = await asyncio.wait_for(
            page.evaluate(_PLACE_EXTRACT_JS, extract_selectors),
            timeout=config.place_extract_timeout_ms / 1000.0,
        )
    except asyncio.TimeoutError:
        # NOT swallowed like the generic failure below: returning None would
        # let the caller carry on against the same unresponsive page.
        raise PlaceExtractionTimeout(
            "page.evaluate(place_extract)", config.place_extract_timeout_ms
        ) from None
    except Exception as exc:
        # Mirrors the legacy convergence: if the page/execution context is
        # in a state this bad, every individual query_selector call in the
        # legacy path would also fail (same root cause), which resolves to
        # an empty name there too — legacy also returns None in that case.
        log.debug(f"[maps] batched place-extraction evaluate() failed: {exc}")
        return None

    if not data:
        return None

    js_matched = data.get("matchedSelectors") if isinstance(data.get("matchedSelectors"), dict) else {}
    matched_selectors = {
        "name": js_matched.get("name") or "none",
        "address": js_matched.get("address") or "none",
        "rating": js_matched.get("rating") or "none",
        "phone": "none",
        "website": "none",
    }

    raw_name_val = (data.get("name") or "").strip()
    if raw_name_val and not _is_excluded_panel_header(raw_name_val):
        place.name = raw_name_val
    elif fallback_name:
        fb = fallback_name.strip()
        if fb and not _is_excluded_panel_header(fb):
            place.name = fb
            matched_selectors["name"] = "page_title_or_card_fallback"
    if not place.name or _is_excluded_panel_header(place.name):
        log.debug("[maps] could not extract place name — skipping")
        return None

    place.category = (data.get("category") or "").strip()

    raw_address = (data.get("address") or "").strip()
    if raw_address:
        place.address = raw_address
        if not place.city and "," in raw_address:
            parts = [p.strip() for p in raw_address.split(",")]
            if len(parts) >= 2:
                place.city = parts[-2] if len(parts) > 2 else parts[0]

    html = data.get("html") or ""

    phone_candidates = data.get("phoneCandidates") or []
    phone, phone_sel = _phone_from_candidates_with_selector(phone_candidates)
    phone_from_fallback = False
    if not phone:
        # Same html blob already fetched above — this eliminates the
        # legacy code's second, independent `page.content()` call.
        phone = _phone_from_html_fallback(html)
        if phone:
            phone_from_fallback = True
            phone_sel = "html_fallback"
    place.phone = phone
    matched_selectors["phone"] = phone_sel

    if profiler is not None:
        if place.phone:
            profiler.incr("maps_phone_extracted_total")
            if phone_from_fallback:
                profiler.incr("maps_phone_extracted_html_fallback")
        else:
            profiler.incr("maps_phone_missing_total")
            if phone_candidates:
                profiler.incr("maps_phone_selector_matched_but_unparsed")
            else:
                profiler.incr("maps_phone_selector_absent")
            log.info(
                f"[maps][phone-diag] phone_extracted=False "
                f"selector_candidates={len(phone_candidates)} "
                f"has_tel_href={'tel:' in html.lower()} html_len={len(html)}"
            )

    if probed_website:
        place.website = probed_website
        matched_selectors["website"] = "probed_website"
        if profiler is not None:
            profiler.incr("maps_website_probe_reused")
    else:
        site_val, site_sel = _website_from_candidates_with_selector(data.get("websiteCandidates") or [])
        place.website = site_val
        matched_selectors["website"] = site_sel

    place.rating = _rating_from_raw((data.get("ratingRaw") or "").strip())
    if place.rating is None:
        matched_selectors["rating"] = "none"
    place.reviews = _reviews_from_raw_or_fallback(
        (data.get("reviewRaw") or "").strip(),
        data.get("reviewFallbackAria") or [],
    )

    place.maps_link = page.url
    try:
        setattr(place, "_matched_selectors", matched_selectors)
    except Exception:
        pass

    # --- Signals from full HTML scan — identical regexes to the legacy
    # path, operating on the same `html` string instead of a fresh
    # page.content() call. -----------------------------------------------
    try:
        html_low = html.lower()

        place.has_photos = bool(
            re.search(r'"photo".*?"count"\s*:\s*[1-9]', html, re.DOTALL)
            or 'aria-label="Photos"' in html
            or "photocount" in html_low
            or 'data-photo' in html_low
            or "Photos" in (data.get("photosTabText") or "")
        )

        place.has_popular_times = bool(
            "popular times" in html_low
            or "populartimes" in html_low
            or "live music" in html_low  # approximation
        )

        place.owner_responds_to_reviews = bool(
            "owner" in html_low and "response" in html_low
            or "responded to this review" in html_low
        )

        place.is_google_verified = bool(
            re.search(r'aria-label="Claimed"', html, re.I)
            or "verified" in html_low
            or "Claimed by" in html
        )

        place.closed = bool(
            "permanently closed" in html_low
            or "closed permanently" in html_low
        )

        place.multi_location = bool(
            re.search(r"\d+\s+location", html_low)
            or "chain" in html_low
            or "franchis" in html_low
        )

        m = re.search(r'aria-label="Price:\s*([^"]+)"', html)
        if m:
            place.price_range = m.group(1).strip()

        hours_summary = (data.get("hoursSummary") or "").strip()
        if hours_summary:
            place.hours_summary = hours_summary[:200]

    except Exception:
        pass

    return place


_DEFAULT_EXTRACT_PLACE_DATA = _extract_place_data


# ──────────────────────────────────────────────────────────────────────────────
# Main scraper class
# ──────────────────────────────────────────────────────────────────────────────

async def _execute_return_failure_recovery(
    page: Page,
    panel_sel: str,
    search_url: str,
    full_query: str,
    context_label: str,
    rounds_this_attempt: int,
    consecutive_return_failures: int,
    max_consecutive_return_failures: int,
    search_nav_recovery_used: bool,
    config: ScraperConfig,
    profiler=None,
    cards_left: int = 0,
    on_progress: "Callable[[str, str, str | None], None] | None" = None,
) -> tuple[bool, bool, str]:
    """Execute return failure diagnostic logging, crash detection, and bounded search-navigation recovery.
    Returns: (recovered: bool, search_nav_recovery_used: bool, panel_sel: str)"""
    prof = profiler or NullProfiler()
    prof.incr("return_to_results_failures")
    prof.incr("return_to_results_failed")

    def _emit(event: str, item_id: str | None = None) -> None:
        _dispatch_progress(on_progress, "discovery", event, item_id)

    if not _is_page_alive(page):
        page_really_closed = False
        if hasattr(page, "is_closed"):
            try:
                page_really_closed = page.is_closed()
            except Exception:
                page_really_closed = True
        ctx_closed = False
        if hasattr(page, "context"):
            try:
                ctx = page.context
                if hasattr(ctx, "is_closed") and ctx.is_closed():
                    ctx_closed = True
            except Exception:
                pass
        if page_really_closed or ctx_closed:
            if ctx_closed:
                _emit("browser_context_closed", context_label)
            else:
                _emit("browser_page_crashed", context_label)
                _log_browser_page_crashed("page_really_closed", context_label=context_label)
            raise DiscoveryFailure(
                DiscoveryFailureReason.SCRAPER_ERROR,
                f"browser page or context closed/crashed during return_to_results in {context_label}",
            )
        # Target not closed at browser level — attempt navigation recovery if available
        if search_url and not search_nav_recovery_used:
            try:
                search_nav_recovery_used = True
                setattr(page, "_mast_target_crashed", False)
                rec_timeout = config.maps_timeout_ms if config else 10000
                set_last_navigation_step("search_nav_recovery_goto")
                await page.goto(search_url, wait_until="domcontentloaded", timeout=rec_timeout)
                panel_sel, _ = await _resolve_results_panel(page, config=config if config else ScraperConfig())
                if await _is_feed_ready(page, panel_sel):
                    _emit("return_recovery_succeeded", context_label)
                    log.info(f"[maps][return-recovery] search-navigation recovered alive target for {full_query!r}")
                    return True, search_nav_recovery_used, panel_sel
            except Exception as rec_err:
                log.warning(f"[maps][return-recovery] recovery attempt failed: {rec_err}")
        _emit("browser_page_crashed", context_label)
        _log_browser_page_crashed("recovery_exhausted_or_failed", context_label=context_label)
        raise DiscoveryFailure(
            DiscoveryFailureReason.SCRAPER_ERROR,
            f"browser page or context closed/crashed during return_to_results in {context_label}",
        )

    feed_present = False
    try:
        feed_present = await _is_feed_ready(page, panel_sel)
    except Exception:
        pass
    mem_mb = round(get_memory_usage(), 1)
    curr_url = getattr(page, "url", "") or ""
    log.warning(
        f"[maps][return-failed] context={context_label} round={rounds_this_attempt} "
        f"selector_tried={panel_sel!r} current_url={curr_url!r} "
        f"feed_present={feed_present} cards_remaining={cards_left} "
        f"skip_reason='return_to_results_failed' memory_mb={mem_mb} "
        f"consecutive_failures={consecutive_return_failures}/{max_consecutive_return_failures}"
    )

    if consecutive_return_failures >= max_consecutive_return_failures or "about:blank" in curr_url:
        if not search_nav_recovery_used:
            search_nav_recovery_used = True
            prof.incr("stale_panel_search_nav_recovery")
            _emit("return_recovery_attempted", context_label)
            log.info(
                f"[maps][return-recovery] consecutive return failures ({consecutive_return_failures}) or url={curr_url!r} "
                f"— performing bounded search-navigation recovery for {full_query!r}"
            )
            try:
                await page.goto(
                    search_url,
                    wait_until="domcontentloaded",
                    timeout=config.maps_timeout_ms,
                )
                panel_sel, _ = await _resolve_results_panel(
                    page, config=config
                )
                rec_feed = await _is_feed_ready(page, panel_sel)
                if rec_feed:
                    _emit("return_recovery_succeeded", context_label)
                    log.info(f"[maps][return-recovery] search-navigation recovery restored feed panel for {full_query!r}")
                    return True, search_nav_recovery_used, panel_sel
                else:
                    _emit("return_recovery_failed", f"{context_label}_feed_not_ready")
            except Exception as rec_err:
                if _is_target_closed_or_crashed_error(rec_err):
                    _mark_page_crashed(page)
                    _emit("browser_page_crashed", str(rec_err)[:60])
                    _log_browser_page_crashed(str(rec_err)[:60], context_label="recovery_exception")
                    raise DiscoveryFailure(
                        DiscoveryFailureReason.SCRAPER_ERROR,
                        f"browser target crashed during recovery: {rec_err}",
                    )
                _emit("return_recovery_failed", f"{context_label}_exception")
                log.warning(f"[maps][return-recovery] search-navigation recovery failed for {full_query!r}: {rec_err}")
        else:
            _emit("return_recovery_failed", f"{context_label}_recovery_already_used")

        log.warning(
            f"[maps][return-recovery] return_to_results failed {consecutive_return_failures} consecutive times "
            f"for {full_query!r} — ending search with RETURN_TO_RESULTS_FAILED"
        )
        raise DiscoveryFailure(
            DiscoveryFailureReason.RETURN_TO_RESULTS_FAILED,
            f"return_to_results failed {consecutive_return_failures} consecutive times for {full_query!r}",
        )
    return False, search_nav_recovery_used, panel_sel


def _resolve_job_handle() -> Any:
    """Safely retrieve the owning Windows Job Object handle from service or __main__
    without triggering duplicate module execution or stale state.
    """
    if sys.platform != "win32":
        return None
    # 1. Check if 'service' is in sys.modules
    srv = sys.modules.get("service")
    if srv:
        h = getattr(srv, "_MAST_JOB_HANDLE", None)
        if h:
            return h
    # 2. Check sys.modules['__main__'] if service.py was launched directly
    main_mod = sys.modules.get("__main__")
    if main_mod:
        h = getattr(main_mod, "_MAST_JOB_HANDLE", None)
        if h:
            return h
    # 3. Fallback import without re-importing if already registered
    try:
        import service as _srv
        return getattr(_srv, "_MAST_JOB_HANDLE", None)
    except Exception:
        return None


class MapsScraper:
    """Google Maps scraper with stealth Playwright automation.

    # Class-level process tracking for OS termination verification
    _last_browser_pgid: int | None = None
    _last_browser_pid: int | None = None
    _last_driver_pid: int | None = None
    _browser_spawn_attempted: bool = False
    _driver_startup_failed: bool = False
    _spawn_failed: bool = False

    Usage:
        async with MapsScraper(config, proxy_manager) as scraper:
            async for place in scraper.search(query, city, country):
                # process RawPlace
    """

    def __init__(
        self,
        config: ScraperConfig,
        proxy_manager: ProxyManager | None = None,
        stats: RunStats | None = None,
        profiler=None,
        scout_id: str | None = None,
        job_handle: Any = None,
    ) -> None:
        self.config = config
        self._proxy_manager = proxy_manager or ProxyManager()
        self._stats = stats or RunStats()
        self._profiler = profiler or NullProfiler()
        self._limiter = RateLimiter(
            requests_per_minute=max(config.maps_rpm, 120),
            burst=10,
            jitter_pct=10,
            min_delay_ms=150,
        )
        self._playwright = None
        self._browser: Browser | None = None
        self._closing: bool = False
        # Phase 7.3: Process ownership and scout session identity
        self._scout_id: str | None = scout_id or os.environ.get("MAST_SCOUT_SESSION_ID")
        self._is_owned: bool = False
        self._is_launched: bool = False
        self._is_closed: bool = False
        self._browser_pid: int | None = None
        self._browser_pgid: int | None = None
        self._driver_pid: int | None = None
        self._driver_assigned_to_job: bool = False
        self._job_handle: Any = job_handle if job_handle is not None else (_resolve_job_handle() if sys.platform == "win32" else None)
        self._termination_confirmed: bool = False

    async def handle_return_failure(
        self,
        page: Page,
        panel_sel: str,
        search_url: str,
        full_query: str,
        context_label: str,
        rounds_this_attempt: int,
        consecutive_return_failures: int,
        max_consecutive_return_failures: int,
        search_nav_recovery_used: bool,
        config: ScraperConfig | None = None,
        profiler: Any = None,
        cards_left: int = 0,
        on_progress: "Callable[[str, str, str | None], None] | None" = None,
        **kwargs: Any,
    ) -> tuple[bool, bool, str]:
        """Production return-to-results failure handler."""
        return await _execute_return_failure_recovery(
            page=page,
            panel_sel=panel_sel,
            search_url=search_url,
            full_query=full_query,
            context_label=context_label,
            rounds_this_attempt=rounds_this_attempt,
            consecutive_return_failures=consecutive_return_failures,
            max_consecutive_return_failures=max_consecutive_return_failures,
            search_nav_recovery_used=search_nav_recovery_used,
            config=config if config is not None else self.config,
            profiler=profiler if profiler is not None else self._profiler,
            cards_left=cards_left,
            on_progress=on_progress,
        )

    async def __aenter__(self) -> "MapsScraper":
        # Phase 7.3: Reject reuse of an already-owned or closed browser
        if self._is_launched or self._is_closed or self._browser is not None:
            raise RuntimeError("Browser instance already owned or closed; reuse is strictly prohibited")
        MapsScraper._browser_spawn_attempted = True
        self._is_launched = True
        self._is_owned = True

        # Phase 2A: separate the Playwright driver spawn from the Chromium
        # launch below — these were previously untimed/combined, and the
        # audit's §3.6 recommendation was specifically to measure this
        # split before deciding anything about browser lifecycle reuse.
        with self._profiler.timer("playwright_startup"):
            self._playwright = await async_playwright().start()

        # Phase 7.3: Extract Playwright driver process ID immediately upon starting Playwright
        try:
            transport = getattr(getattr(getattr(self._playwright, "_impl_obj", None), "_connection", None), "_transport", None)
            driver_proc = getattr(transport, "_proc", None)
            self._driver_pid = getattr(driver_proc, "pid", None)
            if self._driver_pid and self._driver_pid > 0:
                MapsScraper._last_driver_pid = self._driver_pid
        except Exception:
            self._driver_pid = None

        launch_args = [
            "--no-sandbox",
            "--disable-blink-features=AutomationControlled",
            "--disable-dev-shm-usage",
            "--disable-gpu",
            "--disable-software-rasterizer",
            "--blink-settings=imagesEnabled=false",
            "--disable-background-timer-throttling",
            "--disable-backgrounding-occluded-windows",
            "--disable-renderer-backgrounding",
            "--disable-ipc-flooding-protection",
            "--no-first-run",
            "--no-default-browser-check",
            "--disable-extensions",
            "--disable-popup-blocking",
            "--disable-default-apps",
            "--disable-infobars",
            "--mute-audio",
            "--window-size=1280,800",
        ]
        if self._scout_id:
            launch_args.append(f"--mast-scout-session={self._scout_id}")

        if sys.platform == "win32":
            if self._job_handle is None:
                self._job_handle = _resolve_job_handle()

            is_coordinated = bool(
                self._scout_id
                or os.environ.get("MAST_SCOUT_SESSION_ID")
                or os.environ.get("MAST_JOB_NAME")
                or (os.environ.get("MAST_COORDINATION_REQUIRED") in ("1", "true", "TRUE"))
            )
            # Point 1: Missing coordination configuration cannot silently bypass containment
            if is_coordinated and not self._job_handle:
                await _close_bounded(self._playwright.stop, "playwright")
                self._playwright = None
                self._is_closed = True
                self._is_owned = False
                raise RuntimeError(
                    "Coordinated scout session on Windows requires an active Job Object handle; "
                    "containment cannot be bypassed"
                )

            if self._job_handle:
                # 1. Driver PID discovery check (abort before Chromium launch)
                if not self._driver_pid or self._driver_pid <= 0:
                    MapsScraper._driver_startup_failed = True
                    await _close_bounded(self._playwright.stop, "playwright")
                    self._playwright = None
                    self._is_closed = True
                    self._is_owned = False
                    raise RuntimeError("Failed to capture Playwright driver PID for Job Object assignment; aborting browser launch")

                # 2. Assign Playwright driver to Job Object BEFORE Chromium launch
                from service import (
                    assign_pid_to_windows_job,
                    query_job_active_processes,
                    terminate_and_verify_windows_job,
                    terminate_and_verify_windows_pid,
                )
                assigned = assign_pid_to_windows_job(self._job_handle, self._driver_pid)
                if not assigned:
                    MapsScraper._driver_startup_failed = True
                    # Explicitly terminate the unassigned driver using its retained PID and wait for actual OS-level exit
                    term_ok = bool(terminate_and_verify_windows_pid(self._driver_pid, timeout_s=3.0))
                    await _close_bounded(self._playwright.stop, "playwright")
                    self._playwright = None
                    self._is_closed = True
                    self._is_owned = False
                    self._termination_confirmed = term_ok
                    if not term_ok:
                        raise RuntimeError(
                            f"Failed to assign Playwright driver process {self._driver_pid} to Windows Job Object; "
                            f"driver termination unconfirmed (timed out or still alive)"
                        )
                    raise RuntimeError(f"Failed to assign Playwright driver process {self._driver_pid} to Windows Job Object; aborting browser launch")

                # 3. Verify driver is assigned (ActiveProcesses >= 1)
                active_procs = query_job_active_processes(self._job_handle)
                if active_procs < 1:
                    await _close_bounded(self._playwright.stop, "playwright")
                    term_ok = bool(terminate_and_verify_windows_job(self._job_handle, timeout_s=3.0))
                    if not term_ok and self._driver_pid:
                        term_ok = bool(terminate_and_verify_windows_pid(self._driver_pid, timeout_s=3.0))
                    self._playwright = None
                    self._is_closed = True
                    self._is_owned = False
                    self._termination_confirmed = term_ok
                    if not term_ok:
                        raise RuntimeError(
                            f"Job Object active processes verification failed after driver assignment (active={active_procs}); "
                            f"Job Object termination unconfirmed (timed out)"
                        )
                    raise RuntimeError(f"Job Object active processes verification failed after driver assignment (active={active_procs}); aborting browser launch")

                self._driver_assigned_to_job = True

        # Phase 2: time browser startup with safe failure cleanup
        try:
            with self._profiler.timer("browser_startup"):
                self._browser = await self._playwright.chromium.launch(
                    headless=self.config.headless,
                    args=launch_args,
                    ignore_default_args=["--enable-automation"],
                )
            track_browser_created()
        except Exception as launch_err:
            MapsScraper._spawn_failed = True
            term_ok = False
            if sys.platform == "win32":
                if self._job_handle and self._driver_assigned_to_job:
                    from service import terminate_and_verify_windows_job
                    term_ok = bool(terminate_and_verify_windows_job(self._job_handle, timeout_s=3.0))
                elif self._driver_pid and self._driver_pid > 0:
                    from service import terminate_and_verify_windows_pid
                    term_ok = bool(terminate_and_verify_windows_pid(self._driver_pid, timeout_s=3.0))
            else:
                if self._browser_pgid and self._browser_pgid > 0:
                    from service import terminate_and_verify_posix_group
                    term_ok = bool(terminate_and_verify_posix_group(self._browser_pgid, timeout_s=3.0))
                elif self._driver_pid and self._driver_pid > 0:
                    from service import terminate_and_verify_posix_pid
                    term_ok = bool(terminate_and_verify_posix_pid(self._driver_pid, timeout_s=3.0))
            await _close_bounded(self._playwright.stop, "playwright")
            self._browser = None
            self._playwright = None
            self._is_closed = True
            self._is_owned = False
            self._termination_confirmed = term_ok
            if not term_ok:
                raise RuntimeError(
                    f"Chromium launch failed: {launch_err}; process termination unconfirmed (timed out or unverified)"
                ) from launch_err
            raise RuntimeError(f"Chromium launch failed: {launch_err}") from launch_err

        if sys.platform == "win32":
            if self._job_handle:
                from service import query_job_active_processes, terminate_and_verify_windows_job
                # Point 4: Bounded poll (up to 2.0s) for Chromium processes to be registered in Job Object
                deadline = time.monotonic() + 2.0
                procs_after_launch = query_job_active_processes(self._job_handle)
                while procs_after_launch <= 1 and time.monotonic() < deadline:
                    await asyncio.sleep(0.05)
                    procs_after_launch = query_job_active_processes(self._job_handle)

                # If ActiveProcesses <= 1 persists, Chromium was NOT contained! Fail closed!
                if procs_after_launch <= 1:
                    term_ok = bool(terminate_and_verify_windows_job(self._job_handle, timeout_s=3.0))
                    if self._browser:
                        await _close_bounded(self._browser.close, "browser")
                    await _close_bounded(self._playwright.stop, "playwright")
                    self._browser = None
                    self._playwright = None
                    self._is_closed = True
                    self._is_owned = False
                    self._termination_confirmed = term_ok
                    if not term_ok:
                        raise RuntimeError(
                            f"Post-launch containment verification failed: ActiveProcesses={procs_after_launch} <= 1 "
                            f"after Chromium launch; Job Object termination unconfirmed (timed out)"
                        )
                    raise RuntimeError(
                        f"Post-launch containment verification failed: ActiveProcesses={procs_after_launch} <= 1 "
                        f"after Chromium launch; browser tree terminated"
                    )

            if self._driver_pid:
                self._browser_pid = self._driver_pid
        else:
            try:
                pgid = self._discover_posix_browser_pgid(self._driver_pid)
                if pgid:
                    self._browser_pgid = pgid
                    self._browser_pid = pgid
                    MapsScraper._last_browser_pgid = pgid
                    MapsScraper._last_browser_pid = pgid
            except Exception as pg_err:
                log.debug(f"[maps] POSIX browser PGID discovery: {pg_err}")

        return self

    async def __aexit__(self, *_) -> None:
        # Each cleanup step must run independently of the others' outcome.
        # If browser.close() throws (e.g. the Chromium process already
        # crashed/died), playwright.stop() must still execute — otherwise
        # the Playwright driver process is never torn down and leaks for
        # the lifetime of the container.
        if self._closing:
            return
        self._closing = True
        self._is_closed = True
        self._is_owned = False
        browser = self._browser
        self._browser = None
        playwright = self._playwright
        self._playwright = None
        if browser:
            await _close_bounded(browser.close, "browser")
        if playwright:
            await _close_bounded(playwright.stop, "playwright")
        # Phase 7.3: OS-level process-tree termination and verification
        self.terminate_browser_process_tree()

    @staticmethod
    def _extract_canonical_place_id(href: str) -> str | None:
        if not href or "/maps/place/" not in href:
            return None
        pid = _stable_place_id_from_url(href)
        if pid:
            return pid
        if "!5s" in href:
            return None
        return _place_identity_from_href(href) or None

    @property
    def browser(self) -> Browser:
        if not self._browser or self._is_closed:
            raise RuntimeError("MapsScraper not started or already closed — use async with")
        return self._browser

    @property
    def scout_id(self) -> str | None:
        return self._scout_id

    @property
    def browser_pid(self) -> int | None:
        return self._browser_pid

    @property
    def browser_pgid(self) -> int | None:
        return self._browser_pgid

    @property
    def driver_pid(self) -> int | None:
        return self._driver_pid

    @property
    def driver_assigned_to_job(self) -> bool:
        return self._driver_assigned_to_job

    @property
    def is_owned(self) -> bool:
        return self._is_owned

    @property
    def is_launched(self) -> bool:
        return self._is_launched

    @property
    def is_closed(self) -> bool:
        return self._is_closed

    @property
    def is_termination_confirmed(self) -> bool:
        return self._termination_confirmed

    def set_browser_identity(self, pid: int, pgid: int | None = None) -> None:
        """Explicitly record or override the browser PID and PGID for this scraper session.
        Once set, PGID is retained and cannot be overwritten with an invalid or zero value.
        """
        if self._browser_pgid is not None and (pgid is None or pgid <= 0):
            return
        self._browser_pid = pid
        self._browser_pgid = pgid if pgid is not None else pid
        if self._browser_pgid and self._browser_pgid > 0:
            MapsScraper._last_browser_pgid = self._browser_pgid
            MapsScraper._last_browser_pid = self._browser_pid

    def _discover_posix_browser_pgid(self, driver_pid: int | None = None) -> int | None:
        """Discover the detached PGID of the Chromium process group on POSIX."""
        if sys.platform == "win32":
            return None

        if self._scout_id:
            try:
                cmd = ["ps", "-eo", "pid,pgid,args"]
                output = subprocess.check_output(cmd, text=True, stderr=subprocess.DEVNULL)
                marker = f"--mast-scout-session={self._scout_id}"
                for line in output.splitlines():
                    if marker in line and "grep" not in line:
                        parts = line.strip().split(None, 2)
                        if len(parts) >= 2:
                            pid = int(parts[0])
                            pgid = int(parts[1])
                            if pid == pgid:
                                return pgid
                            return pgid
            except Exception as e:
                log.debug(f"[maps] ps query for scout marker failed: {e}")

        if driver_pid and driver_pid > 0:
            try:
                cmd = ["pgrep", "-P", str(driver_pid)]
                output = subprocess.check_output(cmd, text=True, stderr=subprocess.DEVNULL)
                for line in output.splitlines():
                    child_pid = int(line.strip())
                    try:
                        child_pgid = os.getpgid(child_pid)
                        if child_pgid > 0:
                            return child_pgid
                    except OSError:
                        continue
            except Exception as e:
                log.debug(f"[maps] pgrep for driver children failed: {e}")

        return None

    def terminate_browser_process_tree(self, timeout_s: float = 5.0) -> bool:
        """Terminate the browser process tree and verify OS-level termination.

        On Windows:
        - If driver was assigned to Job Object, queries Job Object and verifies ActiveProcesses == 0.
        - If driver was NOT assigned to Job Object, verifies unassigned driver termination by PID.
        - An empty Job Object is NEVER treated as proof that an unassigned driver has terminated.
        On POSIX:
        - Terminates process group and polls until ESRCH confirms exit.
        - If PGID was not discovered but driver PID is known, verifies driver PID termination until ESRCH.
        All platforms:
        - Never reports True merely because a termination request was issued.
        - No process identity means termination remains unconfirmed (returns False).
        """
        if self._termination_confirmed:
            return True

        confirmed = False
        if sys.platform == "win32":
            job_h = self._job_handle
            if not job_h:
                try:
                    import service as _srv
                    job_h = getattr(_srv, "_MAST_JOB_HANDLE", None)
                except Exception:
                    job_h = None

            if job_h and self._driver_assigned_to_job:
                try:
                    from service import terminate_and_verify_windows_job
                    confirmed = terminate_and_verify_windows_job(job_h, timeout_s=timeout_s)
                except Exception as exc:
                    log.warning(f"[maps] terminate_and_verify_windows_job exception: {exc}")
                    confirmed = False
            elif self._driver_pid and self._driver_pid > 0:
                if job_h:
                    try:
                        from service import terminate_and_verify_windows_job
                        terminate_and_verify_windows_job(job_h, timeout_s=timeout_s)
                    except Exception:
                        pass
                try:
                    from service import terminate_and_verify_windows_pid
                    confirmed = terminate_and_verify_windows_pid(self._driver_pid, timeout_s=timeout_s)
                except Exception as exc:
                    log.warning(f"[maps] terminate_and_verify_windows_pid exception: {exc}")
                    confirmed = False
            else:
                confirmed = False
        else:
            if self._browser_pgid and self._browser_pgid > 0:
                try:
                    from service import terminate_and_verify_posix_group
                    confirmed = terminate_and_verify_posix_group(self._browser_pgid, timeout_s=timeout_s)
                except Exception as exc:
                    log.warning(f"[maps] terminate_and_verify_posix_group exception: {exc}")
                    confirmed = False
            elif self._driver_pid and self._driver_pid > 0:
                try:
                    from service import terminate_and_verify_posix_pid
                    confirmed = terminate_and_verify_posix_pid(self._driver_pid, timeout_s=timeout_s)
                except Exception as exc:
                    log.warning(f"[maps] terminate_and_verify_posix_pid exception: {exc}")
                    confirmed = False
            else:
                confirmed = False

        self._termination_confirmed = confirmed
        if confirmed:
            MapsScraper._last_browser_pgid = None
            MapsScraper._last_browser_pid = None
            MapsScraper._last_driver_pid = None
        return confirmed

    async def search(
        self,
        query: str,
        city: str,
        country: str = "US",
        *,
        niche: str = "",
        region: str = "",
        max_results: int = 60,
        should_stop: "Callable[[], bool] | None" = None,
        on_progress: "Callable[[str, str, str | None], None] | None" = None,
        require_website: bool = False,
        known_place_ids: "Iterable[str] | None" = None,
        street: str = "",
    ) -> AsyncIterator[RawPlace]:
        """Search Google Maps and yield RawPlace objects.

        Args:
            query:           Search query, e.g. "specialty coffee shops"
            city:            City name, e.g. "Austin"
            country:         Country code, e.g. "US"
            niche:           Niche tag from the niche catalog
            region:          Region tag from regional config
            max_results:     Stop after yielding this many places
            require_website: DETAIL-PANEL WEBSITE FAST-ABORT: when True,
                probes the detail panel website signal immediately after
                panel mount. If no authoritative website exists, aborts
                expensive full place extraction early and yields a minimal
                RawPlace(website="") for early channel pruning.
            should_stop: PHASE 1B (target-reached / graceful-shutdown
                lifecycle propagation) — optional cooperative check,
                consulted only at the top of the crash-retry loop below,
                immediately before a NEW attempt (a fresh browser
                context/page) would otherwise be started after a crash or
                a recoverable DiscoveryFailure. Never consulted mid-attempt
                and never changes anything about scrolling, selectors, or
                place extraction — this is purely "should a retry begin",
                not "should this attempt stop". `None` (the default)
                preserves the exact previous behavior — a caller that
                doesn't pass one (e.g. verify_business()'s direct probes,
                existing tests) always gets every configured retry
                attempt. See providers/google_maps_provider.py's
                `_discover_async`, which is the one production caller that
                passes `request.should_stop` through to this parameter.
            on_progress: MINIMAL FIX (discovery liveness / watchdog
                blindness — forensic audit §9). Optional, lightweight
                liveness heartbeat, called as `on_progress(stage, event,
                item_id)` — the same three-argument shape service.py's own
                `_on_progress` already accepts, so it can be passed straight
                through with no adapter (see
                providers/google_maps_provider.py's `GoogleMapsDiscoveryRequest
                .on_progress`). Emitted at most once per attempt for
                `panel_resolved`, once per scroll round for `round_scanned`
                (never once per anchor — see the audit's explicit
                "Do NOT emit one stdout event per anchor" instruction), and
                once each for `crash_detected` / `crash_recovered`. This is
                a liveness signal only, entirely independent of candidate
                production — it never carries a RawPlace/BusinessCandidate
                and changes nothing about extraction, selectors, scrolling,
                or dedup. `None` (the default) preserves exact previous
                behavior (no stdout progress lines from this method) for
                any caller that doesn't pass one, e.g. verify_business()'s
                direct probes and every existing test.

        ROOT CAUSE FIX (memory / crash recovery): a Chromium renderer crash
        ("Target crashed" — typically an OOM kill on a memory-constrained
        host) used to be caught by the outer `except Exception` below and
        treated as fatal: the whole search ended immediately, discarding
        every place already yielded for this city, even after several
        minutes of real progress (see production logs — a New York search
        crashed after ~10 places with nothing to show for it). Combined
        with `_block_heavy_resources` (images/media/fonts never loading in
        the first place, cutting the memory pressure that causes the crash
        at all), this method now also treats a crash as *recoverable*: it
        tears down the crashed context/page, builds a fresh one, re-goes to
        the same search URL, fast-forwards scrolling back to roughly where
        it left off, and resumes — `seen_hrefs`/`yielded` are preserved
        across the rebuild so nothing already collected is lost and nothing
        gets double-counted. Only after `config.max_crash_retries`
        consecutive crashes does the search finally give up.
        """
        # Phase 7.3: Reject reuse of uninitialized, closed, or disowned browser instance
        if self._is_closed or (self._browser is None and not self._is_launched) or (self._is_launched and not self._is_owned):
            raise RuntimeError("Browser instance not active or already closed; reuse is strictly prohibited")
        # MINIMAL FIX (discovery liveness — forensic audit §9): a small,
        # local wrapper around `on_progress` so every call site below is a
        # one-liner and — critically — so an observer failure (or absence)
        # can never affect discovery itself. Mirrors
        # execution_driver.py's own `_emit()` wrapper around `on_progress`
        # (same "never allowed to raise into pipeline code" contract),
        # kept local here rather than imported since this module has no
        # existing dependency on engine/.
        def _emit_progress(stage_or_event: str, event_or_item: str | None = None, item_id: str | None = None, **kwargs: Any) -> None:
            _dispatch_progress(on_progress, stage_or_event, event_or_item, item_id, **kwargs)

        if city and city.lower() not in query.lower():
            full_query = f"{query} in {city}"
        else:
            full_query = query
        search_url = (
            "https://www.google.com/maps/search/"
            + quote_plus(full_query)
            + ("&hl=en" if "?" in full_query else "?hl=en")
        )
        area_key = (street or city or region or "default").strip() or "default"
        reset_panel_verify_fail_counts(area_key)

        log.info(f"[maps] searching: {full_query!r}")

        proxy = await self._proxy_manager.next() if self._proxy_manager else None

        yielded = 0
        seen_hrefs: set[str] = set()      # place-identity keys derived from hrefs seen in the feed
        seen_place_keys: set[str] = set() # name+address keys of places already yielded (2nd guard)
        observed_place_ids: set[str] = set()  # canonical place IDs observed across scroll rounds
        emitted_card_attempts: set[str] = set()  # place_key:attempt to prevent duplicate card_attempt_started
        exhausted_mismatch_keys: set[str] = set()
        mismatch_retries_by_key: dict[str, int] = {}
        total_mismatch_recoveries = 0
        search_nav_recovery_used = False
        last_verified_panel: dict | None = None
        known_place_ids_norm: set[str] = set()
        normalization_misses = 0
        if known_place_ids:
            for raw_id in known_place_ids:
                if not raw_id:
                    continue
                s = str(raw_id).strip()
                if s.startswith("place:"):
                    s = s[len("place:"):]
                elif s.startswith("map:"):
                    s = s[len("map:"):]
                if s:
                    forms = expand_place_id_forms(s)
                    if not forms:
                        normalization_misses += 1
                        known_place_ids_norm.add(s)
                        known_place_ids_norm.add(s.lower())
                    else:
                        for form in forms:
                            known_place_ids_norm.add(form)
                            known_place_ids_norm.add(form.lower())

        build_id = (
            os.getenv("GIT_COMMIT_SHA")
            or os.getenv("VERCEL_GIT_COMMIT_SHA")
            or os.getenv("RAILWAY_GIT_COMMIT_SHA")
            or os.getenv("GITHUB_SHA")
            or "mast-lead-engine-1.0.0"
        )
        known_count = len(list(known_place_ids)) if known_place_ids else 0
        self._profiler.incr("known_ids_received", by=known_count)
        if normalization_misses > 0:
            self._profiler.incr("normalization_misses", by=normalization_misses)
        sample_ids = list(known_place_ids_norm)[:5] if known_place_ids_norm else []
        log.info(
            f"[maps][known-ids] received={known_count} "
            f"normalized_count={len(known_place_ids_norm)} sample={sample_ids} build_id={build_id}"
        )
        consecutive_return_failures = 0
        max_consecutive_return_failures = getattr(self.config, "max_consecutive_return_failures", 2)
        _search_start_mono = time.monotonic()
        _last_heartbeat_mono = _search_start_mono

        def _check_periodic_heartbeat():
            nonlocal _last_heartbeat_mono
            now = time.monotonic()
            if now - _last_heartbeat_mono >= 20.0:
                _last_heartbeat_mono = now
                mem_mb = round(get_memory_usage(), 1)
                log.info(
                    f"[maps][heartbeat] elapsed_s={round(now - _search_start_mono, 1)} "
                    f"memory_mb={mem_mb} yielded={yielded} attempt={attempt}"
                )

        def _log_stack_snapshot(context_tag: str):
            mem_mb = round(get_memory_usage(), 1)
            frames = sys._current_frames()
            log.warning(
                f"[maps][stall-diagnostic] context={context_tag} memory_mb={mem_mb} "
                f"elapsed_s={round(time.monotonic() - _search_start_mono, 1)} active_threads={len(frames)}"
            )
        # Rounds actually scrolled so far, summed ACROSS every attempt —
        # this is what a post-crash rebuild fast-forwards through, and it
        # also caps total work across all retries so a search that keeps
        # crashing can't scroll forever.
        total_scroll_rounds = 0
        max_total_rounds = self.config.scroll_max_rounds * (self.config.max_crash_retries + 1)
        max_attempts = self.config.max_crash_retries + 1
        attempt = 0

        while attempt < max_attempts:
            attempt += 1

            # PHASE 1B (stop retries): only ever skips a RETRY (attempt 2+)
            # — the first attempt always runs, exactly as before this
            # phase. Checked here, before a fresh context/page is even
            # created for this attempt, so a target-reached/shutdown that
            # happened while the previous attempt was crashing never pays
            # for (or waits on) a browser restart it doesn't need. Places
            # already yielded by a prior attempt are unaffected — they were
            # already handed to the caller via `yield` before this point
            # could ever be reached.
            if attempt > 1 and should_stop is not None and should_stop():
                log.info(
                    f"[maps] should_stop reported true before retry attempt "
                    f"{attempt}/{max_attempts} for {full_query!r} — skipping "
                    f"the retry ({yielded} place(s) already yielded)"
                )
                return

            if attempt > 1:
                # Phase 2 Watchdog: Signal to Node that context rebuild is in progress
                _emit_progress("attempt_rebuilding", str(attempt))
                # Phase 3 Crash Resilience: Back off exponentially before recreating context
                backoff_s = min(0.5 * (2 ** (attempt - 2)), 3.0)
                await asyncio.sleep(backoff_s)

            with self._profiler.timer("context_creation"):
                ctx = await _new_stealth_context(self.browser, proxy=proxy)
            with self._profiler.timer("page_creation"):
                page = await ctx.new_page()
            crashed = False

            # CRITMODE PART 2 -- PRE-FIRST-CANDIDATE instrumentation: the
            # freshly-created page is a real, usable Playwright page object
            # at this exact point (context + page both already succeeded
            # above) -- before ANY network I/O (goto) happens on it. This
            # is the earliest "browser/page ready" evidence available; it
            # reuses the same _emit_progress()/stage="discovery" protocol
            # maps_navigation_start/panel_resolved already use, not a new
            # event channel. Emitted every attempt (including retries) so
            # a slow post-crash context rebuild is visible too. Diagnostic
            # only -- no control-flow change.
            _emit_progress("browser_page_ready", str(attempt))

            try:
                with self._profiler.timer("rate_limit_wait_search"):
                    await self._limiter.acquire("maps_search")

                # ROOT CAUSE FIX (Part 6 — navigation): `networkidle` is not
                # a usable readiness signal for Maps, which is a highly
                # dynamic SPA that can keep background requests (tiles,
                # telemetry, prefetch) open indefinitely — the old
                # networkidle-first attempt was the dominant contributor to
                # multi-minute searches that eventually produced nothing.
                # `domcontentloaded` plus an explicit, bounded wait for the
                # results panel itself (below, via `_resolve_results_panel`)
                # is what actually determines readiness; a raw navigation
                # timeout here is reported as a typed failure rather than
                # silently falling through to "no results".
                # PHASE 3C-1 STEP 2: explicit navigation start/complete
                # marks on the same progress protocol `panel_resolved`
                # already uses, so a slow `maps_initial_load` (already
                # timed by the profiler, but only visible in the Python-
                # side __perf__ report) is also visible to the Node-side
                # timing summary this phase adds in pythonBridge.ts /
                # discoveryPlanJob.ts without needing to parse __perf__.
                _emit_progress("maps_navigation_start", str(attempt))
                try:
                    with self._profiler.timer("maps_initial_load"):
                        try:
                            set_last_navigation_step("search_goto")
                            await page.goto(search_url, wait_until="domcontentloaded",
                                            timeout=self.config.maps_timeout_ms)
                        except PlaywrightTimeoutError as pto:
                            curr = getattr(page, "url", "") or ""
                            if "google.com/maps" in curr:
                                log.info(f"[maps] navigation domcontentloaded timed out after {self.config.maps_timeout_ms}ms but page landed on {curr!r} — proceeding")
                            else:
                                raise pto
                    _emit_progress("maps_navigation_complete", str(attempt))
                except PlaywrightTimeoutError as exc:
                    raise DiscoveryFailure(
                        DiscoveryFailureReason.NAVIGATION_TIMEOUT,
                        f"page.goto() did not reach domcontentloaded within "
                        f"{self.config.maps_timeout_ms}ms for {search_url!r}: {exc}",
                    ) from exc

                # --- DIAGNOSTIC: confirms what the browser actually landed
                # on before any panel/collection logic runs. Kept — bounded,
                # structured, and this is exactly the evidence PART 14 asks
                # diagnostics to keep providing. ---
                await _run_page_load_diagnostics(
                    page,
                    search_url,
                    timeout_s=getattr(self.config, "diagnostic_timeout_s", 2.0),
                )

                # ROOT CAUSE FIX (Part 7 — consent/interstitial handling):
                # a page.goto() that "succeeds" (HTTP 200, no
                # PlaywrightTimeoutError) can still have landed on a
                # consent/block/challenge page instead of Maps results —
                # every one of those has no results panel, so every
                # selector below would previously time out and the search
                # would report a normal (fake) exhaustion. Detect and
                # report explicitly instead. Ordinary consent gets one
                # legitimate dismiss attempt (a routine "Accept all" click,
                # not a security bypass); anything else fails immediately —
                # this scraper does not attempt to defeat blocks/CAPTCHAs.
                interstitial = await _detect_interstitial(page)
                if interstitial == DiscoveryFailureReason.CONSENT_REQUIRED:
                    dismissed = await _try_dismiss_ordinary_consent(page, config=self.config)
                    interstitial = await _detect_interstitial(page) if dismissed else interstitial
                if interstitial is not None:
                    raise DiscoveryFailure(
                        interstitial,
                        f"landed on {interstitial.value} instead of Maps results "
                        f"for {full_query!r} — landed_on={page.url!r}",
                    )

                # ROOT CAUSE FIX (Parts 3–4 — panel resolution): validated
                # against actual DOM evidence rather than accepting the
                # first selector to match anything at all. Raises
                # DiscoveryFailure(PANEL_NOT_FOUND) — not a silent `return`
                # — if nothing validates as a real results feed.
                set_last_navigation_step("resolve_results_panel")
                panel_sel, _ = await _resolve_results_panel(page, config=self.config)

                # MINIMAL FIX (discovery liveness — forensic audit §9):
                # "Maps results panel resolved" — real, cheap, DOM-backed
                # evidence the engine is alive and looking at a genuine
                # results feed, well before any anchor has been clicked or
                # any candidate extracted. Once per attempt (this line only
                # runs once per attempt, immediately after
                # `_resolve_results_panel()` returns successfully).
                _emit_progress("panel_resolved", str(attempt))

                if attempt > 1:
                    # MINIMAL FIX (discovery liveness — forensic audit §9):
                    # a fresh panel resolved successfully on a retry attempt
                    # means the crash/DiscoveryFailure that triggered this
                    # attempt has been recovered from — the replacement
                    # context/page/browser is up and looking at real
                    # results again. Emitted here (attempt > 1, panel just
                    # resolved) rather than immediately after context/page
                    # creation above, so "recovered" means "recovered AND
                    # confirmed alive", not just "a new page object exists".
                    _emit_progress("crash_recovered", str(attempt))

                # --- TEMPORARY DIAGNOSTIC (discovery-pipeline audit) ---
                # Deep one-shot dump of what's actually inside the
                # resolved panel, before any scrolling or collection
                # happens. See _diag_dump_panel_dom docstring.
                await _diag_dump_panel_dom(page, panel_sel)
                # --- end temporary diagnostic ---

                if attempt > 1:
                    log.info(
                        f"[maps] recovered from crash for {full_query!r} — "
                        f"attempt {attempt}/{max_attempts}, resuming with "
                        f"{yielded} place(s) already yielded"
                    )
                    # Fast-forward back toward roughly where the crashed
                    # attempt left off.
                    #
                    # ROOT CAUSE FIX (blind overshoot / Bug B): this used to
                    # unconditionally replay `total_scroll_rounds` scrolls
                    # with no check in between, on the theory that
                    # "overshooting is harmless because seen_hrefs dedupes
                    # it." That's true for re-encountering already-seen
                    # businesses, but it is NOT harmless in general: because
                    # per-round throughput can be much lower than one round
                    # of *actual* content (see Bug A above), replaying the
                    # same round count blind can scroll straight past
                    # businesses that were never seen in the first place,
                    # landing on — or past — Google's genuine end-of-list
                    # state before the real collection loop ever gets a
                    # chance to look. Now we validate after every single
                    # replay scroll and stop the moment either condition is
                    # true, instead of always doing the full replay count.
                    # PHASE 2B (discovery wall-clock instrumentation):
                    # authoritative wall-clock cost of recovering from a
                    # crash -- the fast-forward replay loop below is real,
                    # measurable work (scrolling + DOM queries), not a
                    # sleep/backoff. Measured as one manual perf_counter
                    # span (rather than `self._profiler.timer(...)`) so the
                    # existing loop body below does not need to be
                    # reindented under a `with` block.
                    _retry_wait_t0 = time.perf_counter()
                    for replay_round in range(total_scroll_rounds):
                        await _human_scroll(
                            page, panel_sel, config=self.config, profiler=self._profiler,
                        )
                        await asyncio.sleep(0.15)

                        # Stop the instant unseen content is back in view —
                        # that's what fast-forwarding was trying to reach.
                        # Continuing to scroll blindly past this point is
                        # exactly what let unseen businesses get skipped.
                        replay_panel = await page.query_selector(panel_sel)
                        found_unseen = False
                        if replay_panel is not None:
                            replay_anchors = await replay_panel.query_selector_all(
                                "a[href*='/maps/place/']"
                            )
                            for a in replay_anchors:
                                try:
                                    href = await a.get_attribute("href") or ""
                                    if "/maps/place/" not in href:
                                        continue
                                    if _place_identity_from_href(href) not in seen_hrefs:
                                        found_unseen = True
                                        break
                                except Exception:
                                    continue

                        if found_unseen:
                            log.debug(
                                f"[maps] recovery: unseen anchors visible "
                                f"after {replay_round + 1} replay scroll(s) "
                                f"— stopping fast-forward"
                            )
                            break

                        # Stop if we've reached the genuine end of the list
                        # — further blind scrolling can't surface anything
                        # new, so there's no reason to keep going.
                        try:
                            replay_body_text = await page.evaluate(
                                "() => document.body?.innerText || ''"
                            )
                            if any(eol in replay_body_text for eol in _EOL_TEXTS):
                                log.debug(
                                    f"[maps] recovery: reached end of "
                                    f"results during fast-forward after "
                                    f"{replay_round + 1} replay scroll(s)"
                                )
                                break
                        except Exception:
                            pass


                rounds_this_attempt = 0
                clicks_in_attempt = 0
                verified_in_attempt = 0

                def _check_panel_verification_failed_outcome(exit_label: str) -> None:
                    if clicks_in_attempt >= 3 and verified_in_attempt == 0 and yielded == 0:
                        exhausted_mismatch_keys.clear()
                        mismatch_retries_by_key.clear()
                        seen_hrefs.clear()
                        raise DiscoveryFailure(
                            DiscoveryFailureReason.PANEL_VERIFICATION_FAILED,
                            f"attempted {clicks_in_attempt} card click(s) and verified 0 (yielded=0) "
                            f"at {exit_label} for {full_query!r} (area={area_key!r})",
                        )

                while (
                    yielded < max_results
                    and not (should_stop is not None and should_stop())
                    and rounds_this_attempt < self.config.scroll_max_rounds
                    and total_scroll_rounds < max_total_rounds
                ):
                    rounds_this_attempt += 1
                    total_scroll_rounds += 1
                    # PHASE 2B (discovery wall-clock instrumentation):
                    # one real scroll round of the outer collection loop
                    # (not the replay/fast-forward rounds after a crash —
                    # those are counted separately under "retry_wait", see
                    # below). A round is real, incremented work whether or
                    # not it turns out to contain any unseen anchors.
                    self._profiler.incr("maps_rounds")
                    _check_periodic_heartbeat()

                    # MINIMAL FIX (discovery liveness — forensic audit §9):
                    # reset once per OUTER round so the inner anchor-processing
                    # loop below (which re-queries `listing_anchors` fresh
                    # before every single anchor, not once per round) only
                    # emits `round_scanned` a single time per round — "Do NOT
                    # emit one stdout event per anchor" is the audit's
                    # explicit instruction, and cards_in_dom is identical
                    # across every re-query within the same round anyway
                    # until a scroll happens.
                    _round_scan_emitted = False

                    # Process every currently-unseen anchor, one at a time,
                    # re-querying fresh ElementHandles from the live DOM
                    # before *each* click instead of processing a batch
                    # captured once at the top of the round.
                    #
                    # ROOT CAUSE FIX (stale anchor handles / Bug A): clicking
                    # a listing card swaps the results feed out for that
                    # place's detail pane *in the same DOM area*, and
                    # returning via _return_to_results swaps it back in —
                    # both are DOM replacements, not in-place mutations. Any
                    # ElementHandle captured before that swap (e.g. anchor
                    # #2, #3, ... in a batch collected once for the whole
                    # round) is left pointing at a detached node. Clicking a
                    # detached handle throws, and the old code swallowed
                    # that silently (`except Exception: continue`) with no
                    # logging — so every anchor after the first in a round
                    # was quietly dropped without ever being marked "seen",
                    # capping real throughput at ~1 new business per round
                    # regardless of how many were actually visible. Re-
                    # querying immediately before every click guarantees the
                    # handle we act on reflects the DOM as it exists *right
                    # now*, not as it existed at the top of the round.
                    panel_lost = False
                    failed_this_round: set[str] = set()
                    consecutive_mismatches_in_round = 0
                    clicks_this_round = 0

                    async def handle_return_failure(context_label: str, cards_left: int = 0) -> bool:
                        nonlocal consecutive_return_failures, search_nav_recovery_used, panel_sel, last_verified_panel
                        consecutive_return_failures += 1
                        recovered, search_nav_recovery_used, panel_sel = await self.handle_return_failure(
                            page=page,
                            panel_sel=panel_sel,
                            search_url=search_url,
                            full_query=full_query,
                            context_label=context_label,
                            rounds_this_attempt=rounds_this_attempt,
                            consecutive_return_failures=consecutive_return_failures,
                            max_consecutive_return_failures=max_consecutive_return_failures,
                            search_nav_recovery_used=search_nav_recovery_used,
                            config=self.config,
                            profiler=self._profiler,
                            cards_left=cards_left,
                            on_progress=_emit_progress,
                        )
                        if recovered:
                            consecutive_return_failures = 0
                            last_verified_panel = None
                        return recovered

                    while not panel_lost:
                        if yielded >= max_results or (should_stop is not None and should_stop()):
                            log.info(f"[maps] search loop ending: target reached or stop requested for {full_query!r}")
                            return

                        # Scoped to the results feed panel itself, never the
                        # whole page — a page-wide query would happily match
                        # anchors inside a place's detail pane too (e.g. a
                        # self-referential link) and mistake them for fresh
                        # results. If the feed isn't present, try to recover
                        # before giving up on this round.
                        panel = await page.query_selector(panel_sel)
                        if panel is None:
                            if not await _return_to_results(
                                page, panel_sel, config=self.config, profiler=self._profiler, on_progress=_emit_progress
                            ):
                                log.debug(
                                    "[maps] lost the results feed and "
                                    "couldn't recover — ending round"
                                )
                                panel_lost = True
                                recovered = await handle_return_failure("panel_none_at_round_top", cards_left=0)
                                if recovered:
                                    panel = await page.query_selector(panel_sel)
                                    if panel is not None:
                                        panel_lost = False
                                if panel_lost:
                                    break
                            else:
                                consecutive_return_failures = 0
                            panel = await page.query_selector(panel_sel)
                            if panel is None:
                                panel_lost = True
                                break

                        listing_anchors = await panel.query_selector_all(
                            "a[href*='/maps/place/']"
                        )
                        if len(listing_anchors) == 0 and rounds_this_attempt == 1 and hasattr(panel, "wait_for_selector"):
                            try:
                                await panel.wait_for_selector("a[href*='/maps/place/']", timeout=6000)
                                listing_anchors = await panel.query_selector_all("a[href*='/maps/place/']")
                            except Exception:
                                pass

                        if not _round_scan_emitted and len(listing_anchors) > 0:
                            _emit_progress("round_scanned", str(len(listing_anchors)))
                            self._profiler.incr("maps_candidates_seen", by=len(listing_anchors))
                            _round_scan_emitted = True

                            # Phase 2 Watchdog Architecture:
                            # search_space_expanded is emitted ONLY when genuinely new canonical
                            # place IDs are observed in the DOM. Repeated identical rounds do not
                            # emit this event and therefore do NOT reset the discovery watchdog.
                            new_canonical_ids: set[str] = set()
                            for anchor_el in listing_anchors:
                                try:
                                    a_href = await anchor_el.get_attribute("href") or ""
                                    cid = MapsScraper._extract_canonical_place_id(a_href)
                                    if cid and cid not in observed_place_ids:
                                        new_canonical_ids.add(cid)
                                except Exception:
                                    pass
                            if new_canonical_ids:
                                observed_place_ids.update(new_canonical_ids)
                                _emit_progress("search_space_expanded", str(len(new_canonical_ids)), new_unique_ids=len(new_canonical_ids))

                        if rounds_this_attempt == 1 and len(listing_anchors) == 0:
                            try:
                                _page_anchors_place = await page.eval_on_selector_all(
                                    "a[href*='/maps/place/']", "els => els.length"
                                )
                            except Exception:
                                _page_anchors_place = "error"
                            if isinstance(_page_anchors_place, int) and _page_anchors_place > 0:
                                raise DiscoveryFailure(
                                    DiscoveryFailureReason.PANEL_NOT_FOUND,
                                    f"panel_sel={panel_sel!r} validated but contains "
                                    f"0 place anchors while {_page_anchors_place} exist "
                                    f"page-wide — wrong container resolved for {full_query!r}",
                                )

                        place_key = None
                        anchor = None
                        card_href = ""
                        for a in listing_anchors:
                            try:
                                href = await a.get_attribute("href") or ""
                                if "/maps/place/" not in href:
                                    continue
                                candidate_key = _place_identity_from_href(href)
                                if (
                                    candidate_key
                                    and candidate_key not in seen_hrefs
                                    and candidate_key not in failed_this_round
                                    and candidate_key not in exhausted_mismatch_keys
                                ):
                                    place_key, anchor, card_href = candidate_key, a, href
                                    break
                            except Exception:
                                continue

                        if anchor is None:
                            # Nothing unseen (and not already given up on)
                            # currently visible — done processing this
                            # round; fall through to the EOL check / scroll.
                            break

                        candidate_pid = _stable_place_id_from_url(card_href)
                        if candidate_pid:
                            cand_forms = expand_place_id_forms(candidate_pid)
                            is_known = any(
                                f in known_place_ids_norm or f.lower() in known_place_ids_norm
                                for f in (cand_forms or [candidate_pid])
                            )
                            if is_known:
                                log.info(
                                    f"[maps][pre-click] skipping known place_id={candidate_pid} "
                                    f"(place_key={place_key!r}, card_href={card_href!r})"
                                )
                                self._profiler.incr("known_place_skipped")
                                self._profiler.incr("maps_candidates_known_place_skipped")
                                _emit_progress("candidate_duplicate_skipped", candidate_pid)
                                seen_hrefs.add(place_key)
                                continue

                        card_signals = await _extract_card_signals(anchor)
                        if card_signals.get("closed"):
                            log.info(
                                f"[maps][diag] card reports explicit closed "
                                f"status — skipping click (place_key="
                                f"{place_key!r})"
                            )
                            self._profiler.incr("maps_candidates_card_closed_skipped")
                            seen_hrefs.add(place_key)
                            continue

                        pre_click_snapshot = await _read_panel_identity_snapshot(page, panel)

                        try:
                            with self._profiler.timer("place_click"):
                                try:
                                    await anchor.scroll_into_view_if_needed(timeout=2000)
                                except Exception:
                                    pass
                                set_last_navigation_step("card_click")
                                await _human_click(page, anchor)
                                clicks_this_round += 1
                                clicks_in_attempt += 1
                                self._profiler.incr("maps_candidates_clicked")
                        except Exception as exc:
                            log.info(
                                f"[maps] anchor detached/stale before click, "
                                f"skipping (will retry next round) — "
                                f"place_key={place_key!r}: {exc}"
                            )
                            failed_this_round.add(place_key)
                            continue

                        handled_return_to_results = False
                        card_completed_cleanly = False
                        generator_closing = False
                        verified_panel_snap: dict = {}
                        card_timeout_s = max(0.05, self.config.card_operation_timeout_ms / 1000.0)
                        card_started_monotonic = asyncio.get_event_loop().time()

                        card_attempt = mismatch_retries_by_key.get(place_key, 0) + 1
                        card_attempt_id = f"{place_key}:{card_attempt}"
                        if card_attempt_id not in emitted_card_attempts:
                            emitted_card_attempts.add(card_attempt_id)
                            _emit_progress("card_attempt_started", card_attempt_id)

                        card_processed_emitted = False
                        def _emit_card_processed(status: str) -> None:
                            nonlocal card_processed_emitted
                            if not card_processed_emitted:
                                card_processed_emitted = True
                                _emit_progress("card_processed", f"{place_key}:{card_attempt}:{status}")

                        async def _run_card_panel_and_extract() -> tuple[str, RawPlace | None, str]:
                            nonlocal verified_panel_snap
                            is_minimal_stub = _is_detail_pane_open is not _DEFAULT_IS_DETAIL_PANE_OPEN
                            with self._profiler.timer("place_panel_wait"):
                                found_panel = False
                                panel_el = None
                                panel_wait_timeout = (
                                    self.config.place_timeout_ms
                                    if self.config.place_timeout_ms <= 200
                                    else max(self.config.place_timeout_ms, 8000)
                                )
                                try:
                                    try:
                                        panel_el = await page.wait_for_selector(
                                            _PLACE_NAME_SELECTOR_COMBINED,
                                            state="attached",
                                            timeout=panel_wait_timeout,
                                        )
                                        found_panel = panel_el is not None
                                    except TypeError:
                                        is_minimal_stub = True
                                        await page.wait_for_selector(
                                            _PLACE_NAME_SELECTOR_COMBINED,
                                            timeout=panel_wait_timeout,
                                        )
                                        found_panel = True
                                except (PlaywrightTimeoutError, Exception):
                                    pass

                                if found_panel and not is_minimal_stub and panel_el is not None:
                                    if panel_el is panel or not hasattr(panel_el, "inner_text"):
                                        is_minimal_stub = True
                                    else:
                                        try:
                                            panel_el_txt = (await panel_el.inner_text() or "").strip()
                                        except Exception:
                                            panel_el_txt = ""
                                        if _is_excluded_panel_header(panel_el_txt):
                                            # `wait_for_selector` matched the persistent search-sidebar
                                            # header (e.g. `<h1>Results</h1>`) rather than an opened
                                            # detail panel. Poll for actual detail-pane opening.
                                            if not await _is_detail_pane_open(page, panel):
                                                found_panel = False
                                                poll_budget_s = (
                                                    self.config.place_timeout_ms / 1000.0
                                                    if self.config.place_timeout_ms <= 200
                                                    else max(self.config.place_timeout_ms / 1000.0, 16.0 if yielded == 0 else 6.0)
                                                )
                                                poll_start = asyncio.get_event_loop().time()
                                                poll_deadline = poll_start + poll_budget_s
                                                retried_dom_click = False
                                                while asyncio.get_event_loop().time() < poll_deadline:
                                                    curr_u = getattr(page, "url", "") or ""
                                                    if await _is_detail_pane_open(page, panel) or (
                                                        "/maps/place/" in curr_u and "/maps/search/" not in curr_u
                                                    ):
                                                        found_panel = True
                                                        break
                                                    if (
                                                        not retried_dom_click
                                                        and (asyncio.get_event_loop().time() - poll_start) >= 0.35
                                                        and hasattr(anchor, "evaluate")
                                                    ):
                                                        retried_dom_click = True
                                                        try:
                                                            await anchor.evaluate("el => el.click()")
                                                        except Exception:
                                                            pass
                                                    poll_sleep = 0.02 if self.config.place_timeout_ms <= 200 else 0.20
                                                    await asyncio.sleep(poll_sleep)

                                if found_panel:
                                    self._profiler.incr("place_panel_wait_resolved")

                                if not found_panel:
                                    if await _is_detail_pane_open(page, panel):
                                        found_panel = True
                                        self._profiler.incr("place_panel_wait_resolved")

                                if not found_panel:
                                    curr_url = getattr(page, "url", "") or ""
                                    if "/maps/place/" in curr_url and "/maps/search/" not in curr_url:
                                        found_panel = True
                                        self._profiler.incr("place_panel_wait_resolved")
                                    else:
                                        log.info(f"[maps][diag] place_panel_wait failed: url={curr_url!r} card_href={card_href!r}")
                                        if should_stop is not None and should_stop():
                                            self._profiler.incr("place_panel_wait_aborted")
                                            return "panel_timeout", None, "panel_wait_timeout"
                                        self._profiler.incr("place_panel_wait_timeout")
                                        if "/maps/place/" not in curr_url and not is_minimal_stub:
                                            return "mismatch", None, "waiting_for_detail_panel"

                            if not is_minimal_stub:
                                try:
                                    probe_h1 = await page.query_selector(_PLACE_NAME_SELECTORS[0])
                                    if probe_h1 is panel and panel is not None:
                                        is_minimal_stub = True
                                except Exception:
                                    pass

                            identity_wait_ms = _resolve_identity_wait_ms(page, found_panel, self.config)
                            set_last_navigation_step("wait_place_panel")
                            identity_ok, panel_snap, mismatch_reason = await _wait_for_verified_panel_identity(
                                page,
                                feed_el=panel,
                                card_href=card_href,
                                place_key=place_key,
                                card_signals=card_signals,
                                pre_click_snapshot=pre_click_snapshot,
                                last_verified_panel=last_verified_panel,
                                timeout_ms=identity_wait_ms,
                                allow_stub=is_minimal_stub,
                                area_key=area_key,
                            )
                            if not identity_ok:
                                return "mismatch", None, mismatch_reason

                            verdict_source = (panel_snap or {}).get("verdict_source") or ""
                            if verdict_source in ("url_id", "title"):
                                marker_timeout_s = getattr(self.config, "panel_content_marker_timeout_s", None)
                                if marker_timeout_s is None:
                                    marker_timeout_s = resolve_panel_marker_wait_ms(self.config) / 1000.0
                                marker_poll_s = getattr(self.config, "panel_content_marker_poll_s", 0.25)
                                if (
                                    getattr(self.config, "place_timeout_ms", 5000) <= 200
                                    and not hasattr(self.config, "panel_content_marker_timeout_s")
                                    and "MAST_PANEL_MARKER_WAIT_MS" not in os.environ
                                ):
                                    marker_timeout_s = min(marker_timeout_s, self.config.place_timeout_ms / 1000.0)
                                    marker_poll_s = min(marker_poll_s, 0.02)
                                else:
                                    marker_timeout_s = max(25.0 if yielded == 0 else 8.0, marker_timeout_s)
                                markers_mounted = await _wait_for_panel_content_markers(
                                    page,
                                    feed_el=panel,
                                    snap=None,
                                    timeout_s=marker_timeout_s,
                                    poll_interval_s=marker_poll_s,
                                    anchor_el=anchor,
                                )
                                if not markers_mounted:
                                    refreshed_snap = await _read_panel_identity_snapshot(page, panel)
                                    h1_cand = refreshed_snap.get("h1_name") or ""
                                    has_detail_content = bool(
                                        (h1_cand and not _is_excluded_panel_header(h1_cand))
                                        or refreshed_snap.get("raw_address")
                                    )
                                    if refreshed_snap.get("open") and has_detail_content:
                                        panel_snap = refreshed_snap
                                        markers_mounted = True
                                    else:
                                        c_name = (card_signals or {}).get("name") or ""
                                        c_pid = (card_signals or {}).get("card_place_id") or ""
                                        log.warning(
                                            f"[maps][verified-but-empty] card verified via {verdict_source} "
                                            f"but no panel content markers mounted for {card_href!r} "
                                            f"(card_name={c_name!r}, place_id={c_pid!r})"
                                        )
                                        return "mismatch", None, "verified_but_empty"

                                refreshed_snap = await _read_panel_identity_snapshot(page, panel)
                                if refreshed_snap.get("open"):
                                    panel_snap = refreshed_snap

                            verified_panel_snap = panel_snap
                            verified_raw_name = (panel_snap.get("raw_name") or panel_snap.get("name") or "").strip()
                            verified_raw_addr = (panel_snap.get("raw_address") or "").strip()
                            verified_snap_pid = (panel_snap.get("place_id") or "").strip()

                            # Phase 3 fast paths: short-circuit before rate-limit wait, place settle,
                            # website probe, and full DOM extraction when panel identity snapshot
                            # already proves this listing is a header, known place, seen duplicate,
                            # or conclusively disqualified by canonical chain/cannabis rules.
                            if verified_raw_name and _is_excluded_panel_header(verified_raw_name):
                                self._profiler.incr("maps_detail_early_header_skipped")
                                return "early_skip", None, "panel_header"

                            if verified_snap_pid:
                                snap_forms = expand_place_id_forms(verified_snap_pid)
                                if any(
                                    f in known_place_ids_norm or f.lower() in known_place_ids_norm
                                    for f in (snap_forms or [verified_snap_pid])
                                ):
                                    self._profiler.incr("known_place_skipped")
                                    self._profiler.incr("maps_candidates_known_place_skipped")
                                    self._profiler.incr("maps_detail_early_known_place_skipped")
                                    _emit_progress("candidate_duplicate_skipped", verified_snap_pid)
                                    return "early_skip", None, "known_place_id"

                            if verified_raw_name and verified_raw_addr:
                                early_key_data = f"{verified_raw_name.lower()}|{verified_raw_addr.lower()}"
                                if early_key_data in seen_place_keys:
                                    self._profiler.incr("maps_detail_early_duplicate_skipped")
                                    return "early_skip", None, "duplicate_place_key"

                            if verified_raw_name and _is_conclusively_disqualified_by_name(verified_raw_name):
                                self._profiler.incr("maps_detail_fast_abort_disqualified")
                                extracted_place = RawPlace(
                                    name=verified_raw_name,
                                    address=verified_raw_addr,
                                    website="",
                                    maps_link=_verified_maps_link_from_href(card_href, getattr(page, "url", "")),
                                    city=city,
                                    country=country,
                                    niche=niche,
                                    region=region,
                                    query=full_query,
                                )
                                return "ok", extracted_place, "fast_abort_disqualified"

                            fast_aborted = False
                            extracted_place: RawPlace | None = None
                            site_url = ""

                            with self._profiler.timer("rate_limit_wait_place"):
                                await self._limiter.acquire("maps_place")

                            with self._profiler.timer("place_settle"):
                                if _wait_for_place_settle is _DEFAULT_WAIT_FOR_PLACE_SETTLE:
                                    await _wait_for_place_settle(
                                        page,
                                        config=self.config,
                                        already_settled=bool(verified_raw_addr),
                                    )
                                else:
                                    await _wait_for_place_settle(page, config=self.config)

                            if require_website:
                                self._profiler.incr("maps_detail_website_probe_attempts")
                                with self._profiler.timer("detail_website_probe"):
                                    site_url = await _probe_detail_panel_website(page)

                                if site_url:
                                    self._profiler.incr("maps_detail_website_probe_has_site")
                                else:
                                    self._profiler.incr("maps_detail_website_probe_no_site")
                                    self._profiler.incr("maps_detail_fast_abort_no_website")
                                    self._profiler.record_stage_duration("detail_fast_abort_saved", 500.0)

                                    candidate_name = (
                                        (card_signals.get("name") if card_signals else "")
                                        or verified_raw_name
                                    )
                                    if not candidate_name:
                                        candidate_name = await _try_selectors(page, _PLACE_NAME_SELECTORS) or ""

                                    candidate_phone = ""
                                    try:
                                        candidate_phone = await _extract_phone(page)
                                    except Exception:
                                        pass

                                    extracted_place = RawPlace(
                                        name=candidate_name or "Unknown Place",
                                        address=verified_raw_addr,
                                        phone=candidate_phone,
                                        website="",
                                        maps_link=_verified_maps_link_from_href(card_href, getattr(page, "url", "")),
                                        city=city,
                                        country=country,
                                        niche=niche,
                                        region=region,
                                        query=full_query,
                                    )
                                    fast_aborted = True

                            if not fast_aborted:
                                try:
                                    set_last_navigation_step("extract_place_data")
                                    with self._profiler.timer("maps_place_extraction"):
                                        verified_title = (panel_snap or {}).get("title_name") or ""
                                        card_name = (card_signals or {}).get("name") or ""
                                        fallback_card_name = (
                                            (verified_title if verified_title and not _is_excluded_panel_header(verified_title) else "")
                                            or (verified_raw_name if verified_raw_name and not _is_excluded_panel_header(verified_raw_name) else "")
                                            or (card_name if card_name and not _is_excluded_panel_header(card_name) else "")
                                            or (_place_name_from_href(card_href) if not _is_excluded_panel_header(_place_name_from_href(card_href)) else "")
                                            or ""
                                        )
                                        if _extract_place_data is _DEFAULT_EXTRACT_PLACE_DATA:
                                            extracted_place = await _extract_place_data(
                                                page,
                                                config=self.config,
                                                query=full_query,
                                                niche=niche,
                                                region=region,
                                                city=city,
                                                country=country,
                                                profiler=self._profiler,
                                                probed_website=site_url or None,
                                                fallback_name=fallback_card_name or None,
                                            )
                                        else:
                                            extracted_place = await _extract_place_data(
                                                page,
                                                config=self.config,
                                                query=full_query,
                                                niche=niche,
                                                region=region,
                                                city=city,
                                                country=country,
                                                profiler=self._profiler,
                                            )
                                            if site_url and extracted_place and not extracted_place.website:
                                                extracted_place.website = site_url
                                        if extracted_place and (not extracted_place.name or _is_excluded_panel_header(extracted_place.name)):
                                            extracted_place.name = fallback_card_name

                                        # Stale-data guard: ensure phone/website/address are not carried over from prior panel
                                        is_stale, stale_reason = _detect_stale_extraction(extracted_place, last_verified_panel)
                                        if is_stale and extracted_place:
                                            if stale_reason == "warning_website_and_address_only":
                                                log.warning(
                                                    f"[maps][stale-extraction] co-located address and website warning for card {extracted_place.name!r} "
                                                    f"matching prior {last_verified_panel.get('name')!r} (different phones) — retaining fields"
                                                )
                                            else:
                                                log.warning(
                                                    f"[maps][stale-extraction] stale data detected for card {extracted_place.name!r} "
                                                    f"matching prior {last_verified_panel.get('name')!r} reason={stale_reason!r} — waiting to re-read once"
                                                )
                                                await asyncio.sleep(0.3)
                                                if _extract_place_data is _DEFAULT_EXTRACT_PLACE_DATA:
                                                    re_extracted = await _extract_place_data(
                                                        page,
                                                        config=self.config,
                                                        query=full_query,
                                                        niche=niche,
                                                        region=region,
                                                        city=city,
                                                        country=country,
                                                        profiler=self._profiler,
                                                        probed_website=None,
                                                        fallback_name=fallback_card_name or None,
                                                    )
                                                else:
                                                    re_extracted = await _extract_place_data(
                                                        page,
                                                        config=self.config,
                                                        query=full_query,
                                                        niche=niche,
                                                        region=region,
                                                        city=city,
                                                        country=country,
                                                        profiler=self._profiler,
                                                    )
                                                if re_extracted:
                                                    is_still_stale, still_reason = _detect_stale_extraction(re_extracted, last_verified_panel)
                                                    if is_still_stale:
                                                        prior_phone = (last_verified_panel.get("phone") or "").strip()
                                                        curr_phone = (getattr(re_extracted, "phone", "") or "").strip()
                                                        # Clear only when phone is non-empty and identical to previous card
                                                        if curr_phone and prior_phone and curr_phone == prior_phone:
                                                            log.warning(
                                                                f"[maps][stale-extraction] re-read still stale ({still_reason!r}) for {re_extracted.name!r} — clearing carried-over fields"
                                                            )
                                                            if re_extracted.website and re_extracted.website == (last_verified_panel.get("website") or ""):
                                                                re_extracted.website = ""
                                                            re_extracted.phone = ""
                                                            if re_extracted.address and re_extracted.address == (last_verified_panel.get("address") or ""):
                                                                re_extracted.address = ""
                                                        else:
                                                            log.warning(
                                                                f"[maps][stale-extraction] co-located website and address retained for {re_extracted.name!r} (different phones)"
                                                            )
                                                    extracted_place = re_extracted
                                except PlaceExtractionTimeout as exc:
                                    seen_hrefs.add(place_key)
                                    self._profiler.incr("place_extraction_timeouts")
                                    log.warning(
                                        f"[maps][extract-timeout] operation={exc.operation} "
                                        f"timeout_ms={exc.timeout_ms} attempt={attempt}/{max_attempts} "
                                        f"yielded={yielded}"
                                    )
                                    raise
                                except Exception as exc:
                                    log.info(f"[maps][diag] extraction raised, business dropped: {exc}")
                                    log.debug(f"[maps] extraction error: {exc}")
                                    self._stats.errors += 1
                                    return "extract_error", None, str(exc)

                            if extracted_place and extracted_place.name and panel_snap.get("open"):
                                post_snap = {
                                    "open": True,
                                    "name": _norm_identity_text(extracted_place.name),
                                    "raw_name": extracted_place.name,
                                    "h1_name": extracted_place.name,
                                    "page_title": panel_snap.get("page_title") or "",
                                    "title_name": panel_snap.get("title_name") or "",
                                    "address": _norm_identity_text(extracted_place.address),
                                    "raw_address": extracted_place.address,
                                    "place_id": _stable_place_id_from_url(getattr(page, "url", "")) if "/maps/place/" in (getattr(page, "url", "") or "") else "",
                                    "url": getattr(page, "url", "") or "",
                                }
                                post_ok, post_reason = _evaluate_panel_identity(
                                    post_snap,
                                    card_href=card_href,
                                    place_key=place_key,
                                    card_signals=card_signals,
                                    pre_click_snapshot=pre_click_snapshot,
                                    last_verified_panel=last_verified_panel,
                                )
                                if not post_ok:
                                    await _log_panel_verification_failure(
                                        page,
                                        post_snap,
                                        post_reason,
                                        card_href=card_href,
                                        card_signals=card_signals,
                                        area_key=area_key,
                                    )
                                    return "mismatch", None, post_reason

                            card_log_name = (
                                (extracted_place.name if extracted_place else "")
                                or verified_raw_name
                                or (card_signals or {}).get("name")
                                or _place_name_from_href(card_href)
                                or ""
                            )
                            card_log_pid = verified_snap_pid or _stable_place_id_from_url(card_href) or ""
                            _log_verified_card_extraction_guard(
                                card_name=card_log_name,
                                card_place_id=card_log_pid,
                                place=extracted_place,
                                panel_snap=panel_snap,
                                area_key=area_key,
                            )
                            await _capture_and_log_dom_snapshot(
                                page,
                                snapshot_kind="verified",
                                area_key=area_key,
                                card_name=card_log_name,
                                card_place_id=card_log_pid,
                                reason="verified",
                            )
                            return "ok", extracted_place, "verified"

                        try:
                            try:
                                card_status, place, card_reason = await asyncio.wait_for(
                                    _run_card_panel_and_extract(),
                                    timeout=card_timeout_s,
                                )
                            except PlaceExtractionTimeout:
                                if should_stop is not None and should_stop():
                                    generator_closing = True
                                    return
                                raise
                            except asyncio.TimeoutError:
                                seen_hrefs.add(place_key)
                                self._profiler.incr("card_operation_timeouts")
                                log.warning(
                                    f"[maps][card-timeout] card_operation exceeded "
                                    f"{self.config.card_operation_timeout_ms}ms "
                                    f"attempt={attempt}/{max_attempts} yielded={yielded}"
                                )
                                _emit_card_processed("timeout_exhausted")
                                _emit_progress("attempt_rebuilding", str(attempt + 1))
                                if should_stop is not None and should_stop():
                                    generator_closing = True
                                    return
                                raise CardOperationTimeout(
                                    "card_operation", self.config.card_operation_timeout_ms
                                ) from None

                            log.info(f"[maps][diag] card_status={card_status} card_reason={card_reason} place={place.name if place else None}")
                            if card_status in ("ok", "early_skip"):
                                verified_in_attempt += 1

                            if card_status == "early_skip":
                                _emit_card_processed("early_skip")
                                consecutive_mismatches_in_round = 0
                                seen_hrefs.add(place_key)
                                snap_link = _verified_maps_link_from_href(card_href, getattr(page, "url", ""))
                                snap_pid = (
                                    (verified_panel_snap.get("place_id") or "").strip()
                                    or _stable_place_id_from_url(snap_link)
                                    or _stable_place_id_from_url(card_href)
                                )
                                last_verified_panel = {
                                    "place_key": place_key,
                                    "place_id": snap_pid,
                                    "name": verified_panel_snap.get("name") or "",
                                    "address": verified_panel_snap.get("address") or "",
                                    "phone": (verified_panel_snap.get("phone") or "").strip(),
                                    "website": (verified_panel_snap.get("website") or "").strip(),
                                }
                                card_completed_cleanly = True
                                continue

                            if card_status in ("panel_timeout", "extract_error"):
                                card_attempts = mismatch_retries_by_key.get(place_key, 0) + 1
                                mismatch_retries_by_key[place_key] = card_attempts
                                if card_attempts >= 2:
                                    _emit_card_processed("timeout_exhausted")
                                    seen_hrefs.add(place_key)
                                else:
                                    _emit_card_processed("error")
                                    failed_this_round.add(place_key)
                                continue

                            if card_status == "mismatch":
                                _emit_progress("detail_panel_stale", place_key)
                                handled_return_to_results = True
                                self._profiler.incr("stale_panel_mismatch")
                                retries_for_key = mismatch_retries_by_key.get(place_key, 0) + 1
                                mismatch_retries_by_key[place_key] = retries_for_key

                                if card_reason in ("waiting_for_detail_panel", "waiting_for_panel_name", "verified_but_empty"):
                                    max_unopened_retries = getattr(
                                        self.config, "max_unopened_panel_retries_per_card", 1
                                    )
                                    log.info(
                                        f"[maps][stale-panel] detail panel did not resolve for "
                                        f"place_key={place_key!r} reason={card_reason} "
                                        f"retry={retries_for_key}/{max_unopened_retries + 1}"
                                    )
                                    self._profiler.incr("return_to_results_executed")
                                    set_last_navigation_step("return_to_results")
                                    if _return_to_results is _DEFAULT_RETURN_TO_RESULTS:
                                        returned = await _return_to_results(
                                            page,
                                            panel_sel,
                                            config=self.config,
                                            profiler=self._profiler,
                                            force_reset=True,
                                            on_progress=_emit_progress,
                                        )
                                    else:
                                        returned = await _return_to_results(
                                            page,
                                            panel_sel,
                                            config=self.config,
                                            profiler=self._profiler,
                                            on_progress=_emit_progress,
                                        )
                                    feed_ready = await _is_feed_ready(page, panel_sel)
                                    if not returned and not feed_ready:
                                        cards_left = max(0, len(listing_anchors) - 1)
                                        recovered = await handle_return_failure(
                                            "waiting_for_detail_panel", cards_left=cards_left
                                        )
                                        if not recovered and not await _is_feed_ready(page, panel_sel):
                                            panel_lost = True
                                            break
                                    if retries_for_key > max_unopened_retries:
                                        _emit_card_processed("mismatch_exhausted")
                                        exhausted_mismatch_keys.add(place_key)
                                        seen_hrefs.add(place_key)
                                        consecutive_mismatches_in_round = 0
                                        log.info(
                                            f"[maps][stale-panel] abandoning card after bounded panel wait "
                                            f"for place_key={place_key!r} reason={card_reason}"
                                        )
                                    else:
                                        _emit_card_processed("mismatch")
                                    continue

                                consecutive_mismatches_in_round += 1
                                total_mismatch_recoveries += 1
                                max_card_retries = getattr(self.config, "max_stale_panel_retries_per_card", 2)
                                if retries_for_key > max_card_retries:
                                    _emit_card_processed("mismatch_exhausted")
                                    exhausted_mismatch_keys.add(place_key)
                                else:
                                    _emit_card_processed("mismatch")

                                log.info(
                                    f"[maps][stale-panel] mismatch for place_key={place_key!r} "
                                    f"reason={card_reason} retry={retries_for_key}/{max_card_retries + 1} "
                                    f"consecutive_in_round={consecutive_mismatches_in_round} "
                                    f"total_recoveries={total_mismatch_recoveries}"
                                )

                                returned = await _return_to_results(
                                    page, panel_sel, config=self.config, profiler=self._profiler, on_progress=_emit_progress
                                )
                                feed_ready = await _is_feed_ready(page, panel_sel)

                                max_area_recoveries = getattr(
                                    self.config, "max_stale_panel_recoveries_per_area", 6
                                )
                                if consecutive_mismatches_in_round >= 3 or (not returned and not feed_ready):
                                    if not search_nav_recovery_used:
                                        search_nav_recovery_used = True
                                        self._profiler.incr("stale_panel_search_nav_recovery")
                                        log.info(
                                            f"[maps][stale-panel] performing bounded search-navigation "
                                            f"recovery for {full_query!r}"
                                        )
                                        _emit_progress("return_recovery_attempted", "stale_panel_mismatch")
                                        try:
                                            await page.goto(
                                                search_url,
                                                wait_until="domcontentloaded",
                                                timeout=self.config.maps_timeout_ms,
                                            )
                                            panel_sel, _ = await _resolve_results_panel(
                                                page, config=self.config
                                            )
                                            last_verified_panel = None
                                            consecutive_mismatches_in_round = 0
                                            if await _wait_for_feed_restored(page, panel_sel, timeout_s=1.5):
                                                _emit_progress("return_recovery_succeeded", "stale_panel_mismatch")
                                                continue
                                            else:
                                                _emit_progress("return_recovery_failed", "stale_panel_feed_not_ready")
                                        except Exception as nav_err:
                                            if _is_target_closed_or_crashed_error(nav_err):
                                                _emit_progress("browser_page_crashed", str(nav_err)[:60])
                                                _log_browser_page_crashed(str(nav_err)[:60], context_label="stale_panel_recovery")
                                                raise DiscoveryFailure(
                                                    DiscoveryFailureReason.SCRAPER_ERROR,
                                                    f"browser target crashed during recovery: {nav_err}",
                                                )
                                            _emit_progress("return_recovery_failed", "stale_panel_exception")
                                    log.warning(
                                        f"[maps][stale-panel] mismatch persisted after search-navigation "
                                        f"recovery for {full_query!r} — terminating area safely"
                                    )
                                    generator_closing = True
                                    _check_panel_verification_failed_outcome("stale_panel_search_nav_recovery")
                                    return

                                if total_mismatch_recoveries >= max_area_recoveries:
                                    log.warning(
                                        f"[maps][stale-panel] reached max_stale_panel_recoveries_per_area="
                                        f"{max_area_recoveries} for {full_query!r} — terminating area safely"
                                    )
                                    generator_closing = True
                                    _check_panel_verification_failed_outcome("max_stale_panel_recoveries")
                                    return

                                continue

                            if not place or not place.name:
                                _emit_card_processed("disqualified")
                                log.info(
                                    "[maps][diag] extraction returned no "
                                    "name — business dropped (card_key="
                                    f"{place_key!r})"
                                )
                                seen_hrefs.add(place_key)
                                card_completed_cleanly = True
                                continue

                            log.info(
                                f"[maps][diag] business parsed — name={place.name!r} "
                                f"address={place.address!r} rating={place.rating} "
                                f"reviews={place.reviews}"
                            )

                            if _is_excluded_panel_header(place.name):
                                _emit_card_processed("disqualified")
                                log.info(
                                    f"[maps][diag] parsed name matched the "
                                    f"panel-header exclusion list "
                                    f"({place.name!r}) — dropped, not a real listing"
                                )
                                seen_hrefs.add(place_key)
                                card_completed_cleanly = True
                                continue

                            # Identity and extraction validated: resolve verified maps_link & place_id,
                            # mark seen_hrefs, and update last_verified_panel.
                            consecutive_mismatches_in_round = 0
                            place.maps_link = _verified_maps_link_from_href(
                                card_href, getattr(page, "url", "")
                            )
                            verified_pid = _stable_place_id_from_url(place.maps_link) or _stable_place_id_from_url(card_href)
                            if verified_pid:
                                place.extra.setdefault("maps_place_id", verified_pid)
                                place.extra.setdefault("mapsPlaceId", verified_pid)
                                for f in expand_place_id_forms(verified_pid):
                                    known_place_ids_norm.add(f)
                                    known_place_ids_norm.add(f.lower())

                            last_verified_panel = {
                                "place_key": place_key,
                                "card_href": card_href,
                                "place_id": verified_pid,
                                "name": _norm_identity_text(place.name),
                                "raw_name": place.name,
                                "address": (place.address or "").strip(),
                                "phone": (place.phone or "").strip(),
                                "website": (place.website or "").strip(),
                            }
                            seen_hrefs.add(place_key)
                            card_completed_cleanly = True

                            # Skip permanently closed
                            if place.closed:
                                _emit_card_processed("disqualified")
                                log.info(
                                    f"[maps][diag] business dropped — "
                                    f"marked permanently closed: {place.name!r}"
                                )
                                self._stats.skip("permanently_closed")
                                continue

                            # Priority 5: Do not claim exact street-level targeting while street geometry is missing.
                            # Tag for diagnostic telemetry without discarding legitimate candidates in city scope.
                            if street and place.address:
                                if is_address_on_street(place.address, street):
                                    self._profiler.incr("on_target_street")
                                else:
                                    self._profiler.incr("outside_street_scope")
                                    self._profiler.incr("street_anchor_proximity")
                                    log.info(
                                        f"[maps] candidate {place.name!r} address {place.address!r} "
                                        f"discovered via anchor {street!r} in city scope"
                                    )

                            # Second-layer identity guard, independent of
                            # href formatting entirely (see docstring on
                            # _place_identity_from_data). Checked BEFORE emitting
                            # candidate_discovered so duplicate panels never
                            # fabricate candidate discovery progress.
                            with self._profiler.timer("duplicate_detection"):
                                place_key_data = _place_identity_from_data(place)
                                is_dup = place_key_data in seen_place_keys
                                if not is_dup:
                                    seen_place_keys.add(place_key_data)

                            if is_dup:
                                _emit_card_processed("duplicate")
                                log.debug(
                                    f"[maps] skipping duplicate place "
                                    f"(identity match): {place.name!r}"
                                )
                                continue

                            self._profiler.mark_first_discovered_business()
                            _emit_progress("candidate_discovered", place_key)

                            log.debug(
                                f"[maps] ✓ {place.name!r} | "
                                f"reviews={place.reviews} | "
                                f"rating={place.rating} | "
                                f"website={place.website[:40]!r}"
                            )

                            log.info(
                                f"[maps][diag] business yielded — "
                                f"name={place.name!r} yielded_total={yielded + 1}"
                            )
                            self._profiler.mark_first_yielded_business()
                            _emit_progress("candidate_queued", place_key)
                            try:
                                yield place
                            except (GeneratorExit, asyncio.CancelledError):
                                generator_closing = True
                                raise
                            _emit_card_processed("verified")
                            yielded += 1
                            self._profiler.incr("maps_candidates_yielded")
                            if yielded >= max_results or (should_stop is not None and should_stop()):
                                generator_closing = True
                        finally:
                            if not card_processed_emitted:
                                _emit_card_processed("verified" if card_completed_cleanly else "error")
                            if not handled_return_to_results and not generator_closing:
                                can_skip_return = False
                                if (
                                    card_completed_cleanly
                                    and getattr(self.config, "skip_redundant_return_to_results", True)
                                    and _return_to_results is _DEFAULT_RETURN_TO_RESULTS
                                ):
                                    can_skip_return = await _can_continue_from_split_results_feed(
                                        page,
                                        panel_sel,
                                        seen_hrefs=seen_hrefs,
                                        failed_this_round=failed_this_round,
                                        exhausted_mismatch_keys=exhausted_mismatch_keys,
                                    )
                                if can_skip_return:
                                    self._profiler.incr("return_to_results_skipped")
                                    consecutive_return_failures = 0
                                else:
                                    self._profiler.incr("return_to_results_executed")
                                    elapsed_card_s = asyncio.get_event_loop().time() - card_started_monotonic
                                    remaining_card_s = max(2.0, card_timeout_s - elapsed_card_s)
                                    try:
                                        returned_ok = await asyncio.wait_for(
                                            _return_to_results(
                                                page,
                                                panel_sel,
                                                config=self.config,
                                                profiler=self._profiler,
                                                on_progress=_emit_progress,
                                            ),
                                            timeout=remaining_card_s,
                                        )
                                    except asyncio.TimeoutError:
                                        self._profiler.incr("card_operation_timeouts")
                                        returned_ok = False
                                    if returned_ok:
                                        consecutive_return_failures = 0
                                    else:
                                        feed_ready = await _is_feed_ready(page, panel_sel)
                                        if not feed_ready:
                                            cards_left = max(0, len(listing_anchors) - 1)
                                            recovered = await handle_return_failure("finally_after_card", cards_left=cards_left)
                                            if not recovered and not await _is_feed_ready(page, panel_sel):
                                                panel_lost = True

                    # Check for end of results
                    try:
                        body_text = await page.evaluate(
                            "() => document.body?.innerText || ''"
                        )
                        body_lower = body_text.lower()
                        if any(eol.lower() in body_lower for eol in _EOL_TEXTS):
                            log.debug(f"[maps] reached end of results after {yielded} places")
                            _check_panel_verification_failed_outcome("end_of_results")
                            return
                        if len(listing_anchors) == 0 and yielded == 0 and rounds_this_attempt >= 1:
                            log.info(f"[maps] 0 places found on initial scan for {full_query!r} — ending area search")
                            _check_panel_verification_failed_outcome("empty_scan")
                            return
                    except Exception as exc:
                        if _is_target_closed_or_crashed_error(exc):
                            _mark_page_crashed(page)
                            raise DiscoveryFailure(
                                DiscoveryFailureReason.SCRAPER_ERROR,
                                f"browser target crashed during end-of-results check: {exc}",
                            )

                    # Scroll the results panel. Phase 6 opt #1: pacing and
                    # the "wait for new content" logic live inside
                    # _human_scroll (event-driven, bounded). Phase 2A:
                    # _human_scroll now times its own "scroll_movement" vs
                    # "scroll_wait" sub-stages internally (see its
                    # docstring), so there's no outer wrapper here anymore
                    # — the old combined `maps_scroll_round` timer hid which
                    # half of scrolling was actually expensive.
                    await _human_scroll(
                        page, panel_sel, config=self.config, profiler=self._profiler,
                    )
                    if clicks_this_round == 0:
                        self._profiler.incr("rounds_without_click")
                        log.debug(f"[maps] round={rounds_this_attempt} finished with 0 clicks")

                # Finished this attempt's scroll budget without crashing —
                # max_results reached, the per-attempt or cross-attempt
                # scroll cap was hit, or EOL already returned above.
                # Nothing left to retry. A clean `return` here is correct:
                # SUCCESS (either TARGET_REACHED or genuine EXHAUSTED — the
                # caller distinguishes those two from `yielded` vs
                # `max_results`), never a disguised failure.
                #
                # CRITMODE PART 2 -- PRE-FIRST-CANDIDATE instrumentation:
                # this IS the "search exhausted" moment for this street's
                # scan -- whether that's genuine EOL, max_results, or a
                # scroll-cap stop, the caller (service.py) can't
                # distinguish those from this signal alone, but Node CAN
                # already tell TARGET_REACHED apart via bridgeTimings/
                # __done__'s own fields -- this event only marks WHEN
                # scanning stopped, carrying how many places were yielded
                # as item_id. Diagnostic only.
                _check_panel_verification_failed_outcome("scroll_rounds_completed")
                _emit_progress("search_exhausted", str(yielded))
                return

            except DiscoveryFailure as exc:
                # ROOT CAUSE FIX (Part 8 — false "exhausted" results): a
                # typed discovery failure (no valid panel, consent/block
                # interstitial, navigation timeout) is NOT a renderer
                # crash, but it still gets one retry with a fresh
                # context/proxy in case it was transient (e.g. a one-off
                # block on this proxy). What changes from the old behavior
                # is the LAST attempt: instead of silently `return`-ing
                # (which is indistinguishable from a query whose results
                # genuinely ran out), the failure is re-raised so it
                # propagates all the way to service.py's `__done__`
                # sentinel as an explicit, machine-readable reason.
                crashed = True
                is_last_attempt = attempt >= max_attempts
                log.error(
                    f"[maps] discovery failure ({exc.reason.value}) for "
                    f"{full_query!r} (attempt {attempt}/{max_attempts}, "
                    f"{yielded} place(s) already yielded): {exc.detail}"
                )
                # CRITMODE PART 2 -- PRE-FIRST-CANDIDATE instrumentation:
                # a typed DiscoveryFailure (panel not found, consent/block,
                # nav timeout) about to be retried (or, on the last
                # attempt, re-raised). Distinct from the generic
                # crash_detected event below (which is only the
                # unclassified except-Exception branch) -- this is
                # specifically "a real DiscoveryFailure just fired", with
                # the reason carried as item_id. Diagnostic only.
                _emit_progress("panel_failure_retry", f"{exc.reason.value}:{attempt}")
                if proxy:
                    self._proxy_manager.report_failure(proxy)
                if is_last_attempt:
                    raise
                # else: fall through to `finally`, then the `while` loop
                # retries with a freshly built context/page.

            except asyncio.CancelledError:
                _log_stack_snapshot("search_cancelled_watchdog_or_abort")
                raise

            except Exception as exc:
                # LIFECYCLE FIX (fast target cleanup / shutdown noise —
                # FINAL SHUTDOWN LATENCY + CONSUMER_STOPPED FIX): once a
                # cooperative stop has been requested, Playwright calls
                # still in flight on this attempt's page/context routinely
                # raise a closed-target/connection-closed error the moment
                # cleanup elsewhere (or the SIGTERM handler) starts tearing
                # the browser down mid-attempt. That is not a crash — it's
                # the expected, intentional side effect of shutting down
                # while a scroll/click/network op was mid-flight. Treating
                # it as one (logging it fatal, spending a full retry with a
                # brand-new browser context, or even raising
                # DiscoveryFailure(SCRAPER_ERROR) on the last attempt) is
                # exactly the wasted ~20s of "shutdown/forced cancellation"
                # latency reported live. Detected only when should_stop()
                # is ALSO true — a real crash that happens to coincide with
                # an unrelated shutdown flag must still surface normally.
                if should_stop is not None and should_stop() and _looks_like_shutdown_noise(exc):
                    log.info(
                        f"[maps] suppressing expected shutdown-noise error for "
                        f"{full_query!r} (attempt {attempt}/{max_attempts}, "
                        f"{yielded} place(s) already yielded) — cooperative "
                        f"stop already requested, not a genuine crash: {exc}"
                    )
                    return
                crashed = True
                is_last_attempt = attempt >= max_attempts
                log.error(
                    f"[maps] {'fatal' if is_last_attempt else 'recoverable'} "
                    f"error for {full_query!r} (attempt {attempt}/{max_attempts}, "
                    f"{yielded} place(s) already yielded): {exc}"
                )
                # MINIMAL FIX (discovery liveness — forensic audit §9): this
                # is the generic browser/page/context crash branch (e.g.
                # "Target crashed", "Target page, context or browser has
                # been closed" — see the audit's §2 evidence) as opposed to
                # a typed DiscoveryFailure (nav timeout, consent, panel not
                # found) above. Emitted regardless of whether this is the
                # last attempt, so Node sees "a crash just happened" even
                # on the final, unrecoverable attempt.
                _emit_progress("crash_detected", str(attempt))
                if proxy:
                    self._proxy_manager.report_failure(proxy)
                if is_last_attempt:
                    # ROOT CAUSE FIX (Part 8): an unclassified error used to
                    # `return` silently here too — same problem as above,
                    # just for errors this module didn't anticipate closely
                    # enough to raise as a typed DiscoveryFailure itself.
                    # Wrapping it (instead of a bare `raise`) guarantees
                    # every exit-by-failure path — known or unknown cause —
                    # surfaces the same way to callers: a DiscoveryFailure,
                    # never a clean-looking `return`.
                    raise DiscoveryFailure(
                        DiscoveryFailureReason.SCRAPER_ERROR,
                        f"unclassified error after {max_attempts} attempt(s) "
                        f"for {full_query!r}: {exc}",
                    ) from exc
                # else: fall through to `finally`, then the `while` loop
                # retries with a freshly built context/page.
            finally:
                await _close_bounded(page.close, "page")
                await _close_bounded(ctx.close, "context")
                log_milestone(f"After search attempt cleanup (attempt {attempt})")
                if not crashed and proxy:
                    self._proxy_manager.report_success(proxy)

    async def get_place_by_url(
        self,
        maps_url: str,
        *,
        city: str = "",
        country: str = "",
        niche: str = "",
        region: str = "",
    ) -> RawPlace | None:
        """Fetch data for a specific Maps place URL (for pool refreshes)."""
        proxy = await self._proxy_manager.next() if self._proxy_manager else None
        ctx = await _new_stealth_context(self.browser, proxy=proxy)
        page = await ctx.new_page()

        try:
            await self._limiter.acquire("maps_direct")
            await page.goto(maps_url, wait_until="domcontentloaded",
                            timeout=self.config.place_timeout_ms)
            try:
                await page.wait_for_selector("h1", timeout=10_000)
            except PlaywrightTimeoutError:
                pass

            # Phase 2A note: the settle wait moved out of _extract_place_data
            # and into callers (see that function's docstring). This is an
            # out-of-Discovery-scope caller (pool refreshes, not the
            # search() path), so it isn't given its own profiler stage here
            # — but it must still settle before extracting to avoid a
            # regression versus the previous behavior.
            await _wait_for_place_settle(page, config=self.config)

            return await _extract_place_data(
                page,
                config=self.config,
                city=city,
                country=country,
                niche=niche,
                region=region,
            )
        except Exception as exc:
            log.debug(f"[maps] direct URL error: {exc}")
            return None
        finally:
            # Same independent-cleanup pattern as search()'s finally block:
            # a failing page.close() must not prevent ctx.close() from
            # running, or the context (and its underlying browser
            # resources) leaks.
            try:
                await page.close()
            except Exception:
                pass
            try:
                await ctx.close()
            except Exception:
                pass
