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
import os
import sys
import random
import re
import time
from dataclasses import dataclass, field
from typing import AsyncIterator
from urllib.parse import urlencode, urlparse, quote_plus

from playwright.async_api import (
    async_playwright,
    Browser,
    BrowserContext,
    Page,
    TimeoutError as PlaywrightTimeoutError,
)

from utils.parsing import (
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
)
from utils.lifecycle_tracker import install_tracker, track_browser_created, log_milestone, get_memory_usage
from utils.perf import NullProfiler
from exceptions import DiscoveryFailure, DiscoveryFailureReason
from utils.place_id import canonical_place_id, expand_place_id_forms
from street_inventory.classifier import is_address_on_street
install_tracker()

log = get_logger("maps")

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
            await page.wait_for_selector(sel, timeout=8000)
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
    "button[aria-label='Back to results']",
    "button[aria-label='Back']",
    "button[aria-label*='back to results' i]",
    "button[aria-label*='Back' i]",
    "button[jsaction*='pane.backButton']",
    "button[data-tooltip*='Back to results' i]",
    "button[data-tooltip*='Back' i]",
    "button.hYBOP",
    "span.google-symbols.mL3xi",
]


def _place_identity_from_href(href: str) -> str:
    """Extract a stable place identity from a Maps href.

    A place's href embeds its actual CID — a hex pair like
    '0x4876...:0x89ab...' — inside the `data=` segment. That CID is
    stable for a given place, but everything else about the href (the
    display-name slug, the lat/lng camera position, `entry=`/tracking
    params) varies depending on *where* the link was captured from: a
    card in the results feed vs. a self-referential link inside that
    same place's own detail pane. Deduping on the raw href (or a
    `?`-stripped prefix of it) treats the same physical place as "new"
    every time it shows up with a differently-formatted href — this is
    what let the same business get yielded repeatedly. Falls back to the
    short `/g/<id>` id, then the bare href, if no CID is present.
    """
    if not href:
        return ""
    m = _PLACE_CID_RE.search(href)
    if m:
        return m.group(0)
    m = _PLACE_GID_RE.search(href)
    if m:
        return f"g/{m.group(1)}"
    return href.split("?")[0]


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
    if not url:
        return ""
    m = _PLACE_CID_RE.search(url)
    if m:
        return m.group(0).lower()
    m = _PLACE_CHIJ_RE.search(url)
    if m:
        return m.group(1)
    m = _PLACE_GID_RE.search(url)
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


async def _is_detail_pane_open(page: Page, feed_el: object = None) -> bool:
    """Return True if a place detail pane (heading or back button) is currently open.
    Checks `el is not feed_el` and element capability so minimal unit-test stubs where
    `page.query_selector(_)` returns the feed panel object for all selectors do not
    falsely report an open detail pane."""
    for sel in _PLACE_NAME_SELECTORS:
        try:
            el = await page.query_selector(sel)
            if el is not None and el is not feed_el:
                if hasattr(el, "is_visible"):
                    try:
                        if not await el.is_visible():
                            continue
                    except Exception:
                        pass
                if hasattr(el, "inner_text"):
                    txt = (await el.inner_text() or "").strip()
                    if txt and txt.lower() not in {"results", "search results", "النتائج"}:
                        return True
        except Exception:
            continue
    # Detail pane back buttons specific to the place pane
    for sel in [
        "button[aria-label='Back to results']",
        "button[aria-label*='back to results' i]",
        "button[jsaction*='pane.backButton']",
        "button[data-tooltip*='Back to results' i]",
    ]:
        try:
            el = await page.query_selector(sel)
            if el is not None and el is not feed_el:
                if hasattr(el, "is_visible"):
                    try:
                        if not await el.is_visible():
                            continue
                    except Exception:
                        pass
                if hasattr(el, "click"):
                    return True
        except Exception:
            continue
    return False


async def _read_panel_identity_snapshot(page: Page, feed_el: object = None) -> dict:
    """Capture the currently rendered detail-pane identity signals."""
    detail_open = await _is_detail_pane_open(page, feed_el)
    raw_name = ""
    raw_address = ""
    if detail_open:
        for sel in _PLACE_NAME_SELECTORS:
            try:
                el = await page.query_selector(sel)
                if el is not None and el is not feed_el and hasattr(el, "inner_text"):
                    t = (await el.inner_text() or "").strip()
                    if t:
                        raw_name = t
                        break
            except Exception:
                continue
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
    url = getattr(page, "url", "") or ""
    place_id = _stable_place_id_from_url(url) if "/maps/place/" in url else ""
    return {
        "open": detail_open,
        "name": _norm_identity_text(raw_name),
        "raw_name": raw_name,
        "address": _norm_identity_text(raw_address),
        "raw_address": raw_address,
        "place_id": place_id,
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
) -> tuple[bool, str]:
    """Verify whether `snap` belongs to the intended clicked card rather than a
    stale detail panel left over from an earlier card."""
    if not snap.get("open") and not snap.get("name"):
        # Minimal unit-test stub without detail-panel DOM elements
        return True, "stub_no_detail_dom"

    card_pid = _stable_place_id_from_url(card_href)
    panel_pid = snap.get("place_id") or ""
    card_name = _norm_identity_text((card_signals or {}).get("name") or "")
    card_slug_name = _place_name_from_href(card_href)
    expected_name = card_name or card_slug_name
    card_addr_hint = _extract_card_address_hint(card_signals, expected_name)
    panel_name = snap.get("name") or ""
    panel_addr = snap.get("address") or ""

    # 1. Strongest check: stable place-ID comparison when both card and panel URL expose one.
    if card_pid and panel_pid and card_pid.lower() != panel_pid.lower():
        return False, f"place_id_conflict(card={card_pid},panel={panel_pid})"

    # 2. Check against prior open panel (either open before click or last verified card).
    prior = None
    if pre_click_snapshot and pre_click_snapshot.get("open"):
        prior = pre_click_snapshot
    elif last_verified_panel and last_verified_panel.get("place_key") != place_key:
        prior = last_verified_panel

    if prior is not None:
        prior_pid = prior.get("place_id") or ""
        prior_name = prior.get("name") or ""
        prior_addr = prior.get("address") or ""
        if panel_pid and prior_pid and panel_pid.lower() == prior_pid.lower():
            if not card_pid or card_pid.lower() != panel_pid.lower():
                return False, "panel_place_id_unchanged_from_prior"
        # If panel name and address are identical to the prior card's panel and no new
        # matching place_id proves the panel updated, reject as stale.
        if (
            panel_name
            and panel_name == prior_name
            and panel_addr == prior_addr
            and not (card_pid and panel_pid and card_pid.lower() == panel_pid.lower())
        ):
            return False, "panel_name_and_address_unchanged_from_prior"

    # 3. Name consistency check.
    if expected_name and panel_name and not _names_consistent(expected_name, panel_name):
        return False, f"name_conflict(expected={expected_name!r},actual={panel_name!r})"

    # 4. Address hint consistency check (distinguishes same-name branches).
    if card_addr_hint and panel_addr and not _addresses_consistent(card_addr_hint, panel_addr):
        return False, f"address_conflict(hint={card_addr_hint!r},actual={panel_addr!r})"

    return True, "verified"


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
) -> tuple[bool, dict, str]:
    """Bounded poll waiting for the detail panel to reflect the clicked card's identity."""
    deadline = asyncio.get_event_loop().time() + max(0.05, min(timeout_ms, 1500) / 1000.0)
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
        )
        last_reason = reason
        if ok:
            return True, last_snap, reason
        if asyncio.get_event_loop().time() >= deadline:
            return False, last_snap, last_reason
        await asyncio.sleep(0.04)


async def _return_to_results(
    page: Page,
    panel_selector: str,
    *,
    config: ScraperConfig,
    profiler=None,
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

    with prof.timer("return_to_results"):
        feed_el = await page.query_selector(panel_selector)
        if feed_el is not None and not await _is_detail_pane_open(page, feed_el):
            return True

        # 1. Keyboard Escape to dismiss the detail pane without DOM manipulation or history navigation
        if hasattr(page, "keyboard") and hasattr(page.keyboard, "press"):
            try:
                await page.keyboard.press("Escape")
                esc_deadline = asyncio.get_event_loop().time() + 0.3
                while asyncio.get_event_loop().time() < esc_deadline:
                    feed_el = await page.query_selector(panel_selector)
                    if feed_el is not None and not await _is_detail_pane_open(page, feed_el):
                        return True
                    await asyncio.sleep(0.03)
            except Exception:
                pass

        # 2. In-DOM back button click
        for sel in _BACK_BUTTON_SELECTORS:
            try:
                btn = await page.query_selector(sel)
                if not btn or btn is feed_el:
                    continue
                if hasattr(btn, "is_visible"):
                    try:
                        if not await btn.is_visible():
                            continue
                    except Exception:
                        pass
                try:
                    await btn.click(timeout=min(2000, timeout_ms))
                except Exception:
                    if hasattr(btn, "evaluate"):
                        await btn.evaluate("el => el.click()")
            except Exception:
                continue

            try:
                await page.wait_for_selector(panel_selector, timeout=min(config.scroll_settle_timeout_ms, timeout_ms))
            except Exception:
                pass

            # Poll UI state until detail pane closes or bounded settle expires
            settle_deadline = asyncio.get_event_loop().time() + min(1.0, max(0.2, timeout_ms / 2000.0))
            while asyncio.get_event_loop().time() < settle_deadline:
                feed_el = await page.query_selector(panel_selector)
                if feed_el is not None and not await _is_detail_pane_open(page, feed_el):
                    return True
                await asyncio.sleep(0.03)

        # 3. In-page history back if still open on place URL
        curr_url = getattr(page, "url", "") or ""
        if "/maps/place/" in curr_url and hasattr(page, "evaluate"):
            try:
                await page.evaluate("() => window.history ? window.history.back() : null")
                settle_deadline = asyncio.get_event_loop().time() + 0.3
                while asyncio.get_event_loop().time() < settle_deadline:
                    feed_el = await page.query_selector(panel_selector)
                    if feed_el is not None and not await _is_detail_pane_open(page, feed_el):
                        return True
                    await asyncio.sleep(0.03)
            except Exception:
                pass

        # Last resort: browser-level back navigation, ONLY if safe and won't pop to about:blank
        try:
            can_go_back = True
            if hasattr(page, "evaluate"):
                try:
                    hist_len = await page.evaluate("() => window.history ? window.history.length : 1")
                    if isinstance(hist_len, int) and hist_len <= 1:
                        can_go_back = False
                except Exception:
                    pass

            if can_go_back and hasattr(page, "go_back"):
                await page.go_back(timeout=min(config.scroll_settle_timeout_ms, timeout_ms))
                curr_url = getattr(page, "url", "") or ""
                if "about:blank" in curr_url or not curr_url.startswith("https://www.google.com/maps"):
                    log.warning(f"[maps] go_back popped to {curr_url!r}; restoring via go_forward")
                    if hasattr(page, "go_forward"):
                        try:
                            await page.go_forward(timeout=2000)
                        except Exception:
                            pass
                else:
                    try:
                        await page.wait_for_selector(panel_selector, timeout=min(config.scroll_settle_timeout_ms, timeout_ms))
                    except Exception:
                        pass
                    feed_el = await page.query_selector(panel_selector)
                    if feed_el is not None and not await _is_detail_pane_open(page, feed_el):
                        return True
        except Exception:
            pass

        prof.incr("return_to_results_failed")
        return False


async def _human_click(page: Page, element) -> None:
    """Click with a short hover pause to mimic human behavior."""
    try:
        box = await element.bounding_box()
        if box:
            # Move to element center with slight offset
            cx = box["x"] + box["width"] / 2 + random.randint(-3, 3)
            cy = box["y"] + box["height"] / 2 + random.randint(-2, 2)
            await page.mouse.move(cx, cy)
            await asyncio.sleep(random.uniform(0.05, 0.15))
        await element.click(timeout=5000)
    except Exception:
        await element.click(force=True, timeout=5000)


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

async def _wait_for_place_settle(page: Page, *, config: ScraperConfig) -> None:
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
    try:
        await page.wait_for_function(
            """() => {
                const sels = [
                    "[data-item-id='address'] .fontBodyMedium",
                    "button[data-item-id='address'] .rogA2c",
                    "div.F7nice span[aria-hidden='true']",
                    "button.DkEaL",
                    "[data-item-id^='phone:tel:'] .fontBodyMedium",
                    "button[data-item-id^='phone:'] .rogA2c",
                    "a[href^='tel:']",
                ];
                return sels.some(s => document.querySelector(s));
            }""",
            timeout=config.place_settle_ms,
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


async def _try_selectors(page: Page, selectors: list[str]) -> str:
    """Try each selector in order, returning first non-empty text."""
    for sel in selectors:
        try:
            el = await page.query_selector(sel)
            if el:
                text = (await el.inner_text()).strip()
                if text:
                    return text
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
    place.name = await _try_selectors(page, _PLACE_NAME_SELECTORS)
    if not place.name:
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
    function firstNonEmptyText(selectors) {
        for (const s of selectors) {
            try {
                const el = document.querySelector(s);
                if (el) {
                    const t = (el.innerText || "").trim();
                    if (t) return t;
                }
            } catch (e) {}
        }
        return "";
    }

    const name = firstNonEmptyText(sel.name);
    const category = firstNonEmptyText(sel.category);
    const address = firstNonEmptyText(sel.address);
    const ratingRaw = firstNonEmptyText(sel.rating);
    const reviewRaw = firstNonEmptyText(sel.review);

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
        html,
    };
}
"""


def _phone_from_candidates(candidates: "list[dict]") -> str:
    """Pure port of `_extract_place_data_legacy`'s `_extract_phone` main
    loop (selector precedence + per-element early-return order preserved
    exactly). Operates on the flattened candidate list the batched JS
    collects instead of live Playwright elements.
    """
    for c in candidates:
        href = c.get("href") or ""
        aria = c.get("ariaLabel") or ""

        if href.startswith("tel:"):
            return href[4:].strip()
        if "phone" in aria.lower() or "call" in aria.lower():
            phones = extract_phones(aria, trusted=True)
            if phones:
                return phones[0]

        text = c.get("innerText") or ""
        phones = extract_phones(text, trusted=True)
        if phones:
            return phones[0]

    return ""


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


def _website_from_candidates(candidates: "list[dict | None]") -> str:
    """Pure port of `_extract_website` — one candidate per selector
    (`query_selector` semantics, first match only), same fall-through from
    "href is an ordering platform" to "check this element's text" that the
    legacy per-selector loop body had.
    """
    for c in candidates:
        if not c:
            continue
        href = c.get("href") or ""
        if href and href.startswith("http"):
            m = re.search(r"[?&]q=([^&]+)", href)
            if m:
                from urllib.parse import unquote
                href = unquote(m.group(1))
            if not is_ordering_platform(href):
                return clean_url(href)
        text = c.get("innerText") or ""
        if text and "." in text and " " not in text:
            return f"https://{text}" if not text.startswith("http") else text
    return ""


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


async def _probe_detail_panel_website(page: Page) -> str:
    """Authoritative, lightweight detail-panel website probe.

    Evaluates _WEBSITE_SELECTORS on the currently-mounted detail panel and
    runs candidate URLs through _website_from_candidates() (which preserves
    clean_url and is_ordering_platform rules).
    Falls back to per-selector query_selector evaluation if page.evaluate() raises.
    """
    try:
        candidates = await page.evaluate(_DETAIL_WEBSITE_PROBE_JS, _WEBSITE_SELECTORS)
        if isinstance(candidates, list):
            return _website_from_candidates(candidates)
    except Exception:
        pass

    # Fallback to query_selector
    try:
        return await _extract_website(page)
    except Exception:
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

    try:
        data = await asyncio.wait_for(
            page.evaluate(_PLACE_EXTRACT_JS, _PLACE_EXTRACT_SELECTORS),
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

    place.name = (data.get("name") or "").strip()
    if not place.name:
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
    phone = _phone_from_candidates(phone_candidates)
    phone_from_fallback = False
    if not phone:
        # Same html blob already fetched above — this eliminates the
        # legacy code's second, independent `page.content()` call.
        phone = _phone_from_html_fallback(html)
        if phone:
            phone_from_fallback = True
    place.phone = phone

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

    place.website = _website_from_candidates(data.get("websiteCandidates") or [])

    place.rating = _rating_from_raw((data.get("ratingRaw") or "").strip())
    place.reviews = _reviews_from_raw_or_fallback(
        (data.get("reviewRaw") or "").strip(),
        data.get("reviewFallbackAria") or [],
    )

    place.maps_link = page.url

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


# ──────────────────────────────────────────────────────────────────────────────
# Main scraper class
# ──────────────────────────────────────────────────────────────────────────────

class MapsScraper:
    """Google Maps scraper with stealth Playwright automation.

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

    async def __aenter__(self) -> "MapsScraper":
        # Phase 2A: separate the Playwright driver spawn from the Chromium
        # launch below — these were previously untimed/combined, and the
        # audit's §3.6 recommendation was specifically to measure this
        # split before deciding anything about browser lifecycle reuse.
        with self._profiler.timer("playwright_startup"):
            self._playwright = await async_playwright().start()
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
        # Phase 2: time browser startup (chromium.launch is the most expensive
        # single synchronous operation in the whole Python subprocess)
        with self._profiler.timer("browser_startup"):
            self._browser = await self._playwright.chromium.launch(
                headless=self.config.headless,
                args=launch_args,
                ignore_default_args=["--enable-automation"],
            )
        track_browser_created()
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
        browser = self._browser
        self._browser = None
        playwright = self._playwright
        self._playwright = None
        if browser:
            await _close_bounded(browser.close, "browser")
        if playwright:
            await _close_bounded(playwright.stop, "playwright")

    @property
    def browser(self) -> Browser:
        if not self._browser:
            raise RuntimeError("MapsScraper not started — use async with")
        return self._browser

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
        # MINIMAL FIX (discovery liveness — forensic audit §9): a small,
        # local wrapper around `on_progress` so every call site below is a
        # one-liner and — critically — so an observer failure (or absence)
        # can never affect discovery itself. Mirrors
        # execution_driver.py's own `_emit()` wrapper around `on_progress`
        # (same "never allowed to raise into pipeline code" contract),
        # kept local here rather than imported since this module has no
        # existing dependency on engine/.
        def _emit_progress(event: str, item_id: str | None = None) -> None:
            if on_progress is None:
                return
            try:
                on_progress("discovery", event, item_id)
            except Exception:
                log.debug("on_progress observer raised — ignored", exc_info=True)

        if city and city.lower() not in query.lower():
            full_query = f"{query} in {city}"
        else:
            full_query = query
        search_url = (
            "https://www.google.com/maps/search/"
            + quote_plus(full_query)
        )

        log.info(f"[maps] searching: {full_query!r}")

        proxy = await self._proxy_manager.next() if self._proxy_manager else None

        yielded = 0
        seen_hrefs: set[str] = set()      # place-identity keys derived from hrefs seen in the feed
        seen_place_keys: set[str] = set() # name+address keys of places already yielded (2nd guard)
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
                            await page.goto(search_url, wait_until="domcontentloaded",
                                            timeout=min(self.config.maps_timeout_ms, 12000))
                        except PlaywrightTimeoutError as pto:
                            curr = getattr(page, "url", "") or ""
                            if "google.com/maps" in curr:
                                log.info(f"[maps] navigation domcontentloaded timed out after 12s but page landed on {curr!r} — proceeding")
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
                try:
                    _landed_url = page.url
                    _title = await page.title()
                    _body_len = len(await page.evaluate("() => document.body?.innerText?.length || 0"))
                    log.info(
                        f"[maps][diag] search page loaded — "
                        f"requested={search_url!r} landed_on={_landed_url!r} "
                        f"title={_title!r} body_chars={_body_len}"
                    )
                except Exception as _diag_exc:
                    log.debug(f"[maps][diag] page-load diagnostic failed: {_diag_exc}")

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
                        self._profiler.incr("return_to_results_failures")
                        self._profiler.incr("return_to_results_failed")

                        feed_present = False
                        try:
                            feed_present = (await page.query_selector(panel_sel)) is not None
                        except Exception:
                            pass
                        mem_mb = round(get_memory_usage(), 1)
                        curr_url = page.url or ""
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
                                self._profiler.incr("stale_panel_search_nav_recovery")
                                log.info(
                                    f"[maps][return-recovery] consecutive return failures ({consecutive_return_failures}) or url={curr_url!r} "
                                    f"— performing bounded search-navigation recovery for {full_query!r}"
                                )
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
                                    rec_feed = (await page.query_selector(panel_sel)) is not None
                                    if rec_feed:
                                        consecutive_return_failures = 0
                                        log.info(f"[maps][return-recovery] search-navigation recovery restored feed panel for {full_query!r}")
                                        return True
                                except Exception as rec_err:
                                    log.warning(f"[maps][return-recovery] search-navigation recovery failed for {full_query!r}: {rec_err}")

                            log.warning(
                                f"[maps][return-recovery] return_to_results failed {consecutive_return_failures} consecutive times "
                                f"for {full_query!r} — ending search with RETURN_TO_RESULTS_FAILED"
                            )
                            raise DiscoveryFailure(
                                DiscoveryFailureReason.RETURN_TO_RESULTS_FAILED,
                                f"return_to_results failed {consecutive_return_failures} consecutive times for {full_query!r}",
                            )
                        return False

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
                                page, panel_sel, config=self.config, profiler=self._profiler
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

                        # --- TEMPORARY DIAGNOSTIC (discovery-pipeline audit) ---
                        try:
                            _page_anchors_place = await page.eval_on_selector_all(
                                "a[href*='/maps/place/']", "els => els.length"
                            )
                        except Exception:
                            _page_anchors_place = "error"
                        log.info(
                            f"[maps][diag] round={rounds_this_attempt} "
                            f"cards_in_dom={len(listing_anchors)} "
                            f"page_anchors_place={_page_anchors_place} "
                            f"seen_so_far={len(seen_hrefs)} yielded_so_far={yielded}"
                        )
                        # --- end temporary diagnostic ---

                        if not _round_scan_emitted and len(listing_anchors) > 0:
                            _emit_progress("round_scanned", str(len(listing_anchors)))
                            self._profiler.incr("maps_candidates_seen", by=len(listing_anchors))
                            _round_scan_emitted = True

                        if (
                            rounds_this_attempt == 1
                            and len(listing_anchors) == 0
                            and isinstance(_page_anchors_place, int)
                            and _page_anchors_place > 0
                        ):
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
                                await _human_click(page, anchor)
                                clicks_this_round += 1
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
                        card_timeout_s = max(0.05, self.config.card_operation_timeout_ms / 1000.0)
                        card_started_monotonic = asyncio.get_event_loop().time()

                        async def _run_card_panel_and_extract() -> tuple[str, RawPlace | None, str]:
                            with self._profiler.timer("place_panel_wait"):
                                found_panel = False
                                for sel in (_PLACE_NAME_SELECTOR_COMBINED, *_PLACE_NAME_SELECTORS):
                                    try:
                                        await page.wait_for_selector(
                                            sel, timeout=max(100, min(self.config.place_timeout_ms, 2000))
                                        )
                                        found_panel = True
                                        self._profiler.incr("place_panel_wait_resolved")
                                        break
                                    except PlaywrightTimeoutError:
                                        continue
                                if not found_panel:
                                    if should_stop is not None and should_stop():
                                        self._profiler.incr("place_panel_wait_aborted")
                                    else:
                                        self._profiler.incr("place_panel_wait_timeout")
                                    return "panel_timeout", None, "panel_wait_timeout"

                            identity_ok, panel_snap, mismatch_reason = await _wait_for_verified_panel_identity(
                                page,
                                feed_el=panel,
                                card_href=card_href,
                                place_key=place_key,
                                card_signals=card_signals,
                                pre_click_snapshot=pre_click_snapshot,
                                last_verified_panel=last_verified_panel,
                                timeout_ms=self.config.place_timeout_ms,
                            )
                            if not identity_ok:
                                return "mismatch", None, mismatch_reason

                            fast_aborted = False
                            extracted_place: RawPlace | None = None
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

                                    candidate_name = card_signals.get("name") if card_signals else ""
                                    if not candidate_name:
                                        candidate_name = await _try_selectors(page, _PLACE_NAME_SELECTORS) or ""

                                    extracted_place = RawPlace(
                                        name=candidate_name or "Unknown Place",
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
                                with self._profiler.timer("rate_limit_wait_place"):
                                    await self._limiter.acquire("maps_place")

                                with self._profiler.timer("place_settle"):
                                    await _wait_for_place_settle(page, config=self.config)

                                try:
                                    with self._profiler.timer("maps_place_extraction"):
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
                                    return "mismatch", None, post_reason

                            return "ok", extracted_place, "verified"

                        try:
                            try:
                                card_status, place, card_reason = await asyncio.wait_for(
                                    _run_card_panel_and_extract(),
                                    timeout=card_timeout_s,
                                )
                            except PlaceExtractionTimeout:
                                if should_stop is not None and should_stop():
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
                                if should_stop is not None and should_stop():
                                    return
                                raise CardOperationTimeout(
                                    "card_operation", self.config.card_operation_timeout_ms
                                ) from None

                            if card_status in ("panel_timeout", "extract_error"):
                                card_attempts = mismatch_retries_by_key.get(place_key, 0) + 1
                                mismatch_retries_by_key[place_key] = card_attempts
                                if card_attempts >= 2:
                                    seen_hrefs.add(place_key)
                                else:
                                    failed_this_round.add(place_key)
                                continue

                            if card_status == "mismatch":
                                handled_return_to_results = True
                                self._profiler.incr("stale_panel_mismatch")
                                consecutive_mismatches_in_round += 1
                                total_mismatch_recoveries += 1
                                retries_for_key = mismatch_retries_by_key.get(place_key, 0) + 1
                                mismatch_retries_by_key[place_key] = retries_for_key
                                max_card_retries = getattr(self.config, "max_stale_panel_retries_per_card", 2)
                                if retries_for_key > max_card_retries:
                                    exhausted_mismatch_keys.add(place_key)

                                log.info(
                                    f"[maps][stale-panel] mismatch for place_key={place_key!r} "
                                    f"reason={card_reason} retry={retries_for_key}/{max_card_retries + 1} "
                                    f"consecutive_in_round={consecutive_mismatches_in_round} "
                                    f"total_recoveries={total_mismatch_recoveries}"
                                )

                                returned = await _return_to_results(
                                    page, panel_sel, config=self.config, profiler=self._profiler
                                )
                                feed_still_present = (await page.query_selector(panel_sel)) is not None

                                max_area_recoveries = getattr(
                                    self.config, "max_stale_panel_recoveries_per_area", 6
                                )
                                if consecutive_mismatches_in_round >= 3 or (not returned and not feed_still_present):
                                    if not search_nav_recovery_used:
                                        search_nav_recovery_used = True
                                        self._profiler.incr("stale_panel_search_nav_recovery")
                                        log.info(
                                            f"[maps][stale-panel] performing bounded search-navigation "
                                            f"recovery for {full_query!r}"
                                        )
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
                                        continue
                                    log.warning(
                                        f"[maps][stale-panel] mismatch persisted after search-navigation "
                                        f"recovery for {full_query!r} — terminating area safely"
                                    )
                                    return

                                if total_mismatch_recoveries >= max_area_recoveries:
                                    log.warning(
                                        f"[maps][stale-panel] reached max_stale_panel_recoveries_per_area="
                                        f"{max_area_recoveries} for {full_query!r} — terminating area safely"
                                    )
                                    return

                                continue

                            if not place or not place.name:
                                log.info(
                                    "[maps][diag] extraction returned no "
                                    "name — business dropped (card_key="
                                    f"{place_key!r})"
                                )
                                seen_hrefs.add(place_key)
                                continue

                            log.info(
                                f"[maps][diag] business parsed — name={place.name!r} "
                                f"address={place.address!r} rating={place.rating} "
                                f"reviews={place.reviews}"
                            )

                            if place.name.lower() in {"results", "search results", "النتائج"}:
                                log.info(
                                    f"[maps][diag] parsed name matched the "
                                    f"panel-header exclusion list "
                                    f"({place.name!r}) — dropped, not a real listing"
                                )
                                seen_hrefs.add(place_key)
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
                                "place_id": verified_pid,
                                "name": _norm_identity_text(place.name),
                                "address": _norm_identity_text(place.address),
                            }
                            seen_hrefs.add(place_key)

                            # Skip permanently closed
                            if place.closed:
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
                            yield place
                            yielded += 1
                            self._profiler.incr("maps_candidates_yielded")
                        finally:
                            if not handled_return_to_results:
                                elapsed_card_s = asyncio.get_event_loop().time() - card_started_monotonic
                                remaining_card_s = max(0.05, card_timeout_s - elapsed_card_s)
                                try:
                                    returned_ok = await asyncio.wait_for(
                                        _return_to_results(
                                            page,
                                            panel_sel,
                                            config=self.config,
                                            profiler=self._profiler,
                                        ),
                                        timeout=remaining_card_s,
                                    )
                                except asyncio.TimeoutError:
                                    self._profiler.incr("card_operation_timeouts")
                                    returned_ok = False
                                if returned_ok:
                                    consecutive_return_failures = 0
                                else:
                                    cards_left = max(0, len(listing_anchors) - 1)
                                    recovered = await handle_return_failure("finally_after_card", cards_left=cards_left)
                                    if not recovered and (await page.query_selector(panel_sel)) is None:
                                        panel_lost = True

                    # Check for end of results
                    try:
                        body_text = await page.evaluate(
                            "() => document.body?.innerText || ''"
                        )
                        body_lower = body_text.lower()
                        if any(eol.lower() in body_lower for eol in _EOL_TEXTS):
                            log.debug(f"[maps] reached end of results after {yielded} places")
                            return
                        if len(listing_anchors) == 0 and yielded == 0 and rounds_this_attempt >= 1:
                            log.info(f"[maps] 0 places found on initial scan for {full_query!r} — ending area search")
                            return
                    except Exception:
                        pass

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
                if is_last_attempt or exc.reason == DiscoveryFailureReason.RETURN_TO_RESULTS_FAILED:
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
