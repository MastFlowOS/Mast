"""
MAST Engine V2 — ProviderCapabilities
========================================

Source: this milestone's own instructions ("implement Provider
Capabilities"), engine/interfaces.py:DiscoveryProviderInterface (read
for precedent, not modified — its own docstring already distinguishes
"identity" from "descriptive metadata... capabilities such as
supported countries/languages/rate limits" and defers both), and the
two existing concrete providers this describes,
providers/google_maps_provider.py:GoogleMapsProvider and
providers/yelp_provider.py:YelpProvider — read for what each one's own
request shape and implementation genuinely support, not modified by
this file.

Responsibility
--------------
ProviderCapabilities has exactly one job: describe what a provider's
discover() can actually be asked to do — which search dimensions its
own request shape exposes, and whether its own discover()
implementation streams / paginates. It is pure data, exactly like
ProviderMetadata (provider_metadata.py) and ProviderConfiguration
(provider_configuration.py) are pure data. It describes; it does not
do, and it does not gate — nothing in this codebase reads a
ProviderCapabilities value to decide whether to allow or block a call;
it is descriptive only, for a caller (a config UI, a future CLI, a
caller assembling a request) deciding *what request to build*.

Capabilities vs. Metadata — why these are two different classes, not
one bigger one
----------------------------------------------------------------------
ProviderMetadata (provider_metadata.py) describes the provider itself:
who it is, what it's called, whether it needs a credential, where its
data comes from. None of that is about what a *request* to it can
contain.

ProviderCapabilities describes the provider's *functionality*: what a
caller can ask it to search by, and how its own discover() behaves
operationally (streaming, pagination). This is a genuinely different
axis — GoogleMapsProvider and YelpProvider already have identical
`requires_api_key=False/True`-style metadata differences AND
completely different sets of search dimensions their own request
dataclasses expose (GoogleMapsDiscoveryRequest: query/city/country/
niche/region/max_results; YelpDiscoveryRequest: term/location/
categories/limit, offset-paginated internally). Folding both axes into
one class would conflate "what this provider is" with "what this
provider's discover() can be asked to do" — two questions a caller may
need answered independently (e.g. "which registered providers support
country filtering," a capabilities question, vs. "which registered
providers need an API key," a metadata question). Keeping them as two
narrow, single-purpose dataclasses, both readable without construction
via the same classmethod pattern, keeps each one answerable from a
single, clear source: this provider's own request shape and
discover() implementation, nothing else.

Field selection — every field below is read directly off an existing
provider's own request dataclass or discover() implementation; none is
invented
----------------------------------------------------------------------
    supports_keyword_search   — the request shape accepts a free-text
                                 search term. GoogleMapsDiscoveryRequest.query;
                                 YelpDiscoveryRequest.term. True for both.

    supports_category_search  — the request shape accepts a
                                 category/niche filter passed to the
                                 underlying source as such.
                                 GoogleMapsDiscoveryRequest.niche (passed
                                 to MapsScraper.search(niche=...));
                                 YelpDiscoveryRequest.categories (passed
                                 to the Fusion API's own `categories`
                                 query parameter). True for both.

    supports_city_filter      — the request shape accepts a
                                 city/locality value used to scope the
                                 search. GoogleMapsDiscoveryRequest.city
                                 (passed to MapsScraper.search(city=...));
                                 YelpDiscoveryRequest.location (passed
                                 to the Fusion API's own `location`
                                 query parameter — Yelp's documented
                                 way of scoping a search to a
                                 city/neighborhood/address string).
                                 True for both.

    supports_country_filter   — the request shape accepts a distinct
                                 country value used to scope the
                                 search. GoogleMapsDiscoveryRequest.country
                                 (passed to MapsScraper.search(country=...))
                                 — True. YelpDiscoveryRequest has no
                                 country field at all (only `location`,
                                 a single free-text string) — False.

    supports_radius_search    — the request shape accepts an explicit
                                 search-radius value. Neither
                                 GoogleMapsDiscoveryRequest nor
                                 YelpDiscoveryRequest defines one today
                                 (Yelp's Fusion API itself supports a
                                 `radius` query parameter, but
                                 YelpDiscoveryRequest does not expose
                                 it and YelpProvider never sends it —
                                 this class describes what this
                                 provider's own request shape actually
                                 lets a caller do today, not what the
                                 underlying API could theoretically
                                 support if the request shape grew a
                                 field. See "Not invented" below).
                                 False for both.

    supports_coordinate_search — the request shape accepts an input
                                 latitude/longitude to search from.
                                 Neither request dataclass has one
                                 (both accept only textual
                                 city/location values). Note this is
                                 the *input* side — both providers'
                                 output BusinessCandidate.coordinates
                                 can be populated (Yelp always; Google
                                 Maps never, per that provider's own
                                 field-mapping docstring), but "this
                                 provider can hand back coordinates" is
                                 not the same claim as "this provider
                                 can search *by* coordinates," and only
                                 the latter is what this field
                                 describes. False for both.

    supports_pagination        — discover() itself pages through the
                                 underlying source across more than one
                                 request as it streams, rather than
                                 the source returning everything in one
                                 call. YelpProvider's own docstring
                                 ("Pagination" section) documents
                                 exactly this: paging through Fusion
                                 API's `offset` until `request.limit`
                                 is reached or the source is exhausted
                                 — True. GoogleMapsProvider drives a
                                 single `MapsScraper.search(...)` call
                                 per discover() (the scraper streams
                                 results from that one call, but
                                 GoogleMapsProvider itself never issues
                                 a second, offset-advanced call the way
                                 YelpProvider does) — False.

    supports_streaming         — discover() yields BusinessCandidate
                                 objects incrementally rather than
                                 materializing the full result set
                                 before returning anything. Both
                                 providers satisfy
                                 DiscoveryProviderInterface's own
                                 streaming requirement by construction
                                 (see engine/interfaces.py — "Returns
                                 an iterator, not a materialized
                                 list"), and both this milestone's own
                                 module docstrings confirm it
                                 explicitly for their own
                                 implementation. True for both — this
                                 field exists so a future third
                                 provider that somehow violated the
                                 interface's own streaming intent (by
                                 materializing internally before
                                 yielding) has a place to honestly say
                                 so, not because the two existing
                                 providers differ on it.

Not invented — deliberately excluded
----------------------------------------------------------------------
Per this milestone's explicit "do not invent speculative capabilities"
instruction: supported languages, rate limits, max result size ceilings,
result freshness/caching behavior, and anything else neither provider's
own request shape or implementation can honestly answer today are all
left out. `supports_radius_search` above is the concrete illustration
of the same discipline applied to a field that IS in this milestone's
own example list: Yelp's underlying API could support it, but this
provider's own code does not expose it, so it is marked False rather
than True-because-the-vendor-supports-it — capabilities describe this
codebase's providers, not the third-party APIs behind them.

Relationship to DiscoveryProviderInterface
----------------------------------------------------------------------
Exactly the same relationship ProviderMetadata already has: this class
is never referenced by DiscoveryProviderInterface's abstract contract,
never appears in any discover() signature, and is not required for a
provider to be constructed or run. It is read the same way metadata is
— via a classmethod on the concrete provider class, independent of
construction (see google_maps_provider.py / yelp_provider.py for the
`capabilities()` classmethod each one adds, and registry.py for how
ProviderRegistry stores and serves it without ever calling a
provider's factory).

Immutability
-------------
Frozen and slotted, matching ProviderMetadata and ProviderConfiguration
— a provider's own declaration of what it supports should not be
mutable by a caller holding a reference to it.

Status
------
Provider Capabilities milestone. Pure data addition. Does not modify
DiscoveryProviderInterface, GoogleMapsProvider's or YelpProvider's
discover() behavior, CompositeDiscoveryProvider, ParallelCompositeDiscoveryProvider,
ProviderDeduplicator, ProviderConfiguration, or ProviderMetadata's own
shape — see google_maps_provider.py / yelp_provider.py for the one
small, additive change each makes (a `capabilities()` classmethod
returning an instance of this class), and registry.py for how
ProviderRegistry stores and serves that classmethod's output.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True, slots=True)
class ProviderCapabilities:
    """
    Declarative description of a single provider's search functionality
    — what its own request shape lets a caller search by, and how its
    own discover() behaves operationally. See module docstring for the
    full field-by-field rationale and for what is deliberately
    excluded.

    Describes functionality, not identity (that's ProviderMetadata) and
    not runtime health (out of scope for this milestone, same as it is
    for ProviderMetadata). Everything on this class is knowable by
    reading a provider's own request dataclass and discover()
    implementation — no construction, no network call, no registry
    required.
    """

    supports_keyword_search: bool = False
    supports_category_search: bool = False
    supports_city_filter: bool = False
    supports_country_filter: bool = False
    supports_radius_search: bool = False
    supports_coordinate_search: bool = False

    # Supported Geographic Coverage (ISO Country Codes, empty = global)
    supported_countries: tuple[str, ...] = ()

    # Supported Entity Output Types
    # Implementation Rule: supported_entity_types must reuse the engine's canonical entity type vocabulary
    # if one exists. Do not create or maintain a second independent set of entity type strings.
    # Only use raw strings if no canonical engine type currently exists.
    supported_entity_types: tuple[str, ...] = ()

    # Data Output Features
    provides_phone_numbers: bool = False
    provides_email_addresses: bool = False
    provides_social_profiles: bool = False
    provides_financial_data: bool = False

    # Protocol & Execution Features
    supports_pagination: bool = False
    supports_streaming: bool = False
    requires_geo_center: bool = False

    def __post_init__(self) -> None:
        object.__setattr__(self, "supported_countries", tuple(self.supported_countries))
        object.__setattr__(self, "supported_entity_types", tuple(self.supported_entity_types))
