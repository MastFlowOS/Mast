"""
Mast Lead Engine — Text parsing utilities.

Phone extraction, email extraction, count parsing, URL normalization.
Battle-tested for international formats.
"""

from __future__ import annotations

import re
import unicodedata
import urllib.parse
from urllib.parse import urlparse


# ──────────────────────────────────────────────────────────────────────────────
# Phone
# ──────────────────────────────────────────────────────────────────────────────

_PHONE_BLOCKLIST = frozenset({
    "0000000000", "1111111111", "1234567890", "9999999999",
    "0123456789", "1000000000", "0000000", "1111111",
})

_TEL_HREF_RE = re.compile(r'href=["\']tel:([^"\']+)["\']', re.I)
_JSON_PHONE_RE = re.compile(
    r'"(?:telephone|phone|phoneNumber|formatted_phone_number)"\s*:\s*"([^"]+)"',
    re.I,
)
_PHONE_PATTERN = re.compile(
    r"(?:\+?\d{1,3}[\s.\-]?)?\(?\d{2,4}\)?[\s.\-]?\d{2,4}[\s.\-]?\d{2,4}(?:[\s.\-]?\d{1,4})?",
)


def digits_only(v: str | None) -> str:
    if not v:
        return ""
    return re.sub(r"\D", "", v)


def is_valid_phone(v: str | None, *, min_digits: int = 7) -> bool:
    d = digits_only(v)
    if len(d) < min_digits or len(d) > 15:
        return False
    if d in _PHONE_BLOCKLIST:
        return False
    if len(set(d)) <= 2:
        return False
    return True


def normalize_phone(raw: str | None, region: str = "US") -> str:
    """Return a normalized display phone or empty string."""
    if not raw:
        return ""
    s = raw.strip()
    if s.lower().startswith("tel:"):
        s = s[4:].strip()
    d = digits_only(s)
    if len(d) == 10 and region.upper() in ("US", "CA", "USA", "CANADA"):
        return f"+1 ({d[:3]}) {d[3:6]}-{d[6:]}"
    if len(d) == 11 and d.startswith("1"):
        return f"+1 ({d[1:4]}) {d[4:7]}-{d[7:]}"
    if is_valid_phone(d, min_digits=10):
        if s.startswith("+"):
            return s
        return f"+{d}"
    if is_valid_phone(d, min_digits=7):
        return d
    return ""


def extract_phones(text: str) -> list[str]:
    """Find all phone-like strings in HTML or plain text."""
    if not text:
        return []
    found: list[str] = []
    seen: set[str] = set()

    def _add(raw: str) -> None:
        n = normalize_phone(raw)
        if n and n not in seen:
            seen.add(n)
            found.append(n)

    for m in _TEL_HREF_RE.findall(text):
        _add(m)
    for m in _JSON_PHONE_RE.findall(text):
        _add(m)
    for m in _PHONE_PATTERN.finditer(text):
        token = m.group(0).strip()
        if len(digits_only(token)) >= 7:
            _add(token)

    return found


def pick_best_phone(candidates: list[str], country: str = "") -> str:
    region = "US" if country.upper() in ("US", "USA", "CA", "CANADA") else "GB"
    scored: list[tuple[int, str]] = []
    for c in candidates:
        n = normalize_phone(c, region=region)
        if not n:
            continue
        d = digits_only(n)
        score = len(d) + (10 if len(d) >= 10 else 0)
        scored.append((score, n))
    if not scored:
        return ""
    scored.sort(reverse=True)
    return scored[0][1]


# ──────────────────────────────────────────────────────────────────────────────
# Email
# ──────────────────────────────────────────────────────────────────────────────

_EMAIL_RE = re.compile(r"[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}")

_EMAIL_BLOCKLIST_PREFIXES = (
    "noreply@", "no-reply@", "donotreply@", "do-not-reply@",
    "wordpress@", "example@", "sentry@", "mailer-daemon@",
    "privacy@", "legal@", "abuse@", "webmaster@", "postmaster@",
    "newsletter@", "unsubscribe@", "subscriptions@", "bounce@",
    "daemon@", "spam@", "phishing@", "security@", "test@",
    "demo@", "hostmaster@", "admin@wordpress",
)

_EMAIL_BLOCKLIST_DOMAINS = (
    "sentry.io", "wixpress.com", "godaddy.com", "squarespace.com",
    "shopify.com", "wix.com", "mailchimp.com", "klaviyo.com",
    "sendgrid.net", "constantcontact.com", "hubspot.com",
    "example.com", "placeholder.com", "domain.com",
    "amazonaws.com", "cloudflare.com",
)

_EMAIL_PRIORITY = (
    "hello@", "hi@", "info@", "contact@", "team@",
    "bookings@", "reservations@", "reserve@", "events@",
    "office@", "studio@", "shop@", "support@", "sales@",
    "enquiries@", "enquiry@",
)


def _email_blocked(email: str) -> bool:
    low = email.lower()
    if any(low.startswith(p) for p in _EMAIL_BLOCKLIST_PREFIXES):
        return True
    domain = low.split("@", 1)[-1]
    if any(domain == d or domain.endswith("." + d) for d in _EMAIL_BLOCKLIST_DOMAINS):
        return True
    return False


def extract_emails(html: str) -> list[str]:
    """Extract all valid emails from HTML."""
    found: list[str] = []
    seen: set[str] = set()

    # mailto: links first (most reliable)
    for m in re.findall(r'mailto:([^"\'>\s?&]+)', html, flags=re.I):
        if "@" in m:
            e = urllib.parse.unquote(m).strip().lower()
            if e not in seen and not _email_blocked(e) and _EMAIL_RE.match(e):
                seen.add(e)
                found.append(e)

    # Raw email scan
    for m in _EMAIL_RE.findall(html):
        e = m.lower()
        if e not in seen and not _email_blocked(e):
            seen.add(e)
            found.append(e)

    return found


_EMAIL_ROLE_PATTERNS: tuple[tuple[str, tuple[str, ...]], ...] = (
    ("owner",   ("owner", "proprietor")),
    ("founder", ("founder", "cofounder", "co-founder")),
    ("ceo",     ("ceo", "president", "director", "principal")),
    ("sales",   ("sales", "business", "bd", "partnerships")),
    ("support", ("support", "help", "service", "care")),
    ("info",    ("info", "contact", "office", "admin")),
    ("hello",   ("hello", "hi", "team", "hey")),
)


def classify_email_role(email: str) -> str:
    """Classify an email's local-part into a coarse outreach role.

    Returns one of: owner, founder, ceo, sales, support, info, hello, other.
    Role emails are NOT all equal for outreach — a decision-maker address
    (owner/founder/ceo) should outrank a generic mailbox (info/hello) which
    should outrank a narrow-purpose one (support/sales), even though all are
    "valid" emails.
    """
    if not email or "@" not in email:
        return "other"
    local = email.split("@", 1)[0].lower()
    for role, needles in _EMAIL_ROLE_PATTERNS:
        if any(n in local for n in needles):
            return role
    return "other"


_ROLE_PRIORITY = ("owner", "founder", "ceo", "hello", "info", "sales", "support", "other")


def rank_emails_by_role(emails: list[str]) -> list[dict]:
    """Return emails as [{email, role}], ordered decision-maker-first.

    This is the "preserve multiple contacts, don't discard" list — display
    logic can still show `pick_best_email()`'s single winner as a default,
    but nothing about a founder's personal address is lost just because a
    generic info@ also existed.
    """
    def _rank_key(e: str) -> int:
        role = classify_email_role(e)
        return _ROLE_PRIORITY.index(role) if role in _ROLE_PRIORITY else len(_ROLE_PRIORITY)

    ranked = sorted(dict.fromkeys(e.lower() for e in emails if e), key=_rank_key)
    return [{"email": e, "role": classify_email_role(e)} for e in ranked]


def pick_best_email(candidates: list[str], preferred_domain: str = "") -> str:
    """Pick the highest-priority outreach email."""
    if not candidates:
        return ""

    # Clean and filter
    cleaned: list[str] = []
    seen: set[str] = set()
    for c in candidates:
        try:
            c = urllib.parse.unquote(c)
        except Exception:
            pass
        c = c.strip().rstrip(".,;)")
        c = re.split(r"[?#\s]", c)[0]
        low = c.lower()
        if low in seen or _email_blocked(low):
            continue
        if not _EMAIL_RE.match(c):
            continue
        if len(c.split("@")[0]) > 50:
            continue
        seen.add(low)
        cleaned.append(c)

    if not cleaned:
        return ""

    # Prefer own-domain emails
    def _priority(email: str) -> int:
        low = email.lower()
        score = 0
        if preferred_domain:
            pd = preferred_domain.lower().lstrip("www.")
            domain = low.split("@", 1)[-1]
            if domain == pd or domain.endswith("." + pd):
                score += 100
        for i, prefix in enumerate(reversed(_EMAIL_PRIORITY)):
            if low.startswith(prefix):
                score += (i + 1) * 2
        return score

    cleaned.sort(key=_priority, reverse=True)
    return cleaned[0]


# ──────────────────────────────────────────────────────────────────────────────
# Count parsing (handles international K/M suffixes, Arabic numerals, etc.)
# ──────────────────────────────────────────────────────────────────────────────

_ARABIC_INDIC = str.maketrans(
    "٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹",
    "01234567890123456789",
)


def parse_count(token: str | None) -> int | None:
    """Parse an engagement count string into an integer.

    Handles: 1,234 / 1.234 / 12.5K / 1.2M / ۱٬۲۳۴ / 2 345
    Returns None if unparseable.
    """
    if not token:
        return None
    s = str(token).strip().translate(_ARABIC_INDIC)
    s = re.sub(r"[\u00a0\u202f\u2009\u200b\s]", "", s)

    m_suffix = re.search(r"([kKmMbBgG])$", s)
    suffix = m_suffix.group(1).lower() if m_suffix else ""
    body = s[: m_suffix.start()] if m_suffix else s

    def _norm_sep(v: str) -> str:
        if "," in v and "." in v:
            lc, ld = v.rfind(","), v.rfind(".")
            return v.replace(",", "") if ld > lc else v.replace(".", "").replace(",", ".")
        if "," in v:
            parts = v.split(",")
            if len(parts) == 2 and len(parts[1]) == 3 and parts[1].isdigit():
                return v.replace(",", "")
            return v.replace(",", ".")
        if "." in v:
            parts = v.split(".")
            if len(parts) == 2 and len(parts[1]) == 3 and parts[1].isdigit():
                return v.replace(".", "")
        return v

    body = _norm_sep(body)
    try:
        num = float(body)
    except ValueError:
        return None

    multipliers = {"k": 1_000, "m": 1_000_000, "b": 1_000_000_000, "g": 1_000_000_000}
    return int(round(num * multipliers.get(suffix, 1)))


def parse_review_count(value: object) -> int:
    """Parse a raw Google Maps review count string."""
    if value is None:
        return 0
    if isinstance(value, (int, float)):
        return max(0, int(value))

    s = str(value).strip().lower()
    if not s:
        return 0

    # "4.7 stars 49 Reviews" or "49 Reviews" or "(1,234)"
    if "review" in s:
        m = re.search(r"([\d.,]+\s*[km]?)\s*reviews?", s)
        if m:
            result = parse_count(m.group(1))
            return result or 0

    paren = re.search(r"\(([\d.,]+\s*[km]?)\)", s)
    if paren:
        result = parse_count(paren.group(1))
        return result or 0

    result = parse_count(s)
    return result or 0


# ──────────────────────────────────────────────────────────────────────────────
# URL normalization
# ──────────────────────────────────────────────────────────────────────────────

_TRACKING_PARAMS = frozenset({
    "utm_source", "utm_medium", "utm_campaign", "utm_content",
    "utm_term", "fbclid", "gclid", "ref", "referrer", "_ga",
    "mc_cid", "mc_eid",
})

_DIRECTORY_DOMAINS = frozenset({
    "yelp.com", "tripadvisor.com", "foursquare.com", "zomato.com",
    "opentable.com", "resy.com", "google.com", "yelp.co.uk", "yelp.de",
    "yelp.fr", "yellowpages.com", "trustpilot.com", "facebook.com", "fb.com",
    "yelp.com.au", "pages.google.com", "linktr.ee", "linktree.com",
})

_WEAK_SITE_DOMAINS = frozenset({
    "facebook.com", "fb.com", "instagram.com", "linktr.ee", "linktree.com",
    "wixsite.com", "wix.com", "sites.google.com", "business.site",
    "godaddysites.com", "weebly.com", "yelp.com", "tripadvisor.com",
    "yola.com", "jimdo.com", "webnode.com", "carrd.co", "bitly.com",
    "squarespace.com", "wordpress.com", "blogspot.com", "myshopify.com",
    "square.site",
})


def clean_url(url: str) -> str:
    """Strip tracking params, normalize scheme, remove trailing slash."""
    if not url:
        return ""
    try:
        p = urlparse(url)
        params = [
            (k, v)
            for k, v in urllib.parse.parse_qsl(p.query)
            if k.lower() not in _TRACKING_PARAMS
        ]
        cleaned = p._replace(query=urllib.parse.urlencode(params)).geturl()
        return cleaned.rstrip("/") if cleaned else url
    except Exception:
        return url


def domain_of(url: str | None) -> str:
    """Extract bare domain (no www.) from a URL."""
    if not url:
        return ""
    try:
        host = urlparse(url if "://" in url else "http://" + url).netloc.lower()
        return host.removeprefix("www.")
    except Exception:
        return ""


def origin_of(url: str) -> str:
    """Return scheme://host from a URL."""
    try:
        p = urlparse(url)
        if p.scheme and p.netloc:
            return f"{p.scheme}://{p.netloc}"
    except Exception:
        pass
    return ""


def is_directory_site(url: str) -> bool:
    host = domain_of(url)
    return any(host == d or host.endswith("." + d) for d in _DIRECTORY_DOMAINS)


def is_weak_site(url: str | None) -> bool:
    if not url:
        return True
    host = domain_of(url)
    return any(host == d or host.endswith("." + d) for d in _WEAK_SITE_DOMAINS)


def is_ordering_platform(url: str) -> bool:
    """Return True if URL belongs to a 3rd-party ordering/booking platform."""
    _ORDERING = frozenset({
        "opentable.com", "resy.com", "yelp.com", "tripadvisor.com",
        "toasttab.com", "squareup.com", "booksy.com", "vagaro.com",
        "mindbodyonline.com", "glofox.com", "ubereats.com", "deliveroo.com",
        "doordash.com", "grubhub.com", "justeat.com", "seamless.com",
        "treatwell.com", "fresha.com", "styleseat.com", "facebook.com",
        "fb.com", "instagram.com", "twitter.com", "x.com", "tiktok.com",
        "linkedin.com",
    })
    host = domain_of(url)
    return any(host == d or host.endswith("." + d) for d in _ORDERING)


# ──────────────────────────────────────────────────────────────────────────────
# Instagram URL helpers
# ──────────────────────────────────────────────────────────────────────────────

_IG_NON_HANDLES = frozenset({
    "p", "reel", "reels", "tv", "explore", "stories", "accounts",
    "about", "directory", "legal", "privacy", "press", "help",
    "api", "oauth", "challenge", "login", "signup", "explore",
})

_IG_HANDLE_RE = re.compile(r"^[A-Za-z][A-Za-z0-9_.]{1,}$")
_IG_URL_RE = re.compile(
    r"https?://(?:www\.)?instagram\.com/([A-Za-z0-9_.]+)(?:/[^\"'\s]*)?",
    re.IGNORECASE,
)


def is_real_ig_handle(url: str) -> bool:
    try:
        path = urlparse(url).path.strip("/")
    except Exception:
        return False
    if not path:
        return False
    handle = path.split("/")[0].lower()
    if not handle or handle in _IG_NON_HANDLES or handle.isdigit():
        return False
    return bool(_IG_HANDLE_RE.match(handle))


def clean_ig_url(raw: str) -> str:
    """Normalise an Instagram URL to https://www.instagram.com/<handle>/"""
    raw = raw.split('"')[0].split("'")[0].strip()
    try:
        p = urlparse(raw)
        handle = p.path.strip("/").split("/")[0]
        if handle:
            return f"https://www.instagram.com/{handle}/"
    except Exception:
        pass
    return raw


def extract_ig_urls(text: str) -> list[str]:
    """Find all Instagram profile URLs in an HTML blob."""
    results: list[str] = []
    seen: set[str] = set()
    for m in _IG_URL_RE.findall(text):
        handle = m.split("/")[0].lower()
        if not handle or handle in _IG_NON_HANDLES or handle.isdigit():
            continue
        url = f"https://www.instagram.com/{handle}/"
        if url not in seen and is_real_ig_handle(url):
            seen.add(url)
            results.append(url)
    return results


# ──────────────────────────────────────────────────────────────────────────────
# LinkedIn URL helpers
# ──────────────────────────────────────────────────────────────────────────────
#
# ROOT CAUSE this fixes: scoring/scorer.py::social_presence_score() already
# reads `biz.get("linkedin")` (has done since it was written), but nothing in
# the engine ever extracted a `linkedin` value — RawPlace, Lead, and
# SiteCrawler.crawl()'s result dict all lacked the field entirely. LinkedIn
# was a silently-dead scoring signal. This mirrors extract_ig_urls() exactly,
# just for the /company/ and /in/ path shapes LinkedIn actually uses.

_LINKEDIN_NON_HANDLES = frozenset({
    "in", "company", "school", "showcase", "pub", "feed", "jobs",
    "help", "legal", "login", "signup", "authwall", "uas", "sharing",
})

_LINKEDIN_URL_RE = re.compile(
    r"https?://(?:www\.)?linkedin\.com/(company|in|school)/([A-Za-z0-9_\-.%]+)",
    re.IGNORECASE,
)


def extract_linkedin_urls(text: str) -> list[str]:
    """Find all LinkedIn company/profile URLs in an HTML blob."""
    results: list[str] = []
    seen: set[str] = set()
    for kind, handle in _LINKEDIN_URL_RE.findall(text):
        h = handle.strip("/").lower()
        if not h or h in _LINKEDIN_NON_HANDLES:
            continue
        url = f"https://www.linkedin.com/{kind.lower()}/{h}/"
        if url not in seen:
            seen.add(url)
            results.append(url)
    return results


# ──────────────────────────────────────────────────────────────────────────────
# Text normalization for deduplication
# ──────────────────────────────────────────────────────────────────────────────

def norm_text(value: str | None) -> str:
    """Lowercase, strip diacritics, collapse whitespace."""
    if not value:
        return ""
    s = unicodedata.normalize("NFKD", value)
    s = "".join(c for c in s if not unicodedata.combining(c))
    s = s.lower()
    s = re.sub(r"[^a-z0-9]+", " ", s)
    return re.sub(r"\s+", " ", s).strip()


def slug(value: str) -> str:
    """Convert to lowercase URL-safe slug."""
    return re.sub(r"[^a-z0-9]+", "-", norm_text(value)).strip("-")
