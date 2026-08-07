"""
discovery/models.py
===================

Immutable, slotted domain models for Discovery Intelligence.

Design Rules
------------
- Frozen, slotted dataclasses — no runtime mutation is possible.
- Collection fields are always stored as ``tuple``, never ``list``.
  ``__post_init__`` converts any mutable sequence passed by the caller
  into an immutable ``tuple`` before instance is sealed.
- No execution logic, no AI, no scoring, no provider calls.
- Strict isolation: no imports from engine/, providers/ (except ProviderMetadata/ProviderCapabilities),
  storage/, database/, crm/, opportunities/, missions/, ai/, or intelligence/.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any


# ---------------------------------------------------------------------------
# Identifier validation helper
# ---------------------------------------------------------------------------

_ID_PATTERN: re.Pattern[str] = re.compile(r"^[a-z0-9]+(?:_[a-z0-9]+)*$")


def _validate_id(value: str, label: str) -> None:
    """
    Raise ``ValueError`` if *value* is not a valid normalized identifier.
    """
    if not isinstance(value, str) or not value:
        raise ValueError(f"{label} must be a non-empty string; got {value!r}")
    if not _ID_PATTERN.match(value):
        raise ValueError(
            f"{label} {value!r} is not a valid normalized identifier. "
            "Only lowercase alphanumeric characters and single underscores "
            "are allowed."
        )


# ---------------------------------------------------------------------------
# DiscoveryIntent
# ---------------------------------------------------------------------------

@dataclass(frozen=True, slots=True)
class DiscoveryIntent:
    """
    Immutable domain model representing a generic user discovery request.

    Fields
    ------
    niche_id
        Normalized niche identifier (e.g. 'web_design').
    region
        Optional geographic region/state (e.g. 'Greater London').
    city
        Target city (e.g. 'London').
    country
        Target country code or name (e.g. 'UK' or 'GB').
    radius_km
        Search radius in kilometers (optional).
    keywords
        Additional raw search keywords provided by the caller.
    requested_providers
        Optional tuple of target provider IDs. If None or empty, default
        compilation targets all available providers.
    max_results
        Maximum results requested per provider / query (default 100).
    """

    niche_id: str
    region: str = ""
    city: str = ""
    country: str = ""
    radius_km: float | None = None
    keywords: tuple[str, ...] = ()
    requested_providers: tuple[str, ...] | None = None
    max_results: int = 100

    def __post_init__(self) -> None:
        _validate_id(self.niche_id, "niche_id")

        if self.max_results <= 0:
            raise ValueError(f"max_results must be positive; got {self.max_results}")

        if self.radius_km is not None and self.radius_km < 0:
            raise ValueError(f"radius_km cannot be negative; got {self.radius_km}")

        # Coerce sequences to tuples
        if not isinstance(self.keywords, tuple):
            object.__setattr__(self, "keywords", tuple(self.keywords))

        if self.requested_providers is not None:
            if not isinstance(self.requested_providers, tuple):
                coerced = tuple(self.requested_providers)
                object.__setattr__(self, "requested_providers", coerced)
            for pid in self.requested_providers:
                _validate_id(pid, "requested_provider_id")


# ---------------------------------------------------------------------------
# ProviderDiscoveryRequest
# ---------------------------------------------------------------------------

@dataclass(frozen=True, slots=True)
class ProviderDiscoveryRequest:
    """
    Immutable domain model representing a compiled, provider-native
    discovery request specification.

    This carries the exact parameters that a provider native driver would
    receive, but contains zero execution or network logic.
    """

    provider_id: str
    niche_id: str
    query: str = ""
    city: str = ""
    region: str = ""
    country: str = ""
    radius_km: float | None = None
    max_results: int = 100
    search_phrases: tuple[str, ...] = ()
    categories: tuple[str, ...] = ()
    osm_tags: tuple[tuple[str, str], ...] = ()
    poi_categories: tuple[str, ...] = ()
    industry_filters: tuple[str, ...] = ()
    organization_filters: tuple[str, ...] = ()
    custom_params: tuple[tuple[str, str], ...] = ()
    payload: tuple[tuple[str, Any], ...] = ()

    def __post_init__(self) -> None:
        _validate_id(self.provider_id, "provider_id")
        _validate_id(self.niche_id, "niche_id")

        if not isinstance(self.search_phrases, tuple):
            object.__setattr__(self, "search_phrases", tuple(self.search_phrases))
        if not isinstance(self.categories, tuple):
            object.__setattr__(self, "categories", tuple(self.categories))
        if not isinstance(self.osm_tags, tuple):
            object.__setattr__(
                self,
                "osm_tags",
                tuple(
                    pair if isinstance(pair, tuple) else tuple(pair)
                    for pair in self.osm_tags
                ),
            )
        if not isinstance(self.poi_categories, tuple):
            object.__setattr__(self, "poi_categories", tuple(self.poi_categories))
        if not isinstance(self.industry_filters, tuple):
            object.__setattr__(self, "industry_filters", tuple(self.industry_filters))
        if not isinstance(self.organization_filters, tuple):
            object.__setattr__(
                self, "organization_filters", tuple(self.organization_filters)
            )
        if not isinstance(self.custom_params, tuple):
            object.__setattr__(
                self,
                "custom_params",
                tuple(
                    pair if isinstance(pair, tuple) else tuple(pair)
                    for pair in self.custom_params
                ),
            )
        if not isinstance(self.payload, tuple):
            object.__setattr__(
                self,
                "payload",
                tuple(
                    pair if isinstance(pair, tuple) else tuple(pair)
                    for pair in self.payload
                ),
            )

    def to_dict(self) -> dict[str, Any]:
        """
        Return a dictionary representation of the compiled native payload.
        """
        if self.payload:
            return dict(self.payload)
        
        # Default payload structure if payload wasn't pre-populated
        d: dict[str, Any] = {
            "provider_id": self.provider_id,
            "niche_id": self.niche_id,
            "query": self.query,
            "city": self.city,
            "region": self.region,
            "country": self.country,
            "radius_km": self.radius_km,
            "max_results": self.max_results,
        }
        if self.search_phrases:
            d["search_phrases"] = list(self.search_phrases)
        if self.categories:
            d["categories"] = list(self.categories)
        if self.osm_tags:
            d["osm_tags"] = dict(self.osm_tags)
        if self.poi_categories:
            d["poi_categories"] = list(self.poi_categories)
        if self.industry_filters:
            d["industry_filters"] = list(self.industry_filters)
        if self.organization_filters:
            d["organization_filters"] = list(self.organization_filters)
        if self.custom_params:
            d["custom_params"] = dict(self.custom_params)
        return d


# ---------------------------------------------------------------------------
# CompiledDiscovery
# ---------------------------------------------------------------------------

@dataclass(frozen=True, slots=True)
class CompiledDiscovery:
    """
    Immutable domain model representing the final provider-specific compilation
    for a given DiscoveryIntent.

    Does NOT execute anything.
    """

    intent: DiscoveryIntent
    requests: tuple[ProviderDiscoveryRequest, ...]

    def __post_init__(self) -> None:
        if not isinstance(self.intent, DiscoveryIntent):
            raise TypeError(f"intent must be a DiscoveryIntent; got {type(self.intent)!r}")

        if not isinstance(self.requests, tuple):
            object.__setattr__(self, "requests", tuple(self.requests))

        for req in self.requests:
            if not isinstance(req, ProviderDiscoveryRequest):
                raise TypeError(
                    f"elements of requests must be ProviderDiscoveryRequest; got {type(req)!r}"
                )

    @property
    def provider_ids(self) -> tuple[str, ...]:
        """Return tuple of all compiled provider IDs in compilation order."""
        return tuple(req.provider_id for req in self.requests)

    def get_request(self, provider_id: str) -> ProviderDiscoveryRequest:
        """
        Return the compiled ``ProviderDiscoveryRequest`` for *provider_id*.

        Raises
        ------
        KeyError
            If no request was compiled for *provider_id*.
        """
        for req in self.requests:
            if req.provider_id == provider_id:
                return req
        raise KeyError(
            f"No request compiled for provider {provider_id!r}. "
            f"Available providers: {self.provider_ids}"
        )
