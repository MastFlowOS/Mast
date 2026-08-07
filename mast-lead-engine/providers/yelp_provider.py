"""
MAST Engine V2 — YelpProvider
================================

Source: Engine BluePrint, Phase 1.5 Stage 2 ("Provider Layer") and the
"remove Google Maps, replace it with LinkedIn/Yelp" extensibility test
that Phase 1.5 poses for this layer. Built directly against
engine/interfaces.py:DiscoveryProviderInterface and
engine/contracts.py:BusinessCandidate — the same two contracts
GoogleMapsProvider is built against — and against no other engine
module.

Purpose of this file
---------------------
This is not a new architecture. It is a second, independent answer to
the same interface GoogleMapsProvider already answers, written to
settle the extensibility question the blueprint asks outright: "If I
remove Google Maps tomorrow and replace it with LinkedIn [or Yelp], how
many files change?" This file, plus its one line of registration
wherever a caller chooses to instantiate a provider, is the answer.
Nothing under engine/, workers/, queues/, or models/ is read, imported,
or modified to make this work.

Responsibility
--------------
YelpProvider has exactly one job: accept a discovery request, query
the Yelp Fusion API's Business Search endpoint
(GET https://api.yelp.com/v3/businesses/search), and stream
BusinessCandidate objects — nothing else. Like GoogleMapsProvider, it
does not enrich, qualify, score, store, deduplicate, retry, cache,
allocate workers, or own queues.

Why an injectable HTTP callable, not a hardwired HTTP client
--------------------------------------------------------------
GoogleMapsProvider wraps an existing, already-built scraper
(MapsScraper) that this codebase owns. No equivalent Yelp client exists
yet, and this milestone's scope is the provider layer, not "also write
and own a general-purpose Yelp HTTP client." So `YelpProvider.__init__`
accepts an optional `http_get` callable — `(url, params, headers) ->
dict` — defaulting to a small private helper built on the standard
library (`urllib.request`), which performs the real network call
against the Fusion API. Callers who already have their own HTTP
client, retry policy, or rate limiter are free to inject it instead of
letting this provider construct its own. This mirrors the same
"provider is a thin wrapper, not the owner of the underlying
transport" shape GoogleMapsProvider already has with MapsScraper — the
transport (urllib call vs. Playwright scraper) differs because the two
data sources differ, but the provider's responsibility relative to
that transport does not.

This also happens to make the provider trivially testable without any
network access at all: a test (see validate_yelp_provider.py) can
inject a fake `http_get` that returns a canned Fusion API response
shape and assert on the resulting BusinessCandidate stream, exactly as
a caller might unit test GoogleMapsProvider by injecting a fake
MapsScraper if that provider were refactored to accept one.

What "never fabricate data" means concretely here
-----------------------------------------------------
Every BusinessCandidate field below is populated only when the Yelp
Fusion API response actually contains the corresponding value.
Fields the Fusion API's Business Search response does not expose at
all are left at their BusinessCandidate default (None) rather than
guessed, derived, or backfilled from another field:

    - website: the Fusion API's business object does not include a
      business website URL (Yelp does not expose it through this
      endpoint). Left None. It is NOT set to the Yelp listing URL —
      that would misrepresent someone else's website field with a
      Yelp link.
    - instagram_url: Fusion API does not expose social links. Left
      None (an expected, normal outcome per BusinessCandidate's own
      docstring on this field).
    - provider_business_id: Fusion API's `id` field IS a stable
      per-business identifier (unlike Google Maps, which only exposed
      a URL to RawPlace) — populated directly.
    - maps_url: mapped from Fusion API's `url` field — Yelp's own
      canonical listing page for the business, the direct analogue of
      RawPlace.maps_link for GoogleMapsProvider.
    - coordinates: Fusion API returns `coordinates.latitude` /
      `coordinates.longitude` directly (unlike Google Maps, whose
      scraper never extracted them) — populated as a (lat, lon) tuple
      when both are present, left None if the response omits either.
    - address / city / country: built from Fusion API's `location`
      object (`display_address` joined for `address`, `city`,
      `country` verbatim) — never inferred from `location` sub-fields
      the response didn't supply.
    - phone: Fusion API's `display_phone` (human-formatted) is
      preferred when present, falling back to the raw `phone` field —
      both are Yelp-reported values for the same field, never a
      constructed or reformatted one.
    - rating / review_count: mapped directly from `rating` /
      `review_count`.
    - category: the first entry of `categories[]` (each an object with
      a `title`), matching how a single BusinessCandidate.category
      string field can only hold one category. Left None if
      `categories` is absent or empty — not defaulted to a guessed
      string.

Request shape
--------------
Same reasoning as GoogleMapsDiscoveryRequest in google_maps_provider.py
(see that module's Ambiguity 3): DiscoveryProviderInterface.discover()
deliberately leaves the request shape as `Any`, and no shared
DiscoverySession/discovery-request contract exists in
engine/contracts.py yet. YelpDiscoveryRequest is therefore defined
locally here, as this provider's own accepted request shape — mirroring
exactly what the Fusion API's Business Search endpoint accepts
(term, location, categories, limit), plus `session_id` for the same
reason GoogleMapsDiscoveryRequest carries it: BusinessCandidate.session_id
is required, and a provider must not invent or own session identity
itself.

Pagination
-----------
The Fusion API caps a single request at 50 results (`limit`) and
exposes further results via `offset`, up to a documented total of
1000. `discover()` pages through `offset` automatically, yielding
candidates as each page arrives, until either `request.limit` total
candidates have been yielded, a page comes back with fewer results
than requested (source exhausted), or the API's own total ceiling is
reached. Nothing is materialized beyond one page at a time — the full
result set is never held in memory at once, matching
DiscoveryProviderInterface's streaming requirement.

Status
------
Extensibility validation milestone. Second concrete
DiscoveryProviderInterface implementation. Added alongside
GoogleMapsProvider; does not replace, wrap, call, or modify it.
scraper/, engine/, workers/, queues/, models/ are all untouched by this
file.
"""

from __future__ import annotations

import json
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Callable, Iterator, Optional
from urllib.request import Request, urlopen
from urllib.parse import urlencode

from engine.contracts import BusinessCandidate
from engine.interfaces import DiscoveryProviderInterface
from providers.provider_capabilities import ProviderCapabilities
from providers.provider_metadata import ProviderMetadata

_FUSION_SEARCH_URL = "https://api.yelp.com/v3/businesses/search"
_PAGE_SIZE = 50  # Fusion API's own per-request maximum.


# ---------------------------------------------------------------------------
# Request shape (provider-local — mirrors GoogleMapsDiscoveryRequest)
# ---------------------------------------------------------------------------
@dataclass(frozen=True, slots=True)
class YelpDiscoveryRequest:
    """
    This provider's own accepted request shape. Not a shared
    engine/contracts.py contract — same reasoning as
    GoogleMapsDiscoveryRequest (see google_maps_provider.py, Ambiguity
    3). Field names mirror the Fusion API's Business Search query
    parameters directly (term, location, categories, limit) so nothing
    is renamed or reinterpreted in translation, plus `session_id`,
    owned by the caller.
    """

    session_id: str
    term: str
    location: str
    categories: str = ""
    limit: int = 50


def _http_get_urllib(url: str, params: dict[str, Any], headers: dict[str, str]) -> dict[str, Any]:
    """
    Default transport: a plain stdlib GET against the Fusion API.
    Injected as `http_get` by default; callers may supply their own
    (see module docstring for why). Raises whatever urllib raises on a
    non-2xx response or network failure — propagated unchanged, same
    "provider failures stay isolated to the provider, but are never
    hidden from the caller" rule GoogleMapsProvider follows.
    """
    query = urlencode({k: v for k, v in params.items() if v not in (None, "")})
    request = Request(f"{url}?{query}", headers=headers, method="GET")
    with urlopen(request, timeout=15) as response:
        return json.loads(response.read().decode("utf-8"))


def _or_none(value: Optional[str]) -> Optional[str]:
    """Same "" / None normalization helper as google_maps_provider.py."""
    return value if value else None


class YelpProvider(DiscoveryProviderInterface):
    """
    Adapts the Yelp Fusion API's Business Search endpoint to
    DiscoveryProviderInterface. Independent of GoogleMapsProvider: no
    shared code, no shared state, no dependency on
    scraper/maps_scraper.py.

    Stateless: every discover() call issues its own HTTP requests
    against the injected (or default) transport; nothing is cached or
    shared across calls or instances.
    """

    def __init__(
        self,
        api_key: str,
        http_get: Optional[Callable[[str, dict[str, Any], dict[str, str]], dict[str, Any]]] = None,
    ) -> None:
        """
        `api_key` is the caller's Yelp Fusion API key — this provider
        does not source, cache, or validate credentials beyond passing
        them through as a bearer token; credential management belongs
        to whoever configures the provider, not to the provider itself.

        `http_get` defaults to `_http_get_urllib` (a real network
        call). Injecting a different callable — e.g. a fake for tests,
        or a caller's own rate-limited HTTP client — never requires
        touching `discover()` or any engine code.
        """
        self._api_key = api_key
        self._http_get = http_get or _http_get_urllib

    @property
    def provider_id(self) -> str:
        return "yelp"

    @property
    def display_name(self) -> str:
        return "Yelp"

    @classmethod
    def metadata(cls) -> ProviderMetadata:
        """
        This provider's own static characteristics — see
        provider_metadata.py for the full field-by-field rationale,
        and GoogleMapsProvider.metadata() for why this is a
        classmethod rather than an instance property.

        This is the concrete case that motivates the classmethod
        design: YelpProvider.__init__ requires an `api_key`, so a
        caller wanting this provider's metadata (e.g. to populate a
        selection UI, or to register it in a ProviderRegistry) must
        not be forced to already have a valid Yelp Fusion API key on
        hand just to learn that this provider requires one.
        """
        return ProviderMetadata(
            provider_id="yelp",
            display_name="Yelp",
            description=(
                "Streams BusinessCandidate objects from the Yelp "
                "Fusion API's Business Search endpoint."
            ),
            provider_type="business_directory_api",
            requires_api_key=True,
            default_enabled=True,
            homepage="https://www.yelp.com/developers",
            version="1.0.0",
        )

    CAPABILITIES: ProviderCapabilities = ProviderCapabilities(
        supports_keyword_search=True,
        supports_category_search=True,
        supports_city_filter=True,
        supports_country_filter=False,
        supports_radius_search=False,
        supports_coordinate_search=False,
        supported_entity_types=("local_business",),
        provides_phone_numbers=True,
        supports_pagination=True,
        supports_streaming=True,
    )

    @classmethod
    def capabilities(cls) -> ProviderCapabilities:
        """
        This provider's own search functionality — see
        provider_capabilities.py for the full field-by-field rationale.

        A classmethod, not an instance property — same reasoning as
        `metadata()` above, and the same concrete motivation:
        YelpProvider.__init__ requires an `api_key`, so a caller
        wanting this provider's capabilities (e.g. to populate a
        selection UI, or to compare providers before choosing one)
        must not be forced to already have a valid Yelp Fusion API key
        on hand just to learn what this provider can search by.

        Return what a caller can ask this provider's discover() to search by.
        """
        return cls.CAPABILITIES

    def discover(self, request: YelpDiscoveryRequest) -> Iterator[BusinessCandidate]:
        """
        Streams BusinessCandidate objects for `request`, paging
        through the Fusion API's offset-based pagination one page at a
        time (see module docstring, "Pagination"). Any exception
        raised by the HTTP transport propagates unchanged — nothing
        here catches or swallows it.
        """
        headers = {"Authorization": f"Bearer {self._api_key}"}
        yielded = 0
        offset = 0

        while yielded < request.limit:
            page_limit = min(_PAGE_SIZE, request.limit - yielded)
            params = {
                "term": request.term,
                "location": request.location,
                "categories": request.categories,
                "limit": page_limit,
                "offset": offset,
            }
            payload = self._http_get(_FUSION_SEARCH_URL, params, headers)
            businesses = payload.get("businesses", [])
            if not businesses:
                break

            for business in businesses:
                yield self._to_business_candidate(business, request.session_id)
                yielded += 1
                if yielded >= request.limit:
                    break

            if len(businesses) < page_limit:
                break  # Source exhausted before request.limit was reached.
            offset += len(businesses)

    def _to_business_candidate(
        self, business: dict[str, Any], session_id: str
    ) -> BusinessCandidate:
        """
        Field-for-field mapping, Fusion API business object ->
        BusinessCandidate. See module docstring, "What 'never
        fabricate data' means concretely here", for the full
        field-by-field rationale — every omission below is a field the
        Fusion API genuinely does not expose, not an oversight.
        """
        location = business.get("location") or {}
        address = _or_none(", ".join(location.get("display_address", []) or []))

        categories = business.get("categories") or []
        category = _or_none(categories[0]["title"]) if categories else None

        coords = business.get("coordinates") or {}
        lat, lon = coords.get("latitude"), coords.get("longitude")
        coordinates = (lat, lon) if lat is not None and lon is not None else None

        phone = business.get("display_phone") or business.get("phone")

        return BusinessCandidate(
            pipeline_id=str(uuid.uuid4()),
            session_id=session_id,
            provider=self.provider_id,
            provider_business_id=_or_none(business.get("id")),
            maps_url=_or_none(business.get("url")),
            name=_or_none(business.get("name")),
            category=category,
            address=address,
            city=_or_none(location.get("city")),
            country=_or_none(location.get("country")),
            website=None,  # Fusion API does not expose this — never fabricated.
            phone=_or_none(phone),
            rating=business.get("rating"),
            review_count=business.get("review_count"),
            coordinates=coordinates,
            discovered_at=datetime.now(timezone.utc).isoformat(),
            instagram_url=None,  # Fusion API does not expose this — never fabricated.
        )
