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
import random
import re
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
from utils.lifecycle_tracker import install_tracker, track_browser_created, log_milestone
from utils.perf import NullProfiler
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
    "h1",
]

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


async def _block_heavy_resources(ctx: BrowserContext) -> None:
    async def _handle(route):
        if route.request.resource_type in _BLOCKED_RESOURCE_TYPES:
            await route.abort()
        else:
            await route.continue_()

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


_PLACE_CID_RE = re.compile(r"0x[0-9a-fA-F]+:0x[0-9a-fA-F]+")
_PLACE_GID_RE = re.compile(r"/g/([A-Za-z0-9_-]+)")

# Controls that return from a place's detail pane to the results feed.
# Maps' markup for this isn't stable, so several are tried in order.
_BACK_BUTTON_SELECTORS = [
    "button[aria-label='Back']",
    "button[jsaction*='pane.backButton.click']",
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


async def _return_to_results(page: Page, panel_selector: str, *, config: ScraperConfig) -> bool:
    """Navigate from a place's detail pane back to the results feed.

    Clicking a listing card swaps the results feed out for that place's
    detail pane *in place* — there's no page navigation to undo, only a
    UI "back" control. Without explicitly clicking it, the scraper is
    left looking at the detail pane: the next round's anchor scan and
    the next scroll both silently operate on that pane instead of the
    results list, which is the root cause of the same business getting
    re-yielded (a self-referential or differently-formatted link on the
    detail pane looks "new" under href-based dedup) and of scrolling
    becoming a no-op (the feed panel `_human_scroll` looks for isn't
    there anymore).
    """
    if await page.query_selector(panel_selector):
        return True  # already on the results list

    for sel in _BACK_BUTTON_SELECTORS:
        try:
            btn = await page.query_selector(sel)
            if not btn:
                continue
            await btn.click(timeout=3000)
        except Exception:
            continue

        try:
            await page.wait_for_selector(panel_selector, timeout=config.scroll_settle_timeout_ms)
            return True
        except PlaywrightTimeoutError:
            continue

    # Last resort: browser-level back navigation.
    try:
        await page.go_back(timeout=config.scroll_settle_timeout_ms)
        await page.wait_for_selector(panel_selector, timeout=config.scroll_settle_timeout_ms)
        return True
    except Exception:
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
                    phones = extract_phones(aria)
                    if phones:
                        return phones[0]

                text = (await el.inner_text()).strip()
                phones = extract_phones(text)
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


async def _extract_place_data(
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
            requests_per_minute=config.maps_rpm,
            burst=3,
            jitter_pct=20,
            min_delay_ms=800,
        )
        self._playwright = None
        self._browser: Browser | None = None

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
            "--window-size=1920,1080",
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
        if self._browser:
            try:
                await self._browser.close()
            except Exception as exc:
                log.warning(f"[maps] browser.close() failed during cleanup: {exc}")
        if self._playwright:
            try:
                await self._playwright.stop()
            except Exception as exc:
                log.warning(f"[maps] playwright.stop() failed during cleanup: {exc}")

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
    ) -> AsyncIterator[RawPlace]:
        """Search Google Maps and yield RawPlace objects.

        Args:
            query:       Search query, e.g. "specialty coffee shops"
            city:        City name, e.g. "Austin"
            country:     Country code, e.g. "US"
            niche:       Niche tag from the niche catalog
            region:      Region tag from regional config
            max_results: Stop after yielding this many places

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
        full_query = f"{query} in {city}"
        search_url = (
            "https://www.google.com/maps/search/"
            + quote_plus(full_query)
        )

        log.info(f"[maps] searching: {full_query!r}")

        proxy = await self._proxy_manager.next() if self._proxy_manager else None

        yielded = 0
        seen_hrefs: set[str] = set()      # place-identity keys derived from hrefs seen in the feed
        seen_place_keys: set[str] = set() # name+address keys of places already yielded (2nd guard)
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
            with self._profiler.timer("context_creation"):
                ctx = await _new_stealth_context(self.browser, proxy=proxy)
            with self._profiler.timer("page_creation"):
                page = await ctx.new_page()
            crashed = False

            try:
                with self._profiler.timer("rate_limit_wait_search"):
                    await self._limiter.acquire("maps_search")
                try:
                    with self._profiler.timer("maps_initial_load"):
                        await page.goto(search_url, wait_until="networkidle",
                                        timeout=self.config.maps_timeout_ms)
                except PlaywrightTimeoutError:
                    with self._profiler.timer("maps_initial_load"):
                        await page.goto(search_url, wait_until="domcontentloaded",
                                        timeout=self.config.maps_timeout_ms)

                # Wait for results to appear
                panel_sel = None
                for sel in _PANEL_SELECTORS:
                    try:
                        await page.wait_for_selector(sel, timeout=8000)
                        panel_sel = sel
                        break
                    except PlaywrightTimeoutError:
                        continue

                if not panel_sel:
                    log.warning(f"[maps] no result panel found for: {full_query!r}")
                    return

                if attempt > 1:
                    log.info(
                        f"[maps] recovered from crash for {full_query!r} — "
                        f"attempt {attempt}/{max_attempts}, resuming with "
                        f"{yielded} place(s) already yielded"
                    )
                    # Fast-forward back toward roughly where the crashed
                    # attempt left off. seen_hrefs dedupes anything
                    # re-encountered along the way, so overshooting or
                    # undershooting slightly is harmless.
                    for _ in range(total_scroll_rounds):
                        await _human_scroll(
                            page, panel_sel, config=self.config, profiler=self._profiler,
                        )
                        await asyncio.sleep(0.15)

                rounds_this_attempt = 0

                while (
                    yielded < max_results
                    and rounds_this_attempt < self.config.scroll_max_rounds
                    and total_scroll_rounds < max_total_rounds
                ):
                    rounds_this_attempt += 1
                    total_scroll_rounds += 1

                    # Collect listing anchors — scoped to the results feed
                    # panel itself, never the whole page. Clicking a card
                    # swaps the feed out for that place's detail pane *in
                    # the same DOM area*; a page-wide query would happily
                    # keep matching anchors inside that detail pane (e.g.
                    # a self-referential link) and mistake them for fresh
                    # results, which is how the same business kept getting
                    # yielded. If the feed isn't present, try to recover
                    # before giving up on this round.
                    panel = await page.query_selector(panel_sel)
                    if panel is None:
                        if not await _return_to_results(page, panel_sel, config=self.config):
                            log.debug("[maps] lost the results feed and couldn't recover — ending round")
                            break
                        panel = await page.query_selector(panel_sel)
                    if panel is None:
                        break

                    listing_anchors = await panel.query_selector_all(
                        "a[href*='/maps/place/']"
                    )

                    # Deduplicate on a stable place identity (CID / g-id
                    # extracted from the href) rather than the raw href
                    # string — the same place can appear with differently
                    # formatted hrefs depending on where in the DOM it was
                    # found (list card vs. detail-pane self-link).
                    new_anchors = []
                    for a in listing_anchors:
                        try:
                            href = await a.get_attribute("href") or ""
                            if "/maps/place/" not in href:
                                continue
                            place_key = _place_identity_from_href(href)
                            if place_key and place_key not in seen_hrefs:
                                seen_hrefs.add(place_key)
                                new_anchors.append(a)
                        except Exception:
                            continue

                    panel_lost = False
                    for anchor in new_anchors:
                        if panel_lost:
                            break
                        if yielded >= max_results:
                            return

                        try:
                            with self._profiler.timer("place_click"):
                                await _human_click(page, anchor)
                        except Exception:
                            continue

                        try:
                            # Wait for place panel to open. Phase 2A: timed
                            # separately from the click itself, so "place
                            # opening" (click + panel wait) is visible as
                            # two distinct numbers rather than folded into
                            # whatever the caller happened to wrap.
                            with self._profiler.timer("place_panel_wait"):
                                try:
                                    await page.wait_for_selector(
                                        _PLACE_NAME_SELECTORS[0],
                                        timeout=self.config.place_timeout_ms,
                                    )
                                except PlaywrightTimeoutError:
                                    try:
                                        await page.wait_for_selector("h1", timeout=5000)
                                    except PlaywrightTimeoutError:
                                        continue

                            # Phase 2A / audit §3.1 + §3.3: the rate-limiter
                            # wait was previously invisible to the profiler
                            # entirely (it ran before any timer started).
                            # It's the single highest-estimated bottleneck
                            # in the Phase 1A audit — now it's measured
                            # directly instead of reasoned about.
                            with self._profiler.timer("rate_limit_wait_place"):
                                await self._limiter.acquire("maps_place")

                            # Phase 2A / audit §3.2 + §3.3: the settle wait
                            # used to be an unconditional sleep folded
                            # inside `maps_place_extraction`'s timer. It's
                            # now its own stage, and event-driven (see
                            # _wait_for_place_settle) instead of a blind
                            # fixed sleep — same ceiling, no regression.
                            with self._profiler.timer("place_settle"):
                                await _wait_for_place_settle(page, config=self.config)

                            try:
                                with self._profiler.timer("maps_place_extraction"):
                                    place = await _extract_place_data(
                                        page,
                                        config=self.config,
                                        query=full_query,
                                        niche=niche,
                                        region=region,
                                        city=city,
                                        country=country,
                                    )
                            except Exception as exc:
                                log.debug(f"[maps] extraction error: {exc}")
                                self._stats.errors += 1
                                continue

                            if not place:
                                continue

                            # Skip permanently closed
                            if place.closed:
                                self._stats.skip("permanently_closed")
                                continue

                            # Phase 2A: first successfully-extracted raw
                            # place, before dedup — distinct from "first
                            # yielded" below, which only fires once a place
                            # has also survived the identity guard.
                            self._profiler.mark_first_discovered_business()

                            # Second-layer identity guard, independent of
                            # href formatting entirely (see docstring on
                            # _place_identity_from_data).
                            with self._profiler.timer("duplicate_detection"):
                                place_key = _place_identity_from_data(place)
                                is_dup = place_key in seen_place_keys
                                if not is_dup:
                                    seen_place_keys.add(place_key)

                            if is_dup:
                                log.debug(
                                    f"[maps] skipping duplicate place "
                                    f"(identity match): {place.name!r}"
                                )
                                continue

                            log.debug(
                                f"[maps] ✓ {place.name!r} | "
                                f"reviews={place.reviews} | "
                                f"rating={place.rating} | "
                                f"website={place.website[:40]!r}"
                            )

                            self._profiler.mark_first_yielded_business()
                            yield place
                            yielded += 1
                        finally:
                            # Clicking a card left us on this place's
                            # detail pane. Return to the results list
                            # before evaluating the next anchor — this is
                            # the actual fix for the same business getting
                            # yielded repeatedly (see _return_to_results).
                            if not await _return_to_results(
                                page, panel_sel, config=self.config
                            ):
                                panel_lost = True

                    # Check for end of results
                    try:
                        body_text = await page.evaluate(
                            "() => document.body?.innerText || ''"
                        )
                        if any(eol in body_text for eol in _EOL_TEXTS):
                            log.debug(f"[maps] reached end of results after {yielded} places")
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

                # Finished this attempt's scroll budget without crashing —
                # max_results reached, the per-attempt or cross-attempt
                # scroll cap was hit, or EOL already returned above.
                # Nothing left to retry.
                return

            except Exception as exc:
                crashed = True
                is_last_attempt = attempt >= max_attempts
                log.error(
                    f"[maps] {'fatal' if is_last_attempt else 'recoverable'} "
                    f"error for {full_query!r} (attempt {attempt}/{max_attempts}, "
                    f"{yielded} place(s) already yielded): {exc}"
                )
                if proxy:
                    self._proxy_manager.report_failure(proxy)
                if is_last_attempt:
                    return
                # else: fall through to `finally`, then the `while` loop
                # retries with a freshly built context/page.
            finally:
                try:
                    await page.close()
                except Exception:
                    pass
                try:
                    await ctx.close()
                except Exception:
                    pass
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
