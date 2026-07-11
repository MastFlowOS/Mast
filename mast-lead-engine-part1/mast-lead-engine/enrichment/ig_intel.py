"""
Mast Lead Engine — Instagram Intelligence Module.

Fetches and parses IG profile data with 4-layer extraction strategy:
  1. og:description meta tag (server-rendered, most reliable)
  2. Embedded JSON in page source (edge_followed_by / shared_data / schema.org)
  3. Visible body text scan
  4. Instagram internal API via in-page fetch() (works when HTML is rate-limited)

Anti-detection:
  • Rotating UA per request from _IG_UA_POOL
  • Human-like random delay between requests
  • Fresh browser page per request (no shared fingerprint)
  • Realistic browser headers
  • Strategy rotation on retry (standard → api_first → mobile)

Returns a structured dict:
  followers: int | None
  posts:     int | None
  following: int | None
  verified:  bool
  private:   bool
  blocked:   bool
  bio:       str
  category:  str
  last_post_days: int | None
  post_frequency: str
  legitimacy_score: int  (0–100)
  is_business: bool
  external_url: str
  email_from_bio: str
"""

from __future__ import annotations

import asyncio
import re
import random
from datetime import datetime
from urllib.parse import urlparse

from playwright.async_api import Page, TimeoutError as PlaywrightTimeoutError

from utils.parsing import parse_count, extract_emails, extract_phones
from utils.runtime import RateLimiter, get_logger, ScraperConfig, random_ua

log = get_logger("ig_intel")

# ─── UA pool specifically for Instagram requests ────────────────────────────
_IG_UAS: list[str] = [
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1",
    "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.6422.52 Mobile Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4_1) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4.1 Safari/605.1.15",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:126.0) Gecko/20100101 Firefox/126.0",
    "Mozilla/5.0 (Linux; Android 13; SM-G991B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/112.0.0.0 Mobile Safari/537.36",
]

_IG_NON_HANDLES = frozenset({
    "p", "reel", "reels", "tv", "explore", "stories", "accounts",
    "about", "directory", "legal", "privacy", "press", "help",
    "api", "oauth", "challenge",
})

_ARABIC_INDIC = str.maketrans(
    "٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹",
    "01234567890123456789",
)

_COUNT_RE = re.compile(
    r"([\d.,٠-٩۰-۹]+\s*[kKmMbB]?)\s*[Ff]ollower",
)
_POST_RE = re.compile(
    r"([\d.,٠-٩۰-۹]+\s*[kKmMbB]?)\s*[Pp]ost",
)
_FOLLOW_RE = re.compile(
    r"([\d.,٠-٩۰-۹]+\s*[kKmMbB]?)\s*[Ff]ollowing",
)

# Legitimacy scoring heuristics
_SPAM_KEYWORDS = frozenset({
    "dm for promo", "dm for collab", "drop shipping", "dropship",
    "get rich", "passive income", "100% profit", "work from home",
    "onlyfans", "cashapp", "$", "bitcoin", "crypto invest",
    "link in bio for more", "free followers", "buy followers",
})

_BUSINESS_INDICATORS = frozenset({
    "open", "hours", "order", "booking", "contact", "visit us",
    "call us", "email us", "shop", "store", "reserve",
    "appointment", "delivery", "take away", "dine in",
})


def _empty_profile() -> dict:
    return {
        "followers": None,
        "posts": None,
        "following": None,
        "verified": False,
        "private": False,
        "blocked": False,
        "bio": "",
        "category": "",
        "last_post_days": None,
        "post_frequency": "",
        "legitimacy_score": 0,
        "is_business": False,
        "external_url": "",
        "email_from_bio": "",
    }


def _parse_ig_count(token: str) -> int | None:
    """Parse IG-formatted count string."""
    return parse_count(token.translate(_ARABIC_INDIC))


def _extract_counts_from_og(og_desc: str) -> tuple[int | None, int | None]:
    """Parse follower/post counts from Instagram's og:description meta tag.

    Format: "1,234 Followers, 567 Following, 89 Posts - See Instagram photos..."
    """
    if not og_desc:
        return None, None

    followers: int | None = None
    posts: int | None = None

    # Match follower count
    m = re.search(r"([\d,\.]+\s*[kKmM]?)\s*[Ff]ollower", og_desc)
    if m:
        followers = _parse_ig_count(m.group(1))

    # Match post count
    m = re.search(r"([\d,\.]+\s*[kKmM]?)\s*[Pp]ost", og_desc)
    if m:
        posts = _parse_ig_count(m.group(1))

    return followers, posts


def _extract_counts_from_json(page_source: str) -> tuple[int | None, int | None, int | None]:
    """Extract follower/post/following from embedded JSON in page source.

    Handles multiple formats:
      - edge_followed_by.count / edge_follow.count (classic shared_data)
      - interactionStatistic (Schema.org)
      - followerCount / mediaCount (newer API format)
    """
    followers: int | None = None
    posts: int | None = None
    following: int | None = None

    # Classic shared_data patterns
    patterns_followers = [
        r'"edge_followed_by"\s*:\s*\{\s*"count"\s*:\s*(\d+)',
        r'"followerCount"\s*:\s*(\d+)',
        r'"followersCount"\s*:\s*(\d+)',
        r'"interactionStatistic"[^}]*"userInteractionCount"\s*:\s*"?(\d+)',
    ]
    patterns_posts = [
        r'"edge_owner_to_timeline_media"\s*:\s*\{\s*"count"\s*:\s*(\d+)',
        r'"mediaCount"\s*:\s*(\d+)',
        r'"postsCount"\s*:\s*(\d+)',
    ]
    patterns_following = [
        r'"edge_follow"\s*:\s*\{\s*"count"\s*:\s*(\d+)',
        r'"followingCount"\s*:\s*(\d+)',
    ]

    for p in patterns_followers:
        m = re.search(p, page_source)
        if m:
            try:
                followers = int(m.group(1))
                break
            except ValueError:
                pass

    for p in patterns_posts:
        m = re.search(p, page_source)
        if m:
            try:
                posts = int(m.group(1))
                break
            except ValueError:
                pass

    for p in patterns_following:
        m = re.search(p, page_source)
        if m:
            try:
                following = int(m.group(1))
                break
            except ValueError:
                pass

    return followers, posts, following


def _extract_bio_intel(page_source: str, bio_text: str) -> dict:
    """Extract structured fields from IG bio text and page source."""
    result: dict = {}

    # Category (often in meta or structured data)
    m = re.search(r'"biography"\s*:\s*"([^"]{3,500})"', page_source)
    if m and not bio_text:
        bio_text = m.group(1).replace("\\n", "\n")
    result["bio"] = bio_text[:500] if bio_text else ""

    # Business category
    m = re.search(r'"category_name"\s*:\s*"([^"]+)"', page_source)
    if not m:
        m = re.search(r'"category"\s*:\s*"([^"]+)"', page_source)
    if m:
        result["category"] = m.group(1)

    # Business account flag
    result["is_business"] = bool(
        re.search(r'"is_business_account"\s*:\s*true', page_source, re.I)
        or re.search(r'"is_professional_account"\s*:\s*true', page_source, re.I)
    )

    # External URL
    m = re.search(r'"external_url"\s*:\s*"([^"]+)"', page_source)
    if m:
        result["external_url"] = m.group(1).replace("\\/", "/")

    # Email from bio
    emails = extract_emails(bio_text or "")
    if emails:
        result["email_from_bio"] = emails[0]

    return result


def _legitimacy_score(followers: int | None, posts: int | None, bio: str, is_business: bool) -> int:
    """0–100 legitimacy score for an IG account.

    High legitimacy = real business worth reaching out to.
    Low legitimacy = spam, bot, influencer, or personal account.
    """
    score = 0

    # Follower count signal
    if followers is not None:
        if 100 <= followers <= 5_000:
            score += 35
        elif 50 <= followers < 100:
            score += 20
        elif 5_000 < followers <= 50_000:
            score += 15
        elif followers < 50:
            score += 5

    # Post count signal
    if posts is not None:
        if posts >= 20:
            score += 15
        elif posts >= 5:
            score += 8

    # Business account flag
    if is_business:
        score += 20

    # Bio quality
    if bio:
        bio_low = bio.lower()
        # Spam signals
        if any(kw in bio_low for kw in _SPAM_KEYWORDS):
            score -= 30
        # Business signals
        if any(kw in bio_low for kw in _BUSINESS_INDICATORS):
            score += 15
        # Reasonable bio length
        if 20 <= len(bio) <= 300:
            score += 10

    return max(0, min(100, score))


def _classify_ig_activity(last_post_days: int | None, followers: int | None) -> str:
    """Classify the activity level of an IG account."""
    if followers is None and last_post_days is None:
        return "UNVERIFIED"
    if last_post_days is None:
        return "VERIFIED"  # we have follower count but no post date
    if last_post_days <= 30:
        return "VERIFIED"  # posted within 30 days = active
    if last_post_days <= 90:
        return "STALE"     # 31–90 days = getting stale
    return "INACTIVE"      # 90+ days = inactive


def _merge_counts(*values: int | None) -> int | None:
    """Return the first non-None count from multiple extraction attempts."""
    for v in values:
        if v is not None:
            return v
    return None


class IGIntelligence:
    """Fetches and parses Instagram profile data using Playwright.

    Designed to be used as part of the MapsScraper — it borrows the browser
    context and applies its own anti-detection measures per request.
    """

    def __init__(self, config: ScraperConfig, browser) -> None:
        self.config = config
        self._browser = browser
        self._limiter = RateLimiter(
            requests_per_minute=config.ig_rpm,
            jitter_pct=25,
            min_delay_ms=int(config.ig_delay_min * 1000),
        )

    async def fetch_profile(self, ig_url: str) -> dict:
        """Fetch an Instagram profile with retry and strategy rotation."""
        if not ig_url:
            return _empty_profile()

        try:
            handle = urlparse(ig_url).path.strip("/").split("/")[0].lower()
            if not handle or handle in _IG_NON_HANDLES:
                return _empty_profile()
        except Exception:
            return _empty_profile()

        strategies = ("standard", "api_first", "mobile")
        attempts: list[dict] = []

        for i in range(self.config.ig_retries):
            strategy = strategies[min(i, len(strategies) - 1)]
            await self._limiter.acquire("ig_profile")
            await asyncio.sleep(
                random.uniform(self.config.ig_delay_min, self.config.ig_delay_max)
            )
            try:
                result = await self._fetch_single(handle, strategy=strategy)
                attempts.append(result)
                # If we have followers + some intel, stop retrying
                if result.get("followers") is not None and (
                    result.get("last_post_days") is not None
                    or result.get("posts") is not None
                ):
                    break
            except Exception as exc:
                log.debug(f"[ig] attempt {i+1} failed for {handle}: {exc}")
                if i + 1 < self.config.ig_retries:
                    await asyncio.sleep(self.config.ig_delay_min * (i + 1))

        return self._merge_attempts(attempts)

    def _merge_attempts(self, attempts: list[dict]) -> dict:
        """Combine multiple fetch attempts into the best available profile."""
        if not attempts:
            return _empty_profile()

        merged = dict(attempts[0])

        # Take the best count from any attempt
        merged["followers"] = _merge_counts(*(a.get("followers") for a in attempts))
        merged["posts"] = _merge_counts(*(a.get("posts") for a in attempts))
        merged["following"] = _merge_counts(*(a.get("following") for a in attempts))

        # String fields: take first non-empty
        for key in ("bio", "category", "external_url", "email_from_bio", "post_frequency"):
            for a in attempts:
                if a.get(key):
                    merged[key] = a[key]
                    break

        # Scalar fields: prefer most recent (any) value
        for key in ("last_post_days",):
            vals = [a.get(key) for a in attempts if a.get(key) is not None]
            if vals:
                merged[key] = min(vals)  # most recent post

        # Booleans: any True wins
        for key in ("private", "blocked", "is_business"):
            merged[key] = any(a.get(key) for a in attempts)

        # Recompute legitimacy from merged data
        merged["legitimacy_score"] = _legitimacy_score(
            merged.get("followers"),
            merged.get("posts"),
            merged.get("bio", ""),
            bool(merged.get("is_business")),
        )

        return merged

    async def _fetch_single(self, handle: str, *, strategy: str = "standard") -> dict:
        """Perform a single IG profile fetch with the given strategy."""
        if strategy == "mobile":
            url = f"https://www.instagram.com/{handle}/?hl=en"
        else:
            url = f"https://www.instagram.com/{handle}/"

        ig_ua = random.choice(_IG_UAS)
        page = await self._browser.new_page(
            user_agent=ig_ua,
            locale="en-US",
            viewport={"width": 1366, "height": 900},
        )
        await page.set_extra_http_headers({
            "Accept-Language": "en-US,en;q=0.9",
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "sec-fetch-dest": "document",
            "sec-fetch-mode": "navigate",
            "sec-fetch-site": "none",
            "sec-fetch-user": "?1",
            "upgrade-insecure-requests": "1",
        })

        result = _empty_profile()

        try:
            try:
                await page.goto(url, wait_until="domcontentloaded",
                                timeout=self.config.ig_timeout_ms)
            except PlaywrightTimeoutError:
                log.debug(f"[ig] timeout loading {handle}")
                return result

            # ── Strategy: API-first ────────────────────────────────────────
            if strategy == "api_first":
                api_data = await self._try_api(page, handle)
                if api_data:
                    result.update(api_data)
                    if result.get("followers") is not None:
                        return result  # got what we need

            # ── Detect private/blocked state early ─────────────────────────
            try:
                body_low = await page.evaluate(
                    "() => (document.body?.innerText || '').toLowerCase()"
                )
                if any(kw in body_low for kw in (
                    "this account is private", "follow to see", "log in to see",
                    "restricted account",
                )):
                    result["private"] = True

                if any(kw in body_low for kw in (
                    "sorry, this page isn't available", "page isn't available",
                    "page not found", "content isn't available", "account suspended",
                )):
                    result["blocked"] = True
                    return result
            except Exception:
                pass

            # ── Strategy 1: og:description meta tag ────────────────────────
            try:
                og_desc = await page.evaluate(
                    "() => document.querySelector('meta[property=\"og:description\"]')?.content || ''"
                )
                f1, p1 = _extract_counts_from_og(og_desc)
                if f1 is not None:
                    result["followers"] = f1
                if p1 is not None:
                    result["posts"] = p1
            except Exception:
                pass

            # ── Strategy 2: Embedded JSON in page source ───────────────────
            try:
                page_source = await page.content()
                f2, p2, fol2 = _extract_counts_from_json(page_source)
                result["followers"] = _merge_counts(result.get("followers"), f2)
                result["posts"] = _merge_counts(result.get("posts"), p2)
                result["following"] = _merge_counts(result.get("following"), fol2)

                # Extract bio, category, business flag from source
                bio_intel = _extract_bio_intel(page_source, "")
                result.update({k: v for k, v in bio_intel.items() if v and not result.get(k)})
            except Exception:
                pass

            # ── Strategy 3: Visible body text scan ─────────────────────────
            if result.get("followers") is None and not result.get("blocked"):
                try:
                    body_text = await page.evaluate(
                        "() => document.body?.innerText || ''"
                    )
                    for line in (body_text or "").splitlines():
                        ll = line.lower()
                        if result.get("followers") is None and "follower" in ll:
                            m = _COUNT_RE.search(line)
                            if m:
                                result["followers"] = _parse_ig_count(m.group(1))
                        if result.get("posts") is None and "post" in ll:
                            m = _POST_RE.search(line)
                            if m:
                                result["posts"] = _parse_ig_count(m.group(1))
                        if result.get("following") is None and "following" in ll:
                            m = _FOLLOW_RE.search(line)
                            if m:
                                result["following"] = _parse_ig_count(m.group(1))
                        if all(result.get(k) is not None for k in ("followers", "posts", "following")):
                            break

                    # Bio from visible text
                    if not result.get("bio"):
                        # Common IG bio location in DOM
                        bio = await page.evaluate(
                            """() => {
                                const el = document.querySelector('span.-vDIg') ||
                                           document.querySelector('div._aa_c') ||
                                           document.querySelector('div.JZcpUe') ||
                                           document.querySelector('meta[name="description"]');
                                return el?.innerText || el?.content || '';
                            }"""
                        )
                        if bio:
                            result["bio"] = bio[:500]
                except Exception:
                    pass

            # ── Strategy 4: Instagram internal API via in-page fetch() ─────
            if result.get("followers") is None and not result.get("blocked"):
                api_data = await self._try_api(page, handle)
                if api_data:
                    result.update({k: v for k, v in api_data.items() if v and not result.get(k)})

            # ── Compute last_post_days from timestamp in JSON ───────────────
            if result.get("last_post_days") is None:
                try:
                    page_source = await page.content() if "page_source" not in dir() else page_source
                    ts_match = re.search(
                        r'"taken_at_timestamp"\s*:\s*(\d{10})', page_source
                    )
                    if ts_match:
                        ts = int(ts_match.group(1))
                        delta = (datetime.utcnow() - datetime.utcfromtimestamp(ts)).days
                        result["last_post_days"] = max(0, delta)
                except Exception:
                    pass

            # Post frequency estimation
            if result.get("posts") and result.get("last_post_days") is not None:
                result["post_frequency"] = _estimate_frequency(
                    result["posts"], result["last_post_days"]
                )

        finally:
            await page.close()

        # Compute derived fields
        result["verified"] = result.get("followers") is not None
        result["legitimacy_score"] = _legitimacy_score(
            result.get("followers"),
            result.get("posts"),
            result.get("bio", ""),
            bool(result.get("is_business")),
        )

        activity = _classify_ig_activity(
            result.get("last_post_days"),
            result.get("followers"),
        )
        result["activity"] = activity

        log.debug(
            f"[ig] {handle}: followers={result.get('followers')} "
            f"posts={result.get('posts')} activity={activity}"
        )

        return result

    async def _try_api(self, page: Page, handle: str) -> dict | None:
        """Try Instagram's internal API via in-page fetch()."""
        try:
            api_url = (
                f"https://i.instagram.com/api/v1/users/web_profile_info/"
                f"?username={handle}"
            )
            api_result = await page.evaluate(f"""
                async () => {{
                    try {{
                        const r = await fetch({api_url!r}, {{
                            credentials: 'include',
                            headers: {{
                                'x-ig-app-id': '936619743392459',
                                'accept': 'application/json'
                            }}
                        }});
                        if (!r.ok) return null;
                        return await r.json();
                    }} catch (e) {{ return null; }}
                }}
            """)
            if not api_result:
                return None

            user = (
                (api_result.get("data") or {}).get("user")
                or api_result.get("user")
                or {}
            )
            if not user:
                return None

            followers = user.get("edge_followed_by", {}).get("count")
            posts = user.get("edge_owner_to_timeline_media", {}).get("count")
            following = user.get("edge_follow", {}).get("count")
            biography = user.get("biography", "")
            category = user.get("category_name", "")
            is_business = bool(
                user.get("is_business_account") or user.get("is_professional_account")
            )
            ext_url = user.get("external_url") or user.get("external_url_linkshimmed") or ""

            emails = extract_emails(biography or "")
            email_from_bio = emails[0] if emails else ""

            return {
                "followers": followers,
                "posts": posts,
                "following": following,
                "bio": (biography or "")[:500],
                "category": category,
                "is_business": is_business,
                "external_url": ext_url.replace("\\/", "/"),
                "email_from_bio": email_from_bio,
                "private": bool(user.get("is_private")),
            }
        except Exception:
            return None


def _estimate_frequency(posts: int, days_active: int) -> str:
    """Estimate how often an account posts based on post count and age."""
    if not posts or not days_active or days_active <= 0:
        return ""
    rate = posts / max(1, days_active)  # posts per day
    if rate >= 1:
        return "daily"
    if rate >= 0.5:
        return "several_per_week"
    if rate >= 0.14:
        return "weekly"
    if rate >= 0.03:
        return "monthly"
    return "rarely"


def bio_contact_hints(bio: str) -> dict[str, str]:
    """Extract contact info buried in an IG bio."""
    hints: dict[str, str] = {}
    if not bio:
        return hints

    emails = extract_emails(bio)
    if emails:
        hints["email"] = emails[0]

    phones = extract_phones(bio)
    if phones:
        hints["phone"] = phones[0]

    # Link in bio detection
    url_m = re.search(r"https?://[^\s]+", bio)
    if url_m:
        hints["website"] = url_m.group(0)

    return hints
