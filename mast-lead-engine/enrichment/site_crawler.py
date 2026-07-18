"""
Mast Lead Engine — Website Crawl Enrichment.

Crawls a business website to extract:
  • Email addresses (multi-strategy, priority-ranked)
  • Instagram / Facebook links
  • Contact form URL
  • Phone numbers
  • Tech stack fingerprinting (CMS, e-commerce platform, analytics)

Architecture (Enrichment Engine Layer 2 + 4):
  Layer 2 — Website Crawl: homepage + /contact + /about + /services
  Layer 4 — Tech Stack Detection: HTTP headers, JS files, meta tags

Crawl strategy:
  1. Load homepage, extract all anchors
  2. Identify contact-path candidates from anchors + URL guesses
  3. Visit up to `budget` contact pages (4 in standard, 2 in fast mode)
  4. Merge all findings, prefer own-domain emails

Tech stack detection:
  - CMS: WordPress, Squarespace, Wix, Webflow, Shopify, Ghost, etc.
  - E-commerce: Shopify, WooCommerce, BigCommerce, Magento, etc.
  - Analytics: GA4, Hotjar, Mixpanel, Segment, etc.
  - Chat: Intercom, Drift, Zendesk, Tawk.to, etc.
"""

from __future__ import annotations

import re
import time
from urllib.parse import urljoin, urlparse

from playwright.async_api import Page, TimeoutError as PlaywrightTimeoutError

from utils.parsing import (
    extract_emails, extract_phones, extract_ig_urls, extract_linkedin_urls,
    pick_best_email, pick_best_phone, rank_emails_by_role, is_ordering_platform,
    is_directory_site, is_weak_site, domain_of, origin_of,
    clean_url,
)
from utils.runtime import RateLimiter, get_logger, ScraperConfig
from utils.perf import NullProfiler

log = get_logger("site_crawler")

# ──────────────────────────────────────────────────────────────────────────────
# Growth signal detection (C3 fix)
# ──────────────────────────────────────────────────────────────────────────────
#
# ROOT CAUSE this fixes: `growth_signals` was read by three scoring/
# explanation layers but never populated anywhere, and the absence was
# narrated to users as a confident "no growth signals found" — see audit
# C3. This is a real, cheap detector reusing HTML the crawler already
# fetched (no extra requests): a careers/jobs link or "we're hiring"
# phrasing on the homepage/about page, and "new location" / "opening soon"
# phrasing for expansion. `recently_rebranded` and `funding` are NOT
# implemented here — there is no reliable, verifiable signal for either
# from a single site crawl (rebrand needs historical comparison, funding
# needs a press/news API) — per the brief's "if a signal cannot exist,
# remove it," those two keys are omitted entirely rather than always-false.

_HIRING_LINK_HINTS = ("/careers", "/jobs", "/join-us", "/join-our-team", "/work-with-us")
_HIRING_PHRASE_RE = re.compile(
    r"we(?:'|’)re hiring|now hiring|join our team|open positions|current openings|careers page",
    re.IGNORECASE,
)
_NEW_LOCATION_PHRASE_RE = re.compile(
    r"new location|opening soon|coming soon|now open in|second location|our new (?:shop|store|studio|location)",
    re.IGNORECASE,
)


def _detect_growth_signals(html: str, anchors: list[str]) -> dict:
    """Cheap, verifiable growth-signal detection from already-fetched HTML."""
    if not html:
        return {}
    signals: dict = {}
    low = html.lower()

    hiring_link = any(any(h in (a or "").lower() for h in _HIRING_LINK_HINTS) for a in anchors)
    if hiring_link or _HIRING_PHRASE_RE.search(low):
        signals["hiring"] = True

    if _NEW_LOCATION_PHRASE_RE.search(low):
        signals["new_location"] = True

    return signals


# ──────────────────────────────────────────────────────────────────────────────
# Lightweight on-page SEO signal detection (supports Priority 5's
# marketing-specific opportunity evidence: "poor SEO, missing metadata")
# ──────────────────────────────────────────────────────────────────────────────

_TITLE_RE = re.compile(r"<title[^>]*>(.*?)</title>", re.IGNORECASE | re.DOTALL)
_META_DESC_RE = re.compile(
    r'<meta[^>]+name=["\']description["\'][^>]+content=["\']([^"\']*)["\']', re.IGNORECASE
)
_BLOG_LINK_RE = re.compile(r'href=["\']([^"\']*?/(?:blog|news|articles|insights)[^"\']*)["\']', re.IGNORECASE)
_DATE_RE = re.compile(r"(20\d{2})[-/](\d{1,2})[-/](\d{1,2})")


def _detect_seo_signals(html: str) -> dict:
    """Missing/weak title + meta description — trivial from HTML already fetched."""
    if not html:
        return {}
    title_m = _TITLE_RE.search(html)
    title = (title_m.group(1).strip() if title_m else "")
    desc_m = _META_DESC_RE.search(html)
    desc = (desc_m.group(1).strip() if desc_m else "")

    return {
        "has_title": bool(title),
        "title_length": len(title),
        "has_meta_description": bool(desc),
        "meta_description_length": len(desc),
    }


def _detect_blog_signal(html: str) -> dict:
    """Presence of a blog/news section and, if a date is visible, how stale it looks."""
    if not html:
        return {}
    m = _BLOG_LINK_RE.search(html)
    if not m:
        return {"has_blog": False}
    result: dict = {"has_blog": True, "blog_url": m.group(1)}
    dates = _DATE_RE.findall(html)
    if dates:
        try:
            from datetime import date
            y, mo, d = (int(x) for x in dates[0])
            days = (date.today() - date(y, mo, d)).days
            if 0 <= days < 3650:
                result["last_post_days"] = days
        except Exception:
            pass
    return result

# ──────────────────────────────────────────────────────────────────────────────
# Contact page detection
# ──────────────────────────────────────────────────────────────────────────────

CONTACT_PATH_HINTS = (
    "/contact", "/contact-us", "/contactus", "/contacto",
    "/about", "/about-us", "/aboutus",
    "/reserve", "/reservations", "/booking", "/book",
    "/get-in-touch", "/getintouch", "/connect", "/reach",
    "/enquiry", "/enquire", "/inquiry", "/inquire",
    "/message", "/chat", "/info", "/hello",
)

FORM_PLATFORM_HINTS = (
    "typeform.com", "jotform.com", "wufoo.com", "formstack.com",
    "cognito", "paperform", "tally.so", "fillout.com",
    "calendly.com", "acuityscheduling.com", "booksy.com",
)

_FACEBOOK_RE = re.compile(
    r"https?://(?:www\.)?facebook\.com/[A-Za-z0-9_.+\-/]+", re.IGNORECASE
)

_FB_SKIP_PATHS = frozenset({
    "/sharer", "/dialog", "/plugins", "/share",
    "/login", "/signup",
})


def _clean_facebook(url: str) -> str:
    url = url.split('"')[0].split("'")[0]
    low = url.lower()
    if any(s in low for s in _FB_SKIP_PATHS):
        return ""
    return url


# ──────────────────────────────────────────────────────────────────────────────
# Tech stack fingerprints
# ──────────────────────────────────────────────────────────────────────────────

_TECH_PATTERNS: list[tuple[str, str, str]] = [
    # (key, category, regex_pattern)

    # CMS
    ("wordpress",    "cms", r"wp-content|wp-includes|wordpress"),
    ("squarespace",  "cms", r"squarespace\.com|static1\.squarespace\.com|sqsp"),
    ("wix",          "cms", r"wix\.com|wixstatic\.com|wix-thunder"),
    ("webflow",      "cms", r"webflow\.com|\.webflow\."),
    ("ghost",        "cms", r"ghost\.org|ghost\.io"),
    ("shopify",      "cms", r"cdn\.shopify\.com|myshopify\.com|shopify\.com/s/"),
    ("squarespace",  "cms", r"squarespace"),
    ("framer",       "cms", r"framer\.com|framer\.website"),
    ("cargo",        "cms", r"cargocollective\.com|cargo\.site"),
    ("format",       "cms", r"format\.com"),

    # E-commerce
    ("woocommerce",  "ecom", r"woocommerce|wc-ajax"),
    ("bigcommerce",  "ecom", r"bigcommerce\.com"),
    ("magento",      "ecom", r"mage|magento"),
    ("prestashop",   "ecom", r"prestashop"),

    # Analytics
    ("ga4",          "analytics", r"gtag\('config'|google-analytics\.com/g/"),
    ("ga_ua",        "analytics", r"google-analytics\.com/analytics\.js|UA-\d{6,}"),
    ("gtm",          "analytics", r"googletagmanager\.com/gtm\.js"),
    ("hotjar",       "analytics", r"hotjar\.com"),
    ("mixpanel",     "analytics", r"mixpanel\.com"),
    ("segment",      "analytics", r"cdn\.segment\.com"),
    ("clarity",      "analytics", r"clarity\.ms"),
    ("heap",         "analytics", r"heapanalytics\.com"),

    # Chat/CRM
    ("intercom",     "chat", r"widget\.intercom\.io"),
    ("drift",        "chat", r"js\.driftt\.com|drift\.com"),
    ("zendesk",      "chat", r"zdassets\.com|zendesk\.com"),
    ("tawk",         "chat", r"tawk\.to"),
    ("hubspot",      "crm", r"js\.hs-scripts\.com|hubspot\.com"),

    # Ad pixels
    ("facebook_pixel", "ads", r"connect\.facebook\.net|fbq\("),
    ("tiktok_pixel",   "ads", r"analytics\.tiktok\.com"),
    ("pinterest_tag",  "ads", r"pintrk\(|pinimg\.com"),
    ("snap_pixel",     "ads", r"tr\.snapchat\.com"),

    # Booking / scheduling
    ("calendly",     "booking", r"calendly\.com"),
    ("acuity",       "booking", r"acuityscheduling\.com"),
    ("booksy",       "booking", r"booksy\.com"),
    ("mindbody",     "booking", r"mindbodyonline\.com"),
    ("vagaro",       "booking", r"vagaro\.com"),
    ("timely",       "booking", r"gettimely\.com"),
    ("fresha",       "booking", r"fresha\.com"),
]


def detect_tech_stack(html: str, headers: dict | None = None) -> dict:
    """Fingerprint a website's technology stack from HTML source and HTTP headers.

    Returns a dict like:
      {
        "cms": "squarespace",
        "ecom": "shopify",
        "analytics": ["ga4", "hotjar"],
        "ads": ["facebook_pixel"],
        "chat": "intercom",
        "booking": "calendly",
        "raw": {"wordpress": True, ...}
      }
    """
    combined = html
    if headers:
        combined += " ".join(f"{k}:{v}" for k, v in headers.items())

    found: dict[str, list[str]] = {}
    for tech, category, pattern in _TECH_PATTERNS:
        if re.search(pattern, combined, re.IGNORECASE):
            found.setdefault(category, []).append(tech)

    result: dict = {"raw": {k: True for techs in found.values() for k in techs}}

    # For CMS, pick first match (most specific)
    result["cms"] = found.get("cms", [None])[0]
    result["ecom"] = found.get("ecom", [None])[0]
    result["booking"] = found.get("booking", [None])[0]
    result["chat"] = found.get("chat", [None])[0]
    result["analytics"] = found.get("analytics", [])
    result["ads"] = found.get("ads", [])

    return result


# ──────────────────────────────────────────────────────────────────────────────
# Crawler
# ──────────────────────────────────────────────────────────────────────────────

class SiteCrawler:
    """Crawls a business website to extract enrichment data."""

    def __init__(self, config: ScraperConfig, browser, profiler=None) -> None:
        self.config = config
        self._browser = browser
        self._profiler = profiler or NullProfiler()
        self._limiter = RateLimiter(
            requests_per_minute=config.site_rpm,
            jitter_pct=15,
            min_delay_ms=400,
        )

    async def crawl(self, url: str) -> dict:
        """Crawl website and return enrichment data.

        Returns:
          {
            "instagram": str, "facebook": str, "linkedin": str,
            "email": str, "emails": list[dict],   # [{email, role}], ranked
            "contact_form": str,
            "phone": str, "phones": list[str],     # all distinct numbers found
            "tech_stack": dict,
            "growth_signals": dict,                # only keys actually detected
            "seo": dict, "blog": dict,
            "ssl_valid": bool | None, "load_time_ms": int | None,
            "field_sources": dict,                 # field -> {source_url, method}
            "reachable": bool | None,
          }
        """
        result: dict = {
            "instagram": "",
            "facebook": "",
            "linkedin": "",
            "email": "",
            "emails": [],
            "contact_form": "",
            "phone": "",
            "phones": [],
            "tech_stack": {},
            "growth_signals": {},
            "seo": {},
            "blog": {},
            "ssl_valid": None,
            "load_time_ms": None,
            # ROOT CAUSE fix (Priority 2/3 — field-level trust): every field
            # extracted below now records exactly which page it came from,
            # so downstream storage can build a real
            # "Email — found on Contact page" style provenance instead of
            # a single whole-record confidence number (see storage/dedup's
            # sibling gap and audit Q2/A1).
            "field_sources": {},
            # ROOT CAUSE fix: previously this dict gave no way to tell "the
            # site was inspected and genuinely has no Instagram/email/etc."
            # apart from "the site never loaded at all" — both looked like
            # an all-empty dict to the caller. pipeline.py needs this
            # distinction to avoid presenting a dead link as a live website
            # channel (see EnrichmentPipeline._merge). None = never
            # attempted (no url / directory site), True = page loaded,
            # False = goto failed (timeout or navigation error).
            "reachable": None,
        }

        if not url or is_directory_site(url):
            return result

        url = clean_url(url)
        site_domain = domain_of(url)

        page = await self._browser.new_page()
        try:
            await self._limiter.acquire("site")
            started_at = time.perf_counter()
            try:
                with self._profiler.timer("site_homepage_load"):
                    response = await page.goto(
                        url,
                        wait_until="domcontentloaded",
                        timeout=self.config.site_timeout_ms,
                    )
                # I3 fix: page-load timing, reusing the goto() the crawler
                # already performs — zero extra requests. "Slow site" is a
                # literal Web Developer opportunity example in the brief.
                result["load_time_ms"] = int((time.perf_counter() - started_at) * 1000)
                headers = dict(response.headers) if response else {}
                result["reachable"] = True
                with self._profiler.timer("site_ssl_check"):
                    result["ssl_valid"] = await self._check_ssl(page, response, url)
            except PlaywrightTimeoutError:
                log.debug(f"[site] timeout: {url}")
                result["reachable"] = False
                return result
            except Exception as e:
                log.debug(f"[site] error loading {url}: {e}")
                result["reachable"] = False
                return result

            base = origin_of(page.url) or origin_of(url)
            home_html = await page.content()

            # Tech stack from homepage
            result["tech_stack"] = detect_tech_stack(home_html, headers)

            # Find contact page candidates (also feeds hiring-link detection)
            try:
                anchors = await page.evaluate(
                    "() => Array.from(document.querySelectorAll('a[href]'))"
                    ".map(a => a.href)"
                )
            except Exception:
                anchors = []

            # Growth / SEO / blog signals — all read from HTML already in
            # memory from the homepage load above (Priority 9: no extra
            # requests). Only set keys that were actually detected (C3 fix:
            # never assert a confident negative for something we can't
            # verify — absence of the key means "not detected", not "we
            # looked and found nothing" for the parts we can't check).
            growth = _detect_growth_signals(home_html, anchors)
            if growth:
                result["growth_signals"] = growth
            result["seo"] = _detect_seo_signals(home_html)
            result["blog"] = _detect_blog_signal(home_html)

            # Extract from homepage
            self._extract_into(home_html, result, page_url=page.url,
                               site_domain=site_domain)

            contact_candidates: list[str] = []
            for href in anchors:
                low = (href or "").lower()
                if not low.startswith("http"):
                    continue
                if base and not low.startswith(base.lower()):
                    continue  # external link
                if is_ordering_platform(href):
                    continue
                if any(hint in low for hint in CONTACT_PATH_HINTS):
                    if href not in contact_candidates:
                        contact_candidates.append(href)

            # Seed guesses for common paths not discoverable from anchors
            if base:
                for hint in ("/contact", "/contact-us", "/about", "/get-in-touch"):
                    guess = base.rstrip("/") + hint
                    if guess not in contact_candidates:
                        contact_candidates.append(guess)

            budget = 2 if self.config.fast else self.config.site_contact_page_budget

            # P1 fix: `_result_is_complete` used to require email + instagram
            # + contact_form ALL at once, so a business with genuinely no
            # Instagram (common for B2B/professional services) always burned
            # its full page budget hoping to find an IG link that doesn't
            # exist. `ig_attempted` tracks whether we've already looked for
            # it on at least one sub-page; once email + contact_form are in
            # hand and IG still hasn't turned up, further visits are very
            # unlikely to find it either — stop rather than keep spending
            # budget on a channel that isn't there.
            ig_attempted = False
            for candidate in contact_candidates[:budget]:
                if self._result_is_complete(result):
                    break
                if (
                    result.get("email")
                    and result.get("contact_form")
                    and ig_attempted
                    and not result.get("instagram")
                ):
                    break
                await self._limiter.acquire("site_sub")
                try:
                    with self._profiler.timer("site_subpage_load"):
                        await page.goto(
                            candidate,
                            wait_until="domcontentloaded",
                            timeout=12_000,
                        )
                    sub_html = await page.content()
                    self._extract_into(
                        sub_html, result,
                        page_url=page.url,
                        site_domain=site_domain,
                    )
                    ig_attempted = True
                except Exception:
                    continue

            # If still no contact_form, point to first /contact URL
            if not result["contact_form"] and contact_candidates:
                for cand in contact_candidates:
                    if "/contact" in cand.lower() and not is_ordering_platform(cand):
                        result["contact_form"] = cand
                        break

            # Rank the accumulated raw email/phone pools (Priority 4 —
            # owner@/founder@/ceo@ should never be silently equal to
            # info@/support@). `email`/`phone` stay the single "best" pick
            # other code already expects; `emails`/`phones` preserve
            # everything found instead of discarding it (C5 fix).
            result["emails"] = rank_emails_by_role(result.get("_email_pool", []))
            result.pop("_email_pool", None)
            result["phones"] = result.pop("_phone_pool", [])

        finally:
            await page.close()

        return result

    async def _check_ssl(self, page: Page, response, url: str) -> bool | None:
        """Real certificate probe (I2 fix), not a string check.

        ROOT CAUSE this fixes: `scoring/scorer.py::website_quality_score`
        previously only checked `website.startswith("https://")` — a site
        with an expired/self-signed cert, or one that silently downgrades
        https -> http, scored as if SSL were fine. Playwright already
        performs the navigation `response` we need; `security_details()` is
        read at zero extra request cost. Returns None (not False) when the
        site is plain http:// by design — that's a different, already-
        visible signal, not a broken-cert one.
        """
        if not url.lower().startswith("https://"):
            return None
        try:
            final_url = page.url or ""
            if final_url and final_url.lower().startswith("http://"):
                return False  # silently downgraded from https -> http
            details = await response.security_details() if response else None
            if details is None:
                # Chromium-only API; if unavailable, fall back to "loaded
                # over https without erroring" as a weaker but honest signal.
                return True
            valid_to = details.get("validTo")
            if valid_to is not None and valid_to < time.time():
                return False
            return True
        except Exception:
            return None

    def _result_is_complete(self, result: dict) -> bool:
        """Return True when we have all the key fields we're hunting for."""
        return bool(
            result.get("email")
            and result.get("instagram")
            and result.get("contact_form")
        )

    def _extract_into(
        self,
        html: str,
        sink: dict,
        page_url: str = "",
        site_domain: str = "",
    ) -> None:
        """Pull all enrichment fields out of an HTML blob into `sink`."""
        if not html:
            return

        sources: dict = sink.setdefault("field_sources", {})

        def _tag(field: str) -> None:
            # First page a field is found on wins the attribution — later
            # pages may repeat the same contact info in a footer, but the
            # *original* page it was found on is the more useful "found on
            # X" label for the user.
            if field not in sources and page_url:
                sources[field] = {"source_url": page_url, "method": "website_crawl"}

        # Instagram
        if not sink["instagram"]:
            ig_urls = extract_ig_urls(html)
            if ig_urls:
                sink["instagram"] = ig_urls[0]
                _tag("instagram")

        # Facebook
        if not sink["facebook"]:
            for m in _FACEBOOK_RE.findall(html):
                clean = _clean_facebook(m)
                if clean:
                    sink["facebook"] = clean
                    _tag("facebook")
                    break

        # LinkedIn
        if not sink.get("linkedin"):
            li_urls = extract_linkedin_urls(html)
            if li_urls:
                sink["linkedin"] = li_urls[0]
                _tag("linkedin")

        # Email — C5 fix: accumulate ALL emails found across every page into
        # `_email_pool` instead of stopping at the first match. The single
        # `sink["email"]` "best pick" is kept for existing callers that just
        # want one display value.
        candidates = extract_emails(html)
        if candidates:
            pool = sink.setdefault("_email_pool", [])
            for c in candidates:
                if c not in pool:
                    pool.append(c)
            if not sink["email"]:
                best = pick_best_email(candidates, preferred_domain=site_domain)
                if best:
                    sink["email"] = best
                    _tag("email")

        # Contact form detection
        if not sink["contact_form"] and page_url:
            is_contact = any(hint in page_url.lower() for hint in CONTACT_PATH_HINTS)
            not_platform = not is_ordering_platform(page_url)
            html_low = html.lower()

            has_native_form = (
                "<form" in html_low
                and (
                    'type="email"' in html_low
                    or "type='email'" in html_low
                    or 'name="email"' in html_low
                    or '<textarea' in html_low
                    or 'placeholder' in html_low
                )
            )
            has_embedded_form = any(p in html_low for p in FORM_PLATFORM_HINTS)

            if not_platform and is_contact and (has_native_form or has_embedded_form):
                sink["contact_form"] = page_url
                _tag("contact_form")

        # Phone — C5 fix: accumulate all distinct phone numbers found.
        phones = extract_phones(html)
        if phones:
            pool = sink.setdefault("_phone_pool", [])
            for p in phones:
                if p not in pool:
                    pool.append(p)
            if not sink["phone"]:
                sink["phone"] = phones[0]
                _tag("phone")
