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
# Control-character sanitization
# ──────────────────────────────────────────────────────────────────────────────

# Phase 42D-1: a URL/href value polluted with an embedded control character
# or literal newline (e.g. from upstream scraping) survives `.strip()`
# unchanged, since `.strip()` only trims leading/trailing whitespace. Left
# in place, such a value reaches `urllib.request` and raises an uncaught
# `ValueError: URL can't contain control characters` deep inside
# `http.client` -- a class of error distinct from (and not caught by) the
# usual `urllib.error.HTTPError` / `urllib.error.URLError` /
# `socket.timeout` / `ConnectionError` handling already present at each
# call site. Centralized here so every caller (WebsiteWorker.process,
# ContactWorker._fetch, ContactWorker._extract_first_link, and this
# module's own `clean_ig_url`) sanitizes the same way.
_CONTROL_CHAR_RE = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")


def strip_control_characters(text: str) -> str:
    """Remove embedded control characters (including literal newlines/tabs
    in the middle of the string, which plain `.strip()` does not reach)
    from `text`. A clean string is returned unchanged. `None`/empty input
    is returned as-is.
    """
    return _CONTROL_CHAR_RE.sub("", text) if text else text


# ──────────────────────────────────────────────────────────────────────────────
# Phone
# ──────────────────────────────────────────────────────────────────────────────

_PHONE_BLOCKLIST = frozenset({
    "0000000000", "1111111111", "1234567890", "9999999999",
    "0123456789", "1000000000", "0000000", "1111111",
})

_TEL_HREF_RE = re.compile(r'href=["\']tel:([^"\']+)["\']', re.I)
# Inline "tel:" values that are not an href (e.g. Google Maps'
# `data-item-id="phone:tel:+15551234567"`): authoritative like a tel: link.
_TEL_INLINE_RE = re.compile(r"\btel:\s*(\+?[\d][\d\s().\-]{5,})", re.I)
_JSON_PHONE_RE = re.compile(
    r'"(?:telephone|phone|phoneNumber|formatted_phone_number)"\s*:\s*"([^"]+)"',
    re.I,
)
# Visible-text phone candidate: an optional "+"/"00" prefix, then digits
# with common separators. Deliberately allows a single-digit area code
# after the country code ("+20 2 2735 9999"), which the previous
# pattern could not match.
_PHONE_PATTERN = re.compile(
    r"(?<![\w@/:.\-])(?:\+|00)?\(?\d[\d\s().\-]{5,22}\d(?![\w@])",
)

_PHONE_EXT_RE = re.compile(
    r"\s*(?:;ext=|[,;]|\bext(?:ension)?\.?|\bx|#)\s*\d{1,6}\s*$",
    re.IGNORECASE,
)

# Values that look like dates, times, IPs, versions or ranges rather than
# phone numbers. Applied to visible-text candidates only.
_NOT_PHONE_RES = (
    # Date-shaped PREFIXES (so "2024-10-22 12" cut from "2024-10-22 12:30"
    # is rejected too): 2024-10-22, 2024/10/22, 10/22/2026, 22.10.2024.
    re.compile(r"^\d{4}[\-/.]\d{1,2}[\-/.]\d{1,2}(?!\d)"),
    re.compile(r"^\d{1,2}[\-/.]\d{1,2}[\-/.]\d{2,4}(?!\d)"),
    re.compile(r"^\d{1,3}(?:\.\d{1,3}){3}$"),                 # IPv4
    re.compile(r"^\d{4}\s*[\-\u2013]\s*\d{4}$"),             # 2020-2024
    re.compile(r".*\d{1,2}:\d{2}.*"),                         # clock times
)

# ISO-3166 alpha-2 -> (calling code, national trunk prefix).
_REGION_TABLE: dict[str, tuple[str, str]] = {
    "US": ("1", "1"), "CA": ("1", "1"),
    "EG": ("20", "0"), "GB": ("44", "0"), "IE": ("353", "0"),
    "AE": ("971", "0"), "SA": ("966", "0"), "QA": ("974", ""),
    "KW": ("965", ""), "JO": ("962", "0"), "LB": ("961", "0"),
    "MA": ("212", "0"), "DZ": ("213", "0"), "TN": ("216", ""),
    "TR": ("90", "0"), "DE": ("49", "0"), "FR": ("33", "0"),
    "ES": ("34", ""), "IT": ("39", ""), "NL": ("31", "0"),
    "BE": ("32", "0"), "CH": ("41", "0"), "AT": ("43", "0"),
    "SE": ("46", "0"), "NO": ("47", ""), "DK": ("45", ""),
    "PL": ("48", ""), "PT": ("351", ""), "GR": ("30", ""),
    "AU": ("61", "0"), "NZ": ("64", "0"), "IN": ("91", "0"),
    "PK": ("92", "0"), "ZA": ("27", "0"), "NG": ("234", "0"),
    "KE": ("254", "0"), "MX": ("52", ""), "BR": ("55", "0"),
    "AR": ("54", "0"), "CL": ("56", ""), "CO": ("57", ""),
    "SG": ("65", ""), "MY": ("60", "0"), "PH": ("63", "0"),
    "ID": ("62", "0"), "TH": ("66", "0"), "JP": ("81", "0"),
    "KR": ("82", "0"), "CN": ("86", "0"),
}

_REGION_ALIASES: dict[str, str] = {
    "USA": "US", "UNITED STATES": "US", "UNITED STATES OF AMERICA": "US",
    "AMERICA": "US", "CANADA": "CA", "EGYPT": "EG", "UK": "GB",
    "UNITED KINGDOM": "GB", "GREAT BRITAIN": "GB", "ENGLAND": "GB",
    "IRELAND": "IE", "UAE": "AE", "UNITED ARAB EMIRATES": "AE",
    "SAUDI ARABIA": "SA", "QATAR": "QA", "KUWAIT": "KW", "JORDAN": "JO",
    "LEBANON": "LB", "MOROCCO": "MA", "ALGERIA": "DZ", "TUNISIA": "TN",
    "TURKEY": "TR", "GERMANY": "DE", "FRANCE": "FR", "SPAIN": "ES",
    "ITALY": "IT", "NETHERLANDS": "NL", "BELGIUM": "BE",
    "SWITZERLAND": "CH", "AUSTRIA": "AT", "SWEDEN": "SE", "NORWAY": "NO",
    "DENMARK": "DK", "POLAND": "PL", "PORTUGAL": "PT", "GREECE": "GR",
    "AUSTRALIA": "AU", "NEW ZEALAND": "NZ", "INDIA": "IN",
    "PAKISTAN": "PK", "SOUTH AFRICA": "ZA", "NIGERIA": "NG",
    "KENYA": "KE", "MEXICO": "MX", "BRAZIL": "BR", "ARGENTINA": "AR",
    "CHILE": "CL", "COLOMBIA": "CO", "SINGAPORE": "SG", "MALAYSIA": "MY",
    "PHILIPPINES": "PH", "INDONESIA": "ID", "THAILAND": "TH",
    "JAPAN": "JP", "SOUTH KOREA": "KR", "KOREA": "KR", "CHINA": "CN",
}

# Longest calling codes first so "+971" wins over "+97".
_CC_TO_REGION = sorted(
    {cc: r for r, (cc, _t) in _REGION_TABLE.items() if r not in ("CA",)}.items(),
    key=lambda kv: -len(kv[0]),
)

_EG_MOBILE_RE = re.compile(r"^1[0125]\d{8}$")
_EG_LANDLINE_RE = re.compile(r"^(?:2\d{8}|3\d{7}|13\d{7}|(?:4[0-9]|5[0-9]|6[2-9]|8[2-9]|9[0-9])\d{7})$")


def resolve_region(country: str | None) -> str | None:
    """Map a country code or name to an ISO-3166 alpha-2 code, or None."""
    if not country:
        return None
    c = str(country).strip().upper()
    if not c:
        return None
    if c in _REGION_TABLE:
        return c
    return _REGION_ALIASES.get(c)


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


def _nanp_valid(d10: str, *, strict: bool = True) -> bool:
    """North American Numbering Plan plausibility for a 10-digit number.

    ``strict`` (used only when we must GUESS that an unprefixed number is
    North American) also requires a valid exchange digit. Numbers that
    state their country explicitly (``+1`` / a US region) only need a
    valid area-code lead digit, so fixture-style numbers such as
    ``+1 555 123 4567`` are still accepted.
    """
    if not (
        len(d10) == 10
        and d10[0] in "23456789"
        and d10 not in _PHONE_BLOCKLIST
        and len(set(d10)) > 2
    ):
        return False
    return d10[3] in "23456789" if strict else True


def _fmt_us(d10: str) -> str:
    return f"+1 ({d10[:3]}) {d10[3:6]}-{d10[6:]}"


def _national_ok(region: str, national: str) -> bool:
    """Length/shape sanity for a national significant number (no trunk)."""
    if region == "EG":
        return bool(_EG_MOBILE_RE.match(national) or _EG_LANDLINE_RE.match(national))
    if region in ("US", "CA"):
        return _nanp_valid(national, strict=False)
    if region == "GB":
        return 9 <= len(national) <= 10
    return 6 <= len(national) <= 12


def _intl_digits(digits: str) -> str:
    """Normalize an already-international digit string (no '+') to display form."""
    if not (8 <= len(digits) <= 15):
        return ""
    if digits in _PHONE_BLOCKLIST or len(set(digits)) <= 2:
        return ""
    if digits.startswith("1") and len(digits) == 11:
        return _fmt_us(digits[1:]) if _nanp_valid(digits[1:], strict=False) else ""
    for cc, region in _CC_TO_REGION:
        if digits.startswith(cc):
            national = digits[len(cc):]
            trunk = _REGION_TABLE[region][1]
            # "+44 020 ..." / "+20 (0)2 ...": drop a redundant trunk zero.
            if trunk == "0" and national.startswith("0"):
                national = national[1:]
            if not _national_ok(region, national):
                return ""
            return f"+{cc}{national}"
    # Unknown calling code: accept a plausible E.164 length as-is.
    return f"+{digits}" if 9 <= len(digits) <= 15 else ""


def normalize_phone(
    raw: str | None,
    region: str | None = None,
    *,
    strict: bool = False,
) -> str:
    """Return a normalized display phone, or "" when it is not a phone.

    * NANP numbers render as ``+1 (AAA) BBB-CCCC``; every other
      international number renders as compact E.164 (``+201001234567``).
    * ``region`` (ISO code or country name) lets national numbers be
      placed (e.g. Egyptian ``010 0123 4567`` -> ``+201001234567``).
    * With no usable region, a number without ``+``/``00`` is accepted
      only if it is a valid North American number; in non-``strict``
      mode any other plausible national number is kept as written
      (whitespace-collapsed) instead of being mislabeled with a guessed
      country code.
    * Extensions (``x22``, ``ext. 5``) are stripped.
    """
    if not raw:
        return ""
    s = str(raw).strip()
    if s.lower().startswith("tel:"):
        s = s[4:].strip()
    s = s.split("?", 1)[0].split(";", 1)[0].strip()
    s = re.sub(r"\(0\)", "", s)           # "+20 (0)2 ..." trunk marker
    s = _PHONE_EXT_RE.sub("", s).strip()
    if not s:
        return ""
    d = digits_only(s)
    if not is_valid_phone(d, min_digits=7):
        return ""

    if s.startswith("+") or s.startswith("00"):
        intl = d[2:] if s.startswith("00") else d
        return _intl_digits(intl)

    reg = resolve_region(region)
    if reg is not None:
        cc, trunk = _REGION_TABLE[reg]
        if reg in ("US", "CA"):
            if len(d) == 10 and _nanp_valid(d, strict=False):
                return _fmt_us(d)
            if len(d) == 11 and d.startswith("1") and _nanp_valid(d[1:], strict=False):
                return _fmt_us(d[1:])
            return ""
        national = d
        if trunk and national.startswith(trunk):
            national = national[len(trunk):]
        elif national.startswith(cc) and _national_ok(reg, national[len(cc):].lstrip("0")):
            national = national[len(cc):].lstrip("0")   # "20 100 123 4567" typed without "+"
        if _national_ok(reg, national):
            return f"+{cc}{national}"
        return ""

    # Unknown region.
    if len(d) == 10 and _nanp_valid(d):
        return _fmt_us(d)
    if len(d) == 11 and d.startswith("1") and _nanp_valid(d[1:]):
        return _fmt_us(d[1:])
    if strict:
        return ""
    # Lenient fallback for authoritative sources (provider fields, tel:
    # links) when the country is unknown: keep the national digits
    # rather than inventing a country code, but never for date/IP-shaped
    # or non-phone-looking strings.
    if re.search(r"[^\d\s().\-+]", s):
        return ""
    if any(rx.match(s) for rx in _NOT_PHONE_RES[:4]):
        return ""
    return re.sub(r"\s+", " ", s) if 8 <= len(d) <= 15 else ""


def phone_dedup_key(value: str | None) -> str:
    """Dedup key for an already-normalized/extracted phone: its last 10
    digits (the whole number if shorter). Makes ``+1 (555) 012-3456``,
    ``555.012.3456`` and ``15550123456`` one number, and
    ``+20 100 123 4567`` equal to ``0100 123 4567``."""
    d = digits_only(value)
    return d[-10:] if len(d) >= 10 else d


def phone_key(raw: str | None, region: str | None = None) -> str:
    """Canonical dedup key for a raw phone string ('' if invalid)."""
    n = normalize_phone(raw, region)
    return phone_dedup_key(n)


def _looks_like_phone_token(token: str) -> bool:
    t = token.strip()
    for rx in _NOT_PHONE_RES:
        if rx.match(t):
            return False
    d = digits_only(t)
    has_sep = bool(re.search(r"[\s().\-]", t))
    has_prefix = t.startswith("+") or t.startswith("00")
    # Unseparated digit runs are only trusted with an international
    # prefix or a leading national zero (order numbers, ids and
    # timestamps are otherwise indistinguishable from phones).
    if not has_sep and not has_prefix and not d.startswith("0"):
        return False
    return 8 <= len(d) <= 15


_TAG_RE = re.compile(r"<[^>]+>")


def strip_scripts_and_styles(html: str) -> str:
    """Remove <script>/<style> blocks in linear time.

    Replaces a lazy ``<script>.*?</script>`` DOTALL regex, which rescans
    to the end of the document for every unclosed ``<script``.
    """
    if not html:
        return html
    low = html.lower()
    out: list[str] = []
    pos = 0
    n = len(html)
    while pos < n:
        nxt = -1
        tag = ""
        for t in ("<script", "<style"):
            i = low.find(t, pos)
            if i != -1 and (nxt == -1 or i < nxt):
                nxt, tag = i, t[1:]
        if nxt == -1:
            out.append(html[pos:])
            break
        out.append(html[pos:nxt])
        close = low.find(f"</{tag}", nxt)
        if close == -1:
            # Unclosed block: drop only the opening tag, keep the rest.
            gt = html.find(">", nxt)
            pos = gt + 1 if gt != -1 else nxt + 1 + len(tag)
            out.append(" ")
            continue
        gt = html.find(">", close)
        pos = gt + 1 if gt != -1 else n
        out.append(" ")
    return "".join(out)


def extract_phones(
    text: str,
    region: str | None = None,
    *,
    trusted: bool = False,
) -> list[str]:
    """Find phone numbers in HTML or plain text, normalized and de-duplicated.

    ``tel:`` hrefs and JSON ``telephone`` keys are authoritative.
    Visible-text candidates are filtered (dates, times, versions, ids)
    and normalized strictly. ``trusted=True`` (text already known to be a
    phone field, e.g. a Maps panel button) keeps plausible national
    numbers even when no region is known.
    """
    if not text:
        return []
    found: list[str] = []
    seen: set[str] = set()

    def _add(raw: str, *, strict: bool) -> None:
        n = normalize_phone(raw, region, strict=strict)
        if not n:
            return
        # Trusted phone-field text with no known region that is written in
        # the unmistakable North American shape "(AAA) BBB-CCCC" /
        # "AAA-BBB-CCCC" is rendered as a US number (previous behaviour),
        # instead of being left unformatted.
        if (
            trusted
            and region is None
            and not n.startswith("+")
            and re.fullmatch(r"\(?\d{3}\)?[\s.\-]\d{3}[\s.\-]\d{4}", raw.strip())
            and _nanp_valid(digits_only(raw), strict=False)
        ):
            n = _fmt_us(digits_only(raw))
        k = phone_dedup_key(n)
        if k and k not in seen:
            seen.add(k)
            found.append(n)

    for m in _TEL_HREF_RE.findall(text):
        _add(m, strict=False)
    for m in _JSON_PHONE_RE.findall(text):
        _add(m, strict=False)
    for m in _TEL_INLINE_RE.findall(text):
        _add(m.strip(), strict=False)
    # For visible text: strip script/style and tags so attributes like
    # data-id / width / height aren't matched.
    cleaned_text = _TAG_RE.sub(" ", strip_scripts_and_styles(text))

    for m in _PHONE_PATTERN.finditer(cleaned_text):
        token = m.group(0).strip()
        if len(digits_only(token)) < 7:
            continue
        if not trusted and not _looks_like_phone_token(token):
            continue
        _add(token, strict=not trusted)

    return found


def pick_best_phone(candidates: list[str], country: str = "") -> str:
    region = resolve_region(country)
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


# TLD-shaped suffixes that are really file names / assets ("logo@2x.png").
_ASSET_TLDS = frozenset({
    "png", "jpg", "jpeg", "gif", "webp", "svg", "ico", "bmp", "tif", "tiff",
    "avif", "heic", "css", "js", "mjs", "map", "json", "xml", "html", "htm",
    "php", "asp", "aspx", "woff", "woff2", "ttf", "otf", "eot", "mp3", "mp4",
    "webm", "mov", "avi", "wav", "pdf", "zip", "gz", "tar", "rar", "txt",
    "csv", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "exe", "dmg", "apk",
    "wasm", "md", "yml", "yaml", "ts", "tsx", "jsx", "scss", "less",
})
_HEX_LOCAL_RE = re.compile(r"^[0-9a-f]{24,}$")


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
    labels = domain.split(".")
    if any(not lab or lab.startswith("-") or lab.endswith("-") for lab in labels):
        return False
    if labels[-1] in _ASSET_TLDS:
        return False
    # "2x"/"3x" retina-suffix labels and hash-like local parts are
    # build artifacts (sentry keys, srcset names), not mailboxes.
    if any(re.fullmatch(r"\d+x", lab) for lab in labels):
        return False
    if _HEX_LOCAL_RE.match(local):
        return False
    return True


def _email_blocked(email: str) -> bool:
    return not is_valid_email(email)


def decode_cfemail(cfemail: str) -> str:
    """Decode Cloudflare email-protection XOR cipher string."""
    try:
        cfemail = cfemail.strip()
        if len(cfemail) < 4 or len(cfemail) % 2 != 0:
            return ""
        k = int(cfemail[:2], 16)
        email_chars = [chr(int(cfemail[i:i+2], 16) ^ k) for i in range(2, len(cfemail), 2)]
        decoded = "".join(email_chars).strip().lower()
        if is_valid_email(decoded):
            return decoded
    except Exception:
        pass
    return ""


_OBFUSCATED_EMAIL_RE = re.compile(
    r"\b([A-Za-z0-9._%+\-]+)\s*(?:\[at\]|\(at\)|\bat\b|\[@\])\s*([A-Za-z0-9.\-]+)\s*(?:\[dot\]|\(dot\)|\bdot\b|\[\.\]|\.)\s*([A-Za-z]{2,})\b",
    re.IGNORECASE,
)
# Strict obfuscated form: requires an explicit bracketed/parenthesised
# "at" marker so ordinary prose ("meet us at home. Visit") never matches.
_BRACKET_OBFUSCATED_EMAIL_RE = re.compile(
    r"([A-Za-z0-9._%+\-]+)\s*(?:\[\s*at\s*\]|\(\s*at\s*\)|\{\s*at\s*\}|\[@\])\s*"
    r"((?:[A-Za-z0-9\-]+\s*(?:\[\s*dot\s*\]|\(\s*dot\s*\)|\{\s*dot\s*\}|\[\.\]|\.)\s*)+)"
    r"([A-Za-z]{2,})",
    re.IGNORECASE,
)
_DOT_SEP_RE = re.compile(r"\s*(?:\[\s*dot\s*\]|\(\s*dot\s*\)|\{\s*dot\s*\}|\[\.\])\s*", re.IGNORECASE)


def extract_obfuscated_emails(text: str) -> list[str]:
    """Decode bracketed obfuscations: ``name [at] shop [dot] com``,
    ``name(at)shop(dot)co(dot)uk``, ``name[@]shop.com``. Only valid,
    de-duplicated addresses are returned."""
    if not text:
        return []
    out: list[str] = []
    seen: set[str] = set()
    for local, dom_head, tld in _BRACKET_OBFUSCATED_EMAIL_RE.findall(text):
        host = _DOT_SEP_RE.sub(".", dom_head)
        host = re.sub(r"\s+", "", host).strip(".")
        e = f"{local}@{host}.{tld}".lower()
        if e not in seen and is_valid_email(e):
            seen.add(e)
            out.append(e)
    return out


def decode_entities(text: str) -> str:
    """Decode HTML entities (``&#64;``, ``&commat;``) and ``%40`` so
    entity-obfuscated addresses are visible to the scanners."""
    if not text or ("&" not in text and "%40" not in text):
        return text
    import html as _html
    return _html.unescape(text).replace("%40", "@")


def select_primary_email(emails: list[str], preferred_domain: str = "") -> list[str]:
    """Return valid, de-duplicated emails ordered best-first: own-domain
    first, then the outreach role priority used by ``pick_best_email``."""
    cleaned = [e for e in dict.fromkeys((x or "").strip().lower() for x in emails) if e and is_valid_email(e)]
    if not cleaned:
        return []
    best = pick_best_email(cleaned, preferred_domain)
    if best and best.lower() in cleaned:
        cleaned.remove(best.lower())
        cleaned.insert(0, best.lower())
    return cleaned


_CF_EMAIL_HREF_RE = re.compile(r'/cdn-cgi/l/email-protection#([a-f0-9]+)', re.IGNORECASE)
_CF_EMAIL_ATTR_RE = re.compile(r'data-cfemail=["\']([a-f0-9]+)["\']', re.IGNORECASE)


def extract_emails(html: str) -> list[str]:
    """Extract all valid emails from HTML including mailto, Cloudflare, obfuscated, and plain text."""
    if not html:
        return []
    found: list[str] = []
    seen: set[str] = set()

    def _add_email(raw: str) -> None:
        if not raw:
            return
        e = urllib.parse.unquote(raw).strip().lower()
        if e not in seen and is_valid_email(e):
            seen.add(e)
            found.append(e)

    # 1. mailto: links first (most reliable)
    for m in re.findall(r'mailto:([^"\'>\s?&]+)', html, flags=re.I):
        if "@" in m:
            _add_email(m)

    # 2. Cloudflare email protection
    for m in _CF_EMAIL_HREF_RE.findall(html):
        decoded = decode_cfemail(m)
        if decoded:
            _add_email(decoded)
    for m in _CF_EMAIL_ATTR_RE.findall(html):
        decoded = decode_cfemail(m)
        if decoded:
            _add_email(decoded)

    # 3. Obfuscated email patterns (e.g. name [at] domain.com)
    for m in _OBFUSCATED_EMAIL_RE.findall(html):
        constructed = f"{m[0]}@{m[1]}.{m[2]}"
        _add_email(constructed)

    # 4. Raw email scan
    for m in _SCAN_EMAIL_RE.findall(html):
        _add_email(m)

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
            pd = preferred_domain.lower().removeprefix("www.")
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


def is_social_platform(url: str) -> bool:
    """Return True if URL belongs to a social network or link-in-bio platform."""
    _SOCIAL = frozenset({
        "instagram.com", "instagr.am", "facebook.com", "fb.com", "fb.me",
        "twitter.com", "x.com", "tiktok.com", "linkedin.com", "linktr.ee",
        "linktree.com", "youtube.com", "pinterest.com",
    })
    host = domain_of(url)
    return any(host == d or host.endswith("." + d) for d in _SOCIAL)


# ──────────────────────────────────────────────────────────────────────────────
# Instagram URL helpers
# ──────────────────────────────────────────────────────────────────────────────

_IG_NON_HANDLES = frozenset({
    "p", "reel", "reels", "tv", "explore", "stories", "accounts",
    "about", "directory", "legal", "privacy", "press", "help",
    "api", "oauth", "challenge", "login", "signup", "explore",
    # Phase 27, Step 5: explicitly named in the reserved-path reject
    # list ("/direct/") but missing from this set before now.
    "direct",
    # Contact-data audit: non-profile paths seen in embeds, share
    # widgets and static assets that were being accepted as handles.
    # Deliberately conservative: only paths that are never a business
    # profile (words a real business might use as a handle, e.g.
    # "business" or "blog", are NOT listed). File-like names such as
    # "embed.js" / "sharer.php" are also rejected by suffix.
    "sharer", "embed", "static", "web", "developer", "developers",
    "nametag", "oembed", "emails", "session", "ajax", "graphql", "_u",
})

_IG_HANDLE_RE = re.compile(r"^[A-Za-z0-9_][A-Za-z0-9_.]{1,29}$")
# A real handle never ends in a file extension or a dot, and never has
# consecutive dots ("embed.js", "sharer.php", "x..y", "name.").
_IG_FILELIKE_SUFFIX_RE = re.compile(
    r"\.(?:js|mjs|php|asp|aspx|html?|json|xml|css|png|jpe?g|gif|webp|svg|ico|txt|map|woff2?|ttf)$",
    re.IGNORECASE,
)


def is_valid_ig_handle(handle: str | None) -> bool:
    """True only for a plausible public profile handle."""
    if not handle:
        return False
    h = handle.strip().lower()
    if not h or h in _IG_NON_HANDLES or h.isdigit():
        return False
    if h.endswith(".") or ".." in h or _IG_FILELIKE_SUFFIX_RE.search(h):
        return False
    return bool(_IG_HANDLE_RE.match(h))

# Phase 27 (Instagram acquisition control-flow + extraction hardening):
# broadened from a scheme-required `https?://` prefix to also recognize
# protocol-relative (`//instagram.com/...`) and bare-domain
# (`instagram.com/...`, no scheme, no leading slashes) forms — both
# confirmed misses in Phase 26 production analysis. The leading
# `(?<![\w.-])` negative lookbehind is what keeps the now-optional
# scheme/slashes safe: without it, a bare-domain match would also fire
# inside an unrelated word ending in "instagram.com" (e.g.
# "fakeinstagram.com/x"); the lookbehind requires the match start with a
# non-word/non-dot/non-hyphen character (or the start of the string),
# which a real "instagram.com" reference — preceded by whitespace, a
# quote, `//`, or nothing — always satisfies, while a domain that merely
# ends the same way never does. Capture group 1 (the handle) is
# unaffected by which prefix variant matched, so every existing caller
# (`extract_ig_urls`, `extract_ig_urls_with_source`,
# `has_invalid_ig_candidate`) gets the broadened recognition for free.
_IG_URL_RE = re.compile(
    r"(?<![\w.-])(?:(?:https?:)?//)?(?:www\.|m\.)?(?:instagram\.com|instagr\.am)/([A-Za-z0-9_.]+)(?:/[^\"'\s<>]*)?",
    re.IGNORECASE,
)


def is_real_ig_handle(url: str) -> bool:
    try:
        path = urlparse(url).path.strip("/")
    except Exception:
        return False
    if not path:
        return False
    return is_valid_ig_handle(path.split("/")[0])


def ig_url_from_provider_value(value: str | None) -> str | None:
    """Canonical profile URL from a provider-supplied Instagram value.

    Providers return a URL (OSM ``contact:instagram`` is often a full
    URL), an ``@handle`` or a bare handle (Foursquare
    ``social_media.instagram``). Normalizing a handle the provider itself
    published is not guessing. Returns None for anything that is not a
    valid public profile (posts, reserved paths, junk).
    """
    if not value:
        return None
    v = strip_control_characters(str(value)).strip()
    if not v:
        return None
    if "instagram.com" in v.lower() or "instagr.am" in v.lower():
        m = _IG_URL_RE.search(v)
        handle = m.group(1) if m else ""
    else:
        handle = v.lstrip("@").strip().strip("/")
        if "/" in handle or " " in handle:
            return None
    if not is_valid_ig_handle(handle):
        return None
    return f"https://www.instagram.com/{handle.lower()}/"


def clean_ig_url(raw: str) -> str:
    """Normalise an Instagram URL to https://www.instagram.com/<handle>/

    Phase 27: accepts the same broadened set of input shapes
    `_IG_URL_RE` now recognizes (protocol-relative `//...` and bare
    `instagram.com/...` with no scheme at all) by giving `urlparse` an
    explicit scheme first — `urlparse` otherwise reads a schemeless
    `instagram.com/x` as a relative path (empty netloc), which would
    silently produce a wrong/empty handle.

    Phase 42D-1: also strips embedded control characters/literal
    newlines (not just leading/trailing whitespace) before parsing, so a
    control-character-polluted Instagram href is normalized instead of
    surviving into the stored URL.
    """
    raw = strip_control_characters(raw.split('"')[0].split("'")[0].strip())
    normalized = raw
    if normalized.startswith("//"):
        normalized = "https:" + normalized
    elif not re.match(r"^https?://", normalized, re.IGNORECASE):
        normalized = "https://" + normalized
    try:
        p = urlparse(normalized)
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
        if not is_valid_ig_handle(handle):
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

# Phase 27 (Instagram acquisition control-flow + extraction hardening),
# Step 6: a bare Instagram handle sitting in a clearly Instagram-specific
# HTML attribute — `data-instagram="business"`,
# `data-instagram-handle="business"`, `data-instagram-url="..."` — with
# no `instagram.com` text anywhere on the page for `_IG_URL_RE` to catch.
# Deliberately narrow: only attribute names that explicitly say
# "instagram" qualify, so an arbitrary `data-id="business"` or
# `data-name="business"` is never treated as Instagram evidence (the
# context must be explicit, per Step 6's own instruction) — this is a
# fixed attribute-name allowlist, not a generic data-* scan.
_IG_DATA_ATTR_RE = re.compile(
    r'\bdata-(?:instagram|ig)(?:-handle|-url|-id|-account|-name)?\s*=\s*["\']([^"\']+)["\']',
    re.IGNORECASE,
)

#: Source-type preference order (Step 7 — wrong-account precedence).
#: Lower number wins. A business-owned anchor/footer/social link is the
#: strongest signal; an unstructured plain-text @handle mention is the
#: weakest. `meta` (e.g. an `og:see_also`/`twitter:site` tag) sits with
#: the "explicit URL elsewhere" tier: structured enough to trust over
#: raw body text, but not an explicit social link or a business's own
#: data attribute.
_IG_SOURCE_PRIORITY = {
    "anchor_href": 0,
    "data_attribute": 1,
    "jsonld": 2,
    "meta": 3,
    "raw_html": 4,
    "plain_handle": 5,
}


def _ig_handle_from_attr_value(value: str) -> "str | None":
    """
    Resolve a `data-instagram*` attribute value — which may be a bare
    handle (`"business"`) or a full/partial URL
    (`"https://instagram.com/business"`, `"instagram.com/business"`) —
    to a validated lowercase handle, or None if it doesn't look like a
    real business handle. Reuses `_IG_URL_RE`/`_IG_NON_HANDLES`/
    `_IG_HANDLE_RE` rather than a second parsing path.
    """
    value = value.strip()
    if not value:
        return None
    url_match = _IG_URL_RE.search(value)
    if url_match:
        handle = url_match.group(1).split("/")[0].lower()
    else:
        handle = value.lstrip("@").split("/")[0].split("?")[0].lower()
    if not is_valid_ig_handle(handle):
        return None
    return handle


def _find_ig_data_attribute_candidates(html: str) -> "list[tuple[int, str]]":
    """(position, canonical_url) pairs from `data-instagram*` attributes.
    See `_IG_DATA_ATTR_RE`'s own comment for the explicit-context
    requirement that keeps this from firing on unrelated `data-*`
    attributes."""
    if not html or ("data-instagram" not in html.lower() and "data-ig" not in html.lower()):
        return []
    candidates: "list[tuple[int, str]]" = []
    for m in _IG_DATA_ATTR_RE.finditer(html):
        handle = _ig_handle_from_attr_value(m.group(1))
        if not handle:
            continue
        url = f"https://www.instagram.com/{handle}/"
        if not is_real_ig_handle(url):
            continue
        candidates.append((m.start(), url))
    return candidates


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
    Business-specific @handles mentioned as plain text or within social icon
    attributes (aria-label, title, alt), ONLY when the surrounding text / attribute
    also mentions "instagram" — e.g. "Instagram: @joesbarber" or
    <a aria-label="Instagram: @joesbarber" ...>.
    """
    if not html or ("@" not in html and "instagram" not in html.lower()):
        return []
    text = _HTML_TAG_RE.sub(" ", html)
    results: list[str] = []
    seen: set[str] = set()

    # 1. Plain text mentions
    for m in _PLAIN_HANDLE_RE.finditer(text):
        handle = m.group(1)
        low = handle.lower()
        if low in seen:
            continue
        if low == "instagram" or not is_valid_ig_handle(handle):
            continue
        window = text[
            max(0, m.start() - _PLAIN_HANDLE_CONTEXT_WINDOW):
            min(len(text), m.end() + _PLAIN_HANDLE_CONTEXT_WINDOW)
        ]
        if not re.search(r"instagram", window, re.IGNORECASE):
            continue
        seen.add(low)
        results.append(handle)

    # 2. Contextual attributes on elements / icons (aria-label, title, alt)
    for tag_match in _ATTR_SCAN_RE.finditer(html):
        attr_str = tag_match.group(2)
        for attr_m in _ATTR_PAIR_RE.finditer(attr_str):
            k = attr_m.group(1).lower()
            val = (attr_m.group(2) or attr_m.group(3) or "").strip()
            if k in ("aria-label", "title", "alt", "data-title", "data-name") and val:
                has_ig_ctx = bool(re.search(r"instagram", k, re.I) or re.search(r"instagram", val, re.I))
                if has_ig_ctx:
                    for m in _PLAIN_HANDLE_RE.finditer(val):
                        h = m.group(1)
                        low_h = h.lower()
                        if (
                            low_h not in seen
                            and low_h != "instagram"
                            and is_valid_ig_handle(h)
                        ):
                            seen.add(low_h)
                            results.append(h)
    return results


def extract_ig_urls_with_source(text: str) -> list[tuple[str, str]]:
    """
    Like `extract_ig_urls()`, but paired with where each canonical
    Instagram URL was found: "anchor_href", "data_attribute", "jsonld",
    "meta", "raw_html" (a literal instagram.com URL elsewhere in the
    markup), or "plain_handle" (a business @handle in plain text next to
    the word "instagram").

    Phase 27 (Step 7 — wrong-account precedence): previously this
    function returned candidates in raw document order, and only ever
    looked for a plain-text @handle when zero `instagram.com` URLs were
    found anywhere on the page — so a single arbitrary/incidental
    Instagram URL (e.g. a press-mention link) silently suppressed a
    correct plain-handle mention elsewhere on the same page, and a
    same-priority-but-later structured signal (JSON-LD) could rank
    ahead of a same-page anchor purely because it happened to appear
    earlier in the HTML. Fixed by collecting every candidate first, from
    every source (including `data-instagram*` attributes and plain-text
    @handles, unconditionally — no longer gated on "no URL found"), then
    ranking by evidence-type strength (`_IG_SOURCE_PRIORITY`) with
    document position only as a same-type tie-break, then deduplicating
    canonical handles. A plain-text @handle is therefore never silently
    discarded (Step 7's own bug report) even when a stronger candidate
    also exists on the page — it simply ranks below any URL-based
    evidence, exactly as `test_plain_handle_only_used_when_no_url_present`
    already established for the anchor-vs-plain-handle case.
    """
    if not text:
        return []

    anchor_spans = [m.span(1) for m in _ANCHOR_HREF_RE.finditer(text)]
    jsonld_spans = [m.span() for m in _JSONLD_BLOCK_RE.finditer(text)]
    meta_spans = [m.span() for m in _META_TAG_RE.finditer(text)]

    # 1. Collect every literal instagram.com URL candidate, whatever
    #    shape it's written in (see _IG_URL_RE), tagged with its
    #    document position and source.
    raw_candidates: "list[tuple[int, str, str]]" = []  # (position, source, url)
    for m in _IG_URL_RE.finditer(text):
        handle = m.group(1).split("/")[0].lower()
        if not handle or handle in _IG_NON_HANDLES or handle.isdigit():
            continue
        url = f"https://www.instagram.com/{handle}/"
        if not is_real_ig_handle(url):
            continue
        source = _ig_source_for_span(
            m.start(), m.end(), anchor_spans, jsonld_spans, meta_spans
        )
        raw_candidates.append((m.start(), source, url))

    # 2. Collect data-instagram* attribute candidates (Step 6).
    for pos, url in _find_ig_data_attribute_candidates(text):
        raw_candidates.append((pos, "data_attribute", url))

    # 3. Rank by evidence-type strength, document position as tie-break,
    #    then deduplicate canonical handles (first/best-ranked wins).
    raw_candidates.sort(key=lambda c: (_IG_SOURCE_PRIORITY[c[1]], c[0]))
    results: list[tuple[str, str]] = []
    seen: set[str] = set()
    for _pos, source, url in raw_candidates:
        if url in seen:
            continue
        seen.add(url)
        results.append((url, source))

    # 4. Plain-text @handle mentions are always collected too (Step 7 —
    #    no longer suppressed just because a URL-based candidate
    #    exists), but stay ranked last: the lowest-confidence signal
    #    never overrides an actual URL or data attribute.
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

            # 1. Cloudflare cfemail attribute
            if attr_key_low == "data-cfemail":
                decoded = decode_cfemail(val)
                if decoded and decoded not in seen_emails and is_valid_email(decoded):
                    seen_emails.add(decoded)
                    found_emails.append(decoded)
                continue

            # 2. Direct email-named attributes
            if attr_key_low in _EMAIL_CONTEXT_ATTR_NAMES:
                for match in _SCAN_EMAIL_RE.findall(val):
                    clean = match.lower()
                    if clean not in seen_emails and is_valid_email(clean):
                        seen_emails.add(clean)
                        found_emails.append(clean)
                for m in _OBFUSCATED_EMAIL_RE.findall(val):
                    constructed = f"{m[0]}@{m[1]}.{m[2]}".lower()
                    if constructed not in seen_emails and is_valid_email(constructed):
                        seen_emails.add(constructed)
                        found_emails.append(constructed)
                continue

            # 3. aria-label / title / alt with email syntax or email context
            if attr_key_low in ("aria-label", "title", "alt"):
                if "@" in val or "mail" in attr_key_low or "mail" in val.lower():
                    for match in _SCAN_EMAIL_RE.findall(val):
                        clean = match.lower()
                        if clean not in seen_emails and is_valid_email(clean):
                            seen_emails.add(clean)
                            found_emails.append(clean)
                    for m in _OBFUSCATED_EMAIL_RE.findall(val):
                        constructed = f"{m[0]}@{m[1]}.{m[2]}".lower()
                        if constructed not in seen_emails and is_valid_email(constructed):
                            seen_emails.add(constructed)
                            found_emails.append(constructed)

            # 4. Direct phone-named attributes
            if attr_key_low in _PHONE_CONTEXT_ATTR_NAMES:
                norm = normalize_phone(val)
                if norm and norm not in seen_phones and is_valid_phone(norm):
                    seen_phones.add(norm)
                    found_phones.append(norm)
                continue

            # 5. aria-label / title / alt with phone context
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
    ("contact", re.compile(r"\b(?:contact(?:-us|_us|us)?|connect|get-in-touch|reach-us)\b", re.IGNORECASE)),
    ("about", re.compile(r"\b(?:about(?:-us|_us|us)?)\b", re.IGNORECASE)),
    ("locations", re.compile(r"\b(?:locations?|find-us|visit-us)\b", re.IGNORECASE)),
    ("team", re.compile(r"\bteam\b", re.IGNORECASE)),
    ("staff", re.compile(r"\bstaff\b", re.IGNORECASE)),
    ("catering", re.compile(r"\bcatering\b", re.IGNORECASE)),
    ("wholesale", re.compile(r"\bwholesale\b", re.IGNORECASE)),
    ("press", re.compile(r"\bpress\b", re.IGNORECASE)),
    ("partners", re.compile(r"\bpartners?\b", re.IGNORECASE)),
)

_STANDARD_CONTACT_PATHS: tuple[tuple[str, str], ...] = (
    ("contact", "/contact"),
    ("contact", "/contact-us"),
    ("about", "/about"),
    ("about", "/about-us"),
    ("locations", "/locations"),
    ("locations", "/find-us"),
    ("contact", "/connect"),
)


def get_standard_contact_candidates(
    base_url: str,
    tried_urls: set[str],
) -> list[tuple[str, str]]:
    """Return prioritized fallback (category, url) pairs for standard contact pages."""
    if not base_url:
        return []
    base_parsed = urlparse(base_url)
    if not base_parsed.scheme or not base_parsed.netloc:
        return []
    origin = f"{base_parsed.scheme}://{base_parsed.netloc}"
    normalized_tried = {u.strip().rstrip("/").lower() for u in tried_urls if u}

    results: list[tuple[str, str]] = []
    for cat, path in _STANDARD_CONTACT_PATHS:
        full_url = urljoin(origin, path)
        if full_url.rstrip("/").lower() not in normalized_tried:
            results.append((cat, full_url))
    return results

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

