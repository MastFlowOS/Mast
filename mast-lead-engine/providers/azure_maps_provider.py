"""
MAST Engine V2 — AzureMapsProvider
=====================================
(Originally requested as "BingMapsProvider" — see "Architecture review /
target selection" below for why this file, and the class inside it, are
named AzureMapsProvider instead. This is a naming decision made BEFORE
implementation, per this milestone's own instructions, not a rename of
something already built.)

Source: this milestone's own instructions ("implement BingMapsProvider"
— read in full, including its explicit instruction to redirect target
if Bing Maps business search turns out to be deprecated),
engine/interfaces.py:DiscoveryProviderInterface, engine/contracts.py:
BusinessCandidate, and the four existing concrete providers this one is
built alongside — providers/google_maps_provider.py:GoogleMapsProvider,
providers/yelp_provider.py:YelpProvider,
providers/apple_maps_provider.py:AppleMapsProvider, and
providers/overpass_provider.py:OverpassProvider — read for precedent,
not modified. Also read, not modified: providers/provider_metadata.py,
providers/provider_capabilities.py, providers/provider_configuration.py,
providers/registry.py, providers/composite_provider.py,
providers/parallel_composite_provider.py, providers/provider_deduplicator.py.
External reference: Microsoft's own Bing Maps for Enterprise retirement
announcements and Azure Maps REST API documentation (learn.microsoft.com)
— cited throughout the "Architecture review" section below, the same
discipline yelp_provider.py / apple_maps_provider.py / overpass_provider.py
already apply to their respective third-party APIs.

This is not a new architecture. It is a fifth, independent answer to the
same interface GoogleMapsProvider, YelpProvider, AppleMapsProvider, and
OverpassProvider already answer — see "Architecture review" below for
why no engine/, workers/, queues/, models/, or provider-platform file
needed to change to add it.

Architecture review / target selection
----------------------------------------------------------------------
This milestone's own instructions required researching "the official
Bing Maps / Azure Maps Places Search APIs that are currently supported
by Microsoft" and stopping if a genuine architectural contradiction
existed. Research findings, as of this milestone (August 2026):

    1. Bing Maps for Enterprise — the product family that included
       Bing's own Locations/Places-style REST APIs and the Bing Maps
       Spatial Data Services "PointsOfInterest" data source — is
       deprecated. Free (Basic) accounts were retired June 30, 2025;
       paid Enterprise accounts are retired June 30, 2028. Microsoft's
       own retirement notice states plainly: "To avoid service
       disruptions, all implementations using Bing Maps for Enterprise
       REST APIs and SDKs will need to be updated to use Azure Maps by
       the retirement date." Specifically for business/POI discovery —
       the exact capability this milestone needs — Microsoft's own POI
       Entity Types documentation states: "The Bing Maps Spatial Data
       Service – Points of Interest data source is deprecated and will
       be retired on June 30, 2026 ... we recommend updating your
       application to use the Azure Maps Get Search POI API before
       that date."

    2. This is not a soft, community-sourced deprecation notice — it is
       Microsoft's own documentation, for the exact API surface (POI /
       business search) this milestone needs, naming its own official
       successor by name: Azure Maps' Search service, specifically the
       "Get Search POI" operation.

    3. Is there a genuine architectural contradiction that should stop
       this milestone? No. The instructions' stop condition is a
       contradiction between what MAST's business discovery workflow
       needs and what Microsoft's currently-supported API can honestly
       provide — not "the originally-named vendor product is
       deprecated." Azure Maps' Get Search POI operation
       (GET https://atlas.microsoft.com/search/poi/{format}?api-version=1.0)
       is itself a live, documented, currently-supported REST endpoint
       (last documentation update within this milestone's research
       window; no deprecation notice attached to it — see "A note on
       Azure Maps' own Search v1 vs. 2026-01-01 reorganization" below
       for the one nuance worth flagging) that does everything
       GoogleMapsDiscoveryRequest / YelpDiscoveryRequest /
       AppleMapsDiscoveryRequest / OverpassDiscoveryRequest already
       needed from their own sources: a free-text query, real
       category-based filtering (`categorySet`), real country
       filtering (`countrySet`), real radius filtering (`radius` —
       joining OverpassProvider as the second of five providers whose
       source has a genuine native radius primitive), real
       coordinate-biased search (`lat`/`lon`), real bounding-box
       filtering (`topLeft`/`btmRight`), and real offset-based
       pagination (`ofs`, 0-1900) — a materially richer, still-fully-
       supported request surface than what AppleMapsProvider's Search
       endpoint offers today. It returns POI name, address (multiple
       structured fields plus a pre-built `freeformAddress`),
       coordinates, phone, and — notably, unlike every other provider
       in this codebase except OverpassProvider's inconsistent
       `contact:website` tag — a genuine, directly-documented business
       website field (`poi.url`). There is no dimension on which this
       endpoint fails to satisfy what DiscoveryProviderInterface or
       BusinessCandidate need. No blocker. Proceeding to implementation.

    4. Per this milestone's own explicit instruction ("target the
       officially supported replacement rather than a deprecated
       service, and explain that decision before implementation"):
       this file targets Azure Maps' Get Search POI operation, not any
       Bing Maps REST endpoint. Naming this file/class "BingMapsProvider"
       while wiring it to Azure Maps endpoints would itself violate
       this codebase's own "never fabricate data" discipline applied
       one level up — a provider's *name* and *provider_id* are
       supposed to honestly identify its real data source, exactly the
       same way `BusinessCandidate.provider` is required to (see
       google_maps_provider.py / yelp_provider.py / etc., which all
       name themselves after their real upstream). So this milestone's
       deliverable is `AzureMapsProvider` in `azure_maps_provider.py`,
       with `provider_id="azure_maps"` and `display_name="Azure Maps"`
       — an honest name for what this class actually calls. Nothing
       named `BingMapsProvider` or `BingMapsDiscoveryRequest` is
       produced by this milestone; there is no live, currently-
       supported Bing Maps business-search endpoint left to wrap
       honestly.

A note on Azure Maps' own Search v1 vs. 2026-01-01 reorganization
----------------------------------------------------------------------
Separately from the Bing Maps retirement above, Azure Maps' own Search
service is mid-reorganization: starting with API version 2026-01-01,
forward/reverse geocoding and autocomplete are being split into
intent-specific endpoints (`/geocode`, `/geocode:autocomplete`,
`/reverseGeocode`, `/polygon`). As of this milestone's research, that
reorganization covers *address geocoding*, not POI/business search —
Get Search POI, Get Search POI Category, and Get Search Nearby remain
on `api-version=1.0`, with no deprecation notice, no announced
retirement timeline, and no 2026-01-01 replacement identified for them
(a Microsoft Q&A thread from this milestone's research window, asked
directly about Search v1.0's deprecation timeline, was answered by a
Microsoft employee: "We do not have a timeline to deprecate V1 as of
yet and we will announce if and when that is coming"). This file
therefore targets `api-version=1.0`'s Get Search POI operation — the
current, stable, officially-recommended-for-POI-data target — not a
guess at a future POI-specific 2026-01-01 endpoint that does not exist
yet. If Microsoft later ships one, that is a future migration, exactly
the same category of future work as any other API's next version.

Responsibility
--------------
AzureMapsProvider has exactly one job: accept a discovery request,
query the Azure Maps Search service's Get Search POI operation
(GET https://atlas.microsoft.com/search/poi/json), and stream
BusinessCandidate objects — nothing else. Like the four providers
before it, it does not enrich, qualify, score, store, deduplicate,
retry, cache, allocate workers, or own queues.

Why an injectable HTTP callable, not a hardwired HTTP client
--------------------------------------------------------------
Same reasoning as YelpProvider / AppleMapsProvider / OverpassProvider
(see any of those modules' own docstrings, "Why an injectable HTTP
callable, not a hardwired HTTP client"): no Azure Maps HTTP client
exists yet in this codebase, and this milestone's scope is the
provider layer, not "also write and own a general-purpose Azure Maps
HTTP client." `AzureMapsProvider.__init__` accepts an optional
`http_get` callable — `(url, params, headers) -> dict` — defaulting to
a small private helper built on the standard library
(`urllib.request`). Callers with their own HTTP client, retry policy,
or rate limiter may inject it instead. This also makes the provider
testable without network access (see validate_azure_maps_provider.py,
which injects a fake `http_get` returning a canned Get Search POI
response shape, taken directly from Microsoft's own documented
example response).

Authentication — subscription key, passed through, never sourced here
----------------------------------------------------------------------
Azure Maps' documented `subscription-key` security scheme is a shared
key passed as a query-string parameter (Microsoft's own docs: "Type:
apiKey, In: query" — distinct from YelpProvider's/AppleMapsProvider's
bearer-header schemes, because Azure Maps' own documented scheme
genuinely differs). Azure Maps also documents an alternative Microsoft
Entra ID (OAuth2) scheme; this provider does not implement that flow,
for the same reason AppleMapsProvider does not implement Apple's own
JWT-minting flow — credential/token provisioning is a caller concern,
not a discovery-provider concern (see apple_maps_provider.py,
"Authentication"). `AzureMapsProvider` therefore accepts a
caller-supplied `subscription_key: str` and appends it as the
documented `subscription-key` query parameter on every request; it
does not source, refresh, cache, rotate, or validate it beyond passing
it through.

`endpoint_url` — an optional constructor override for the Azure Maps
regional/sovereign-cloud base URL (e.g. Azure Government's
`atlas.azure.us` vs. public cloud's `atlas.microsoft.com` — both real,
Microsoft-documented, independently-addressed base URLs for the same
API surface, differing only in cloud/region). Same "real, documented
alternative endpoint, not a made-up option" justification
OverpassProvider's own `endpoint_url` override already established for
its own multiple public mirrors — see overpass_provider.py, "No
credential required."

Request shape
--------------
Same reasoning as every other provider's discovery request (see
google_maps_provider.py, Ambiguity 3): DiscoveryProviderInterface.
discover() deliberately leaves the request shape as `Any`, and no
shared engine/contracts.py discovery-request contract exists.
`AzureMapsDiscoveryRequest` is therefore defined locally here,
mirroring the Get Search POI operation's own documented query
parameters directly — nothing renamed or reinterpreted in translation:

    - `query` (required) -> `query`. The POI name/free-text term.
    - `limit` -> caller's desired TOTAL candidates across however many
      pages `discover()` issues (mirrors YelpDiscoveryRequest.limit's
      role exactly — see "Pagination" below); NOT sent verbatim as the
      per-request `limit` query parameter, since Azure's own documented
      per-request `limit` caps at 100 while this field can honestly
      exceed that across pages.
    - `category_set` -> `categorySet`, a sequence of Azure's own
      numeric POI category IDs (e.g. 7315 for "Restaurant" — see
      Azure's own POI Categories reference). Exposed as
      `Sequence[int]`, matching the documented type exactly. No niche
      translation happens here — same explicit discipline
      OverpassProvider's `tags` and AppleMapsProvider's
      `include_poi_categories` already apply to their own category
      vocabularies (see overpass_provider.py, "No niche translation —
      by design, not by omission"): this provider does not contain a
      `"restaurant" -> 7315`-style lookup table, and none should be
      added here. A caller wanting that translation needs a layer
      above all five providers that does not exist in this codebase
      today.
    - `country_set` -> `countrySet`, a sequence of ISO ALPHA-2
      country/region codes — real, API-side country filtering, the
      same shape GoogleMapsDiscoveryRequest already had for `country`
      and AppleMapsDiscoveryRequest already had for
      `limit_to_countries`.
    - `lat` / `lon` -> `lat` / `lon`. Coordinate-biased search — an
      input lat/lon to search from/around.
    - `radius` -> `radius`, in meters. Real, API-documented radius
      filtering — Azure Maps' own Get Search POI operation has a
      native radius primitive, the second of five providers in this
      codebase (after OverpassProvider's `around`) whose underlying
      source genuinely has one.
    - `top_left` / `btm_right` -> `topLeft` / `btmRight`, each a
      documented `"lat,lon"` string. Real bounding-box filtering.
    - `language` -> `language`, an IETF language tag.
    - `view` -> `view`, Azure's own documented "user region" parameter
      for geopolitically-disputed-region map compliance; passed
      through unmodified, never defaulted to a specific region by this
      provider (this provider has no authority to decide a caller's
      compliance region for them).
    - `brand_set` -> `brandSet`, a sequence of brand-name strings —
      real, API-side brand filtering.
    - `session_id`, for the same reason every other request carries
      it: BusinessCandidate.session_id is required, and a provider
      must not invent or own session identity itself.

Deliberately excluded — real, documented Get Search POI parameters
this request shape does NOT expose, and why:

    - `typeahead` — switches the operation into predictive/autocomplete
      mode ("the query will be interpreted as a partial input"), a
      different search *intent* than business discovery (matching
      Azure's own 2026-01-01 reorganization rationale for separating
      autocomplete from final search — see "A note on Azure Maps' own
      Search v1 vs. 2026-01-01 reorganization" above). Exposing it here
      would let a caller silently turn a discovery request into an
      autocomplete request; out of scope for this provider's one job.
    - `openingHours` — BusinessCandidate has no field to hold operating
      hours (see engine/contracts.py; no provider in this codebase
      populates anything like it). Requesting it would fetch data this
      provider has nowhere honest to put, and it would need to be
      silently dropped on the way to BusinessCandidate — the request
      shape does not offer parameters this provider cannot honestly
      consume.
    - `extendedPostalCodesFor` — same reasoning: BusinessCandidate.address
      is a single free-text field; there is no
      `extendedPostalCode`-shaped destination for this response
      property to land in.
    - `connectorSet` — restricts results to EV-charging-station POIs
      with specific connector types. Genuinely real and documented, but
      it is a narrow slice of one POI vertical (EV charging), not a
      general business-discovery dimension, and BusinessCandidate has
      no field for connector type. Exposing it would invite a caller to
      build an EV-specific request this provider's own output contract
      cannot represent any more richly than any other POI.

Pagination
-----------
The Get Search POI operation documents a per-request `limit` (default
10, max 100) and a starting `ofs` (offset, min 0, max 1900) — real,
API-side offset pagination, the same primitive YelpProvider's Fusion
API already has (see yelp_provider.py, "Pagination"), with a
documented, enforced ceiling Yelp's own endpoint also has (Yelp: 1000
total; Azure Maps: `ofs` capped at 1900, meaning the last reachable
page starts at offset 1900). `discover()` pages through `ofs`
automatically — issuing one HTTP request per page, each capped at the
documented 100-per-request maximum — yielding candidates as each page
arrives, until any of: `request.limit` total candidates have been
yielded, a page comes back with fewer results than requested (source
exhausted), or the next page's starting offset would exceed the
documented `ofs` ceiling of 1900. Nothing is materialized beyond one
page at a time — the full result set is never held in memory at once,
matching DiscoveryProviderInterface's streaming requirement, the same
"page at a time, still streaming" shape YelpProvider already has.

What "never fabricate data" means concretely here
-----------------------------------------------------
Every BusinessCandidate field below is populated only when the Get
Search POI operation's own documented response
(`SearchAddressResultItem`, inside `results[]`) actually contains the
corresponding value. Fields BusinessCandidate has that this documented
response shape simply does not expose are left at their
BusinessCandidate default (None) rather than guessed, derived, or
backfilled from another field:

    - rating / review_count: `PointOfInterest` (the `poi` object) and
      `SearchAddressResultItem` document no rating or review-count
      field of any kind — Azure Maps' Search service is a
      geocoding/POI-search endpoint, not a ratings/reviews API, the
      same category of gap AppleMapsProvider's Search endpoint has for
      the identical reason (see apple_maps_provider.py, "What 'never
      fabricate data' means concretely here"). Left None for both.
    - maps_url: the documented response has no canonical
      "maps listing page" URL field distinct from `poi.url` (which IS
      documented, and IS mapped — to `website`, below, since that is
      what it actually is: the business's own website, per Azure's own
      field description "Website URL property"). Left None rather than
      constructing an atlas.microsoft.com or bing.com/maps search-link
      guess, or misusing `poi.url` as a maps link it isn't — the same
      "constructed URL is not an API-returned one" discipline
      AppleMapsProvider already applies to this exact field.
    - instagram_url: not part of the documented response. Left None
      (an expected, normal outcome per BusinessCandidate's own
      docstring on this field).
    - website: mapped from `poi.url` directly — see `maps_url` above.
      Notably, this is the one provider (of five) whose documented
      response genuinely contains a business's own website URL as a
      first-class field, not a listing-page or maps-link substitute;
      GoogleMapsProvider/YelpProvider/AppleMapsProvider all leave this
      None because their own sources don't expose it (see each
      module's own docstring). Mapped here because — and only because
      — Azure's own documentation genuinely supports it.
    - phone: mapped from `poi.phone` directly.
    - provider_business_id: mapped from the result item's own `id`
      field — Azure's own documented per-result identifier, the direct
      analogue of Yelp's `id` (see yelp_provider.py).
    - name: mapped from `poi.name` directly.
    - category: the first entry of `poi.categories[]` (a plain
      string array, distinct from the numeric `categorySet` request
      parameter and from the coded `classifications[]` response
      field) — matching how a single BusinessCandidate.category string
      field can only hold one category, the same "first entry of a
      documented array" discipline YelpProvider already applies to
      Fusion API's `categories[].title`. Left None if `categories` is
      absent or empty.
    - address: mapped from `address.freeformAddress` — Azure's own
      pre-built, single-line formatted address, documented as "An
      address line formatted according to the formatting rules of a
      result's country/region of origin." Used as-is, never
      reconstructed from `address`'s many structured sub-fields
      (streetNumber, streetName, municipality, ...) the way Yelp's/
      Apple's `address` fields have to be built by joining lines —
      Azure's response already does that joining for us, so this
      provider does not redo it.
    - city: mapped from `address.municipality` — Azure's own
      documented "City / Town" field. (Azure's own documentation notes
      `localName` is sometimes the more "commonly known" city name for
      a given location; `municipality` is used here as the one
      directly-labeled "City / Town" field, the same "use the
      field whose own documented meaning matches the
      BusinessCandidate field, don't chase a second, softer field"
      discipline every other provider's field selection already
      applies.)
    - country: mapped from `address.country` — the full country/region
      name Azure's own response returns, matching this field 1:1 with
      no reinterpretation, same as AppleMapsProvider's `country`
      mapping.
    - coordinates: `position.lat` / `position.lon`, populated as a
      (lat, lon) tuple when both are present in the response (which,
      per the documented schema, is unconditional for POI results —
      still guarded defensively here, matching every other provider's
      own coordinate-mapping caution).

Status
------
BingMapsProvider milestone (redirected to Azure Maps — see
"Architecture review / target selection" above). Fifth concrete
DiscoveryProviderInterface implementation, added alongside
GoogleMapsProvider, YelpProvider, AppleMapsProvider, and
OverpassProvider; does not replace, wrap, call, or modify any of them.
engine/, workers/, queues/, models/, and every existing
provider-platform file (interfaces.py, contracts.py, registry.py,
composite_provider.py, parallel_composite_provider.py,
provider_deduplicator.py, provider_metadata.py,
provider_capabilities.py, provider_configuration.py, __init__.py) are
untouched by this file — see this milestone's deliverable summary for
the full "zero architectural changes required" accounting.
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

_DEFAULT_ENDPOINT = "https://atlas.microsoft.com"
_SEARCH_PATH = "/search/poi/json"
_API_VERSION = "1.0"
_PAGE_SIZE = 100  # Get Search POI's own documented per-request maximum.
_MAX_OFFSET = 1900  # Get Search POI's own documented `ofs` ceiling.


# ---------------------------------------------------------------------------
# Request shape (provider-local — mirrors GoogleMapsDiscoveryRequest /
# YelpDiscoveryRequest / AppleMapsDiscoveryRequest / OverpassDiscoveryRequest)
# ---------------------------------------------------------------------------
@dataclass(frozen=True, slots=True)
class AzureMapsDiscoveryRequest:
    """
    This provider's own accepted request shape. Not a shared
    engine/contracts.py contract — same reasoning as every other
    provider-local request (see google_maps_provider.py, Ambiguity 3).
    Field names mirror the Get Search POI operation's own documented
    query parameters directly (`query`, `categorySet`, `countrySet`,
    `lat`, `lon`, `radius`, `topLeft`, `btmRight`, `language`, `view`,
    `brandSet`) so nothing is renamed or reinterpreted in translation,
    plus `session_id`, owned by the caller, and `limit`, whose meaning
    is this request's TOTAL desired candidates across pages — see
    module docstring, "Request shape" and "Pagination", for the full
    rationale on every field, including the documented parameters
    deliberately NOT exposed here (`typeahead`, `openingHours`,
    `extendedPostalCodesFor`, `connectorSet`).
    """

    session_id: str
    query: str
    limit: int = 50
    category_set: Optional[Sequence[int]] = None
    country_set: Optional[Sequence[str]] = None
    lat: Optional[float] = None
    lon: Optional[float] = None
    radius: Optional[int] = None  # meters
    top_left: Optional[str] = None  # "lat,lon"
    btm_right: Optional[str] = None  # "lat,lon"
    language: Optional[str] = None
    view: Optional[str] = None
    brand_set: Optional[Sequence[str]] = None


def _http_get_urllib(url: str, params: dict[str, Any], headers: dict[str, str]) -> dict[str, Any]:
    """
    Default transport: a plain stdlib GET against the Get Search POI
    operation. Injected as `http_get` by default; callers may supply
    their own (see module docstring for why). Raises whatever urllib
    raises on a non-2xx response or network failure — propagated
    unchanged, same "provider failures stay isolated to the provider,
    but are never hidden from the caller" rule every other provider in
    this codebase follows.
    """
    query = urlencode({k: v for k, v in params.items() if v not in (None, "")})
    request = Request(f"{url}?{query}", headers=headers, method="GET")
    with urlopen(request, timeout=15) as response:
        return json.loads(response.read().decode("utf-8"))


def _or_none(value: Optional[str]) -> Optional[str]:
    """Same "" / None normalization helper as every other provider."""
    return value if value else None


def _comma_join_str(values: Optional[Sequence[str]]) -> Optional[str]:
    """
    Azure Maps' documented wire format for `countrySet`, `brandSet`,
    etc. is a single comma-separated string — this is the one place
    that joining happens, mirroring AppleMapsProvider's own
    `_comma_join` helper, so `AzureMapsDiscoveryRequest` itself can
    stay a plain `Sequence[str]` per field rather than asking a caller
    to pre-format Azure's own wire syntax. Returns None (omitted from
    the request entirely) when `values` is None or empty.
    """
    if not values:
        return None
    return ",".join(values)


def _comma_join_int(values: Optional[Sequence[int]]) -> Optional[str]:
    """Same as `_comma_join_str`, for `categorySet`'s integer IDs."""
    if not values:
        return None
    return ",".join(str(v) for v in values)


class AzureMapsProvider(DiscoveryProviderInterface):
    """
    Adapts Azure Maps' Search service Get Search POI operation to
    DiscoveryProviderInterface. Independent of GoogleMapsProvider,
    YelpProvider, AppleMapsProvider, and OverpassProvider: no shared
    code, no shared state, no dependency on any of their transports.

    Stateless: every discover() call issues its own HTTP request(s)
    against the injected (or default) transport; nothing is cached or
    shared across calls or instances.
    """

    def __init__(
        self,
        subscription_key: str,
        http_get: Optional[Callable[[str, dict[str, Any], dict[str, str]], dict[str, Any]]] = None,
        endpoint_url: Optional[str] = None,
    ) -> None:
        """
        `subscription_key` is the caller's already-provisioned Azure
        Maps subscription key — this provider does not source, mint,
        rotate, cache, or validate it beyond passing it through as the
        documented `subscription-key` query parameter; credential
        management belongs to whoever configures the provider, not to
        the provider itself (see module docstring, "Authentication").

        `http_get` defaults to `_http_get_urllib` (a real network
        call). Injecting a different callable — e.g. a fake for tests,
        or a caller's own rate-limited HTTP client — never requires
        touching `discover()` or any engine code.

        `endpoint_url` defaults to Azure public cloud's own documented
        base URL (`https://atlas.microsoft.com`). Overridable for a
        real, documented alternative base URL (e.g. a sovereign-cloud
        deployment) — see module docstring, "Authentication", final
        paragraph.
        """
        self._subscription_key = subscription_key
        self._http_get = http_get or _http_get_urllib
        self._endpoint_url = endpoint_url or _DEFAULT_ENDPOINT

    @property
    def provider_id(self) -> str:
        return "azure_maps"

    @property
    def display_name(self) -> str:
        return "Azure Maps"

    @classmethod
    def metadata(cls) -> ProviderMetadata:
        """
        This provider's own static characteristics — see
        provider_metadata.py for the full field-by-field rationale,
        and YelpProvider.metadata() / AppleMapsProvider.metadata() for
        why this is a classmethod rather than an instance property:
        AzureMapsProvider.__init__ requires a `subscription_key`, so a
        caller wanting this provider's metadata (e.g. to populate a
        selection UI, or to register it in a ProviderRegistry) must
        not be forced to already have a valid key on hand just to
        learn that this provider requires one.
        """
        return ProviderMetadata(
            provider_id="azure_maps",
            display_name="Azure Maps",
            description=(
                "Streams BusinessCandidate objects from Azure Maps' "
                "Search service Get Search POI operation — Microsoft's "
                "own officially recommended successor to Bing Maps' "
                "retired POI/business-search capability."
            ),
            provider_type="business_directory_api",
            requires_api_key=True,
            default_enabled=True,
            homepage="https://learn.microsoft.com/en-us/rest/api/maps/search/get-search-poi",
            version="1.0.0",
        )

    CAPABILITIES: ProviderCapabilities = ProviderCapabilities(
        supports_keyword_search=True,
        supports_category_search=True,
        supports_city_filter=False,
        supports_country_filter=True,
        supports_radius_search=True,
        supports_coordinate_search=True,
        supported_entity_types=("local_business",),
        provides_phone_numbers=True,
        supports_pagination=True,
        supports_streaming=True,
    )

    @classmethod
    def capabilities(cls) -> ProviderCapabilities:
        """Return what a caller can ask this provider's discover() to search by."""
        return cls.CAPABILITIES

    def discover(self, request: AzureMapsDiscoveryRequest) -> Iterator[BusinessCandidate]:
        """
        Streams BusinessCandidate objects for `request`, paging through
        Get Search POI's offset-based pagination one page at a time
        (see module docstring, "Pagination"). Any exception raised by
        the HTTP transport propagates unchanged — nothing here catches
        or swallows it.
        """
        url = f"{self._endpoint_url}{_SEARCH_PATH}"
        yielded = 0
        offset = 0

        while yielded < request.limit and offset <= _MAX_OFFSET:
            page_limit = min(_PAGE_SIZE, request.limit - yielded)
            params = {
                "api-version": _API_VERSION,
                "subscription-key": self._subscription_key,
                "query": request.query,
                "limit": page_limit,
                "ofs": offset,
                "categorySet": _comma_join_int(request.category_set),
                "countrySet": _comma_join_str(request.country_set),
                "lat": request.lat,
                "lon": request.lon,
                "radius": request.radius,
                "topLeft": request.top_left,
                "btmRight": request.btm_right,
                "language": request.language,
                "view": request.view,
                "brandSet": _comma_join_str(request.brand_set),
            }
            payload = self._http_get(url, params, {})
            results = payload.get("results", [])
            if not results:
                break

            for result in results:
                yield self._to_business_candidate(result, request.session_id)
                yielded += 1
                if yielded >= request.limit:
                    break

            if len(results) < page_limit:
                break  # Source exhausted before request.limit was reached.
            offset += len(results)

    def _to_business_candidate(
        self, result: dict[str, Any], session_id: str
    ) -> BusinessCandidate:
        """
        Field-for-field mapping, Get Search POI SearchAddressResultItem
        -> BusinessCandidate. See module docstring, "What 'never
        fabricate data' means concretely here", for the full
        field-by-field rationale — every omission below is a field the
        Get Search POI response genuinely does not expose, not an
        oversight.
        """
        poi = result.get("poi") or {}
        address = result.get("address") or {}
        position = result.get("position") or {}

        categories = poi.get("categories") or []
        category = _or_none(categories[0]) if categories else None

        lat, lon = position.get("lat"), position.get("lon")
        coordinates = (lat, lon) if lat is not None and lon is not None else None

        return BusinessCandidate(
            pipeline_id=str(uuid.uuid4()),
            session_id=session_id,
            provider=self.provider_id,
            provider_business_id=_or_none(result.get("id")),
            maps_url=None,  # No documented maps-listing URL — never fabricated.
            name=_or_none(poi.get("name")),
            category=category,
            address=_or_none(address.get("freeformAddress")),
            city=_or_none(address.get("municipality")),
            country=_or_none(address.get("country")),
            website=_or_none(poi.get("url")),
            phone=_or_none(poi.get("phone")),
            rating=None,  # Get Search POI does not expose this — never fabricated.
            review_count=None,  # Get Search POI does not expose this — never fabricated.
            coordinates=coordinates,
            discovered_at=datetime.now(timezone.utc).isoformat(),
            instagram_url=None,  # Get Search POI does not expose this — never fabricated.
        )
