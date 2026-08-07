"""
MAST Engine V2 — AppleMapsProvider
=====================================

Source: this milestone's own instructions ("implement AppleMapsProvider"),
engine/interfaces.py:DiscoveryProviderInterface, engine/contracts.py:
BusinessCandidate, and the two existing concrete providers this one is
built alongside — providers/google_maps_provider.py:GoogleMapsProvider
and providers/yelp_provider.py:YelpProvider — read for precedent, not
modified. Also read, not modified: providers/provider_metadata.py,
providers/provider_capabilities.py, providers/provider_configuration.py,
providers/registry.py, providers/composite_provider.py,
providers/parallel_composite_provider.py, providers/provider_deduplicator.py.
External reference: Apple's own Maps Server API documentation
(developer.apple.com/documentation/applemapsserverapi) for the Search
endpoint's real, documented request/response shape — this file's own
field-selection rationale below cites exactly what that endpoint does
and does not return, the same discipline yelp_provider.py already
applies to the Fusion API.

This is not a new architecture. It is a third, independent answer to
the same interface GoogleMapsProvider and YelpProvider already answer
— see this milestone's own architecture review (delivered alongside
this file) for why no engine/, workers/, queues/, models/, or
provider-platform file needed to change to add it.

Responsibility
--------------
AppleMapsProvider has exactly one job: accept a discovery request,
query the Apple Maps Server API's Search endpoint
(GET https://maps-api.apple.com/v1/search), and stream
BusinessCandidate objects — nothing else. Like GoogleMapsProvider and
YelpProvider, it does not enrich, qualify, score, store, deduplicate,
retry, cache, allocate workers, or own queues.

Why an injectable HTTP callable, not a hardwired HTTP client
--------------------------------------------------------------
Same reasoning as YelpProvider (see that module's own docstring,
"Why an injectable HTTP callable, not a hardwired HTTP client"): no
Apple Maps HTTP client exists yet in this codebase, and this
milestone's scope is the provider layer, not "also write and own a
general-purpose Apple Maps HTTP client." `AppleMapsProvider.__init__`
accepts an optional `http_get` callable — `(url, params, headers) ->
dict` — defaulting to a small private helper built on the standard
library (`urllib.request`). Callers with their own HTTP client, retry
policy, or rate limiter may inject it instead. This also makes the
provider testable without network access (see
validate_apple_maps_provider.py, which injects a fake `http_get`
returning a canned Search response shape).

Authentication — deliberately not re-implemented here (flagged, not
silently worked around)
----------------------------------------------------------------------
The Apple Maps Server API authenticates every call with a bearer
token obtained from Apple's own Token API
(GET /v1/token), itself exchanged for a JWT the caller signs with a
Maps identifier and private key generated in their Apple Developer
account. Minting that JWT and exchanging it for an access token is a
credential-provisioning concern, not a discovery concern — exactly the
same boundary YelpProvider already draws around its own `api_key`
("credential management belongs to whoever configures the provider,
not to the provider itself"). AppleMapsProvider therefore accepts a
caller-supplied `access_token: str` — an already-obtained, valid Maps
Server API access token — and does not source, refresh, cache, or
validate it beyond passing it through as a bearer token. A future
caller wanting this provider to mint/refresh its own tokens is free to
inject an `http_get` that does so transparently; that remains entirely
outside this provider's own responsibility, the same way YelpProvider
never implements Yelp's own OAuth flow.

Parameter completeness — full parity with the documented Search
endpoint request shape
----------------------------------------------------------------------
`AppleMapsDiscoveryRequest` exposes every query parameter the Search
endpoint's own documentation lists as a search-scoping input (as
opposed to `userLocation`, a personalization hint about the end user
making the request, not the caller — this provider has no end user of
its own to report, so that parameter is not exposed here):

    - `include_poi_categories` -> `includePoiCategories` (comma-
      separated PoiCategory strings — see
      https://developer.apple.com/documentation/applemapsserverapi/poicategory
      for the enumerated values). Real category filtering the Search
      endpoint documents and performs itself; this provider does not
      filter results locally.
    - `exclude_poi_categories` -> `excludePoiCategories`. Same
      PoiCategory vocabulary, inverted.
    - `result_type_filter` -> `resultTypeFilter`. Documented values
      are `"Poi"` and `"Address"`; a caller wanting business-only
      results (as opposed to plain geocoded addresses) sets this to
      `"Poi"`.
    - `limit_to_countries` -> `limitToCountries` (comma-separated
      ISO ALPHA-2 country codes).
    - `search_location` / `search_region` / `lang` — unchanged from
      the initial implementation.

Earlier versions of this file omitted the four parameters above and
described category/country filtering as unsupported
(`supports_category_search=False`, `supports_country_filter=False`).
That was inaccurate: the Search endpoint's own documentation lists
`includePoiCategories`/`excludePoiCategories` and `limitToCountries`
as real, first-class request parameters, no different in kind from
`q` or `searchLocation`. This revision adds them, so
`AppleMapsDiscoveryRequest` now mirrors the Search endpoint's full
documented parameter set — the same "field mirrors a real, documented
API parameter, nothing invented" discipline every other field on this
request already follows — and `ProviderCapabilities` below is updated
to match (see "Capabilities" section).

Known limitation — place search, not high-volume business enumeration
----------------------------------------------------------------------
Even with every documented parameter exposed, the Search endpoint
remains architecturally a *place search* endpoint, not a business-
directory enumeration endpoint like Yelp's Business Search or the
scraper GoogleMapsProvider wraps. Its documented parameters expose no
`limit`/`offset`/page-size control of any kind (see "Pagination"
below, unchanged) — a single call returns whatever single-shot result
set Apple's own search ranking decides for one query, which in
practice is a short list sized for "resolve what the user typed," not
"enumerate every business of this niche in this city." `resultTypeFilter=Poi`
and `includePoiCategories` narrow *which* results come back; neither
parameter — nor any other documented one — asks Apple for *more*
results, or a specific number of them. A caller that needs high-volume
per-niche-per-city discovery at the scale GoogleMapsProvider or
YelpProvider deliver should not expect AppleMapsProvider to be a
like-for-like substitute for that role; it is better suited to
resolving or verifying a specific place than to broad enumeration.
This is a property of the endpoint itself, not a gap this provider's
own request/response mapping could close.

What "never fabricate data" means concretely here
-----------------------------------------------------
Every BusinessCandidate field below is populated only when the Search
endpoint's own documented response actually contains the corresponding
value. The Search endpoint's `PlaceResult` shape
(`results[]` in its JSON response) documents exactly these fields:
`name`, `coordinate` (`latitude`/`longitude`), `formattedAddressLines`,
`structuredAddress` (`locality`, `administrativeArea`,
`administrativeAreaCode`, `postCode`, `thoroughfare`,
`fullThoroughfare`, `subThoroughfare`, `subLocality`,
`areasOfInterest`, `dependentLocalities`), `country`, `countryCode`,
`displayMapRegion`, and — for point-of-interest results specifically —
`poiCategory`. Fields BusinessCandidate has, that this documented
response shape simply does not expose, are left at their
BusinessCandidate default (None) rather than guessed, derived, or
backfilled from another field:

    - website: the Search endpoint's PlaceResult does not include a
      business's own website URL. Left None — the same discipline
      YelpProvider already applies to this exact field (Fusion API
      doesn't expose it either), and for the same reason: it is NOT
      set to anything Apple-Maps-specific, since that would
      misrepresent someone else's website field with a Maps link.
    - phone: not part of PlaceResult. Left None.
    - rating / review_count: not part of PlaceResult — the Search
      endpoint is a geocoding/POI-search endpoint, not a
      ratings/reviews API. Left None.
    - provider_business_id: PlaceResult carries no stable per-place
      identifier field (no analogue of Yelp's `id` or a Google Place
      ID) in its documented shape. Left None rather than deriving a
      synthetic id from name+coordinate, which would be this
      provider's own invention, not Apple's.
    - maps_url: PlaceResult carries no listing-page URL field either
      (unlike Yelp's `url` or GoogleMapsProvider's `maps_link`). Left
      None rather than constructing a maps.apple.com search-link
      guess — a constructed URL is not the same thing as an API-
      returned one, and this provider does not fabricate one.
    - instagram_url: not part of PlaceResult. Left None (an expected,
      normal outcome per BusinessCandidate's own docstring on this
      field).
    - category: mapped from `poiCategory` when the result is a POI
      result and Apple's response includes it; left None when the
      response is a plain address/geocode result with no `poiCategory`
      (Apple's own documented behavior — not every result is a
      business).
    - address: built from `formattedAddressLines` (joined), mirroring
      how YelpProvider builds `address` from Fusion API's
      `display_address` lines — never inferred from `structuredAddress`
      sub-fields the response didn't supply.
    - city: `structuredAddress.locality`.
    - country: `country` (the full country name Apple's own response
      returns), matching this field 1:1 with no reinterpretation —
      same "use the field as given" rule YelpProvider applies to
      `location.country`.
    - coordinates: `coordinate.latitude` / `coordinate.longitude`,
      populated as a (lat, lon) tuple when both are present in the
      response, left None otherwise.

Request shape
--------------
Same reasoning as GoogleMapsDiscoveryRequest / YelpDiscoveryRequest
(see google_maps_provider.py, Ambiguity 3): DiscoveryProviderInterface.
discover() deliberately leaves the request shape as `Any`, and no
shared engine/contracts.py discovery-request contract exists.
AppleMapsDiscoveryRequest is therefore defined locally here, mirroring
exactly what the Search endpoint's own documented query parameters
accept: `q` (the search term); `searchLocation` and `searchRegion`
(optional lat/lon and bounding-box hints used to bias results toward
an area — not a radius; Apple's Search endpoint documents no radius
parameter, so none is invented here, the same discipline
provider_capabilities.py's own `supports_radius_search` field
description calls out explicitly for Yelp); `lang`;
`includePoiCategories` / `excludePoiCategories` (real category
filtering); `resultTypeFilter` (`"Poi"` vs `"Address"`); and
`limitToCountries` (real country filtering) — see "Parameter
completeness" above for the full rationale on the four
category/country/result-type fields. Plus `session_id`, for the same
reason the other two requests carry it: BusinessCandidate.session_id
is required, and a provider must not invent or own session identity
itself. No `city` request field exists here, because the Search
endpoint's own documented query parameters expose no city parameter —
a caller wanting to scope by city folds that into the free-text `q`
or a `search_region` bounding box, exactly as a person typing into
Apple Maps would; this provider does not invent a parameter Apple's
own API doesn't accept. No `limit` request field exists either,
because the Search endpoint's own documented parameters expose no
result-count control — see "Pagination" below and "Known limitation"
above.

Pagination
-----------
The Search endpoint returns its full result set in a single response;
its documented parameters expose no `offset`/`page`/`limit` mechanism
the way the Fusion API's Business Search endpoint does for
YelpProvider. `discover()` therefore issues exactly one HTTP request
per call and streams the response's `results[]` one BusinessCandidate
at a time — still satisfying DiscoveryProviderInterface's streaming
contract (an iterator, never a materialized list handed back before
iteration begins), the same "single-call, still-streaming" shape
GoogleMapsProvider already has for a different reason (one
MapsScraper.search() call, no second offset-advanced call).

Status
------
AppleMapsProvider implementation milestone. Third concrete
DiscoveryProviderInterface implementation, added alongside
GoogleMapsProvider and YelpProvider; does not replace, wrap, call, or
modify either. engine/, workers/, queues/, models/, and every existing
provider-platform file (interfaces.py, contracts.py, registry.py,
composite_provider.py, parallel_composite_provider.py,
provider_deduplicator.py, provider_metadata.py,
provider_capabilities.py, provider_configuration.py, __init__.py) are
untouched by this file — see this milestone's architecture review for
the full "zero architectural changes required" accounting.

Parameter completeness revision: `AppleMapsDiscoveryRequest` gained
`include_poi_categories`, `exclude_poi_categories`,
`result_type_filter`, and `limit_to_countries` — the remaining Search
endpoint request parameters this file's initial version omitted (see
"Parameter completeness" above). `capabilities()` was corrected to
`supports_category_search=True` / `supports_country_filter=True` to
match. No other field, method, or class in this file changed shape;
no provider-platform file changed at all. This revision also documents
(see "Known limitation" above) that full parameter parity does not
change the Search endpoint's own architectural nature — it remains a
place-search endpoint with no result-count control, not a substitute
for GoogleMapsProvider/YelpProvider's high-volume per-niche-per-city
enumeration.
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

_SEARCH_URL = "https://maps-api.apple.com/v1/search"


# ---------------------------------------------------------------------------
# Request shape (provider-local — mirrors GoogleMapsDiscoveryRequest /
# YelpDiscoveryRequest)
# ---------------------------------------------------------------------------
@dataclass(frozen=True, slots=True)
class AppleMapsDiscoveryRequest:
    """
    This provider's own accepted request shape. Not a shared
    engine/contracts.py contract — same reasoning as
    GoogleMapsDiscoveryRequest / YelpDiscoveryRequest (see
    google_maps_provider.py, Ambiguity 3). Field names mirror the
    Search endpoint's own documented query parameters directly (`q`,
    `searchLocation`, `searchRegion`, `lang`, `includePoiCategories`,
    `excludePoiCategories`, `resultTypeFilter`, `limitToCountries`) so
    nothing is renamed or reinterpreted in translation, plus
    `session_id`, owned by the caller. See module docstring, "Request
    shape" and "Parameter completeness", for why no `city` or `limit`
    field exists here, and for the full rationale on the four
    category/country/result-type fields below.

    `include_poi_categories` / `exclude_poi_categories` — sequences of
    PoiCategory strings (see
    https://developer.apple.com/documentation/applemapsserverapi/poicategory).
    Kept as `Optional[Sequence[str]]`, not a pre-joined string, so a
    caller builds a plain Python list/tuple of category names rather
    than hand-formatting Apple's comma-separated wire format
    themselves — `discover()` below does that joining, the same
    responsibility split ProviderCapabilities' own field descriptions
    already draw between "what a caller can ask for" (this dataclass)
    and "how it's transmitted" (the HTTP call).

    `result_type_filter` — one of the Search endpoint's own documented
    values, `"Poi"` or `"Address"` (or both, comma-separated, per
    Apple's own documentation); not validated against that vocabulary
    here, for the same reason no other field on this request validates
    against its own API-side vocabulary — this dataclass describes the
    request shape, it does not re-implement Apple's own parameter
    validation.

    `limit_to_countries` — a sequence of ISO ALPHA-2 country codes,
    same `Sequence[str]`-not-pre-joined-string reasoning as the
    PoiCategory fields above.
    """

    session_id: str
    query: str
    search_location: Optional[str] = None  # "lat,lon" hint, e.g. "37.78,-122.42"
    search_region: Optional[str] = None  # "north,east,south,west" hint
    language: str = "en-US"
    include_poi_categories: Optional[Sequence[str]] = None
    exclude_poi_categories: Optional[Sequence[str]] = None
    result_type_filter: Optional[str] = None  # "Poi" and/or "Address"
    limit_to_countries: Optional[Sequence[str]] = None


def _http_get_urllib(url: str, params: dict[str, Any], headers: dict[str, str]) -> dict[str, Any]:
    """
    Default transport: a plain stdlib GET against the Search endpoint.
    Injected as `http_get` by default; callers may supply their own
    (see module docstring for why). Raises whatever urllib raises on a
    non-2xx response or network failure — propagated unchanged, same
    "provider failures stay isolated to the provider, but are never
    hidden from the caller" rule GoogleMapsProvider and YelpProvider
    both follow.
    """
    query = urlencode({k: v for k, v in params.items() if v not in (None, "")})
    request = Request(f"{url}?{query}", headers=headers, method="GET")
    with urlopen(request, timeout=15) as response:
        return json.loads(response.read().decode("utf-8"))


def _or_none(value: Optional[str]) -> Optional[str]:
    """Same "" / None normalization helper as the other two providers."""
    return value if value else None


def _comma_join(values: Optional[Sequence[str]]) -> Optional[str]:
    """
    Apple's documented wire format for `includePoiCategories`,
    `excludePoiCategories`, and `limitToCountries` is a single
    comma-separated string (e.g. "Restaurant,Cafe" or "US,CA") — this
    is the one place that joining happens, so
    AppleMapsDiscoveryRequest itself can stay a plain
    `Sequence[str]` per field rather than asking a caller to
    pre-format Apple's own wire syntax. Returns None (omitted from the
    request entirely, same as every other unset param — see
    `_http_get_urllib`'s own None/"" filtering) when `values` is None
    or empty, never an empty string.
    """
    if not values:
        return None
    return ",".join(values)


class AppleMapsProvider(DiscoveryProviderInterface):
    """
    Adapts the Apple Maps Server API's Search endpoint to
    DiscoveryProviderInterface. Independent of GoogleMapsProvider and
    YelpProvider: no shared code, no shared state, no dependency on
    scraper/maps_scraper.py or on YelpProvider's Fusion API client.

    Stateless: every discover() call issues its own HTTP request
    against the injected (or default) transport; nothing is cached or
    shared across calls or instances.
    """

    def __init__(
        self,
        access_token: str,
        http_get: Optional[Callable[[str, dict[str, Any], dict[str, str]], dict[str, Any]]] = None,
    ) -> None:
        """
        `access_token` is the caller's already-obtained Apple Maps
        Server API access token — this provider does not source,
        mint, refresh, cache, or validate it beyond passing it through
        as a bearer token; credential management belongs to whoever
        configures the provider, not to the provider itself (see
        module docstring, "Authentication").

        `http_get` defaults to `_http_get_urllib` (a real network
        call). Injecting a different callable — e.g. a fake for tests,
        or a caller's own token-refreshing HTTP client — never
        requires touching `discover()` or any engine code.
        """
        self._access_token = access_token
        self._http_get = http_get or _http_get_urllib

    @property
    def provider_id(self) -> str:
        return "apple_maps"

    @property
    def display_name(self) -> str:
        return "Apple Maps"

    @classmethod
    def metadata(cls) -> ProviderMetadata:
        """
        This provider's own static characteristics — see
        provider_metadata.py for the full field-by-field rationale,
        and GoogleMapsProvider.metadata() / YelpProvider.metadata()
        for why this is a classmethod rather than an instance
        property: AppleMapsProvider.__init__ requires an
        `access_token`, so a caller wanting this provider's metadata
        (e.g. to populate a selection UI, or to register it in a
        ProviderRegistry) must not be forced to already have a valid
        token on hand just to learn that this provider requires one.
        """
        return ProviderMetadata(
            provider_id="apple_maps",
            display_name="Apple Maps",
            description=(
                "Streams BusinessCandidate objects from the Apple Maps "
                "Server API's Search endpoint (GET /v1/search)."
            ),
            provider_type="business_directory_api",
            requires_api_key=True,
            default_enabled=True,
            homepage="https://developer.apple.com/documentation/applemapsserverapi",
            version="1.0.0",
        )

    CAPABILITIES: ProviderCapabilities = ProviderCapabilities(
        supports_keyword_search=True,
        supports_category_search=True,
        supports_city_filter=False,
        supports_country_filter=True,
        supports_radius_search=False,
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

    def discover(self, request: AppleMapsDiscoveryRequest) -> Iterator[BusinessCandidate]:
        """
        Streams BusinessCandidate objects for `request` — a single
        HTTP call against the Search endpoint (see module docstring,
        "Pagination"), yielding one BusinessCandidate per entry in the
        response's `results[]`. Any exception raised by the HTTP
        transport propagates unchanged — nothing here catches or
        swallows it.
        """
        headers = {"Authorization": f"Bearer {self._access_token}"}
        params = {
            "q": request.query,
            "searchLocation": request.search_location,
            "searchRegion": request.search_region,
            "lang": request.language,
            "includePoiCategories": _comma_join(request.include_poi_categories),
            "excludePoiCategories": _comma_join(request.exclude_poi_categories),
            "resultTypeFilter": request.result_type_filter,
            "limitToCountries": _comma_join(request.limit_to_countries),
        }
        payload = self._http_get(_SEARCH_URL, params, headers)
        results = payload.get("results", [])
        for result in results:
            yield self._to_business_candidate(result, request.session_id)

    def _to_business_candidate(
        self, result: dict[str, Any], session_id: str
    ) -> BusinessCandidate:
        """
        Field-for-field mapping, Search endpoint PlaceResult ->
        BusinessCandidate. See module docstring, "What 'never
        fabricate data' means concretely here", for the full
        field-by-field rationale — every omission below is a field the
        Search endpoint genuinely does not expose, not an oversight.
        """
        structured = result.get("structuredAddress") or {}
        address_lines = result.get("formattedAddressLines") or []
        address = _or_none(", ".join(address_lines))

        coord = result.get("coordinate") or {}
        lat, lon = coord.get("latitude"), coord.get("longitude")
        coordinates = (lat, lon) if lat is not None and lon is not None else None

        return BusinessCandidate(
            pipeline_id=str(uuid.uuid4()),
            session_id=session_id,
            provider=self.provider_id,
            provider_business_id=None,  # Search endpoint exposes no stable id — never fabricated.
            maps_url=None,  # Search endpoint exposes no listing URL — never fabricated.
            name=_or_none(result.get("name")),
            category=_or_none(result.get("poiCategory")),
            address=address,
            city=_or_none(structured.get("locality")),
            country=_or_none(result.get("country")),
            website=None,  # Search endpoint does not expose this — never fabricated.
            phone=None,  # Search endpoint does not expose this — never fabricated.
            rating=None,  # Search endpoint does not expose this — never fabricated.
            review_count=None,  # Search endpoint does not expose this — never fabricated.
            coordinates=coordinates,
            discovered_at=datetime.now(timezone.utc).isoformat(),
            instagram_url=None,  # Search endpoint does not expose this — never fabricated.
        )
