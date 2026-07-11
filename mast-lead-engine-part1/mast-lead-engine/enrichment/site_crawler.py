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
from urllib.parse import urljoin, urlparse

from playwright.async_api import Page, TimeoutError as PlaywrightTimeoutError

from utils.parsing import (
    extract_emails, extract_phones, extract_ig_urls,
    pick_best_email, pick_best_phone, is_ordering_platform,
    is_directory_site, is_weak_site, domain_of, origin_of,
    clean_url,
)
from utils.runtime import RateLimiter, get_logger, ScraperConfig

log = get_logger("site_crawler")

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

    def __init__(self, config: ScraperConfig, browser) -> None:
        self.config = config
        self._browser = browser
        self._limiter = RateLimiter(
            requests_per_minute=config.site_rpm,
            jitter_pct=15,
            min_delay_ms=400,
        )

    async def crawl(self, url: str) -> dict:
        """Crawl website and return enrichment data.

        Returns:
          {
            "instagram": str,
            "facebook": str,
            "email": str,
            "contact_form": str,
            "phone": str,
            "tech_stack": dict,
          }
        """
        result: dict = {
            "instagram": "",
            "facebook": "",
            "email": "",
            "contact_form": "",
            "phone": "",
            "tech_stack": {},
        }

        if not url or is_directory_site(url):
            return result

        url = clean_url(url)
        site_domain = domain_of(url)

        page = await self._browser.new_page()
        try:
            await self._limiter.acquire("site")
            try:
                response = await page.goto(
                    url,
                    wait_until="domcontentloaded",
                    timeout=self.config.site_timeout_ms,
                )
                headers = dict(response.headers) if response else {}
            except PlaywrightTimeoutError:
                log.debug(f"[site] timeout: {url}")
                return result
            except Exception as e:
                log.debug(f"[site] error loading {url}: {e}")
                return result

            base = origin_of(page.url) or origin_of(url)
            home_html = await page.content()

            # Tech stack from homepage
            result["tech_stack"] = detect_tech_stack(home_html, headers)

            # Extract from homepage
            self._extract_into(home_html, result, page_url=page.url,
                               site_domain=site_domain)

            # Find contact page candidates
            try:
                anchors = await page.evaluate(
                    "() => Array.from(document.querySelectorAll('a[href]'))"
                    ".map(a => a.href)"
                )
            except Exception:
                anchors = []

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

            for candidate in contact_candidates[:budget]:
                if self._result_is_complete(result):
                    break
                await self._limiter.acquire("site_sub")
                try:
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
                except Exception:
                    continue

            # If still no contact_form, point to first /contact URL
            if not result["contact_form"] and contact_candidates:
                for cand in contact_candidates:
                    if "/contact" in cand.lower() and not is_ordering_platform(cand):
                        result["contact_form"] = cand
                        break

        finally:
            await page.close()

        return result

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

        # Instagram
        if not sink["instagram"]:
            ig_urls = extract_ig_urls(html)
            if ig_urls:
                sink["instagram"] = ig_urls[0]

        # Facebook
        if not sink["facebook"]:
            for m in _FACEBOOK_RE.findall(html):
                clean = _clean_facebook(m)
                if clean:
                    sink["facebook"] = clean
                    break

        # Email (priority-ranked with domain preference)
        if not sink["email"]:
            candidates = extract_emails(html)
            best = pick_best_email(candidates, preferred_domain=site_domain)
            if best:
                sink["email"] = best

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

        # Phone
        if not sink["phone"]:
            phones = extract_phones(html)
            if phones:
                sink["phone"] = phones[0]
