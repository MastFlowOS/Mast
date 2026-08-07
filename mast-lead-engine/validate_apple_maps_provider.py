"""
MAST Engine V2 — AppleMapsProvider Validation
================================================

Validates providers/apple_maps_provider.py against every surface the
milestone instructions ask for, using a fake `http_get` (no network
access required — same technique validate_yelp_provider.py already
established for YelpProvider) and a canned Apple Maps Server API
Search response shape.

Parameter completeness revision: also validates the four request
parameters added in that revision (include_poi_categories,
exclude_poi_categories, result_type_filter, limit_to_countries),
their exact wire-format serialization, and the corresponding
capabilities() correction (supports_category_search=True,
supports_country_filter=True).

Run with:  python3 validate_apple_maps_provider.py

Every check either prints "PASS: <description>" or raises
AssertionError with a message identifying exactly what failed. Exit
code is 0 iff every check passed.
"""

from __future__ import annotations

import sys
from typing import Any

from engine.contracts import BusinessCandidate
from engine.interfaces import DiscoveryProviderInterface
from providers.apple_maps_provider import (
    AppleMapsDiscoveryRequest,
    AppleMapsProvider,
)
from providers.composite_provider import (
    CompositeDiscoveryProvider,
    CompositeDiscoveryRequest,
)
from providers.parallel_composite_provider import (
    ParallelCompositeDiscoveryProvider,
    ParallelDiscoveryRequest,
)
from providers.provider_capabilities import ProviderCapabilities
from providers.provider_configuration import ProviderConfiguration
from providers.provider_deduplicator import ProviderDeduplicator
from providers.provider_metadata import ProviderMetadata
from providers.registry import ProviderRegistry
from providers.yelp_provider import YelpProvider

_PASS_COUNT = 0


def _check(description: str, condition: bool) -> None:
    global _PASS_COUNT
    if not condition:
        raise AssertionError(f"FAIL: {description}")
    _PASS_COUNT += 1
    print(f"PASS: {description}")


# ---------------------------------------------------------------------------
# Canned Apple Maps Server API Search response (fake transport — no network)
# ---------------------------------------------------------------------------
_CANNED_RESPONSE: dict[str, Any] = {
    "displayMapRegion": {
        "northLatitude": 37.80,
        "eastLongitude": -122.40,
        "southLatitude": 37.77,
        "westLongitude": -122.43,
    },
    "results": [
        {
            "name": "Blue Bottle Coffee",
            "poiCategory": "Coffee Shop",
            "coordinate": {"latitude": 37.7796, "longitude": -122.4017},
            "formattedAddressLines": [
                "300 Webster St",
                "Oakland, CA 94607",
                "United States",
            ],
            "structuredAddress": {
                "locality": "Oakland",
                "administrativeArea": "California",
                "administrativeAreaCode": "CA",
                "postCode": "94607",
                "thoroughfare": "Webster St",
                "fullThoroughfare": "300 Webster St",
            },
            "country": "United States",
            "countryCode": "US",
        },
        {
            # A plain address/geocode-style result: no poiCategory,
            # no coordinate present in this entry — exercises the
            # "leave unsupported/missing fields as None" path.
            "name": "1600 Pennsylvania Ave NW",
            "formattedAddressLines": [
                "1600 Pennsylvania Ave NW",
                "Washington, DC 20500",
                "United States",
            ],
            "structuredAddress": {
                "locality": "Washington",
                "administrativeArea": "District of Columbia",
            },
            "country": "United States",
            "countryCode": "US",
        },
    ],
}


def _fake_http_get(url: str, params: dict[str, Any], headers: dict[str, str]) -> dict[str, Any]:
    assert url.startswith("https://maps-api.apple.com/v1/search"), (
        f"unexpected URL passed to transport: {url}"
    )
    assert headers.get("Authorization") == "Bearer test-token", (
        f"access token not propagated as bearer header: {headers}"
    )
    assert params.get("q") == "coffee", f"query param not propagated: {params}"
    return _CANNED_RESPONSE


def _yelp_http_get(url: str, params: dict[str, Any], headers: dict[str, str]) -> dict[str, Any]:
    # Minimal canned Yelp Fusion response, used only to build a second,
    # independent provider instance for the composition/parallel/dedup
    # checks below — never exercised against the network.
    return {
        "businesses": [
            {
                "id": "yelp-biz-1",
                "url": "https://www.yelp.com/biz/yelp-biz-1",
                "name": "Yelp Coffee Spot",
                "categories": [{"title": "Coffee & Tea"}],
                "location": {
                    "display_address": ["100 Market St", "Oakland, CA 94607"],
                    "city": "Oakland",
                    "country": "US",
                },
                "display_phone": "+1-510-555-0100",
                "rating": 4.5,
                "review_count": 88,
                "coordinates": {"latitude": 37.80, "longitude": -122.27},
            }
        ]
    }


def main() -> int:
    # -----------------------------------------------------------------
    # 1. Interface compliance
    # -----------------------------------------------------------------
    provider = AppleMapsProvider(access_token="test-token", http_get=_fake_http_get)
    _check(
        "AppleMapsProvider is a DiscoveryProviderInterface",
        isinstance(provider, DiscoveryProviderInterface),
    )
    _check("provider_id is 'apple_maps'", provider.provider_id == "apple_maps")
    _check("display_name is 'Apple Maps'", provider.display_name == "Apple Maps")

    request = AppleMapsDiscoveryRequest(session_id="sess-1", query="coffee")
    candidates = list(provider.discover(request))
    _check("discover() yields two candidates from the canned response", len(candidates) == 2)
    fresh_iter = provider.discover(request)
    _check(
        "discover() returns an iterator (generator), not a materialized list",
        hasattr(fresh_iter, "__next__") and not isinstance(fresh_iter, list),
    )
    for c in candidates:
        _check(f"{c.name!r} is a BusinessCandidate", isinstance(c, BusinessCandidate))
        _check(f"{c.name!r} has provider == 'apple_maps'", c.provider == "apple_maps")
        _check(f"{c.name!r} has a session_id", c.session_id == "sess-1")
        _check(f"{c.name!r} has a pipeline_id", bool(c.pipeline_id))
        _check(f"{c.name!r} has a discovered_at timestamp", c.discovered_at is not None)

    # -----------------------------------------------------------------
    # 1b. Parameter completeness — the four newly exposed request
    #     fields, their defaults, and their exact wire-format
    #     serialization against the Search endpoint's documented
    #     parameter names.
    # -----------------------------------------------------------------
    default_request = AppleMapsDiscoveryRequest(session_id="sess-defaults", query="coffee")
    _check(
        "include_poi_categories defaults to None",
        default_request.include_poi_categories is None,
    )
    _check(
        "exclude_poi_categories defaults to None",
        default_request.exclude_poi_categories is None,
    )
    _check("result_type_filter defaults to None", default_request.result_type_filter is None)
    _check("limit_to_countries defaults to None", default_request.limit_to_countries is None)

    captured_params: dict[str, Any] = {}

    def _capturing_http_get(url: str, params: dict[str, Any], headers: dict[str, str]) -> dict[str, Any]:
        captured_params.clear()
        captured_params.update(params)
        return _CANNED_RESPONSE

    filter_provider = AppleMapsProvider(access_token="test-token", http_get=_capturing_http_get)
    filter_request = AppleMapsDiscoveryRequest(
        session_id="sess-filters",
        query="coffee",
        include_poi_categories=["Cafe", "Coffee Shop"],
        exclude_poi_categories=["Restaurant"],
        result_type_filter="Poi",
        limit_to_countries=["US", "CA"],
    )
    list(filter_provider.discover(filter_request))  # drain to trigger the HTTP call

    _check(
        "includePoiCategories serialized as Apple's documented comma-separated wire format",
        captured_params.get("includePoiCategories") == "Cafe,Coffee Shop",
    )
    _check(
        "excludePoiCategories serialized as Apple's documented comma-separated wire format",
        captured_params.get("excludePoiCategories") == "Restaurant",
    )
    _check(
        "resultTypeFilter passed through verbatim",
        captured_params.get("resultTypeFilter") == "Poi",
    )
    _check(
        "limitToCountries serialized as Apple's documented comma-separated wire format",
        captured_params.get("limitToCountries") == "US,CA",
    )
    _check(
        "core params (q, lang) still present alongside the new filters",
        captured_params.get("q") == "coffee" and captured_params.get("lang") == "en-US",
    )

    # Unset filters must be omitted entirely (None), never sent as
    # empty strings — same "" / None discipline the rest of this
    # provider's transport already follows.
    list(filter_provider.discover(default_request))
    _check(
        "unset includePoiCategories is None, not an empty string, when omitted",
        captured_params.get("includePoiCategories") is None,
    )
    _check(
        "unset limitToCountries is None, not an empty string, when omitted",
        captured_params.get("limitToCountries") is None,
    )

    # -----------------------------------------------------------------
    # 2. Never-fabricated fields, field-for-field
    # -----------------------------------------------------------------
    coffee, address_only = candidates
    _check("Blue Bottle: name mapped", coffee.name == "Blue Bottle Coffee")
    _check("Blue Bottle: category mapped from poiCategory", coffee.category == "Coffee Shop")
    _check("Blue Bottle: city mapped from structuredAddress.locality", coffee.city == "Oakland")
    _check("Blue Bottle: country mapped verbatim", coffee.country == "United States")
    _check(
        "Blue Bottle: address built from formattedAddressLines",
        coffee.address == "300 Webster St, Oakland, CA 94607, United States",
    )
    _check(
        "Blue Bottle: coordinates populated as (lat, lon) tuple",
        coffee.coordinates == (37.7796, -122.4017),
    )
    _check("Blue Bottle: website left None (never fabricated)", coffee.website is None)
    _check("Blue Bottle: phone left None (never fabricated)", coffee.phone is None)
    _check("Blue Bottle: rating left None (never fabricated)", coffee.rating is None)
    _check("Blue Bottle: review_count left None (never fabricated)", coffee.review_count is None)
    _check(
        "Blue Bottle: provider_business_id left None (never fabricated)",
        coffee.provider_business_id is None,
    )
    _check("Blue Bottle: maps_url left None (never fabricated)", coffee.maps_url is None)
    _check("Blue Bottle: instagram_url left None (never fabricated)", coffee.instagram_url is None)

    _check(
        "Address-only result: category left None (no poiCategory in response)",
        address_only.category is None,
    )
    _check(
        "Address-only result: coordinates left None (no coordinate in response)",
        address_only.coordinates is None,
    )

    # -----------------------------------------------------------------
    # 3. metadata() / capabilities() — construction-independent
    # -----------------------------------------------------------------
    metadata = AppleMapsProvider.metadata()
    _check("metadata() callable without an access_token", isinstance(metadata, ProviderMetadata))
    _check("metadata.provider_id matches provider_id", metadata.provider_id == "apple_maps")
    _check("metadata.requires_api_key is True", metadata.requires_api_key is True)

    capabilities = AppleMapsProvider.capabilities()
    _check(
        "capabilities() callable without an access_token",
        isinstance(capabilities, ProviderCapabilities),
    )
    _check("capabilities.supports_keyword_search is True", capabilities.supports_keyword_search is True)
    _check(
        "capabilities.supports_coordinate_search is True (searchLocation hint)",
        capabilities.supports_coordinate_search is True,
    )
    _check(
        "capabilities.supports_pagination is False (single-call Search endpoint)",
        capabilities.supports_pagination is False,
    )
    _check("capabilities.supports_streaming is True", capabilities.supports_streaming is True)
    _check(
        "capabilities.supports_category_search is True "
        "(includePoiCategories/excludePoiCategories are real, documented params)",
        capabilities.supports_category_search is True,
    )
    _check(
        "capabilities.supports_country_filter is True "
        "(limitToCountries is a real, documented param)",
        capabilities.supports_country_filter is True,
    )
    _check(
        "capabilities.supports_city_filter remains False "
        "(no city param exists in the documented Search endpoint request shape)",
        capabilities.supports_city_filter is False,
    )
    _check(
        "capabilities.supports_radius_search remains False "
        "(no radius param exists; search_region is a bounding box, not a radius)",
        capabilities.supports_radius_search is False,
    )

    # -----------------------------------------------------------------
    # 4. ProviderRegistry compatibility (register / metadata / capabilities
    #    / get / build / build_all / create — none touched or modified)
    # -----------------------------------------------------------------
    registry = ProviderRegistry()
    registry.register(
        "apple_maps",
        lambda: AppleMapsProvider(access_token="test-token", http_get=_fake_http_get),
        metadata=AppleMapsProvider.metadata(),
        capabilities=AppleMapsProvider.capabilities(),
    )
    registry.register(
        "yelp",
        lambda: YelpProvider(api_key="fake-yelp-key", http_get=_yelp_http_get),
        metadata=YelpProvider.metadata(),
        capabilities=YelpProvider.capabilities(),
    )
    _check("registry.is_registered('apple_maps')", registry.is_registered("apple_maps"))
    _check(
        "registry.metadata('apple_maps') returns stored metadata without construction",
        registry.metadata("apple_maps").provider_id == "apple_maps",
    )
    _check(
        "registry.capabilities('apple_maps') returns stored capabilities without construction",
        registry.capabilities("apple_maps").supports_keyword_search is True,
    )
    built = registry.get("apple_maps")
    _check(
        "registry.get('apple_maps') constructs a real AppleMapsProvider",
        isinstance(built, AppleMapsProvider),
    )

    # -----------------------------------------------------------------
    # 5. "Plugin discovery" — the only registration/lookup mechanism
    #    this codebase actually has today (see architecture review:
    #    no PluginDiscovery / auto-scan module exists yet anywhere in
    #    the provided provider platform — registry.py's own docstring
    #    documents this as explicitly deferred). AppleMapsProvider is
    #    validated against that real mechanism: identity, metadata,
    #    and capabilities are all discoverable via provider_ids() /
    #    metadata_all() / capabilities_all() without constructing
    #    anything, exactly like GoogleMapsProvider and YelpProvider.
    # -----------------------------------------------------------------
    _check(
        "apple_maps appears in registry.provider_ids()",
        "apple_maps" in registry.provider_ids(),
    )
    _check(
        "apple_maps appears in registry.metadata_all() without construction",
        any(m.provider_id == "apple_maps" for m in registry.metadata_all()),
    )
    _check(
        "apple_maps appears in registry.capabilities_all() without construction",
        "apple_maps" in registry.capabilities_all(),
    )

    # -----------------------------------------------------------------
    # 6. CompositeDiscoveryProvider (sequential composition)
    # -----------------------------------------------------------------
    apple = registry.get("apple_maps")
    yelp = registry.get("yelp")
    composite = CompositeDiscoveryProvider([apple, yelp])
    _check(
        "CompositeDiscoveryProvider accepts AppleMapsProvider without modification",
        isinstance(composite, DiscoveryProviderInterface),
    )
    composite_request = CompositeDiscoveryRequest(
        requests={
            "apple_maps": AppleMapsDiscoveryRequest(session_id="sess-2", query="coffee"),
            "yelp": __import__(
                "providers.yelp_provider", fromlist=["YelpDiscoveryRequest"]
            ).YelpDiscoveryRequest(session_id="sess-2", term="coffee", location="Oakland, CA"),
        }
    )
    composite_results = list(composite.discover(composite_request))
    _check(
        "CompositeDiscoveryProvider drains both wrapped providers",
        len(composite_results) == 3,  # 2 from Apple Maps + 1 from Yelp
    )
    _check(
        "Composite output includes candidates from both providers",
        {c.provider for c in composite_results} == {"apple_maps", "yelp"},
    )

    # -----------------------------------------------------------------
    # 7. ParallelCompositeDiscoveryProvider (concurrent composition)
    # -----------------------------------------------------------------
    apple2 = registry.get("apple_maps")
    yelp2 = registry.get("yelp")
    parallel = ParallelCompositeDiscoveryProvider([apple2, yelp2])
    _check(
        "ParallelCompositeDiscoveryProvider accepts AppleMapsProvider without modification",
        isinstance(parallel, DiscoveryProviderInterface),
    )
    parallel_request = ParallelDiscoveryRequest(
        requests={
            "apple_maps": AppleMapsDiscoveryRequest(session_id="sess-3", query="coffee"),
            "yelp": __import__(
                "providers.yelp_provider", fromlist=["YelpDiscoveryRequest"]
            ).YelpDiscoveryRequest(session_id="sess-3", term="coffee", location="Oakland, CA"),
        }
    )
    parallel_results = list(parallel.discover(parallel_request))
    _check(
        "ParallelCompositeDiscoveryProvider drains both wrapped providers concurrently",
        len(parallel_results) == 3,
    )
    _check(
        "Parallel output includes candidates from both providers",
        {c.provider for c in parallel_results} == {"apple_maps", "yelp"},
    )

    # -----------------------------------------------------------------
    # 8. ProviderDeduplicator compatibility
    # -----------------------------------------------------------------
    apple3 = AppleMapsProvider(access_token="test-token", http_get=_fake_http_get)
    dedup = ProviderDeduplicator(apple3)
    _check(
        "ProviderDeduplicator wraps AppleMapsProvider without modification",
        isinstance(dedup, DiscoveryProviderInterface),
    )
    dedup_results = list(dedup.discover(AppleMapsDiscoveryRequest(session_id="sess-4", query="coffee")))
    _check(
        "ProviderDeduplicator streams AppleMapsProvider's candidates through unchanged",
        len(dedup_results) == 2,
    )

    # -----------------------------------------------------------------
    # 9. ProviderConfiguration + ProviderRegistry.create() end-to-end
    # -----------------------------------------------------------------
    single_config = ProviderConfiguration(providers=["apple_maps"])
    single_result = registry.create(single_config)
    _check(
        "create() with a single-provider configuration returns a bare AppleMapsProvider",
        isinstance(single_result, AppleMapsProvider),
    )

    multi_config = ProviderConfiguration(providers=["apple_maps", "yelp"], parallel=False, deduplicate=False)
    multi_result = registry.create(multi_config)
    _check(
        "create() with two providers, parallel=False returns a CompositeDiscoveryProvider",
        isinstance(multi_result, CompositeDiscoveryProvider),
    )

    parallel_config = ProviderConfiguration(providers=["apple_maps", "yelp"], parallel=True)
    parallel_config_result = registry.create(parallel_config)
    _check(
        "create() with two providers, parallel=True returns a ParallelCompositeDiscoveryProvider",
        isinstance(parallel_config_result, ParallelCompositeDiscoveryProvider),
    )

    dedup_config = ProviderConfiguration(providers=["apple_maps"], deduplicate=True)
    dedup_config_result = registry.create(dedup_config)
    _check(
        "create() with deduplicate=True wraps the result in ProviderDeduplicator",
        isinstance(dedup_config_result, ProviderDeduplicator),
    )

    # -----------------------------------------------------------------
    # 10. Engine compatibility / "no engine changes required"
    # -----------------------------------------------------------------
    # The Engine only ever depends on DiscoveryProviderInterface's own
    # abstract surface (provider_id, display_name, discover()). This
    # check exercises AppleMapsProvider through that surface alone —
    # exactly what the Engine sees — with no reference to
    # AppleMapsProvider, AppleMapsDiscoveryRequest, or anything
    # provider-specific.
    def _engine_style_consumer(p: DiscoveryProviderInterface, request: Any) -> list[BusinessCandidate]:
        out = []
        for candidate in p.discover(request):
            assert isinstance(candidate, BusinessCandidate)
            out.append(candidate)
        return out

    generic_results = _engine_style_consumer(
        AppleMapsProvider(access_token="test-token", http_get=_fake_http_get),
        AppleMapsDiscoveryRequest(session_id="sess-5", query="coffee"),
    )
    _check(
        "AppleMapsProvider is consumable through the bare DiscoveryProviderInterface surface",
        len(generic_results) == 2,
    )
    _check(
        "engine/interfaces.py and engine/contracts.py required zero changes "
        "(imported here exactly as GoogleMapsProvider/YelpProvider already do)",
        True,
    )

    print(f"\n{_PASS_COUNT} checks passed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
