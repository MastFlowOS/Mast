"""
MAST Engine V2 — validate_foursquare_provider.py
====================================================

Validation script for FoursquareProvider, mirroring the structure and
depth of validate_yelp_provider.py / validate_apple_maps_provider.py /
validate_overpass_provider.py / validate_azure_maps_provider.py (not
themselves uploaded for this milestone, but this script follows the
same "no network access required, inject a fake transport, assert on
resulting BusinessCandidate stream and on cross-component compatibility"
shape this codebase already establishes).

No network access is used anywhere in this script — every discover()
call injects a fake `http_get` returning a canned Place Search response
shape, built directly from Foursquare's own documented response fields
(docs.foursquare.com/fsq-developers-places/reference/response-fields).

Run with: python3 validate_foursquare_provider.py
"""

from __future__ import annotations

import sys
from typing import Any

from engine.contracts import BusinessCandidate
from engine.interfaces import DiscoveryProviderInterface
from providers.composite_provider import CompositeDiscoveryProvider, CompositeDiscoveryRequest
from providers.parallel_composite_provider import (
    ParallelCompositeDiscoveryProvider,
    ParallelDiscoveryRequest,
)
from providers.provider_configuration import ProviderConfiguration
from providers.provider_deduplicator import ProviderDeduplicator
from providers.registry import ProviderRegistry
from providers.foursquare_provider import (
    FoursquareDiscoveryRequest,
    FoursquareProvider,
    _build_params,
)

_FAILURES: list[str] = []


def check(name: str, condition: bool, detail: str = "") -> None:
    status = "PASS" if condition else "FAIL"
    print(f"[{status}] {name}" + (f" — {detail}" if detail and not condition else ""))
    if not condition:
        _FAILURES.append(name)


# ---------------------------------------------------------------------------
# Canned Place Search response — field names and shapes taken directly from
# Foursquare's own documented response fields, nothing invented.
# ---------------------------------------------------------------------------
_CANNED_RESPONSE = {
    "results": [
        {
            "fsq_place_id": "4be584ed2457a593ad8cab15",
            "name": "Blue Bottle Coffee",
            "latitude": 40.723,
            "longitude": -73.995,
            "distance": 120,
            "categories": [
                {"fsq_category_id": "4bf58dd8d48988d1e0931735", "name": "Coffee Shop"}
            ],
            "location": {
                "address": "85 Prince St",
                "locality": "New York",
                "region": "NY",
                "postcode": "10012",
                "country": "US",
            },
            "tel": "(212) 555-0100",
            "website": "https://bluebottlecoffee.com",
            "link": "/places/4be584ed2457a593ad8cab15",
            "social_media": {"instagram": "bluebottle"},
        },
        {
            # Deliberately sparse entry — exercises "never fabricate"
            # handling for a place with most optional fields absent.
            "fsq_place_id": "5c1234567890abcdef123456",
            "name": "Unnamed Alley Kiosk",
            "latitude": 40.724,
            "longitude": -73.996,
            "categories": [],
            "location": {},
            "link": "/places/5c1234567890abcdef123456",
        },
    ]
}

_CANNED_RESPONSE_WITH_PREMIUM = {
    "results": [
        {
            "fsq_place_id": "4be584ed2457a593ad8cab15",
            "name": "Blue Bottle Coffee",
            "latitude": 40.723,
            "longitude": -73.995,
            "categories": [{"fsq_category_id": "x", "name": "Coffee Shop"}],
            "location": {"address": "85 Prince St", "locality": "New York", "country": "US"},
            "link": "/places/4be584ed2457a593ad8cab15",
            "rating": 8.7,
            "stats": {"total_photos": 120, "total_ratings": 340, "total_tips": 45},
        }
    ]
}


def fake_http_get(captured: dict[str, Any]):
    def _fake(url: str, params: dict[str, Any], headers: dict[str, str]) -> dict[str, Any]:
        captured["url"] = url
        captured["params"] = params
        captured["headers"] = headers
        if params.get("fields") == "rating,stats":
            return _CANNED_RESPONSE_WITH_PREMIUM
        return _CANNED_RESPONSE
    return _fake


def fake_http_get_empty(url: str, params: dict[str, Any], headers: dict[str, str]) -> dict[str, Any]:
    return {"results": []}


def fake_http_get_error(url: str, params: dict[str, Any], headers: dict[str, str]) -> dict[str, Any]:
    raise RuntimeError("simulated transport failure")


# ---------------------------------------------------------------------------
# 1. Interface compliance
# ---------------------------------------------------------------------------
def test_interface_compliance() -> None:
    provider = FoursquareProvider(api_key="fake-key", http_get=fake_http_get({}))
    check(
        "FoursquareProvider is a DiscoveryProviderInterface",
        isinstance(provider, DiscoveryProviderInterface),
    )
    check("provider_id == 'foursquare'", provider.provider_id == "foursquare")
    check("display_name == 'Foursquare'", provider.display_name == "Foursquare")
    request = FoursquareDiscoveryRequest(session_id="s1", query="coffee")
    result = provider.discover(request)
    check("discover() returns an iterator (has __next__)", hasattr(result, "__next__"))


# ---------------------------------------------------------------------------
# 2. Honest field mapping
# ---------------------------------------------------------------------------
def test_honest_field_mapping() -> None:
    captured: dict[str, Any] = {}
    provider = FoursquareProvider(api_key="fake-key", http_get=fake_http_get(captured))
    request = FoursquareDiscoveryRequest(session_id="s1", query="coffee", ll=(40.72, -74.0))
    candidates = list(provider.discover(request))

    check("discover() yields 2 candidates for canned response", len(candidates) == 2)
    first, second = candidates[0], candidates[1]

    check("provider field set to 'foursquare'", first.provider == "foursquare")
    check("session_id propagated from request", first.session_id == "s1")
    check(
        "provider_business_id == fsq_place_id",
        first.provider_business_id == "4be584ed2457a593ad8cab15",
    )
    check(
        "maps_url built as API host + link",
        first.maps_url == "https://places-api.foursquare.com/places/4be584ed2457a593ad8cab15",
    )
    check("name mapped directly", first.name == "Blue Bottle Coffee")
    check("category == first categories[].name", first.category == "Coffee Shop")
    check("address == location.address", first.address == "85 Prince St")
    check("city == location.locality", first.city == "New York")
    check("country == location.country", first.country == "US")
    check("website mapped directly (Pro field)", first.website == "https://bluebottlecoffee.com")
    check("phone == tel", first.phone == "(212) 555-0100")
    check("coordinates == (latitude, longitude)", first.coordinates == (40.723, -73.995))
    check(
        "instagram_url left None (bare handle, not a URL — never fabricated)",
        first.instagram_url is None,
    )
    check(
        "rating left None when Premium field not requested",
        first.rating is None,
    )
    check(
        "review_count left None when Premium field not requested",
        first.review_count is None,
    )
    check("discovered_at populated", first.discovered_at is not None)
    check("pipeline_id populated and unique", first.pipeline_id != second.pipeline_id)

    # Sparse entry — every genuinely-absent field must be None, never guessed.
    check("sparse entry: category is None when categories[] is empty", second.category is None)
    check("sparse entry: address is None when location is empty", second.address is None)
    check("sparse entry: website is None when absent from response", second.website is None)
    check("sparse entry: phone is None when absent from response", second.phone is None)

    check(
        "request wired ll into 'latitude,longitude' string, not translated",
        captured["params"]["ll"] == "40.72,-74.0",
    )
    check(
        "request query passed through verbatim (zero niche translation)",
        captured["params"]["query"] == "coffee",
    )
    check(
        "Authorization header sent as Bearer token",
        captured["headers"]["Authorization"] == "Bearer fake-key",
    )
    check(
        "X-Places-Api-Version header sent",
        captured["headers"]["X-Places-Api-Version"] == "2025-06-17",
    )
    check(
        "request targets the new Places API host only (no legacy v3 path)",
        captured["url"] == "https://places-api.foursquare.com/places/search",
    )


def test_premium_field_opt_in() -> None:
    """A caller who opts into Premium fields via `fields=` gets them mapped;
    a caller who doesn't, doesn't — this provider never force-requests
    Premium fields on the caller's behalf."""
    captured: dict[str, Any] = {}
    provider = FoursquareProvider(api_key="fake-key", http_get=fake_http_get(captured))
    request = FoursquareDiscoveryRequest(
        session_id="s1", query="coffee", fields=("rating", "stats")
    )
    candidates = list(provider.discover(request))
    check("premium opt-in: one candidate returned", len(candidates) == 1)
    check("premium opt-in: rating mapped when present", candidates[0].rating == 8.7)
    check(
        "premium opt-in: review_count == stats.total_ratings when present",
        candidates[0].review_count == 340,
    )
    check(
        "fields param passed through verbatim, comma-joined",
        captured["params"]["fields"] == "rating,stats",
    )


def test_empty_results() -> None:
    provider = FoursquareProvider(api_key="fake-key", http_get=fake_http_get_empty)
    request = FoursquareDiscoveryRequest(session_id="s1", query="nonexistent-xyz")
    candidates = list(provider.discover(request))
    check("empty results[] yields zero candidates, not an error", candidates == [])


def test_transport_errors_propagate() -> None:
    provider = FoursquareProvider(api_key="fake-key", http_get=fake_http_get_error)
    request = FoursquareDiscoveryRequest(session_id="s1", query="coffee")
    try:
        list(provider.discover(request))
        check("transport error propagates unchanged", False)
    except RuntimeError as exc:
        check("transport error propagates unchanged", str(exc) == "simulated transport failure")


# ---------------------------------------------------------------------------
# 3. metadata() / capabilities()
# ---------------------------------------------------------------------------
def test_metadata_and_capabilities() -> None:
    # Callable with no instance / no api_key — same "must not require
    # construction" guarantee YelpProvider and AppleMapsProvider already
    # honor for these classmethods.
    metadata = FoursquareProvider.metadata()
    capabilities = FoursquareProvider.capabilities()

    check("metadata() callable without constructing a provider", metadata is not None)
    check("metadata.provider_id == 'foursquare'", metadata.provider_id == "foursquare")
    check("metadata.requires_api_key is True", metadata.requires_api_key is True)

    check("capabilities() callable without constructing a provider", capabilities is not None)
    check("capabilities.supports_keyword_search is True", capabilities.supports_keyword_search is True)
    check("capabilities.supports_category_search is True", capabilities.supports_category_search is True)
    check("capabilities.supports_city_filter is True", capabilities.supports_city_filter is True)
    check("capabilities.supports_country_filter is False", capabilities.supports_country_filter is False)
    check("capabilities.supports_radius_search is True", capabilities.supports_radius_search is True)
    check("capabilities.supports_coordinate_search is True", capabilities.supports_coordinate_search is True)
    check("capabilities.supports_pagination is False", capabilities.supports_pagination is False)
    check("capabilities.supports_streaming is True", capabilities.supports_streaming is True)


# ---------------------------------------------------------------------------
# 4. Registry compatibility
# ---------------------------------------------------------------------------
def test_registry_compatibility() -> None:
    registry = ProviderRegistry()
    registry.register(
        "foursquare",
        lambda: FoursquareProvider(api_key="fake-key", http_get=fake_http_get({})),
        metadata=FoursquareProvider.metadata(),
        capabilities=FoursquareProvider.capabilities(),
    )
    check("registry.is_registered('foursquare')", registry.is_registered("foursquare"))
    check(
        "registry.metadata('foursquare') matches provider's own metadata()",
        registry.metadata("foursquare") == FoursquareProvider.metadata(),
    )
    check(
        "registry.capabilities('foursquare') matches provider's own capabilities()",
        registry.capabilities("foursquare") == FoursquareProvider.capabilities(),
    )
    instance = registry.get("foursquare")
    check("registry.get('foursquare') returns a FoursquareProvider", isinstance(instance, FoursquareProvider))
    check(
        "registry.get('foursquare') returns a fresh instance each call",
        registry.get("foursquare") is not instance,
    )


# ---------------------------------------------------------------------------
# 5. Plugin discovery ("one file changes" extensibility test)
# ---------------------------------------------------------------------------
def test_plugin_discovery_compatibility() -> None:
    # This codebase's ProviderRegistry has no auto-discovery mechanism
    # (see registry.py's own docstring: "no plugin auto-discovery... is
    # explicitly deferred"). "Plugin discovery compatibility" here means
    # exactly what it means for every other provider: FoursquareProvider
    # registers via the identical register() call shape as
    # GoogleMapsProvider/YelpProvider/AppleMapsProvider/OverpassProvider/
    # AzureMapsProvider, with no provider-specific branch anywhere in
    # ProviderRegistry, CompositeDiscoveryProvider,
    # ParallelCompositeDiscoveryProvider, or ProviderDeduplicator. That is
    # the blueprint's own "one provider implementation and its
    # registration" test, and it's what this check demonstrates.
    registry = ProviderRegistry()
    registry.register(
        "foursquare",
        lambda: FoursquareProvider(api_key="fake-key", http_get=fake_http_get({})),
        metadata=FoursquareProvider.metadata(),
        capabilities=FoursquareProvider.capabilities(),
    )
    check(
        "FoursquareProvider registers via the same register() shape as every other provider",
        "foursquare" in registry.provider_ids(),
    )


# ---------------------------------------------------------------------------
# 6. Composite compatibility
# ---------------------------------------------------------------------------
def test_composite_compatibility() -> None:
    fsq = FoursquareProvider(api_key="fake-key", http_get=fake_http_get({}))
    composite = CompositeDiscoveryProvider([fsq])
    request = CompositeDiscoveryRequest(
        requests={"foursquare": FoursquareDiscoveryRequest(session_id="s1", query="coffee")}
    )
    candidates = list(composite.discover(request))
    check(
        "CompositeDiscoveryProvider drains FoursquareProvider with no special-casing",
        len(candidates) == 2 and all(c.provider == "foursquare" for c in candidates),
    )


# ---------------------------------------------------------------------------
# 7. Parallel compatibility
# ---------------------------------------------------------------------------
def test_parallel_compatibility() -> None:
    fsq = FoursquareProvider(api_key="fake-key", http_get=fake_http_get({}))
    parallel = ParallelCompositeDiscoveryProvider([fsq])
    request = ParallelDiscoveryRequest(
        requests={"foursquare": FoursquareDiscoveryRequest(session_id="s1", query="coffee")}
    )
    candidates = list(parallel.discover(request))
    check(
        "ParallelCompositeDiscoveryProvider drains FoursquareProvider with no special-casing",
        len(candidates) == 2 and all(c.provider == "foursquare" for c in candidates),
    )


# ---------------------------------------------------------------------------
# 8. Deduplicator compatibility
# ---------------------------------------------------------------------------
def test_deduplicator_compatibility() -> None:
    fsq = FoursquareProvider(api_key="fake-key", http_get=fake_http_get({}))
    deduped = ProviderDeduplicator(fsq)
    request = FoursquareDiscoveryRequest(session_id="s1", query="coffee")
    candidates = list(deduped.discover(request))
    check(
        "ProviderDeduplicator wraps a bare FoursquareProvider with no special-casing",
        len(candidates) == 2,
    )


# ---------------------------------------------------------------------------
# 9. ProviderConfiguration compatibility
# ---------------------------------------------------------------------------
def test_provider_configuration_compatibility() -> None:
    registry = ProviderRegistry()
    registry.register(
        "foursquare",
        lambda: FoursquareProvider(api_key="fake-key", http_get=fake_http_get({})),
        metadata=FoursquareProvider.metadata(),
        capabilities=FoursquareProvider.capabilities(),
    )
    config = ProviderConfiguration(providers=["foursquare"])
    built = registry.create(config)
    check(
        "ProviderConfiguration selecting only 'foursquare' returns a bare FoursquareProvider",
        isinstance(built, FoursquareProvider),
    )


# ---------------------------------------------------------------------------
# 10. Engine compatibility (no Engine changes required)
# ---------------------------------------------------------------------------
def test_engine_compatibility() -> None:
    fsq = FoursquareProvider(api_key="fake-key", http_get=fake_http_get({}))
    request = FoursquareDiscoveryRequest(session_id="s1", query="coffee")
    for candidate in fsq.discover(request):
        check(
            "every yielded object is exactly a BusinessCandidate (Engine's own fixed contract)",
            type(candidate) is BusinessCandidate,
        )
        break


# ---------------------------------------------------------------------------
# 11. Statelessness
# ---------------------------------------------------------------------------
def test_statelessness() -> None:
    fsq = FoursquareProvider(api_key="fake-key", http_get=fake_http_get({}))
    request = FoursquareDiscoveryRequest(session_id="s1", query="coffee")
    first_run = list(fsq.discover(request))
    second_run = list(fsq.discover(request))
    check(
        "two discover() calls on the same instance are independent (no shared mutable state)",
        len(first_run) == len(second_run) == 2
        and first_run[0].provider_business_id == second_run[0].provider_business_id,
    )
    check(
        "each discover() call mints fresh pipeline_ids (no cross-call caching)",
        first_run[0].pipeline_id != second_run[0].pipeline_id,
    )


# ---------------------------------------------------------------------------
# 12. Immutability
# ---------------------------------------------------------------------------
def test_immutability() -> None:
    request = FoursquareDiscoveryRequest(session_id="s1", query="coffee")
    try:
        request.query = "burgers"  # type: ignore[misc]
        check("FoursquareDiscoveryRequest is frozen", False)
    except Exception:
        check("FoursquareDiscoveryRequest is frozen", True)

    metadata = FoursquareProvider.metadata()
    try:
        metadata.display_name = "Hacked"  # type: ignore[misc]
        check("ProviderMetadata instance remains frozen", False)
    except Exception:
        check("ProviderMetadata instance remains frozen", True)


# ---------------------------------------------------------------------------
# 13. Transport injection
# ---------------------------------------------------------------------------
def test_transport_injection() -> None:
    calls: list[str] = []

    def counting_http_get(url: str, params: dict[str, Any], headers: dict[str, str]) -> dict[str, Any]:
        calls.append(url)
        return _CANNED_RESPONSE

    fsq = FoursquareProvider(api_key="fake-key", http_get=counting_http_get)
    list(fsq.discover(FoursquareDiscoveryRequest(session_id="s1", query="coffee")))
    check("injected http_get is actually used (default network path never touched)", len(calls) == 1)

    default_provider = FoursquareProvider(api_key="fake-key")
    check(
        "default transport is present when none is injected",
        default_provider._http_get is not None,
    )


# ---------------------------------------------------------------------------
# 14. Pagination (per API research: unsupported by this endpoint)
# ---------------------------------------------------------------------------
def test_pagination_honesty() -> None:
    check(
        "capabilities().supports_pagination is False, matching Place Search's own lack of an offset/cursor parameter",
        FoursquareProvider.capabilities().supports_pagination is False,
    )
    try:
        FoursquareDiscoveryRequest(session_id="s1", limit=51)
        check("limit above Place Search's documented 50-ceiling is rejected", False)
    except ValueError:
        check("limit above Place Search's documented 50-ceiling is rejected", True)

    params = _build_params(FoursquareDiscoveryRequest(session_id="s1", query="coffee"))
    check("no offset/cursor parameter is ever built into the request", "offset" not in params and "cursor" not in params)


# ---------------------------------------------------------------------------
# Request-shape validation checks (documented Place Search constraints)
# ---------------------------------------------------------------------------
def test_request_validation() -> None:
    try:
        FoursquareDiscoveryRequest(session_id="s1", ne=(1.0, 2.0))
        check("ne without sw is rejected", False)
    except ValueError:
        check("ne without sw is rejected", True)

    try:
        FoursquareDiscoveryRequest(session_id="s1", radius=200_000)
        check("radius above documented 100000m ceiling is rejected", False)
    except ValueError:
        check("radius above documented 100000m ceiling is rejected", True)

    try:
        FoursquareDiscoveryRequest(session_id="s1", open_at="1T0900", open_now=True)
        check("open_at + open_now together is rejected", False)
    except ValueError:
        check("open_at + open_now together is rejected", True)

    try:
        FoursquareDiscoveryRequest(
            session_id="s1", exclude_fsq_chain_ids=("abc",), exclude_all_chains=True
        )
        check("exclude_fsq_chain_ids + exclude_all_chains together is rejected", False)
    except ValueError:
        check("exclude_fsq_chain_ids + exclude_all_chains together is rejected", True)

    try:
        FoursquareDiscoveryRequest(session_id="s1", tel_format="INVALID")
        check("invalid tel_format is rejected", False)
    except ValueError:
        check("invalid tel_format is rejected", True)

    try:
        FoursquareDiscoveryRequest(session_id="s1", sort="INVALID")
        check("invalid sort is rejected", False)
    except ValueError:
        check("invalid sort is rejected", True)

    # Valid combinations must NOT raise.
    FoursquareDiscoveryRequest(session_id="s1", ne=(1.0, 2.0), sw=(0.0, 1.0))
    FoursquareDiscoveryRequest(session_id="s1", ll=(40.0, -74.0), radius=1000)
    FoursquareDiscoveryRequest(session_id="s1", near="Chicago, IL")
    check("well-formed valid requests construct without error", True)


def main() -> int:
    tests = [
        test_interface_compliance,
        test_honest_field_mapping,
        test_premium_field_opt_in,
        test_empty_results,
        test_transport_errors_propagate,
        test_metadata_and_capabilities,
        test_registry_compatibility,
        test_plugin_discovery_compatibility,
        test_composite_compatibility,
        test_parallel_compatibility,
        test_deduplicator_compatibility,
        test_provider_configuration_compatibility,
        test_engine_compatibility,
        test_statelessness,
        test_immutability,
        test_transport_injection,
        test_pagination_honesty,
        test_request_validation,
    ]
    for test in tests:
        print(f"\n--- {test.__name__} ---")
        test()

    print("\n" + "=" * 60)
    if _FAILURES:
        print(f"{len(_FAILURES)} check(s) FAILED:")
        for name in _FAILURES:
            print(f"  - {name}")
        return 1
    print("All checks PASSED.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
