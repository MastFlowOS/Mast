"""
MAST Engine V2 — FoursquareProvider
======================================

Source: this milestone's own instructions ("implement FoursquareProvider"
— read in full, including its explicit instruction to research whether
Foursquare's official API can honestly satisfy MAST's business discovery
workflow, and to target only the officially supported API if an old/new
split exists), engine/interfaces.py:DiscoveryProviderInterface,
engine/contracts.py:BusinessCandidate, and the five existing concrete
providers this one is built alongside — providers/google_maps_provider.py:
GoogleMapsProvider, providers/yelp_provider.py:YelpProvider,
providers/apple_maps_provider.py:AppleMapsProvider,
providers/overpass_provider.py:OverpassProvider, and
providers/azure_maps_provider.py:AzureMapsProvider — read for precedent,
not modified. Also read, not modified: providers/provider_metadata.py,
providers/provider_capabilities.py, providers/provider_configuration.py,
providers/registry.py, providers/composite_provider.py,
providers/parallel_composite_provider.py, providers/provider_deduplicator.py.
External reference: Foursquare's own developer documentation
(docs.foursquare.com) — specifically the "Upcoming Places API Changes"
notice, the Place Search endpoint reference, and the Places Response
Fields reference — cited throughout "Architecture review" below, the
same discipline yelp_provider.py / apple_maps_provider.py /
overpass_provider.py / azure_maps_provider.py already apply to their
respective third-party APIs.

This is not a new architecture. It is a sixth, independent answer to the
same interface GoogleMapsProvider, YelpProvider, AppleMapsProvider,
OverpassProvider, and AzureMapsProvider already answer — see "Architecture
review" below for why no engine/, workers/, queues/, models/, or
provider-platform file needed to change to add it.

Architecture review / target selection
----------------------------------------------------------------------
This milestone's own instructions required researching Foursquare's
official Places API and determining whether it can honestly satisfy
MAST's business discovery workflow, targeting only the officially
supported API if an old-vs-new split exists. Research findings, as of
this milestone (August 2026):

    1. Foursquare's own documentation ("Upcoming Places API Changes",
       docs.foursquare.com/developer/reference/upcoming-changes) states
       plainly: "the legacy V3 endpoints will be deprecated on
       May 15, 2026. You should migrate to the new Places API." That
       date has already passed as of this milestone. The same notice
       names the replacement explicitly: "Our new Places API endpoints,
       powered by FSQ OS Places, provide more accurate and up-to-date
       POI data."

    2. This is Foursquare's own migration notice for the exact surface
       (place search / business discovery) this milestone needs — the
       same category of unambiguous, source-published deprecation
       AzureMapsProvider's own review already found for Bing Maps, not
       a soft or community-sourced signal.

    3. The new Places API's Place Search endpoint
       (GET https://places-api.foursquare.com/places/search, current
       documented version 2025-06-17, sent via the required
       `X-Places-Api-Version` header) genuinely satisfies MAST's
       business discovery workflow:
           - Free-text search across name/category/telephone/taste/chain
             (`query`).
           - Category-scoped search (`fsq_category_ids`).
           - Three real, independent geographic-scoping mechanisms:
             `ll` + `radius` (circular), `near` (geocodable locality),
             `ne` + `sw` (rectangular bounding box).
           - A response shape (see "API mapping summary" below) that
             maps honestly onto BusinessCandidate's own fields —
             including a real per-place stable identifier
             (`fsq_place_id`), coordinates, address components, a
             website field (Pro tier — a genuine improvement over
             YelpProvider's Fusion API, which exposes no website field
             at all), and a telephone number.
       No part of MAST's discovery workflow (search by keyword/category,
       scope by city or radius, stream BusinessCandidate objects) is
       something the new Places API cannot honestly do.

    4. Target selected: the new Places API's Place Search endpoint,
       exclusively. FoursquareDiscoveryRequest and this provider's
       discover() build requests against `places-api.foursquare.com`
       only — no `api.foursquare.com/v3/...` (legacy V3) code path
       exists anywhere in this file. Per this milestone's own
       instruction to target only the officially supported API, that is
       the entirety of the "old vs. new" decision this file makes.

No genuine architectural contradiction exists — this milestone does not
stop. What follows is a fully-scoped implementation, per the "if no
blocker exists" branch of this milestone's own instructions.

Why an injectable HTTP callable, not a hardwired HTTP client
--------------------------------------------------------------
Same reasoning as YelpProvider / AppleMapsProvider / AzureMapsProvider
(see any of those modules' own docstrings, "Why an injectable HTTP
callable, not a hardwired HTTP client"): no Foursquare HTTP client
exists yet in this codebase, and this milestone's scope is the provider
layer, not "also write and own a general-purpose Foursquare HTTP
client." `FoursquareProvider.__init__` accepts an optional `http_get`
callable — `(url, params, headers) -> dict` — defaulting to a small
private helper built on the standard library (`urllib.request`), which
performs the real network call against the Place Search endpoint.
Callers with their own HTTP client, retry policy, or rate limiter may
inject it instead. This also makes the provider testable without
network access (see validate_foursquare_provider.py, which injects a
fake `http_get` returning a canned Place Search response shape).

Authentication
----------------
Every Place Search call requires two headers, both documented by
Foursquare directly:

    - `Authorization: Bearer {api_key}` — the caller's Foursquare
      service key. Same "provider does not source, cache, or validate
      credentials beyond passing them through" rule YelpProvider and
      AppleMapsProvider already apply to their own credentials.
    - `X-Places-Api-Version: 2025-06-17` — Foursquare's own required
      API-version header (the Place Search reference's "Headers"
      section marks it `required`, with `2025-06-17` as the only
      currently-documented allowed value and the field's own default).
      Sent as a plain constant this provider owns, not a per-request
      caller-supplied value — a caller choosing a discovery request has
      no reason to independently decide which Foursquare API version to
      address, any more than a YelpProvider caller decides which Fusion
      API version to call.

What "never fabricate data" means concretely here
-----------------------------------------------------
Every BusinessCandidate field below is populated only when the Place
Search response's own documented field shape actually contains the
corresponding value. Fields the response does not (reliably) expose are
left at their BusinessCandidate default (None), matching the discipline
GoogleMapsProvider, YelpProvider, AppleMapsProvider, OverpassProvider,
and AzureMapsProvider all already apply to their own sources:

    - provider_business_id: `fsq_place_id` — Foursquare's own
      documented "unique identifier for a FSQ Place (formerly known as
      Venue ID)." Populated directly, the same stable-identifier
      category as Fusion API's `id` for YelpProvider.
    - maps_url: built as `f"https://places-api.foursquare.com{link}"`
      from the response's own `link` field. Foursquare's own Response
      Fields reference documents `link` as "The URL associated with the
      FSQ Place Detail API call" — its value is a host-relative path
      (e.g. `/places/4be584ed2457a593ad8cab15`), and prefixing it with
      the Places API's own host is the exact, documented way Foursquare
      itself shows this field being resolved into a working URL (the
      same pattern Foursquare's own developer blog demonstrates
      resolving an analogous `link` field for the Autocomplete
      endpoint). This is a real difference from Yelp's `url` /
      Overpass's constructed OSM permalink: it resolves to Foursquare's
      own place-detail *API* resource, not a foursquare.com consumer
      web page — flagged explicitly here rather than silently
      presented as an end-user page, because no consumer-facing URL
      field exists anywhere in the documented Place Search response.
    - name: `name`, mapped directly.
    - category: the first entry of `categories[]` (each an object with
      a `name` field), matching how a single BusinessCandidate.category
      string field can only hold one category — the same "first
      category" precedent YelpProvider already sets for its own
      `categories[].title`. Left None if `categories` is absent or
      empty.
    - address / city / country: built from the response's own
      `location` object — `location.address` (a discrete street-address
      field, unlike Yelp's pre-joined `display_address` array) for
      `address`, `location.locality` for `city`, `location.country`
      for `country`. Never inferred from a sub-field the response
      didn't supply, and never combined with `location.region` /
      `location.postcode` into a synthesized single-line address the
      response itself does not present as one field.
    - website: the response's own top-level `website` field —
      documented as "The official website for the FSQ Place." This is
      a genuine capability difference from YelpProvider (whose Fusion
      API exposes no business-website field at all) and is populated
      directly, never derived from `maps_url` or any other field.
    - phone: the response's own `tel` field — documented as "The best
      known telephone number, with local formatting."
    - rating / review_count: `rating` and `stats.total_ratings` are
      documented Places *Premium* fields, returned only when explicitly
      requested via the `fields` query parameter (Foursquare's own
      Place Search reference: "If no explicit fields are provided in an
      API request, all Pro fields will be returned by default" — Pro,
      not Premium). This provider does not silently force Premium
      fields into every request on the caller's behalf (a cost/billing
      decision belonging to whoever configures the request, not to this
      provider — see `FoursquareDiscoveryRequest.fields` below).
      Mapped from the response when present (i.e. when the caller
      opted in via `fields`), left None otherwise — the same
      "response-shape-dependent, never guessed" treatment
      AppleMapsProvider already applies to fields its own PlaceResult
      sometimes omits.
    - coordinates: the response's own top-level `latitude` / `longitude`
      fields, populated as a `(lat, lon)` tuple when both are present.
    - instagram_url: the response's own `social_media.instagram`
      subfield is documented as a bare identifier
      ("`social_media`... `instagram`... Not all FSQ Places will have
      all subfields"), not a URL — Foursquare's Response Fields
      reference gives it no `https://instagram.com/...` format
      guarantee, the same "handle, not URL" ambiguity OverpassProvider's
      own docstring already documents for OSM's `contact:instagram` tag
      and declines to resolve by guessing. Left None here for the
      identical reason — constructing a URL from a bare handle would be
      asserting a format the response itself never asserted.

Request shape
--------------
Same reasoning as every other provider's discovery request (see
google_maps_provider.py, Ambiguity 3): DiscoveryProviderInterface.
discover() deliberately leaves the request shape as `Any`, and no
shared engine/contracts.py discovery-request contract exists.
FoursquareDiscoveryRequest is therefore defined locally here, mirroring
the Place Search endpoint's own documented query parameters directly —
`query`, `ll`, `radius`, `near`, `ne`/`sw`, `fsq_category_ids`,
`fsq_chain_ids`, `exclude_fsq_chain_ids`, `exclude_all_chains`,
`min_price`/`max_price`, `open_at`/`open_now`, `tel_format`, `sort`,
`limit`, and `fields` — plus `session_id`, owned by the caller for the
same reason every other request dataclass carries it.

No niche translation — by design, not by omission
----------------------------------------------------------------------
Per this codebase's now-established discipline (see
overpass_provider.py, "No niche translation", and
google_maps_provider.py's own Ambiguity 3, which declined the identical
opportunity first): `fsq_category_ids` takes Foursquare's own category
ID strings directly — nothing is renamed, reinterpreted, or looked up
from a generic niche vocabulary. `fields` passes Foursquare's own
documented field names straight through to the `fields` query
parameter — a caller wanting Premium-tier fields (e.g. `rating`,
`stats`) opts in by naming them exactly as Foursquare's own Response
Fields reference names them. A caller wanting to go from a generic,
provider-agnostic niche term to `fsq_category_ids` (or to Yelp's
`categories`, Apple's `include_poi_categories`, or Overpass's `tags`)
needs a translation layer that sits above all providers — that layer
does not exist anywhere in this codebase today, and inventing it here
was explicitly out of scope.

`ll`, `ne`, and `sw` are accepted as `(latitude, longitude)` tuples —
matching this codebase's `bbox`/`around` tuple precedent in
OverpassDiscoveryRequest — and joined into Foursquare's own documented
`"latitude,longitude"` string format when the query is built. This is
wiring a caller-supplied value into the literal syntax Foursquare's own
API requires, not translating what that value means, the same category
of operation OverpassProvider's own `_build_ql` already performs for
`area_name`.

Validation performed here
----------------------------------------------------------------------
Only what Foursquare's own Place Search reference documents as a hard
constraint on the request's own data, checked without a network call —
the same "validate what the data itself can tell you" discipline
ProviderConfiguration and OverpassDiscoveryRequest already apply to
their own fields:

    - `ne` and `sw` must be supplied together (Foursquare's own
      reference: "Must be used with sw parameter to specify a
      rectangular search box.").
    - `radius`, when given, must be in Foursquare's own documented
      0-100000 (meters) range.
    - `limit`, when given, must be in Foursquare's own documented 1-50
      range (the endpoint's own hard per-call ceiling — see
      "Pagination" below for why this is also this provider's own
      request-level ceiling, not merely a suggestion).
    - `min_price` / `max_price`, when given, must each be in
      Foursquare's own documented 1-4 range.
    - `open_at` and `open_now` are documented as mutually exclusive
      ("Cannot be specified in conjunction with `open_now`.").
    - `exclude_fsq_chain_ids` and `exclude_all_chains` are documented as
      mutually exclusive ("Cannot be used in conjunction with
      exclude_all_chains.").
    - `tel_format`, when given, must be one of Foursquare's own
      documented enum values (`NATIONAL`, `E164`).
    - `sort`, when given, must be one of Foursquare's own documented
      enum values (`RELEVANCE`, `RATING`, `DISTANCE`, `POPULARITY`).

No geographic-scope mutual-exclusivity constraint is invented among
`ll`/`near`/`ne`+`sw` themselves: unlike Overpass QL (where combining
scopes is a syntax error this codebase's own query builder would
otherwise produce), Foursquare's reference does not document these
three approaches as mutually rejected by the endpoint, only as three
independent ways to supply a location — inventing a stricter
constraint than the source itself documents would not be "validating
what the data can tell you," it would be guessing at undocumented
server behavior.

Pagination
-----------
The Place Search endpoint's own documented query parameters (`query`,
`ll`, `radius`, `fsq_category_ids`, `fsq_chain_ids`,
`exclude_fsq_chain_ids`, `exclude_all_chains`, `fields`, `min_price`,
`max_price`, `open_at`, `open_now`, `tel_format`, `ne`, `sw`, `near`,
`sort`, `limit`) include no offset, page token, or cursor parameter of
any kind — unlike the Fusion API's `offset`, which YelpProvider already
pages through automatically. `limit` itself is capped at 50 by
Foursquare's own documentation, with no documented mechanism to
retrieve results beyond that ceiling from this endpoint. `discover()`
therefore issues exactly one HTTP GET per call and streams the
response's `results[]` one BusinessCandidate at a time — the same
"single-call, still-streaming" shape OverpassProvider and
AppleMapsProvider already have, for the identical reason (one HTTP
call, no second offset-advanced call to make).

Status
------
FoursquareProvider implementation milestone. Sixth concrete
DiscoveryProviderInterface implementation, added alongside
GoogleMapsProvider, YelpProvider, AppleMapsProvider, OverpassProvider,
and AzureMapsProvider; does not replace, wrap, call, or modify any of
them. engine/, workers/, queues/, models/, and every existing
provider-platform file (interfaces.py, contracts.py, registry.py,
composite_provider.py, parallel_composite_provider.py,
provider_deduplicator.py, provider_metadata.py, provider_capabilities.py,
provider_configuration.py, __init__.py) are untouched by this file —
see this milestone's own deliverables summary for the full "zero
architectural changes required" accounting.
"""

from __future__ import annotations

import json
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Callable, Iterator, Optional, Sequence
from urllib.request import Request, urlopen
from urllib.parse import urlencode

from engine.contracts import BusinessCandidate
from engine.interfaces import DiscoveryProviderInterface
from providers.provider_capabilities import ProviderCapabilities
from providers.provider_metadata import ProviderMetadata

_SEARCH_URL = "https://places-api.foursquare.com/places/search"
_API_HOST = "https://places-api.foursquare.com"
_API_VERSION = "2025-06-17"  # Foursquare's own current documented Place Search version.
_MAX_LIMIT = 50  # Place Search's own documented per-call ceiling.
_MAX_RADIUS_METERS = 100_000  # Place Search's own documented ceiling.
_VALID_TEL_FORMATS = ("NATIONAL", "E164")
_VALID_SORT_VALUES = ("RELEVANCE", "RATING", "DISTANCE", "POPULARITY")


# ---------------------------------------------------------------------------
# Request shape (provider-local — mirrors GoogleMapsDiscoveryRequest /
# YelpDiscoveryRequest / AppleMapsDiscoveryRequest / OverpassDiscoveryRequest /
# AzureMapsDiscoveryRequest)
# ---------------------------------------------------------------------------
@dataclass(frozen=True, slots=True)
class FoursquareDiscoveryRequest:
    """
    This provider's own accepted request shape. Not a shared
    engine/contracts.py contract — same reasoning as every other
    provider's request dataclass (see google_maps_provider.py,
    Ambiguity 3). Field names mirror the Place Search endpoint's own
    documented query parameters directly so nothing is renamed or
    reinterpreted in translation — see module docstring, "Request
    shape" and "No niche translation", for the full field-by-field
    rationale.

    No field here is required to be non-empty on its own (unlike
    OverpassDiscoveryRequest.tags): Place Search itself accepts a bare
    request with no location and no query, falling back to IP-biased
    geolocation, per its own documentation. This provider does not
    invent a mandatory field the endpoint itself does not require.

    See module docstring, "Validation performed here", for the full
    rationale behind every check `__post_init__` performs.
    """

    session_id: str
    query: Optional[str] = None
    ll: Optional[tuple[float, float]] = None  # (latitude, longitude)
    radius: Optional[int] = None  # meters, 0-100000
    near: Optional[str] = None
    ne: Optional[tuple[float, float]] = None  # (latitude, longitude)
    sw: Optional[tuple[float, float]] = None  # (latitude, longitude)
    fsq_category_ids: Optional[Sequence[str]] = None
    fsq_chain_ids: Optional[Sequence[str]] = None
    exclude_fsq_chain_ids: Optional[Sequence[str]] = None
    exclude_all_chains: bool = False
    min_price: Optional[int] = None  # 1-4
    max_price: Optional[int] = None  # 1-4
    open_at: Optional[str] = None  # DOWTHHMM, e.g. "1T2130"
    open_now: Optional[bool] = None
    tel_format: Optional[str] = None  # "NATIONAL" | "E164"
    sort: Optional[str] = None  # "RELEVANCE" | "RATING" | "DISTANCE" | "POPULARITY"
    limit: int = 10  # Place Search's own documented default.
    fields: Optional[Sequence[str]] = None  # Foursquare's own field names, passed through verbatim.

    def __post_init__(self) -> None:
        if (self.ne is None) != (self.sw is None):
            raise ValueError(
                "FoursquareDiscoveryRequest requires `ne` and `sw` "
                "together — Place Search documents ne as usable only "
                "with sw (and vice versa) to specify a rectangular "
                "search box."
            )
        if self.radius is not None and not (0 <= self.radius <= _MAX_RADIUS_METERS):
            raise ValueError(
                f"FoursquareDiscoveryRequest.radius must be between 0 "
                f"and {_MAX_RADIUS_METERS} meters, per Place Search's "
                f"own documented ceiling — got {self.radius!r}."
            )
        if not (1 <= self.limit <= _MAX_LIMIT):
            raise ValueError(
                f"FoursquareDiscoveryRequest.limit must be between 1 "
                f"and {_MAX_LIMIT}, per Place Search's own documented "
                f"per-call ceiling — got {self.limit!r}."
            )
        for name, value in (("min_price", self.min_price), ("max_price", self.max_price)):
            if value is not None and not (1 <= value <= 4):
                raise ValueError(
                    f"FoursquareDiscoveryRequest.{name} must be between "
                    f"1 and 4, per Place Search's own documented price "
                    f"tier range — got {value!r}."
                )
        if self.open_at is not None and self.open_now is not None:
            raise ValueError(
                "FoursquareDiscoveryRequest.open_at and open_now are "
                "mutually exclusive, per Place Search's own "
                "documentation."
            )
        if self.exclude_fsq_chain_ids is not None and self.exclude_all_chains:
            raise ValueError(
                "FoursquareDiscoveryRequest.exclude_fsq_chain_ids and "
                "exclude_all_chains are mutually exclusive, per Place "
                "Search's own documentation."
            )
        if self.tel_format is not None and self.tel_format not in _VALID_TEL_FORMATS:
            raise ValueError(
                f"FoursquareDiscoveryRequest.tel_format must be one of "
                f"{_VALID_TEL_FORMATS!r} — got {self.tel_format!r}."
            )
        if self.sort is not None and self.sort not in _VALID_SORT_VALUES:
            raise ValueError(
                f"FoursquareDiscoveryRequest.sort must be one of "
                f"{_VALID_SORT_VALUES!r} — got {self.sort!r}."
            )


def _http_get_urllib(url: str, params: dict[str, Any], headers: dict[str, str]) -> dict[str, Any]:
    """
    Default transport: a plain stdlib GET against the Place Search
    endpoint. Injected as `http_get` by default; callers may supply
    their own (see module docstring, "Why an injectable HTTP callable").
    Raises whatever urllib raises on a non-2xx response or network
    failure — propagated unchanged, same "provider failures stay
    isolated to the provider, but are never hidden from the caller"
    rule every other provider in this codebase already follows.
    """
    query = urlencode(params)
    request = Request(f"{url}?{query}", headers=headers, method="GET")
    with urlopen(request, timeout=30) as response:
        return json.loads(response.read().decode("utf-8"))


def _or_none(value: Any) -> Any:
    """Same "" / None normalization helper every other provider uses."""
    return value if value else None


def _format_latlon(pair: Optional[tuple[float, float]]) -> Optional[str]:
    """
    Wires a caller-supplied (latitude, longitude) tuple into Place
    Search's own documented "latitude,longitude" string format — see
    module docstring, "No niche translation", for why this is wiring,
    not translation.
    """
    if pair is None:
        return None
    lat, lon = pair
    return f"{lat},{lon}"


def _build_params(request: FoursquareDiscoveryRequest) -> dict[str, Any]:
    """
    Builds the Place Search query-parameter dict for `request`, wiring
    each of this provider's own request fields into the exact
    parameter name Foursquare's own documentation assigns it. Omits
    any parameter whose corresponding request field is unset, so an
    unset field is simply absent from the call rather than sent as an
    empty or default value this provider invented.
    """
    params: dict[str, Any] = {}
    if request.query is not None:
        params["query"] = request.query
    if request.ll is not None:
        params["ll"] = _format_latlon(request.ll)
    if request.radius is not None:
        params["radius"] = request.radius
    if request.near is not None:
        params["near"] = request.near
    if request.ne is not None:
        params["ne"] = _format_latlon(request.ne)
    if request.sw is not None:
        params["sw"] = _format_latlon(request.sw)
    if request.fsq_category_ids:
        params["fsq_category_ids"] = ",".join(request.fsq_category_ids)
    if request.fsq_chain_ids:
        params["fsq_chain_ids"] = ",".join(request.fsq_chain_ids)
    if request.exclude_fsq_chain_ids:
        params["exclude_fsq_chain_ids"] = ",".join(request.exclude_fsq_chain_ids)
    if request.exclude_all_chains:
        params["exclude_all_chains"] = "true"
    if request.min_price is not None:
        params["min_price"] = request.min_price
    if request.max_price is not None:
        params["max_price"] = request.max_price
    if request.open_at is not None:
        params["open_at"] = request.open_at
    if request.open_now is not None:
        params["open_now"] = "true" if request.open_now else "false"
    if request.tel_format is not None:
        params["tel_format"] = request.tel_format
    if request.sort is not None:
        params["sort"] = request.sort
    params["limit"] = request.limit
    if request.fields:
        params["fields"] = ",".join(request.fields)
    return params


class FoursquareProvider(DiscoveryProviderInterface):
    """
    Adapts Foursquare's new Places API Place Search endpoint to
    DiscoveryProviderInterface. Independent of GoogleMapsProvider,
    YelpProvider, AppleMapsProvider, OverpassProvider, and
    AzureMapsProvider: no shared code, no shared state, no dependency
    on any of the other five.

    Stateless: every discover() call issues its own HTTP request
    against the injected (or default) transport; nothing is cached or
    shared across calls or instances.
    """

    def __init__(
        self,
        api_key: str,
        http_get: Optional[Callable[[str, dict[str, Any], dict[str, str]], dict[str, Any]]] = None,
    ) -> None:
        """
        `api_key` is the caller's Foursquare service key — this
        provider does not source, cache, or validate credentials
        beyond passing them through as a bearer token; credential
        management belongs to whoever configures the provider, not to
        the provider itself (same rule as YelpProvider.__init__ and
        AppleMapsProvider.__init__).

        `http_get` defaults to `_http_get_urllib` (a real network
        call). Injecting a different callable — e.g. a fake for tests,
        or a caller's own rate-limited HTTP client — never requires
        touching `discover()` or any engine code.
        """
        self._api_key = api_key
        self._http_get = http_get or _http_get_urllib

    @property
    def provider_id(self) -> str:
        return "foursquare"

    @property
    def display_name(self) -> str:
        return "Foursquare"

    @classmethod
    def metadata(cls) -> ProviderMetadata:
        """
        This provider's own static characteristics — see
        provider_metadata.py for the full field-by-field rationale.

        A classmethod, not an instance property — same reasoning as
        YelpProvider.metadata() and AppleMapsProvider.metadata():
        FoursquareProvider.__init__ requires an `api_key`, so a caller
        wanting this provider's metadata (e.g. to populate a selection
        UI, or to register it in a ProviderRegistry) must not be
        forced to already have a valid Foursquare service key on hand
        just to learn that this provider requires one.
        """
        return ProviderMetadata(
            provider_id="foursquare",
            display_name="Foursquare",
            description=(
                "Streams BusinessCandidate objects from Foursquare's "
                "new Places API Place Search endpoint (FSQ OS Places)."
            ),
            provider_type="business_directory_api",
            requires_api_key=True,
            default_enabled=True,
            homepage="https://location.foursquare.com/products/places-api/",
            version="1.0.0",
        )

    CAPABILITIES: ProviderCapabilities = ProviderCapabilities(
        supports_keyword_search=True,
        supports_category_search=True,
        supports_city_filter=True,
        supports_country_filter=False,
        supports_radius_search=True,
        supports_coordinate_search=True,
        supported_entity_types=("local_business",),
        provides_phone_numbers=True,
        supports_pagination=False,
        supports_streaming=True,
    )

    @classmethod
    def capabilities(cls) -> ProviderCapabilities:
        """Return what a caller can ask this provider's discover() to search by."""
        return cls.CAPABILITIES

    def discover(self, request: FoursquareDiscoveryRequest) -> Iterator[BusinessCandidate]:
        """
        Streams BusinessCandidate objects for `request` — a single
        HTTP GET against the Place Search endpoint (see module
        docstring, "Pagination"), yielding one BusinessCandidate per
        entry in the response's `results[]`. Any exception raised by
        the HTTP transport propagates unchanged — nothing here catches
        or swallows it.
        """
        headers = {
            "Authorization": f"Bearer {self._api_key}",
            "X-Places-Api-Version": _API_VERSION,
            "Accept": "application/json",
        }
        params = _build_params(request)
        payload = self._http_get(_SEARCH_URL, params, headers)
        results = payload.get("results", [])
        for result in results:
            yield self._to_business_candidate(result, request.session_id)

    def _to_business_candidate(
        self, result: dict[str, Any], session_id: str
    ) -> BusinessCandidate:
        """
        Field-for-field mapping, Place Search result object ->
        BusinessCandidate. See module docstring, "What 'never
        fabricate data' means concretely here", for the full
        field-by-field rationale — every omission below is a field the
        Place Search response genuinely does not (reliably) expose,
        not an oversight.
        """
        location = result.get("location") or {}

        categories = result.get("categories") or []
        category = _or_none(categories[0].get("name")) if categories else None

        lat, lon = result.get("latitude"), result.get("longitude")
        coordinates = (lat, lon) if lat is not None and lon is not None else None

        link = result.get("link")
        maps_url = f"{_API_HOST}{link}" if link else None

        stats = result.get("stats") or {}

        return BusinessCandidate(
            pipeline_id=str(uuid.uuid4()),
            session_id=session_id,
            provider=self.provider_id,
            provider_business_id=_or_none(result.get("fsq_place_id")),
            maps_url=maps_url,
            name=_or_none(result.get("name")),
            category=category,
            address=_or_none(location.get("address")),
            city=_or_none(location.get("locality")),
            country=_or_none(location.get("country")),
            website=_or_none(result.get("website")),
            phone=_or_none(result.get("tel")),
            rating=result.get("rating"),  # Premium field — None unless caller opted in via `fields`.
            review_count=stats.get("total_ratings"),  # Premium field — same as above.
            coordinates=coordinates,
            discovered_at=datetime.now(timezone.utc).isoformat(),
            instagram_url=None,  # social_media.instagram is a bare handle, not a URL — never fabricated.
        )
