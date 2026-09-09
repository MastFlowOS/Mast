"""
street_inventory/normalization.py
===================================

Deterministic street-name normalization and canonical `street_key`
construction for Phase 2A.

Why this is a NEW, small normalizer rather than reusing an existing one
-----------------------------------------------------------------------
This codebase already has one deterministic text normalizer:
`providers/provider_deduplicator.py:_normalize_text` (lowercase,
collapse all non-alphanumeric runs to a single space, collapse
whitespace). It solves a different problem — approximate business
name/address matching for lead deduplication — and is:

    1. module-private (leading underscore; not part of that module's
       public surface, and importing a private helper across modules
       creates exactly the kind of hidden coupling this codebase's own
       provider docstrings repeatedly warn against — see e.g.
       overpass_provider.py's "No niche translation" section on not
       inventing cross-module coupling that wasn't asked for), and
    2. NOT type-abbreviation aware: it would leave "Jackson Ave" and
       "Jackson Avenue" as two different normalized strings ("jackson
       ave" vs "jackson avenue"), which this phase's own instructions
       require to resolve to the same street.

So this module defines its own, narrowly-scoped normalizer for street
names specifically. It is not a second "text normalization framework"
in the sense the phase instructions warn against — it does one new
thing (street type/case normalization) the existing normalizer does
not do, and does not duplicate anything the existing one already
solves (this module does not touch phone numbers, domains, or business
name fuzzy-matching at all).

What normalization DOES do
---------------------------
- Case-folds to lowercase.
- Collapses whitespace and strips punctuation runs to single spaces
  (periods in "Ave." / "St." are removed, not preserved as distinct).
- Canonicalizes a known, small set of street-TYPE abbreviations to
  their long form, but ONLY when they appear as the LAST token (the
  position a street type/suffix actually occupies in US/CA/UK/AU
  addressing convention) — see `_STREET_TYPE_ALIASES`. "Ave" mid-name
  (which basically never happens) is left alone rather than guessed at.
- Canonicalizes a known, small set of directional-prefix abbreviations
  (E/W/N/S/NE/NW/SE/SW) to their long form, but ONLY when they appear
  as the FIRST token AND at least one more token follows (so a street
  literally just named "S" is not mangled, and so this never touches
  the LAST-token street-type pass above).

What normalization explicitly does NOT do (per this phase's own
"do not aggressively collapse meaningful distinctions" instruction)
---------------------------------------------------------------------
- It never removes or folds together a directional prefix with its
  opposite: "E 14th St" normalizes to "east 14th street" and "W 14th
  St" normalizes to "west 14th street" — DIFFERENT strings, correctly
  distinct.
- It never strips numbered-street ordinals ("14th" stays "14th").
- It never fuzzy-matches, stems, or removes filler words ("the", "old",
  "new") — those are meaningful, not noise.
- It never guesses at "St" between two words as "Saint" vs "Street";
  the last-token-only rule means "St Marys Church Way" is untouched by
  the type-alias pass (its last token is "way", not "st"), which is
  the correct behavior — "St" there is "Saint", and this module does
  not attempt to disambiguate that case.
"""

from __future__ import annotations

import re
import unicodedata

# ---------------------------------------------------------------------------
# Alias tables — deliberately small and conservative. Extend only with
# unambiguous, well-known abbreviations; when in doubt, leave a token
# unexpanded rather than risk a false collapse (see module docstring).
# ---------------------------------------------------------------------------

_STREET_TYPE_ALIASES: dict[str, str] = {
    "ave": "avenue",
    "av": "avenue",
    "blvd": "boulevard",
    "dr": "drive",
    "rd": "road",
    "ln": "lane",
    "pl": "place",
    "ct": "court",
    "sq": "square",
    "hwy": "highway",
    "pkwy": "parkway",
    "ter": "terrace",
    "cir": "circle",
    "aly": "alley",
    "byp": "bypass",
    "st": "street",
    "expy": "expressway",
    "fwy": "freeway",
    "trl": "trail",
    "cres": "crescent",
}

_DIRECTIONAL_ALIASES: dict[str, str] = {
    "n": "north",
    "s": "south",
    "e": "east",
    "w": "west",
    "ne": "northeast",
    "nw": "northwest",
    "se": "southeast",
    "sw": "southwest",
}

_WHITESPACE_RE = re.compile(r"\s+")
_NON_ALNUM_RE = re.compile(r"[^a-z0-9]+")
_SLUG_NON_ALNUM_RE = re.compile(r"[^a-z0-9]+")


def normalize_street_name(raw_name: str) -> str:
    """
    Deterministically normalizes a raw street name for identity
    comparison. Same output for the same real street regardless of
    capitalization or common type-abbreviation spelling; see module
    docstring for exactly what is and is not folded together.

    Raises ValueError on empty/whitespace-only input — a street with no
    name has no identity this function can produce (callers should
    filter unnamed OSM ways out before reaching this function; see
    `overpass_source.py`).
    """
    if raw_name is None:
        raise ValueError("normalize_street_name requires a non-empty street name")
    cleaned = unicodedata.normalize("NFKC", raw_name).strip()
    if not cleaned:
        raise ValueError("normalize_street_name requires a non-empty street name")

    lowered = cleaned.lower()
    # Strip punctuation (periods, commas, etc.) down to plain word
    # tokens separated by single spaces. This intentionally treats
    # "Ave." and "Ave" identically (trailing punctuation carries no
    # meaning here) without touching letters/digits within a token.
    collapsed = _NON_ALNUM_RE.sub(" ", lowered)
    tokens = [t for t in _WHITESPACE_RE.split(collapsed) if t]
    if not tokens:
        raise ValueError("normalize_street_name requires a non-empty street name")

    # Directional prefix pass — FIRST token only, and only when another
    # token follows (see module docstring for why).
    if len(tokens) > 1 and tokens[0] in _DIRECTIONAL_ALIASES:
        tokens[0] = _DIRECTIONAL_ALIASES[tokens[0]]

    # Street-type suffix pass — LAST token only (see module docstring).
    if tokens[-1] in _STREET_TYPE_ALIASES:
        tokens[-1] = _STREET_TYPE_ALIASES[tokens[-1]]

    return " ".join(tokens)


def _slugify(value: str) -> str:
    """
    Lowercase, ASCII-ish, hyphen-separated slug for use inside
    `street_key`. Distinct from `normalize_street_name` above: this is
    pure key-formatting (no abbreviation expansion — it operates on
    already-normalized or already-canonical strings), used identically
    for the geographic-scope components (country_code/region/city) and
    the normalized street name.
    """
    cleaned = unicodedata.normalize("NFKD", value).encode("ascii", "ignore").decode("ascii")
    cleaned = cleaned.lower().strip()
    cleaned = _SLUG_NON_ALNUM_RE.sub("-", cleaned)
    return cleaned.strip("-")


#: Placeholder token for a geographic-scope component that is unknown /
#: not supplied (e.g. no region for a country that doesn't use one).
#: Explicit and stable — never the empty string — so `street_key`
#: always has the same number of ":"-separated segments and two
#: streets that both lack a region are still correctly distinguished
#: by country_code + city, never silently collapsed onto each other by
#: an empty segment.
_UNKNOWN_SCOPE_TOKEN = "unk"


def build_street_key(
    country_code: str,
    region: str | None,
    city: str,
    normalized_name: str,
) -> str:
    """
    Builds the durable, geographically-scoped canonical identity for a
    street. Format:

        {country_code}:{region}:{city}:{normalized_name}

    all four components slugified via `_slugify`. This is deliberately
    NOT just the street name (see this phase's own instructions: a bare
    "main-street" is explicitly called out as an invalid, collision-
    prone identity) — country/region/city scoping is baked into the key
    itself so two different real streets that happen to share a name
    (e.g. "Main St" in two different cities) never collide, without
    requiring every caller to remember to *also* filter by city when
    querying.

    Raises ValueError if `country_code`, `city`, or `normalized_name`
    slugify to an empty string — those three are required geographic/
    identity components (unlike `region`, which may legitimately be
    absent and is represented by `_UNKNOWN_SCOPE_TOKEN` instead).
    """
    country_slug = _slugify(country_code or "")
    city_slug = _slugify(city or "")
    name_slug = _slugify(normalized_name or "")
    region_slug = _slugify(region) if region else ""

    if not country_slug:
        raise ValueError("build_street_key requires a non-empty country_code")
    if not city_slug:
        raise ValueError("build_street_key requires a non-empty city")
    if not name_slug:
        raise ValueError("build_street_key requires a non-empty normalized_name")

    return ":".join(
        [
            country_slug,
            region_slug or _UNKNOWN_SCOPE_TOKEN,
            city_slug,
            name_slug,
        ]
    )
