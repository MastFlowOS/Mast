"""
street_inventory/classifier.py
==============================

Pure functions for street inventory classification, low-value/route filtering,
feature-variant collapsing, and address-vs-street spatial containment verification.
"""

from __future__ import annotations

import re
import unicodedata
from typing import NamedTuple, Optional

from street_inventory.normalization import normalize_street_name, _STREET_TYPE_ALIASES, _DIRECTIONAL_ALIASES

_FEATURE_TOKENS = [
    "pedestrian bridge",
    "pedestrian walkway",
    "access path",
    "access road",
    "access ramp",
    "access",
    "bikeway",
    "bike path",
    "cycleway",
    "footpath",
    "footway",
    "pathway",
    "walkway",
    "steps",
    "bridleway",
    "busway",
    "trail",
    "on ramp",
    "off ramp",
    "ramp",
    "dropoff lane",
    "drop-off lane",
    "bus dropoff",
    "bus drop-off",
    "bus lane",
    "service road",
    "taxiway",
    "runway",
    "concourse",
    "parking",
    "turnpike",
    "interchange",
    "cargo",
    "terminal",
    "hangar",
    "freeway",
    "expressway",
    "tollway",
    "alley",
    "railway",
    "tracks",
    "substation",
    "depot",
    "distribution center",
    "heliport",
]

_ROUTE_SUFFIXES = [
    "eb",
    "wb",
    "nb",
    "sb",
    "eastbound",
    "westbound",
    "northbound",
    "southbound",
]

_SUITE_PATTERNS = [
    re.compile(r"#\s*[\w-]+", re.IGNORECASE),
    re.compile(r"\b(?:suite|ste|apt|unit|floor|fl|bldg|building|room|rm)\s*[\w#-]+", re.IGNORECASE),
]

_LEADING_NUMBER_RE = re.compile(r"^\s*\d+(?:-\d+)?(?:[a-zA-Z])?\s+")


class StreetClassification(NamedTuple):
    raw_name: str
    collapsed_name: str
    is_low_value: bool
    rejection_reason: Optional[str]


def is_low_value_street(name: str) -> tuple[bool, Optional[str]]:
    """Determine if a street name is a route ref, bare number, ramp, or non-commercial path."""
    if not name or not name.strip():
        return True, "empty"
    cleaned = unicodedata.normalize("NFKC", name).strip()
    lowered = cleaned.lower()

    # Digits only or digits with commas/spaces/refs (e.g. "315", "379", "315, 379")
    if re.match(r"^[\d\s,/-]+$", lowered):
        return True, "number_only"

    # Alphanumeric gate / concourse / runway codes like 'A', 'A1', 'A10', 'B2' (length <= 4, letter + digits)
    if re.match(r"^[a-z]\d{0,3}$", lowered):
        return True, "gate_or_concourse_code"

    # Route refs like "35 EB", "I-90 WB", "US-41 NB", "315, 379"
    for sfx in _ROUTE_SUFFIXES:
        if re.search(rf"\b\d+\s*{sfx}\b", lowered):
            return True, "route_ref"
        if re.search(rf"\b(?:i|us|state route|route|rt|sr|hwy|highway)[\s-]*\d+\s*{sfx}\b", lowered):
            return True, "route_ref"

    # Feature tokens: Access Path, Bikeway, Pedestrian Bridge, Ramp, Cycleway, etc.
    for token in _FEATURE_TOKENS:
        if re.search(rf"\b{re.escape(token)}\b", lowered):
            return True, f"feature_{token.replace(' ', '_')}"

    return False, None


def collapse_street_name(name: str) -> str:
    """Collapse EB/WB, directional ramps, and feature variants of one road into its base street name.

    Examples:
        '35 EB' -> '35th street'
        '35 WB' -> '35th street'
        '35th St Pedestrian Bridge' -> '35th street'
        '35th Street Access Path' -> '35th street'
    """
    if not name or not name.strip():
        return ""
    cleaned = unicodedata.normalize("NFKC", name).strip()
    lowered = cleaned.lower()

    # Remove feature tokens
    for token in _FEATURE_TOKENS:
        lowered = re.sub(rf"\b{re.escape(token)}\b", "", lowered)

    # Remove directional route tokens (EB, WB, NB, SB, etc.)
    for sfx in _ROUTE_SUFFIXES:
        lowered = re.sub(rf"\b{sfx}\b", "", lowered)

    # Clean whitespace and punctuation
    lowered = re.sub(r"[^a-z0-9]+", " ", lowered).strip()
    tokens = lowered.split()
    if not tokens:
        return ""

    # Convert numeric tokens to ordinals if applicable (e.g. '35' -> '35th')
    new_tokens = []
    for t in tokens:
        if t.isdigit():
            val = int(t)
            if 1 <= val <= 250:
                # Add ordinal suffix
                if 11 <= (val % 100) <= 13:
                    ord_suffix = "th"
                else:
                    ord_suffix = {1: "st", 2: "nd", 3: "rd"}.get(val % 10, "th")
                new_tokens.append(f"{val}{ord_suffix}")
            else:
                new_tokens.append(t)
        else:
            new_tokens.append(t)
    tokens = new_tokens

    # Normalize directional prefix if present
    if tokens and tokens[0] in _DIRECTIONAL_ALIASES:
        tokens[0] = _DIRECTIONAL_ALIASES[tokens[0]]

    # Normalize street-type suffix if present
    if tokens and tokens[-1] in _STREET_TYPE_ALIASES:
        tokens[-1] = _STREET_TYPE_ALIASES[tokens[-1]]
    elif tokens and tokens[0].endswith(("st", "nd", "rd", "th")) and len(tokens) == 1:
        tokens.append("street")

    res = " ".join(tokens).strip()
    return res or name.strip()


def extract_street_portion_from_address(address: str) -> str:
    """Extract and normalize the street name portion from a full address string."""
    if not address or not address.strip():
        return ""
    # Take line before first comma (standard street line)
    street_line = address.split(",", 1)[0].strip()

    # Strip suite, unit, apartment, etc.
    for pat in _SUITE_PATTERNS:
        street_line = pat.sub("", street_line).strip()

    # Strip leading building number (e.g. "311 S Wacker Dr" -> "S Wacker Dr")
    street_line = _LEADING_NUMBER_RE.sub("", street_line).strip()

    try:
        return normalize_street_name(street_line)
    except ValueError:
        return street_line.lower()


def is_address_on_street(address: str, street: str) -> bool:
    """Verify whether a candidate business address is genuinely on the targeted street.

    Guards against Google Maps returning:
    - Suite/unit number false matches (e.g. '311 S Wacker Dr #110' for '110th Street')
    - Building number false matches (e.g. '108 N State St' for '108th Street')
    - Business name keyword collisions (e.g. 'Pedestrian Coffee' at '939 W Belmont Ave' for '41st Street Pedestrian Bridge')
    """
    if not address or not street:
        return False

    addr_street_norm = extract_street_portion_from_address(address)
    target_norm = collapse_street_name(street)

    if not addr_street_norm or not target_norm:
        return False

    # Exact normalized match
    if addr_street_norm == target_norm:
        return True

    # Check word boundaries / containment
    # e.g. target_norm is '35th street' and addr_street_norm is 'west 35th street'
    target_tokens = target_norm.split()
    addr_tokens = addr_street_norm.split()

    # Core name token (e.g. '35th' or 'state' or 'wacker')
    core_target = target_tokens[0] if target_tokens else ""
    if core_target and core_target not in addr_tokens:
        return False

    # If target has a street type (e.g. 'street'), address should match type or be compatible
    if len(target_tokens) >= 2 and target_tokens[-1] in ("street", "avenue", "boulevard", "road", "drive", "way", "lane"):
        target_type = target_tokens[-1]
        if target_type in addr_tokens:
            return True
        # If address has a different street type entirely (e.g. 'drive' vs 'street'), reject
        types_in_addr = [t for t in addr_tokens if t in ("street", "avenue", "boulevard", "road", "drive", "way", "lane")]
        if types_in_addr and target_type not in types_in_addr:
            return False

    return core_target in addr_tokens
