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

    return ctx


async def _human_scroll(page: Page, panel_selector: str, *, config: ScraperConfig) -> None:
    """Scroll the results panel with human-like speed and pauses."""
    try:
        panel = await page.query_selector(panel_selector)
        if not panel:
            return
        # Variable scroll amounts (humans don't scroll exactly the same each time)
        for _ in range(3):
            amount = random.randint(280, 480)
            await panel.evaluate(
                f"el => el.scrollBy({{ top: {amount}, behavior: 'smooth' }})"
            )
            await asyncio.sleep(
                random.uniform(
                    config.scroll_delay_ms / 1200,
                    config.scroll_delay_ms / 600,
                )
            )
    except Exception:
        pass


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
    """Extract all structured data from the currently open place panel."""

    # Wait for the place panel to settle
    await asyncio.sleep(config.place_settle_ms / 1000)

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
    ) -> None:
        self.config = config
        self._proxy_manager = proxy_manager or ProxyManager()
        self._stats = stats or RunStats()
        self._limiter = RateLimiter(
            requests_per_minute=config.maps_rpm,
            burst=3,
            jitter_pct=20,
            min_delay_ms=800,
        )
        self._playwright = None
        self._browser: Browser | None = None

    async def __aenter__(self) -> "MapsScraper":
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
        self._browser = await self._playwright.chromium.launch(
            headless=self.config.headless,
            args=launch_args,
            ignore_default_args=["--enable-automation"],
        )
        return self

    async def __aexit__(self, *_) -> None:
        if self._browser:
            await self._browser.close()
        if self._playwright:
            await self._playwright.stop()

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
        """
        proxy = await self._proxy_manager.next() if self._proxy_manager else None
        ctx = await _new_stealth_context(self.browser, proxy=proxy)
        page = await ctx.new_page()

        full_query = f"{query} in {city}"
        search_url = (
            "https://www.google.com/maps/search/"
            + quote_plus(full_query)
        )

        log.info(f"[maps] searching: {full_query!r}")

        try:
            await self._limiter.acquire("maps_search")
            try:
                await page.goto(search_url, wait_until="networkidle",
                                timeout=self.config.maps_timeout_ms)
            except PlaywrightTimeoutError:
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

            yielded = 0
            seen_hrefs: set[str] = set()
            scroll_round = 0

            while yielded < max_results and scroll_round < self.config.scroll_max_rounds:
                scroll_round += 1

                # Collect all visible listing anchors
                listing_anchors = await page.query_selector_all(
                    "a[href*='/maps/place/']"
                )

                # Deduplicate
                new_anchors = []
                for a in listing_anchors:
                    try:
                        href = await a.get_attribute("href") or ""
                        href_key = href.split("?")[0]
                        if href_key not in seen_hrefs and "/maps/place/" in href_key:
                            seen_hrefs.add(href_key)
                            new_anchors.append(a)
                    except Exception:
                        continue

                for anchor in new_anchors:
                    if yielded >= max_results:
                        return

                    try:
                        await _human_click(page, anchor)
                    except Exception:
                        continue

                    # Wait for place panel to open
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

                    await self._limiter.acquire("maps_place")

                    try:
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

                    log.debug(
                        f"[maps] ✓ {place.name!r} | "
                        f"reviews={place.reviews} | "
                        f"rating={place.rating} | "
                        f"website={place.website[:40]!r}"
                    )

                    yield place
                    yielded += 1

                # Check for end of results
                try:
                    body_text = await page.evaluate(
                        "() => document.body?.innerText || ''"
                    )
                    if any(eol in body_text for eol in _EOL_TEXTS):
                        log.debug(f"[maps] reached end of results after {yielded} places")
                        break
                except Exception:
                    pass

                # Scroll the results panel
                await _human_scroll(page, panel_sel, config=self.config)
                await asyncio.sleep(
                    random.uniform(
                        self.config.scroll_delay_ms / 1500,
                        self.config.scroll_delay_ms / 750,
                    )
                )

        except Exception as exc:
            log.error(f"[maps] fatal error for {full_query!r}: {exc}")
            if proxy:
                self._proxy_manager.report_failure(proxy)
        finally:
            await page.close()
            await ctx.close()
            if proxy:
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
            await page.close()
            await ctx.close()
