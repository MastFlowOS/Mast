"""
Mast Lead Engine — Text parsing utilities.

Phone extraction, email extraction, count parsing, URL normalization.
Battle-tested for international formats.
"""

from __future__ import annotations

import json
import re
import unicodedata
import urllib.parse
from urllib.parse import urljoin, urlparse


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
    if not is_valid_phone(d, min_digits=7):
        return ""
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
    # For visible text: strip script/style and tags so attributes like data-id / width / height aren't matched
    cleaned_text = re.sub(r"<(script|style)[^>]*>.*?</\1>", " ", text, flags=re.DOTALL | re.IGNORECASE)
    cleaned_text = re.sub(r"<[^>]+>", " ", cleaned_text)

    for m in _PHONE_PATTERN.finditer(cleaned_text):
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

_EMAIL_RE = re.compile(r"^[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}$")
_SCAN_EMAIL_RE = re.compile(r"[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}")

_PLACEHOLDER_EMAIL_LOCAL_PARTS = frozenset({
    "test",
    "example",
    "someone",
    "user",
    "youremail",
    "your-email",
    "name",
    "firstname.lastname",
    "email",
})

_PLACEHOLDER_EMAIL_DOMAINS = frozenset({
    "example.com",
    "example.org",
    "test.com",
    "domain.com",
    "email.com",
    "yourdomain.com",
    "placeholder.com",
    "sentry.io",
    "wixpress.com",
    "godaddy.com",
    "squarespace.com",
    "shopify.com",
    "wix.com",
    "mailchimp.com",
    "klaviyo.com",
    "sendgrid.net",
    "constantcontact.com",
    "hubspot.com",
    "amazonaws.com",
    "cloudflare.com",
})

_EMAIL_BLOCKLIST_PREFIXES = (
    "noreply@", "no-reply@", "donotreply@", "do-not-reply@",
    "wordpress@", "example@", "sentry@", "mailer-daemon@",
    "privacy@", "legal@", "abuse@", "webmaster@", "postmaster@",
    "newsletter@", "unsubscribe@", "subscriptions@", "bounce@",
    "daemon@", "spam@", "phishing@", "security@", "test@",
    "demo@", "hostmaster@", "admin@wordpress",
)

_EMAIL_PRIORITY = (
    "hello@", "hi@", "info@", "contact@", "team@",
    "bookings@", "reservations@", "reserve@", "events@",
    "office@", "studio@", "shop@", "support@", "sales@",
    "enquiries@", "enquiry@",
)


def is_valid_email(value: str | None) -> bool:
    """Canonical email validation matching Node's leadValidation.ts isValidEmail().

    Rejects missing/blank emails, syntax violations, placeholder local-parts,
    placeholder domains, and automated system/no-reply prefixes.
    """
    if not value:
        return False
    email = value.strip().lower()
    if not email:
        return False
    if not _EMAIL_RE.match(email):
        return False
    if "@" not in email:
        return False
    local, domain = email.split("@", 1)
    if not local or not domain:
        return False
    if len(local) > 50:
        return False
    if local in _PLACEHOLDER_EMAIL_LOCAL_PARTS:
        return False
    if any(email.startswith(p) for p in _EMAIL_BLOCKLIST_PREFIXES):
        return False
    if domain in _PLACEHOLDER_EMAIL_DOMAINS or any(domain == d or domain.endswith("." + d) for d in _PLACEHOLDER_EMAIL_DOMAINS):
        return False
    return True


def _email_blocked(email: str) -> bool:
    return not is_valid_email(email)


def extract_emails(html: str) -> list[str]:
    """Extract all valid emails from HTML."""
    if not html:
        return []
    found: list[str] = []
    seen: set[str] = set()

    # mailto: links first (most reliable)
    for m in re.findall(r'mailto:([^"\'>\s?&]+)', html, flags=re.I):
        if "@" in m:
            e = urllib.parse.unquote(m).strip().lower()
            if e not in seen and is_valid_email(e):
                seen.add(e)
                found.append(e)

    # Raw email scan
    for m in _SCAN_EMAIL_RE.findall(html):
        e = m.lower()
        if e not in seen and is_valid_email(e):
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


# ──────────────────────────────────────────────────────────────────────────────
# Business classification keyword lists
#
# Canonical source for chain/cannabis detection. Both scoring/scorer.py
# (V1's is_chain/is_cannabis) and workers/scoring_worker.py (V2's
# ScoringWorker._is_chain/_is_cannabis) evaluate the exact same
# real-world fact — "is this business a chain" / "is this a cannabis
# business" — and previously did so against two independently
# maintained but byte-identical copies of these tuples. Consolidated
# here (2.0 Scoring Reconciliation, Milestone 3B-3) so a future edit to
# either list can't silently drift between V1 and V2. The two modules
# still expose their own is_chain/is_cannabis wrappers, since they take
# different argument shapes (a raw dict in V1, discrete name/category
# strings in V2) — only the underlying keyword data is shared.
# ──────────────────────────────────────────────────────────────────────────────

CHAIN_KEYWORDS = (
    "starbucks", "mcdonald", "burger king", "kfc", "subway",
    "taco bell", "pizza hut", "domino", "dunkin", "tim hortons",
    "costa coffee", "wendy", "chipotle", "panera", "walmart",
    "7-eleven", "circle k", "shell", "exxon", "carrefour", "tesco",
    "ikea", "sephora", "h&m", "zara", "uniqlo", "nike", "adidas",
    "pret a manger", "five guys", "popeyes", "chili's", "applebee",
    "olive garden", "ihop", "denny", "chick-fil-a", "shake shack",
    "krispy kreme", "baskin", "cinnabon", "auntie anne",
    "gloria jean", "coffee bean", "lavazza", "illy caffe",
    "paul bakery", "greggs", "le pain quotidien", "mcdonalds",
    "pizzahut", "pizzaexpress", "nandos", "wagamama",
)

CANNABIS_KEYWORDS = (
    "cannabis", "marijuana", "weed dispensary", "dispensary",
    "coffeeshop", "cannabis café", "cannabis cafe", "cannabis coffee",
    "hash bar", "hash café", "420 café", "420 cafe", "hemp café",
    "cbd café", "cbd cafe", "cbd shop",
)


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
# Instagram discovery — source classification + plain-text @handle fallback
#
# Phase 14.2 (Instagram acquisition, quality-preserving). `extract_ig_urls()`
# above already finds a literal `instagram.com/<handle>` URL wherever one
# appears in the raw HTML blob it's given — that single regex pass already
# covers anchor hrefs, bare URLs elsewhere in the markup, JSON-LD
# (`Organization.sameAs`, profile `sameAs` lists) and `<meta ...>` tag
# `content=` attributes alike, since none of those are structurally special
# to a plain substring/regex scan: a JSON-LD `sameAs` value or a meta
# `content` attribute containing `https://www.instagram.com/joesbarber/` is
# just that same literal string sitting in the page text. What
# `extract_ig_urls()` never did is (a) say *which* of those shapes a given
# match came from, which Phase 14.2's telemetry ask needs, or (b) recognize
# a business handle mentioned as plain text (`Instagram: @joesbarber`) with
# no `instagram.com` URL anywhere on the page at all.
#
# `extract_ig_urls_with_source()` adds both, additively, reusing every
# validation/canonicalization rule above (`_IG_URL_RE`, `_IG_NON_HANDLES`,
# `is_real_ig_handle`) rather than duplicating them, and does not change
# `extract_ig_urls()` itself — it is used elsewhere (V1 crawler, Maps
# scraper) and this phase's own instruction is "bounded, cheap
# improvements", not a rewrite of an already-working, already-tested path.
# ──────────────────────────────────────────────────────────────────────────────

_ANCHOR_HREF_RE = re.compile(
    r'<a\s[^>]*href=["\']([^"\']+)["\']', re.IGNORECASE | re.DOTALL
)
_JSONLD_BLOCK_RE = re.compile(
    r'<script[^>]+type=["\']application/ld\+json["\'][^>]*>(.*?)</script>',
    re.IGNORECASE | re.DOTALL,
)
_META_TAG_RE = re.compile(r"<meta\b[^>]*>", re.IGNORECASE)

#: A business-specific @handle mentioned as plain text, e.g.
#: "Follow us on Instagram: @joesbarber". Deliberately conservative — see
#: `_find_plain_ig_handles()` below for the context requirement that keeps
#: this from firing on an arbitrary @mention (Twitter handle, email
#: fragment, etc.) elsewhere on the page.
_PLAIN_HANDLE_RE = re.compile(r"(?<![\w.@\-])@([A-Za-z0-9_.]{2,30})\b")
_PLAIN_HANDLE_CONTEXT_WINDOW = 60
_HTML_TAG_RE = re.compile(r"<[^>]+>")


def _ig_source_for_span(
    start: int,
    end: int,
    anchor_spans: "list[tuple[int, int]]",
    jsonld_spans: "list[tuple[int, int]]",
    meta_spans: "list[tuple[int, int]]",
) -> str:
    for s, e in anchor_spans:
        if s <= start and end <= e:
            return "anchor_href"
    for s, e in jsonld_spans:
        if s <= start and end <= e:
            return "jsonld"
    for s, e in meta_spans:
        if s <= start and end <= e:
            return "meta"
    return "raw_html"


def _find_plain_ig_handles(html: str) -> list[str]:
    """
    Business-specific @handles mentioned as plain text, ONLY when the
    surrounding text (within `_PLAIN_HANDLE_CONTEXT_WINDOW` characters
    either side) also mentions "instagram" — e.g. "Instagram: @joesbarber"
    or "Follow @joesbarber on Instagram". This is deliberately the
    lowest-confidence signal: an arbitrary @mention with no nearby
    "instagram" text (a Twitter handle, an email fragment, an unrelated
    @-mention) never qualifies. The literal word "@instagram" itself is
    excluded — that names the platform, not a business account.
    """
    if not html or "@" not in html:
        return []
    text = _HTML_TAG_RE.sub(" ", html)
    results: list[str] = []
    seen: set[str] = set()
    for m in _PLAIN_HANDLE_RE.finditer(text):
        handle = m.group(1)
        low = handle.lower()
        if low in seen:
            continue
        if low in _IG_NON_HANDLES or low == "instagram" or handle.isdigit():
            continue
        if not _IG_HANDLE_RE.match(handle):
            continue
        window = text[
            max(0, m.start() - _PLAIN_HANDLE_CONTEXT_WINDOW):
            min(len(text), m.end() + _PLAIN_HANDLE_CONTEXT_WINDOW)
        ]
        if not re.search(r"instagram", window, re.IGNORECASE):
            continue
        seen.add(low)
        results.append(handle)
    return results


def extract_ig_urls_with_source(text: str) -> list[tuple[str, str]]:
    """
    Like `extract_ig_urls()`, but paired with where each canonical
    Instagram URL was found: "anchor_href", "jsonld", "meta", "raw_html"
    (a literal instagram.com URL elsewhere in the markup), or
    "plain_handle" (a business @handle in plain text next to the word
    "instagram", with no instagram.com URL anywhere on the page).

    Order matches `extract_ig_urls()`'s own first-match-found order for
    literal URLs; the plain-text fallback is only ever consulted when no
    literal instagram.com URL was found anywhere on the page — it is the
    least confident signal and never overrides an actual URL.
    """
    if not text:
        return []

    anchor_spans = [m.span(1) for m in _ANCHOR_HREF_RE.finditer(text)]
    jsonld_spans = [m.span() for m in _JSONLD_BLOCK_RE.finditer(text)]
    meta_spans = [m.span() for m in _META_TAG_RE.finditer(text)]

    results: list[tuple[str, str]] = []
    seen: set[str] = set()
    for m in _IG_URL_RE.finditer(text):
        handle = m.group(1).split("/")[0].lower()
        if not handle or handle in _IG_NON_HANDLES or handle.isdigit():
            continue
        url = f"https://www.instagram.com/{handle}/"
        if url in seen or not is_real_ig_handle(url):
            continue
        seen.add(url)
        source = _ig_source_for_span(
            m.start(), m.end(), anchor_spans, jsonld_spans, meta_spans
        )
        results.append((url, source))

    if not results:
        for handle in _find_plain_ig_handles(text):
            url = f"https://www.instagram.com/{handle}/"
            if url in seen:
                continue
            seen.add(url)
            results.append((url, "plain_handle"))

    return results


def has_invalid_ig_candidate(text: str) -> bool:
    """
    True if the HTML contains something shaped like an
    `instagram.com/<path>` URL that was correctly declined as evidence —
    a reserved path (`/p/`, `/reel/`, `/explore/`, ...), a numeric-only
    segment, or a bare instagram.com homepage link — i.e. a near-miss the
    extractor saw and rejected, not silence. Purely observational (see
    ContactIntel.instagram_invalid_candidate_seen / Phase 14.2 telemetry);
    never changes what `extract_ig_urls`/`extract_ig_urls_with_source`
    return as evidence.
    """
    if not text:
        return False
    for m in _IG_URL_RE.finditer(text):
        handle = m.group(1).split("/")[0].lower()
        url = f"https://www.instagram.com/{handle}/"
        if not handle or handle in _IG_NON_HANDLES or handle.isdigit():
            return True
        if not is_real_ig_handle(url):
            return True
    return False


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


# ──────────────────────────────────────────────────────────────────────────────
# Phase 15 — Contact Acquisition & Discovery Helpers
# ──────────────────────────────────────────────────────────────────────────────

_JSONLD_CONTACT_TYPES = frozenset({
    "organization", "localbusiness", "contactpoint", "corporation",
    "store", "restaurant", "foodestablishment", "medicalbusiness",
    "dentist", "bakery", "cafeorcoffeeshop", "barorpub", "winery",
    "automotivebusiness", "childcare", "drycleaningorlaundry",
    "emergencyservice", "employmentagency", "entertainmentbusiness",
    "financialservice", "healthandbeautybusiness", "homeandconstructionbusiness",
    "internetcafé", "legalbusiness", "library", "lodgingbusiness",
    "professionalservice", "radiostation", "realestateagent",
    "recyclingcenter", "selfstorage", "shoppingcenter", "sportsactivitylocation",
    "televisionstation", "touristinformationcenter", "travelagency",
    "postaladdress", "place", "service", "company", "business",
})


def _walk_jsonld(data: object) -> list[dict]:
    """Yield all dict nodes in a parsed JSON-LD document or graph."""
    nodes: list[dict] = []
    if isinstance(data, dict):
        nodes.append(data)
        for v in data.values():
            if isinstance(v, (dict, list)):
                nodes.extend(_walk_jsonld(v))
    elif isinstance(data, list):
        for item in data:
            if isinstance(item, (dict, list)):
                nodes.extend(_walk_jsonld(item))
    return nodes


def extract_jsonld_contact_data(html: str) -> dict[str, list[str]]:
    """Extract explicit email, telephone, and social URLs from JSON-LD schema blocks.

    Inspects Organization, LocalBusiness (and all sub-classes), and ContactPoint.
    Only explicit fields are extracted and validated via is_valid_email / is_valid_phone.
    """
    if not html:
        return {"emails": [], "phones": [], "urls": []}

    emails: list[str] = []
    phones: list[str] = []
    urls: list[str] = []
    seen_emails: set[str] = set()
    seen_phones: set[str] = set()
    seen_urls: set[str] = set()

    for script_match in _JSONLD_BLOCK_RE.finditer(html):
        raw_json = script_match.group(1).strip()
        if not raw_json:
            continue
        try:
            parsed = json.loads(raw_json)
        except Exception:
            continue

        for node in _walk_jsonld(parsed):
            node_type = node.get("@type") or node.get("type") or ""
            type_names: list[str] = []
            if isinstance(node_type, str):
                type_names = [node_type.strip().lower()]
            elif isinstance(node_type, list):
                type_names = [str(t).strip().lower() for t in node_type if t]

            # Check if this node represents an organization/business/contactpoint
            # or has explicit contact fields
            is_contact_node = any(
                t in _JSONLD_CONTACT_TYPES or any(sub in t for sub in ("business", "organization", "contactpoint", "store", "company"))
                for t in type_names
            )

            # Email extraction
            email_val = node.get("email")
            if email_val:
                raw_emails = [email_val] if isinstance(email_val, str) else (email_val if isinstance(email_val, list) else [])
                for e in raw_emails:
                    if isinstance(e, str):
                        clean_e = e.strip().lower()
                        if clean_e.startswith("mailto:"):
                            clean_e = clean_e[len("mailto:"):].split("?", 1)[0].strip()
                        if is_valid_email(clean_e) and clean_e not in seen_emails:
                            seen_emails.add(clean_e)
                            emails.append(clean_e)

            # Telephone extraction
            phone_val = node.get("telephone") or node.get("phone") or node.get("phoneNumber") or node.get("formatted_phone_number")
            if phone_val:
                raw_phones = [phone_val] if isinstance(phone_val, str) else (phone_val if isinstance(phone_val, list) else [])
                for p in raw_phones:
                    if isinstance(p, str):
                        norm_p = normalize_phone(p)
                        if norm_p and norm_p not in seen_phones:
                            seen_phones.add(norm_p)
                            phones.append(norm_p)

            # URL / sameAs extraction
            url_val = node.get("url")
            same_as = node.get("sameAs")
            raw_urls = []
            if isinstance(url_val, str):
                raw_urls.append(url_val)
            elif isinstance(url_val, list):
                raw_urls.extend(url_val)
            if isinstance(same_as, str):
                raw_urls.append(same_as)
            elif isinstance(same_as, list):
                raw_urls.extend(same_as)
            for u in raw_urls:
                if isinstance(u, str) and u.strip() and u.strip() not in seen_urls:
                    seen_urls.add(u.strip())
                    urls.append(u.strip())

    return {"emails": emails, "phones": phones, "urls": urls}


_ATTR_SCAN_RE = re.compile(
    r'<([a-zA-Z0-9]+)\s+([^>]*?)>',
    re.IGNORECASE | re.DOTALL,
)
_ATTR_PAIR_RE = re.compile(
    r'([a-zA-Z0-9_\-:]+)\s*=\s*(?:["\']([^"\']*)["\']|([^\s>]+))',
    re.IGNORECASE,
)
_PHONE_CONTEXT_ATTR_NAMES = frozenset({
    "data-phone", "data-tel", "data-telephone", "data-contact-phone",
    "data-call", "data-phonenumber", "data-phone-number", "data-number",
})
_EMAIL_CONTEXT_ATTR_NAMES = frozenset({
    "data-email", "data-mail", "data-contact-email", "data-e-mail",
    "data-mailto", "data-address",
})
_PHONE_KEYWORD_RE = re.compile(r"\b(?:call|phone|tel|telephone|contact|mobile|cell|dial)\b", re.IGNORECASE)
_EMAIL_KEYWORD_RE = re.compile(r"\b(?:email|mail|contact|envelope|msg|message|write)\b", re.IGNORECASE)


def extract_contextual_attribute_contacts(html: str) -> dict[str, list[str]]:
    """Extract emails and phones from contact-bearing HTML attributes and icon containers.

    Inspects href, aria-label, title, alt, data-* attributes on elements with
    contact context (or wrapping icon elements).
    Rejects arbitrary numeric strings and non-email '@' fragments.
    """
    if not html:
        return {"emails": [], "phones": [], "pop_phones": [], "emails_with_source": []}

    found_emails: list[str] = []
    found_phones: list[str] = []
    seen_emails: set[str] = set()
    seen_phones: set[str] = set()

    for tag_match in _ATTR_SCAN_RE.finditer(html):
        tag_name = tag_match.group(1).lower()
        attr_str = tag_match.group(2)
        attrs = {m[0]: m[1] if m[1] else m[2] for m in _ATTR_PAIR_RE.findall(attr_str)}

        # Check for email attributes
        for attr_key, attr_val in attrs.items():
            attr_key_low = attr_key.lower()
            val = (attr_val or "").strip()
            if not val:
                continue

            # 1. Direct email-named attributes
            if attr_key_low in _EMAIL_CONTEXT_ATTR_NAMES:
                for match in _SCAN_EMAIL_RE.findall(val):
                    clean = match.lower()
                    if clean not in seen_emails and is_valid_email(clean):
                        seen_emails.add(clean)
                        found_emails.append(clean)
                continue

            # 2. aria-label / title / alt with email syntax or email context
            if attr_key_low in ("aria-label", "title", "alt"):
                if "@" in val:
                    for match in _SCAN_EMAIL_RE.findall(val):
                        clean = match.lower()
                        if clean not in seen_emails and is_valid_email(clean):
                            seen_emails.add(clean)
                            found_emails.append(clean)

            # 3. Direct phone-named attributes
            if attr_key_low in _PHONE_CONTEXT_ATTR_NAMES:
                norm = normalize_phone(val)
                if norm and norm not in seen_phones and is_valid_phone(norm):
                    seen_phones.add(norm)
                    found_phones.append(norm)
                continue

            # 4. aria-label / title / alt with phone context
            if attr_key_low in ("aria-label", "title", "alt"):
                has_phone_ctx = bool(_PHONE_KEYWORD_RE.search(attr_key_low) or _PHONE_KEYWORD_RE.search(val) or val.lower().startswith("tel:"))
                if has_phone_ctx:
                    for m in _PHONE_PATTERN.finditer(val):
                        token = m.group(0).strip()
                        if len(digits_only(token)) >= 7:
                            norm = normalize_phone(token)
                            if norm and norm not in seen_phones and is_valid_phone(norm):
                                seen_phones.add(norm)
                                found_phones.append(norm)

    return {"emails": found_emails, "phones": found_phones}


_SECONDARY_PAGE_PRIORITY: tuple[tuple[str, re.Pattern[str]], ...] = (
    ("contact", re.compile(r"\bcontact(?:-us|_us|us)?\b", re.IGNORECASE)),
    ("about", re.compile(r"\babout(?:-us|_us|us)?\b", re.IGNORECASE)),
    ("team", re.compile(r"\bteam\b", re.IGNORECASE)),
    ("staff", re.compile(r"\bstaff\b", re.IGNORECASE)),
    ("locations", re.compile(r"\b(?:locations?)\b", re.IGNORECASE)),
    ("catering", re.compile(r"\bcatering\b", re.IGNORECASE)),
    ("wholesale", re.compile(r"\bwholesale\b", re.IGNORECASE)),
    ("press", re.compile(r"\bpress\b", re.IGNORECASE)),
    ("partners", re.compile(r"\bpartners?\b", re.IGNORECASE)),
)

_IGNORED_LINK_EXTENSIONS = frozenset({
    ".pdf", ".jpg", ".jpeg", ".png", ".gif", ".svg", ".webp",
    ".zip", ".mp4", ".mov", ".avi", ".css", ".js", ".json",
    ".xml", ".rss", ".ico", ".woff", ".woff2", ".ttf",
})

_SOCIAL_DOMAINS = frozenset({
    "facebook.com", "instagram.com", "twitter.com", "x.com",
    "linkedin.com", "youtube.com", "tiktok.com", "pinterest.com",
    "yelp.com", "tripadvisor.com", "google.com", "apple.com",
})

_ANCHOR_RE = re.compile(
    r'<a\s+[^>]*href=["\']([^"\']+)["\'][^>]*>(.*?)</a>',
    re.IGNORECASE | re.DOTALL,
)


def find_secondary_contact_link(
    fetched_htmls: list[tuple[str, str]],
    base_url: str,
    tried_urls: set[str],
) -> tuple[str | None, str | None]:
    """Find the single highest-priority same-domain secondary page from already-fetched HTMLs.

    Priority order:
    1. contact
    2. about
    3. team
    4. staff
    5. locations
    6. catering
    7. wholesale
    8. press
    9. partners

    Strictly same-domain, non-external, non-social, and not already fetched.
    Returns (best_url, matched_category) or (None, None).
    """
    if not fetched_htmls or not base_url:
        return None, None

    base_parsed = urlparse(base_url)
    base_domain = base_parsed.netloc.lower().lstrip("www.").split(":")[0]
    if not base_domain:
        return None, None

    normalized_tried = {u.strip().rstrip("/").lower() for u in tried_urls if u}

    # Collect candidates: (priority_index, category_name, url)
    candidates: list[tuple[int, str, str]] = []
    seen_urls: set[str] = set()

    for html, page_url in fetched_htmls:
        if not html:
            continue
        for href, text in _ANCHOR_RE.findall(html):
            href_clean = href.strip()
            if not href_clean or href_clean.startswith(("#", "mailto:", "tel:", "javascript:", "data:")):
                continue

            resolved = urljoin(page_url, href_clean)
            resolved_no_hash = resolved.split("#", 1)[0].strip()
            resolved_clean = resolved_no_hash.rstrip("/")
            resolved_low = resolved_clean.lower()

            if resolved_low in normalized_tried or resolved_low in seen_urls:
                continue

            parsed = urlparse(resolved_no_hash)
            if parsed.scheme not in ("http", "https"):
                continue

            cand_domain = parsed.netloc.lower().lstrip("www.").split(":")[0]
            if not cand_domain:
                continue
            if cand_domain != base_domain and not cand_domain.endswith("." + base_domain):
                continue
            if any(cand_domain == d or cand_domain.endswith("." + d) for d in _SOCIAL_DOMAINS):
                continue

            # Check file extensions
            path_low = parsed.path.lower()
            if any(path_low.endswith(ext) for ext in _IGNORED_LINK_EXTENSIONS):
                continue

            # Evaluate against priority list
            # Inspect href path, query, and anchor text
            haystack = f"{parsed.path} {parsed.query} {text}"
            matched_priority: int | None = None
            matched_category: str | None = None

            for p_idx, (cat_name, cat_pattern) in enumerate(_SECONDARY_PAGE_PRIORITY):
                if cat_pattern.search(haystack):
                    matched_priority = p_idx
                    matched_category = cat_name
                    break

            if matched_priority is not None and matched_category is not None:
                seen_urls.add(resolved_low)
                candidates.append((matched_priority, matched_category, resolved_no_hash))

    if not candidates:
        return None, None

    # Pick lowest priority index (0 is highest priority: contact, then about, etc.)
    # Stable sort preserves document encounter order
    candidates.sort(key=lambda item: item[0])
    _, best_cat, best_url = candidates[0]
    return best_url, best_cat

