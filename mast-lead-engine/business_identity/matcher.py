"""
business_identity/matcher.py
============================

Stateless Business Identity Matcher for the MAST Lead Engine.

Design Rules
------------
- Pure evaluation service — answers "Do these match?".
- Stateless: No instance attributes or mutable state.
- Deterministic hooks only: No fuzzy AI, embeddings, LLM, enrichment, or scoring.
- Does NOT create domain objects or act as a factory.
"""

from __future__ import annotations

import math
import re
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from business.models import Business


def _normalize_str(val: str | None) -> str:
    """Lowercase, replace '&' with 'and', strip leading/trailing whitespace, and collapse multiple spaces."""
    if not val:
        return ""
    cleaned = val.replace("&", "and")
    return re.sub(r"\s+", " ", cleaned.strip().lower())


def _normalize_phone(phone: str) -> str:
    """Extract last 10 digits from a phone string for deterministic national comparison."""
    digits = re.sub(r"\D", "", phone)
    if len(digits) >= 10:
        return digits[-10:]
    return digits


def _normalize_website(url: str) -> str:
    """Normalize website URL by stripping protocol, 'www.', and trailing slashes."""
    cleaned = re.sub(r"^https?://", "", url.strip().lower())
    cleaned = re.sub(r"^www\.", "", cleaned)
    return cleaned.rstrip("/")


def _haversine_distance_meters(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Calculate the Great Circle (Haversine) distance in meters between two lat/lon pairs."""
    r_earth = 6371000.0  # Earth radius in meters
    phi1 = math.radians(lat1)
    phi2 = math.radians(lat2)
    delta_phi = math.radians(lat2 - lat1)
    delta_lambda = math.radians(lon2 - lon1)

    a = math.sin(delta_phi / 2.0) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(delta_lambda / 2.0) ** 2
    c = 2.0 * math.atan2(math.sqrt(a), math.sqrt(1.0 - a))
    return r_earth * c


class BusinessIdentityMatcher:
    """
    Stateless evaluator for determining identity relationships (equivalence)
    between canonical Business objects.
    """

    __slots__ = ()

    @staticmethod
    def match_by_provider_ids(b1: Business, b2: Business) -> bool:
        """
        Return True if both Business objects share the same originating provider ID
        and non-empty provider-specific business ID.
        """
        p1_id = b1.originating_provider_id
        p2_id = b2.originating_provider_id
        p1_biz_id = b1.originating_provider_business_id
        p2_biz_id = b2.originating_provider_business_id

        if not p1_id or not p2_id or p1_id != p2_id:
            return False
        if not p1_biz_id or not p2_biz_id:
            return False
        return p1_biz_id.strip() == p2_biz_id.strip()

    @staticmethod
    def match_by_name(b1: Business, b2: Business) -> bool:
        """Return True if normalized business names match exactly."""
        n1 = _normalize_str(b1.name)
        n2 = _normalize_str(b2.name)
        return len(n1) > 0 and n1 == n2

    @staticmethod
    def match_by_phone(b1: Business, b2: Business) -> bool:
        """Return True if any normalized phone number matches between b1 and b2."""
        p1_set = {_normalize_phone(p) for p in b1.phones if _normalize_phone(p)}
        p2_set = {_normalize_phone(p) for p in b2.phones if _normalize_phone(p)}
        if not p1_set or not p2_set:
            return False
        return bool(p1_set & p2_set)

    @staticmethod
    def match_by_website(b1: Business, b2: Business) -> bool:
        """Return True if any normalized website domain/path matches between b1 and b2."""
        w1_set = {_normalize_website(w) for w in b1.websites if _normalize_website(w)}
        w2_set = {_normalize_website(w) for w in b2.websites if _normalize_website(w)}
        if not w1_set or not w2_set:
            return False
        return bool(w1_set & w2_set)

    @staticmethod
    def match_by_location(b1: Business, b2: Business, max_distance_meters: float = 50.0) -> bool:
        """
        Return True if WGS84 coordinates are within max_distance_meters,
        or if address, city, and country match normalized strings.
        """
        if (
            b1.latitude is not None
            and b1.longitude is not None
            and b2.latitude is not None
            and b2.longitude is not None
        ):
            dist = _haversine_distance_meters(b1.latitude, b1.longitude, b2.latitude, b2.longitude)
            if dist <= max_distance_meters:
                return True

        # Normalized address fallback match
        addr1 = _normalize_str(b1.address)
        addr2 = _normalize_str(b2.address)
        city1 = _normalize_str(b1.city)
        city2 = _normalize_str(b2.city)

        if addr1 and addr2 and city1 and city2 and addr1 == addr2 and city1 == city2:
            return True

        return False

    @classmethod
    def evaluate_match(cls, b1: Business, b2: Business) -> tuple[bool, str]:
        """
        Evaluate all deterministic match hooks in order.
        Returns (True, rule_name) if matched, or (False, "no_match").
        """
        if cls.match_by_provider_ids(b1, b2):
            return True, "match_by_provider_ids"
        if cls.match_by_name(b1, b2):
            return True, "match_by_name"
        if cls.match_by_phone(b1, b2):
            return True, "match_by_phone"
        if cls.match_by_website(b1, b2):
            return True, "match_by_website"
        if cls.match_by_location(b1, b2):
            return True, "match_by_location"
        return False, "no_match"
