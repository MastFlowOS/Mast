"""
providers/provider_request_translation.py
==========================================

MAST — Provider Parallelism v1: Provider Request Translation (Step 3).

Responsibility
--------------
Translate one generic `DiscoveryQueryContext` (the request-shaped
information service.py already has today: session_id, query, city,
country, niche, region, max_results, plus the existing cooperative
`should_stop` / `on_progress` hooks) into each *selected* provider's
own request dataclass — `GoogleMapsDiscoveryRequest`,
`YelpDiscoveryRequest`, `AppleMapsDiscoveryRequest`,
`FoursquareDiscoveryRequest`, `AzureMapsDiscoveryRequest`,
`OverpassDiscoveryRequest`, `CrunchbaseDiscoveryRequest`, or
`ApolloDiscoveryRequest` — unchanged, exactly as each provider already
defines it.

This module invents no shared request contract (see
composite_provider.py and parallel_composite_provider.py, both of
which already establish and rely on the same rule: "the wrapped
providers are independent, possibly-incompatible request shapes, and
this layer has no business inventing a shared shape or translating
between them"). It only maps the query/city/country/niche/region
fields service.py already collects onto whichever of those fields a
given provider's own request dataclass actually has, using each
field's own documented meaning — never renamed, never reinterpreted.

Honesty rule (per this milestone's own instructions: "If a generic
niche cannot honestly be translated into a provider-specific
category/tag, do not fabricate a mapping.")
----------------------------------------------------------------------
`translate_request()` returns `None` — not a best-guess request — for
any (provider_id, context) pair this module cannot honestly build a
request for:

    - Overpass requires structured OSM tags (`amenity=cafe`, etc.),
      not free text. This module only ever supplies tags that are
      either (a) given explicitly by the caller (`context.osm_tags`)
      or (b) present in `_OSM_TAG_HINTS`, a small, explicitly curated
      table of common niche keywords -> standard, documented OSM
      tagging-scheme tags (see
      https://wiki.openstreetmap.org/wiki/Map_features) — real
      OpenStreetMap tagging conventions, not fabricated business
      data, matched against the structured `niche` field only (never
      the free-text `query` — see `_resolve_osm_tags()`). A niche with
      no entry in that table, and no caller-supplied tags, yields
      `None` for Overpass rather than a made-up tag.
    - Crunchbase and Apollo (corporate/company search) require an
      organization-search term, which is a materially different kind
      of query than a local-business niche/keyword search. This
      module only translates for them when the caller explicitly
      supplies `context.organization_query` — it never repurposes a
      local-business `query`/`niche` string (e.g. "coffee shop") as
      an organization-name search, which would silently ask
      Crunchbase/Apollo a question the caller never actually asked.

A caller (providers/discovery_composition.py) is expected to drop any
provider `translate_request()` returns `None` for from the composed
request, logging why, rather than fail the whole discovery request
over one provider it cannot honestly query.

Status
------
Provider Parallelism v1 milestone. Pure translation logic; does not
modify any provider or its request dataclass.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable, Mapping, Optional

from providers.apollo_provider import ApolloDiscoveryRequest
from providers.apple_maps_provider import AppleMapsDiscoveryRequest
from providers.azure_maps_provider import AzureMapsDiscoveryRequest
from providers.crunchbase_provider import CrunchbaseDiscoveryRequest
from providers.foursquare_provider import FoursquareDiscoveryRequest
from providers.google_maps_provider import GoogleMapsDiscoveryRequest
from providers.overpass_provider import OverpassDiscoveryRequest
from providers.yelp_provider import YelpDiscoveryRequest


@dataclass(frozen=True, slots=True)
class DiscoveryQueryContext:
    """
    The generic, provider-agnostic shape of "what is this discovery
    request actually asking for" — exactly the fields service.py's
    `run_query()` already collects today (query/city/country/niche/
    region/max_results), plus the two existing cooperative hooks
    (`should_stop`, `on_progress`) `GoogleMapsDiscoveryRequest` already
    defines, threaded through so every translated provider request
    that supports them gets the same target/shutdown/progress
    behavior GoogleMapsProvider alone has today.

    `osm_tags` / `organization_query` are optional, caller-supplied
    escape hatches for the two translation cases this module will
    never guess at (see module docstring, "Honesty rule") — omitted
    by default, meaning "translate what can be honestly translated,
    skip what can't."
    """

    session_id: str
    query: str
    city: str
    country: str = ""
    niche: str = ""
    region: str = ""
    max_results: int = 60
    osm_tags: Optional[Mapping[str, str]] = None
    organization_query: Optional[str] = None
    should_stop: Optional[Callable[[], bool]] = None
    on_progress: Optional[Callable[[str, str, Optional[str]], None]] = None


# ---------------------------------------------------------------------------
# Overpass — small, explicitly curated niche-keyword -> OSM tag table.
# Real OpenStreetMap tagging-scheme tags (see
# https://wiki.openstreetmap.org/wiki/Map_features), not fabricated
# business data. Deliberately small: a niche not covered here simply
# does not get an Overpass request rather than an invented tag. Keys
# are matched as a case-insensitive substring of `niche` only (never
# `query` — see `_resolve_osm_tags()`) — e.g. "Coffee Shop" and
# "coffee_shop" both match "coffee".
# ---------------------------------------------------------------------------
_OSM_TAG_HINTS: tuple[tuple[str, Mapping[str, str]], ...] = (
    ("coffee", {"amenity": "cafe"}),
    ("cafe", {"amenity": "cafe"}),
    ("restaurant", {"amenity": "restaurant"}),
    ("bakery", {"shop": "bakery"}),
    ("bar", {"amenity": "bar"}),
    ("pub", {"amenity": "pub"}),
    ("dental", {"amenity": "dentist"}),
    ("dentist", {"amenity": "dentist"}),
    ("pharmacy", {"amenity": "pharmacy"}),
    ("plumb", {"shop": "trade", "trade": "plumber"}),
    ("hair", {"shop": "hairdresser"}),
    ("salon", {"shop": "hairdresser"}),
    ("gym", {"leisure": "fitness_centre"}),
    ("fitness", {"leisure": "fitness_centre"}),
    ("hardware", {"shop": "hardware"}),
    ("hotel", {"tourism": "hotel"}),
    ("grocery", {"shop": "supermarket"}),
    ("supermarket", {"shop": "supermarket"}),
    ("veterinary", {"amenity": "veterinary"}),
    ("vet", {"amenity": "veterinary"}),
)


def _resolve_osm_tags(context: DiscoveryQueryContext) -> Optional[Mapping[str, str]]:
    if context.osm_tags:
        return context.osm_tags
    # Matched against the structured `niche` field only — never the
    # free-text `query` — so an incidental keyword inside a query
    # string (e.g. "coffee" appearing in an otherwise unrelated
    # search) never silently pulls Overpass into a request whose
    # actual niche classification says nothing about a cafe. `niche`
    # is the caller's explicit classification; `query` is free text
    # meant for the providers that do free-text search, not for
    # keyword sniffing.
    haystack = context.niche.strip().lower()
    if not haystack:
        return None
    for keyword, tags in _OSM_TAG_HINTS:
        if keyword in haystack:
            return tags
    return None


def _translate_google_maps(context: DiscoveryQueryContext) -> GoogleMapsDiscoveryRequest:
    return GoogleMapsDiscoveryRequest(
        session_id=context.session_id,
        query=context.query,
        city=context.city,
        country=context.country or "US",
        niche=context.niche,
        region=context.region,
        max_results=context.max_results,
        should_stop=context.should_stop,
        on_progress=context.on_progress,
    )


def _translate_yelp(context: DiscoveryQueryContext) -> YelpDiscoveryRequest:
    location = ", ".join(part for part in (context.city, context.country) if part)
    return YelpDiscoveryRequest(
        session_id=context.session_id,
        term=context.query,
        location=location,
        limit=min(context.max_results, 50),  # Yelp Fusion's own documented page ceiling
    )


def _translate_apple_maps(context: DiscoveryQueryContext) -> AppleMapsDiscoveryRequest:
    query = " ".join(part for part in (context.query, context.city) if part)
    return AppleMapsDiscoveryRequest(
        session_id=context.session_id,
        query=query,
        limit_to_countries=(context.country,) if context.country else None,
    )


def _translate_foursquare(context: DiscoveryQueryContext) -> FoursquareDiscoveryRequest:
    near = ", ".join(part for part in (context.city, context.country) if part) or None
    return FoursquareDiscoveryRequest(
        session_id=context.session_id,
        query=context.query or None,
        near=near,
        limit=min(max(context.max_results, 1), 50),  # Place Search's own documented ceiling
    )


def _translate_azure_maps(context: DiscoveryQueryContext) -> AzureMapsDiscoveryRequest:
    query = " ".join(part for part in (context.query, context.city) if part)
    return AzureMapsDiscoveryRequest(
        session_id=context.session_id,
        query=query,
        limit=min(context.max_results, 100),  # Azure Maps Search POI's own documented page ceiling
        country_set=(context.country,) if context.country else None,
    )


def _translate_overpass(context: DiscoveryQueryContext) -> Optional[OverpassDiscoveryRequest]:
    tags = _resolve_osm_tags(context)
    if not tags:
        return None
    return OverpassDiscoveryRequest(
        session_id=context.session_id,
        tags=tags,
        area_name=context.city or context.country or None,
        limit=context.max_results,
        should_stop=context.should_stop,
    )


def _translate_crunchbase(context: DiscoveryQueryContext) -> Optional[CrunchbaseDiscoveryRequest]:
    if not context.organization_query:
        return None
    return CrunchbaseDiscoveryRequest(
        session_id=context.session_id,
        query=context.organization_query,
    )


def _translate_apollo(context: DiscoveryQueryContext) -> Optional[ApolloDiscoveryRequest]:
    if not context.organization_query:
        return None
    return ApolloDiscoveryRequest(
        session_id=context.session_id,
        q_organization_name=context.organization_query,
    )


_TRANSLATORS: Mapping[str, Callable[[DiscoveryQueryContext], Any]] = {
    "google_maps": _translate_google_maps,
    "yelp": _translate_yelp,
    "apple_maps": _translate_apple_maps,
    "foursquare": _translate_foursquare,
    "azure_maps": _translate_azure_maps,
    "overpass": _translate_overpass,
    "crunchbase": _translate_crunchbase,
    "apollo": _translate_apollo,
}


def translate_request(provider_id: str, context: DiscoveryQueryContext) -> Optional[Any]:
    """
    Build `provider_id`'s own request object from `context`, or return
    `None` if this provider cannot be honestly translated for this
    particular context (see module docstring, "Honesty rule").

    Raises KeyError if `provider_id` is not one of the eight providers
    this module knows how to translate for — a caller-configuration
    error (an unrecognized/unsupported provider_id was selected), not
    a translation failure.
    """
    if provider_id not in _TRANSLATORS:
        raise KeyError(
            f"No request translation known for provider_id {provider_id!r}. "
            f"Known providers: {tuple(_TRANSLATORS)!r}"
        )
    return _TRANSLATORS[provider_id](context)
