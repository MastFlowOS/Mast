"""
business/models.py
==================

Immutable domain models for Canonical Businesses in the MAST Lead Engine.

Design Rules
------------
- Frozen, slotted dataclass — runtime mutation is impossible.
- Collections are stored as immutable `tuple`.
- Single Source of Truth: Contact collections (`phones`, `emails`, `websites`) and
  social URLs (`instagram_url`, `facebook_url`, `linkedin_url`) are stored as the
  sole internal state. Singular getters (`phone`, `email`, `website`) and aggregate
  getters (`social_urls`) are exposed as read-only `@property` accessors.
- Provenance Naming: Uses `originating_provider_id` to express initial discovery lineage
  without implying permanent single-provider entity ownership.
- Strict isolation: Consumes standard library types and optional immutable models from
  `provider_execution`, `discovery_sessions`, or `discovery` packages.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import datetime

_ID_PATTERN: re.Pattern[str] = re.compile(r"^[a-zA-Z0-9_-]+$")


def _validate_non_empty_str(value: str, label: str) -> None:
    """
    Raise ValueError if value is not a non-empty string.
    """
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{label} must be a non-empty string; got {value!r}")


@dataclass(frozen=True, slots=True)
class Business:
    """
    Immutable domain model representing a single canonical business discovered
    by a provider execution.

    Fields
    ------
    business_id
        Unique normalized canonical business identifier (e.g. 'biz_dentist_berlin_01').
    execution_id
        Owning Provider Execution identifier (e.g. 'exec_google_maps_01').
    session_id
        Owning Discovery Session identifier (e.g. 'session_a1b2c3d4').
    originating_provider_id
        Target provider that originally discovered this business (e.g. 'google_maps').
    name
        Canonical name of the business.
    discovered_at
        Timestamp when the business was discovered.
    originating_provider_business_id
        Optional original business identifier assigned by the discovering provider.
    category
        Optional category or industry taxonomy string.
    address
        Optional street address line.
    city
        Optional city/municipality name.
    region
        Optional state/province/region name.
    country
        Optional country name or ISO code.
    postal_code
        Optional postal/zip code.
    latitude
        Optional WGS84 latitude coordinate.
    longitude
        Optional WGS84 longitude coordinate.
    description
        Optional business description or summary.
    instagram_url
        Optional Instagram profile URL.
    facebook_url
        Optional Facebook page/profile URL.
    linkedin_url
        Optional LinkedIn organization profile URL.
    phones
        Immutable tuple of discovered phone number strings (default: ()).
    emails
        Immutable tuple of discovered email address strings (default: ()).
    websites
        Immutable tuple of discovered website URL strings (default: ()).
    """

    business_id: str
    execution_id: str
    session_id: str
    originating_provider_id: str
    name: str
    discovered_at: datetime
    originating_provider_business_id: str | None = None
    category: str | None = None
    address: str | None = None
    city: str | None = None
    region: str | None = None
    country: str | None = None
    postal_code: str | None = None
    latitude: float | None = None
    longitude: float | None = None
    description: str | None = None
    instagram_url: str | None = None
    facebook_url: str | None = None
    linkedin_url: str | None = None
    phones: tuple[str, ...] = ()
    emails: tuple[str, ...] = ()
    websites: tuple[str, ...] = ()

    def __post_init__(self) -> None:
        _validate_non_empty_str(self.business_id, "business_id")
        _validate_non_empty_str(self.execution_id, "execution_id")
        _validate_non_empty_str(self.session_id, "session_id")
        _validate_non_empty_str(self.originating_provider_id, "originating_provider_id")
        _validate_non_empty_str(self.name, "name")

        if not isinstance(self.discovered_at, datetime):
            raise TypeError(f"discovered_at must be a datetime instance; got {type(self.discovered_at)!r}")

        # Validate optional string fields if present
        opt_str_fields = [
            ("originating_provider_business_id", self.originating_provider_business_id),
            ("category", self.category),
            ("address", self.address),
            ("city", self.city),
            ("region", self.region),
            ("country", self.country),
            ("postal_code", self.postal_code),
            ("description", self.description),
            ("instagram_url", self.instagram_url),
            ("facebook_url", self.facebook_url),
            ("linkedin_url", self.linkedin_url),
        ]
        for label, val in opt_str_fields:
            if val is not None and not isinstance(val, str):
                raise TypeError(f"{label} must be a string or None; got {type(val)!r}")

        # Validate numeric coordinates if present
        if self.latitude is not None:
            if not isinstance(self.latitude, (int, float)) or isinstance(self.latitude, bool):
                raise TypeError(f"latitude must be a float/int or None; got {type(self.latitude)!r}")
            if not (-90.0 <= float(self.latitude) <= 90.0):
                raise ValueError(f"latitude must be between -90.0 and 90.0; got {self.latitude!r}")

        if self.longitude is not None:
            if not isinstance(self.longitude, (int, float)) or isinstance(self.longitude, bool):
                raise TypeError(f"longitude must be a float/int or None; got {type(self.longitude)!r}")
            if not (-180.0 <= float(self.longitude) <= 180.0):
                raise ValueError(f"longitude must be between -180.0 and 180.0; got {self.longitude!r}")

        # Coerce and validate collection fields
        for col_name, col_val in [
            ("phones", self.phones),
            ("emails", self.emails),
            ("websites", self.websites),
        ]:
            if not isinstance(col_val, tuple):
                col_tuple = tuple(col_val)
            else:
                col_tuple = col_val

            for item in col_tuple:
                _validate_non_empty_str(item, f"item in {col_name}")

            object.__setattr__(self, col_name, col_tuple)

    # ---------------------------------------------------------------------------
    # Read-Only Computed Accessors (Single Source of Truth)
    # ---------------------------------------------------------------------------

    @property
    def phone(self) -> str | None:
        """Return the primary phone number (first element of phones), or None."""
        return self.phones[0] if self.phones else None

    @property
    def email(self) -> str | None:
        """Return the primary email address (first element of emails), or None."""
        return self.emails[0] if self.emails else None

    @property
    def website(self) -> str | None:
        """Return the primary website URL (first element of websites), or None."""
        return self.websites[0] if self.websites else None

    @property
    def social_urls(self) -> tuple[str, ...]:
        """Return immutable tuple of present social profile URLs."""
        urls = [url for url in (self.instagram_url, self.facebook_url, self.linkedin_url) if url is not None]
        return tuple(urls)
