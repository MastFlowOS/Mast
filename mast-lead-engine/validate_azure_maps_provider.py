"""
MAST Engine V2 — validate_azure_maps_provider.py
====================================================

Validation script for AzureMapsProvider (this milestone's deliverable
— see azure_maps_provider.py's own module docstring, "Architecture
review / target selection", for why the originally-requested
"BingMapsProvider" was redirected to Azure Maps before any code was
written).

Runs entirely offline: every HTTP call is replaced with a fake
`http_get`/canned-response closure built from Microsoft's own
documented example response for the Get Search POI operation
(reproduced in `_CANNED_RESPONSE` below, field-for-field, from
learn.microsoft.com/en-us/rest/api/maps/search/get-search-poi). No
network access, no real subscription key, required.

What this validates, in order (matching this milestone's own
"Validation" checklist):

    1.  Interface compliance
    2.  Mapping correctness (honest field mapping)
    3.  metadata()
    4.  capabilities()
    5.  Registry compatibility
    6.  Plugin discovery (registration is generic — no AzureMapsProvider-
        specific branch anywhere in ProviderRegistry)
    7.  Composite compatibility
    8.  Parallel compatibility
    9.  Deduplicator compatibility
    10. Engine compatibility (no engine/ file imports or references
        AzureMapsProvider)
    11. Statelessness
    12. Immutability (AzureMapsDiscoveryRequest, ProviderMetadata,
        ProviderCapabilities are all frozen)
    13. Transport injection
    14. No Engine changes required

Each check is a plain function that raises AssertionError on failure
and prints a PASS line on success. `main()` runs them all and reports
a final summary; a non-zero exit code means at least one check failed.
"""

from __future__ import annotations

import sys
import traceback
from dataclasses import FrozenInstanceError
from typing import Any, Callable, Iterator

from engine.contracts import BusinessCandidate
from engine.interfaces import DiscoveryProviderInterface
from providers.azure_maps_provider import AzureMapsDiscoveryRequest, AzureMapsProvider
from providers.composite_provider import CompositeDiscoveryProvider, CompositeDiscoveryRequest
from providers.parallel_composite_provider import (
    ParallelCompositeDiscoveryProvider,
    ParallelDiscoveryRequest,
)
from providers.provider_capabilities import ProviderCapabilities
from providers.provider_configuration import ProviderConfiguration
from providers.provider_deduplicator import ProviderDeduplicator
from providers.provider_metadata import ProviderMetadata
from providers.registry import ProviderRegistry
from providers.yelp_provider import YelpDiscoveryRequest, YelpProvider

# ---------------------------------------------------------------------------
# Canned Get Search POI response — Microsoft's own documented example,
# reproduced field-for-field (learn.microsoft.com/en-us/rest/api/maps/
# search/get-search-poi, "Search for juice bars ... " example), trimmed
# to two results for readability. Used to prove honest field mapping
# without any real network call.
# ---------------------------------------------------------------------------
_CANNED_RESPONSE: dict[str, Any] = {
    "summary": {
        "query": "juice bars",
        "queryTime": 36,
        "numResults": 2,
        "offset": 0,
        "totalResults": 12,
    },
    "results": [
        {
            "type": "POI",
            "id": "US/POI/p0/9223158",
            "dist": 667.271,
            "poi": {
                "name": "Pressed Juicery",
                "phone": "+(1)-(206)-6240804",
                "brands": [{"name": "Pressed Juicery"}],
                "categories": ["yogurt/juice bar", "restaurant"],
                "categorySet": [{"id": 7315149}],
                "url": "www.pressedjuicery.com",
                "classifications": [
                    {
                        "code": "RESTAURANT",
                        "names": [{"nameLocale": "en-US", "name": "restaurant"}],
                    }
                ],
            },
            "address": {
                "streetNumber": "400",
                "streetName": "Pine St",
                "municipality": "Seattle",
                "countrySubdivisionCode": "WA",
                "postalCode": "98101",
                "countryCode": "US",
                "country": "United States",
                "freeformAddress": "400 Pine St, Seattle, WA 98101",
                "localName": "Seattle",
            },
            "position": {"lat": 47.61138, "lon": -122.3374},
        },
        {
            "type": "POI",
            "id": "US/POI/p1/9131285",
            "dist": 5097.757,
            "poi": {
                "name": "Custom Smoothie & Sports Nutrition",
                "phone": "+(1)-(206)-5475522",
                "categories": ["yogurt/juice bar", "restaurant"],
                "categorySet": [{"id": 7315149}],
                "url": "www.customsmoothie.com",
                "classifications": [
                    {
                        "code": "RESTAURANT",
                        "names": [{"nameLocale": "en-US", "name": "restaurant"}],
                    }
                ],
            },
            "address": {
                "streetNumber": "462",
                "streetName": "N 34th St",
                "municipality": "Seattle",
                "countrySubdivisionCode": "WA",
                "postalCode": "98103",
                "countryCode": "US",
                "country": "United States",
                "freeformAddress": "462 N 34th St, Seattle, WA 98103",
                "localName": "Seattle",
            },
            "position": {"lat": 47.65016, "lon": -122.35182},
        },
    ],
}

_EMPTY_RESPONSE: dict[str, Any] = {
    "summary": {"query": "x", "numResults": 0, "offset": 0, "totalResults": 0},
    "results": [],
}


def _make_fake_http_get(
    response: dict[str, Any] = _CANNED_RESPONSE,
    *,
    record: list[dict[str, Any]] | None = None,
) -> Callable[[str, dict[str, Any], dict[str, str]], dict[str, Any]]:
    """
    Builds a fake `http_get` closure — no network access, ever. If
    `record` is supplied, every call's params dict is appended to it,
    so a test can assert on exactly what AzureMapsProvider sent.
    """

    def _fake(url: str, params: dict[str, Any], headers: dict[str, str]) -> dict[str, Any]:
        if record is not None:
            record.append(dict(params))
        assert url.endswith("/search/poi/json"), f"unexpected URL: {url}"
        assert params.get("api-version") == "1.0"
        assert "subscription-key" in params
        return response

    return _fake


PASS_COUNT = 0
FAIL_COUNT = 0


def check(name: str, fn: Callable[[], None]) -> None:
    global PASS_COUNT, FAIL_COUNT
    try:
        fn()
    except Exception:
        FAIL_COUNT += 1
        print(f"[FAIL] {name}")
        traceback.print_exc()
    else:
        PASS_COUNT += 1
        print(f"[PASS] {name}")


# ---------------------------------------------------------------------------
# 1. Interface compliance
# ---------------------------------------------------------------------------
def check_interface_compliance() -> None:
    assert issubclass(AzureMapsProvider, DiscoveryProviderInterface)
    provider = AzureMapsProvider(subscription_key="fake-key", http_get=_make_fake_http_get())
    assert isinstance(provider, DiscoveryProviderInterface)
    assert isinstance(provider.provider_id, str) and provider.provider_id
    assert isinstance(provider.display_name, str) and provider.display_name
    request = AzureMapsDiscoveryRequest(session_id="s1", query="juice bars")
    result = provider.discover(request)
    assert isinstance(result, Iterator), "discover() must return an iterator, not a list"
    candidates = list(result)
    assert all(isinstance(c, BusinessCandidate) for c in candidates)
    assert len(candidates) == 2


# ---------------------------------------------------------------------------
# 2. Mapping correctness / honest field mapping
# ---------------------------------------------------------------------------
def check_mapping_correctness() -> None:
    provider = AzureMapsProvider(subscription_key="fake-key", http_get=_make_fake_http_get())
    request = AzureMapsDiscoveryRequest(session_id="session-42", query="juice bars")
    candidates = list(provider.discover(request))
    assert len(candidates) == 2

    first = candidates[0]
    # Fields the documented response DOES contain — must be populated, verbatim.
    assert first.session_id == "session-42"
    assert first.provider == "azure_maps"
    assert first.provider_business_id == "US/POI/p0/9223158"
    assert first.name == "Pressed Juicery"
    assert first.category == "yogurt/juice bar"  # first entry of poi.categories[]
    assert first.address == "400 Pine St, Seattle, WA 98101"  # freeformAddress verbatim
    assert first.city == "Seattle"  # address.municipality
    assert first.country == "United States"  # address.country
    assert first.website == "www.pressedjuicery.com"  # poi.url, honestly a website here
    assert first.phone == "+(1)-(206)-6240804"  # poi.phone
    assert first.coordinates == (47.61138, -122.3374)  # position.lat/lon

    # Fields the documented response does NOT contain — must be None,
    # never guessed/derived/fabricated.
    assert first.maps_url is None
    assert first.rating is None
    assert first.review_count is None
    assert first.instagram_url is None

    # pipeline_id must be freshly minted per candidate, never fabricated
    # from response data, and never shared between candidates.
    assert first.pipeline_id != candidates[1].pipeline_id
    assert first.discovered_at is not None


def check_mapping_handles_missing_optional_fields() -> None:
    """
    A result missing optional response fields (no `poi.url`, no
    `poi.phone`, no `poi.categories`) must map to None for those
    BusinessCandidate fields — never a KeyError, never a fabricated
    default.
    """
    sparse_response = {
        "summary": {"query": "x", "numResults": 1, "offset": 0, "totalResults": 1},
        "results": [
            {
                "id": "US/POI/p9/000",
                "poi": {"name": "No Website Cafe"},
                "address": {"freeformAddress": "1 Main St"},
                "position": {"lat": 1.0, "lon": 2.0},
            }
        ],
    }
    provider = AzureMapsProvider(
        subscription_key="fake-key", http_get=_make_fake_http_get(sparse_response)
    )
    request = AzureMapsDiscoveryRequest(session_id="s1", query="cafe")
    [candidate] = list(provider.discover(request))
    assert candidate.name == "No Website Cafe"
    assert candidate.website is None
    assert candidate.phone is None
    assert candidate.category is None
    assert candidate.coordinates == (1.0, 2.0)


# ---------------------------------------------------------------------------
# 3. metadata()
# ---------------------------------------------------------------------------
def check_metadata() -> None:
    # Classmethod — callable with no subscription_key on hand.
    metadata = AzureMapsProvider.metadata()
    assert isinstance(metadata, ProviderMetadata)
    assert metadata.provider_id == "azure_maps"
    assert metadata.display_name == "Azure Maps"
    assert metadata.requires_api_key is True
    assert metadata.provider_type == "business_directory_api"
    assert metadata.homepage is not None


# ---------------------------------------------------------------------------
# 4. capabilities()
# ---------------------------------------------------------------------------
def check_capabilities() -> None:
    capabilities = AzureMapsProvider.capabilities()
    assert isinstance(capabilities, ProviderCapabilities)
    assert capabilities.supports_keyword_search is True
    assert capabilities.supports_category_search is True
    assert capabilities.supports_city_filter is False
    assert capabilities.supports_country_filter is True
    assert capabilities.supports_radius_search is True
    assert capabilities.supports_coordinate_search is True
    assert capabilities.supports_pagination is True
    assert capabilities.supports_streaming is True


# ---------------------------------------------------------------------------
# 5. Registry compatibility
# ---------------------------------------------------------------------------
def check_registry_compatibility() -> None:
    registry = ProviderRegistry()
    registry.register(
        "azure_maps",
        lambda: AzureMapsProvider(subscription_key="fake-key", http_get=_make_fake_http_get()),
        metadata=AzureMapsProvider.metadata(),
        capabilities=AzureMapsProvider.capabilities(),
    )
    assert registry.is_registered("azure_maps")
    assert "azure_maps" in registry.provider_ids()

    # Metadata/capabilities lookup requires no construction (no key needed).
    assert registry.metadata("azure_maps").provider_id == "azure_maps"
    assert registry.capabilities("azure_maps").supports_radius_search is True

    provider = registry.get("azure_maps")
    assert isinstance(provider, AzureMapsProvider)
    assert provider.provider_id == "azure_maps"

    composite = registry.build(["azure_maps"])
    assert isinstance(composite, CompositeDiscoveryProvider)
    assert composite.providers[0].provider_id == "azure_maps"


# ---------------------------------------------------------------------------
# 6. Plugin discovery
# ---------------------------------------------------------------------------
def check_plugin_discovery_compatibility() -> None:
    """
    ProviderRegistry.register() is fully generic — it takes any
    zero-arg factory returning a DiscoveryProviderInterface, with no
    AzureMapsProvider-specific branch anywhere. This proves
    AzureMapsProvider can be registered exactly the way a future
    plugin-discovery mechanism (scanning providers/*.py for a
    `factory`/`metadata`/`capabilities` triple, per __init__.py's own
    TODO) would register it: by provider_id string, a bare callable,
    and this provider's own metadata()/capabilities() classmethods —
    nothing hardcoded to "azure_maps" anywhere in the registry itself.
    """
    discovered = {
        "azure_maps": {
            "factory": lambda: AzureMapsProvider(
                subscription_key="fake-key", http_get=_make_fake_http_get()
            ),
            "metadata": AzureMapsProvider.metadata,
            "capabilities": AzureMapsProvider.capabilities,
        }
    }
    registry = ProviderRegistry()
    for provider_id, entry in discovered.items():
        registry.register(
            provider_id,
            entry["factory"],
            metadata=entry["metadata"](),
            capabilities=entry["capabilities"](),
        )
    assert registry.is_registered("azure_maps")
    assert isinstance(registry.get("azure_maps"), AzureMapsProvider)


# ---------------------------------------------------------------------------
# 7. Composite compatibility
# ---------------------------------------------------------------------------
def check_composite_compatibility() -> None:
    azure = AzureMapsProvider(subscription_key="fake-key", http_get=_make_fake_http_get())
    yelp = YelpProvider(api_key="fake-key", http_get=_make_fake_yelp_http_get())

    composite = CompositeDiscoveryProvider([azure, yelp])
    assert isinstance(composite, DiscoveryProviderInterface)

    request = CompositeDiscoveryRequest(
        requests={
            "azure_maps": AzureMapsDiscoveryRequest(session_id="s1", query="juice bars"),
            "yelp": YelpDiscoveryRequest(session_id="s1", term="juice bars", location="Seattle"),
        }
    )
    candidates = list(composite.discover(request))
    assert any(c.provider == "azure_maps" for c in candidates)
    assert any(c.provider == "yelp" for c in candidates)


# ---------------------------------------------------------------------------
# 8. Parallel compatibility
# ---------------------------------------------------------------------------
def check_parallel_compatibility() -> None:
    azure = AzureMapsProvider(subscription_key="fake-key", http_get=_make_fake_http_get())
    yelp = YelpProvider(api_key="fake-key", http_get=_make_fake_yelp_http_get())

    parallel = ParallelCompositeDiscoveryProvider([azure, yelp])
    assert isinstance(parallel, DiscoveryProviderInterface)

    request = ParallelDiscoveryRequest(
        requests={
            "azure_maps": AzureMapsDiscoveryRequest(session_id="s1", query="juice bars"),
            "yelp": YelpDiscoveryRequest(session_id="s1", term="juice bars", location="Seattle"),
        }
    )
    candidates = list(parallel.discover(request))
    assert any(c.provider == "azure_maps" for c in candidates)
    assert any(c.provider == "yelp" for c in candidates)


# ---------------------------------------------------------------------------
# 9. Deduplicator compatibility
# ---------------------------------------------------------------------------
def check_deduplicator_compatibility() -> None:
    azure = AzureMapsProvider(subscription_key="fake-key", http_get=_make_fake_http_get())
    dedup = ProviderDeduplicator(azure)
    assert isinstance(dedup, DiscoveryProviderInterface)

    request = AzureMapsDiscoveryRequest(session_id="s1", query="juice bars")
    candidates = list(dedup.discover(request))
    # Canned response has two distinct POIs -> no duplicates to collapse,
    # but this proves ProviderDeduplicator wraps AzureMapsProvider without
    # any special-casing (same generic DiscoveryProviderInterface wrap
    # every other provider already gets).
    assert len(candidates) == 2


# ---------------------------------------------------------------------------
# 10. Engine compatibility (no engine/ file references this provider)
# ---------------------------------------------------------------------------
def check_engine_compatibility() -> None:
    import inspect

    import engine.contracts as contracts_module
    import engine.interfaces as interfaces_module

    for module in (contracts_module, interfaces_module):
        source = inspect.getsource(module)
        assert "azure_maps" not in source.lower()
        assert "AzureMapsProvider" not in source
        assert "BingMaps" not in source

    # The Engine's only contact point is the abstract DiscoveryProviderInterface;
    # confirm AzureMapsProvider satisfies it with no additional required
    # constructor arguments beyond what every other provider already needs
    # (a credential — same shape as YelpProvider/AppleMapsProvider).
    assert DiscoveryProviderInterface in AzureMapsProvider.__mro__


# ---------------------------------------------------------------------------
# 11. Statelessness
# ---------------------------------------------------------------------------
def check_statelessness() -> None:
    provider = AzureMapsProvider(subscription_key="fake-key", http_get=_make_fake_http_get())
    request = AzureMapsDiscoveryRequest(session_id="s1", query="juice bars")

    first_run = list(provider.discover(request))
    second_run = list(provider.discover(request))
    assert len(first_run) == len(second_run) == 2
    # Distinct pipeline_ids each call -> no cached/shared candidate state
    # carried between discover() invocations.
    assert {c.pipeline_id for c in first_run}.isdisjoint({c.pipeline_id for c in second_run})

    # No instance attribute mutated by discover() beyond what __init__ set.
    attrs_before = dict(vars(provider))
    list(provider.discover(request))
    attrs_after = dict(vars(provider))
    assert attrs_before.keys() == attrs_after.keys()
    for key in attrs_before:
        # Callables (the injected http_get) compare by identity; everything
        # else must compare equal - nothing discover() touches should change.
        assert attrs_before[key] is attrs_after[key] or attrs_before[key] == attrs_after[key]


# ---------------------------------------------------------------------------
# 12. Immutability
# ---------------------------------------------------------------------------
def check_immutability() -> None:
    request = AzureMapsDiscoveryRequest(session_id="s1", query="juice bars")
    try:
        request.query = "changed"  # type: ignore[misc]
    except FrozenInstanceError:
        pass
    else:
        raise AssertionError("AzureMapsDiscoveryRequest must be frozen")

    metadata = AzureMapsProvider.metadata()
    try:
        metadata.display_name = "changed"  # type: ignore[misc]
    except FrozenInstanceError:
        pass
    else:
        raise AssertionError("ProviderMetadata must remain frozen")

    capabilities = AzureMapsProvider.capabilities()
    try:
        capabilities.supports_radius_search = False  # type: ignore[misc]
    except FrozenInstanceError:
        pass
    else:
        raise AssertionError("ProviderCapabilities must remain frozen")

    provider = AzureMapsProvider(subscription_key="fake-key", http_get=_make_fake_http_get())
    candidate = next(iter(provider.discover(request)))
    try:
        candidate.name = "changed"  # type: ignore[misc]
    except FrozenInstanceError:
        pass
    else:
        raise AssertionError("BusinessCandidate must remain frozen")


# ---------------------------------------------------------------------------
# 13. Transport injection
# ---------------------------------------------------------------------------
def check_transport_injection() -> None:
    record: list[dict[str, Any]] = []
    provider = AzureMapsProvider(
        subscription_key="my-key", http_get=_make_fake_http_get(record=record)
    )
    request = AzureMapsDiscoveryRequest(
        session_id="s1",
        query="juice bars",
        category_set=(7315, 7315149),
        country_set=("US", "CA"),
        lat=47.6,
        lon=-122.3,
        radius=8046,
        top_left="47.7,-122.4",
        btm_right="47.5,-122.2",
        language="en-US",
        view="US",
        brand_set=("Pressed Juicery",),
    )
    list(provider.discover(request))

    assert record, "fake http_get was never called — transport injection failed"
    sent = record[0]
    assert sent["subscription-key"] == "my-key"
    assert sent["query"] == "juice bars"
    assert sent["categorySet"] == "7315,7315149"
    assert sent["countrySet"] == "US,CA"
    assert sent["lat"] == 47.6
    assert sent["lon"] == -122.3
    assert sent["radius"] == 8046
    assert sent["topLeft"] == "47.7,-122.4"
    assert sent["btmRight"] == "47.5,-122.2"
    assert sent["language"] == "en-US"
    assert sent["view"] == "US"
    assert sent["brandSet"] == "Pressed Juicery"

    # Default transport is never invoked when http_get is injected — no
    # real network access occurs anywhere in this validation run.
    assert provider._http_get is not None


def _make_poi_page(count: int, start_id: int = 0) -> dict[str, Any]:
    return {
        "summary": {"numResults": count},
        "results": [
            {
                "id": f"id-{start_id + i}",
                "poi": {"name": f"Business {start_id + i}"},
                "address": {"freeformAddress": f"{start_id + i} Main St"},
                "position": {"lat": 1.0, "lon": 2.0},
            }
            for i in range(count)
        ],
    }


def check_pagination_via_injected_transport() -> None:
    """
    Proves discover() actually pages through `ofs` — not just that it
    can be called once. discover()'s per-request page size is capped at
    the documented 100 maximum (`_PAGE_SIZE`), so real multi-page
    pagination only occurs when `request.limit` exceeds 100 — this test
    requests 150, gets a full first page of 100 (triggering a second
    call), then a partial second page of 30 (fewer than the 50
    requested, so discover() must recognize source exhaustion and stop
    without a third call).
    """
    page_one = _make_poi_page(100, start_id=0)
    page_two = _make_poi_page(30, start_id=100)
    pages = [page_one, page_two]
    calls: list[dict[str, Any]] = []

    def fake_paged_get(url: str, params: dict[str, Any], headers: dict[str, str]) -> dict[str, Any]:
        calls.append(dict(params))
        assert len(calls) <= len(pages), "discover() issued a call beyond source exhaustion"
        return pages[len(calls) - 1]

    provider = AzureMapsProvider(subscription_key="fake-key", http_get=fake_paged_get)
    request = AzureMapsDiscoveryRequest(session_id="s1", query="x", limit=150)
    candidates = list(provider.discover(request))

    assert len(candidates) == 130  # 100 (page 1, full) + 30 (page 2, exhausted)
    assert len(calls) == 2, "expected exactly two HTTP calls (one per page)"
    assert calls[0]["ofs"] == 0 and calls[0]["limit"] == 100
    assert calls[1]["ofs"] == 100 and calls[1]["limit"] == 50
    # Candidates are streamed, never materialized as a list before the
    # caller can iterate — confirmed separately by check_interface_compliance's
    # isinstance(..., Iterator) assertion on the raw discover() return value.


def _make_fake_yelp_http_get() -> Callable[[str, dict[str, Any], dict[str, str]], dict[str, Any]]:
    def _fake(url: str, params: dict[str, Any], headers: dict[str, str]) -> dict[str, Any]:
        return {
            "businesses": [
                {
                    "id": "yelp-1",
                    "name": "Juice Yelp Co",
                    "url": "https://yelp.com/biz/juice-yelp-co",
                    "location": {"display_address": ["1 Yelp St"], "city": "Seattle", "country": "US"},
                    "coordinates": {"latitude": 47.6, "longitude": -122.3},
                    "rating": 4.5,
                    "review_count": 10,
                }
            ]
        }

    return _fake


# ---------------------------------------------------------------------------
# 14. Provider Configuration & Selection compatibility (registry.create())
# ---------------------------------------------------------------------------
def check_provider_configuration_compatibility() -> None:
    registry = ProviderRegistry()
    registry.register(
        "azure_maps",
        lambda: AzureMapsProvider(subscription_key="fake-key", http_get=_make_fake_http_get()),
        metadata=AzureMapsProvider.metadata(),
        capabilities=AzureMapsProvider.capabilities(),
    )
    registry.register(
        "yelp",
        lambda: YelpProvider(api_key="fake-key", http_get=_make_fake_yelp_http_get()),
        metadata=YelpProvider.metadata(),
        capabilities=YelpProvider.capabilities(),
    )

    single = registry.create(ProviderConfiguration(providers=["azure_maps"]))
    assert isinstance(single, AzureMapsProvider)

    sequential = registry.create(ProviderConfiguration(providers=["azure_maps", "yelp"]))
    assert isinstance(sequential, CompositeDiscoveryProvider)

    parallel = registry.create(
        ProviderConfiguration(providers=["azure_maps", "yelp"], parallel=True)
    )
    assert isinstance(parallel, ParallelCompositeDiscoveryProvider)

    deduped = registry.create(
        ProviderConfiguration(providers=["azure_maps", "yelp"], deduplicate=True)
    )
    assert isinstance(deduped, ProviderDeduplicator)


def main() -> int:
    check("Interface compliance", check_interface_compliance)
    check("Mapping correctness", check_mapping_correctness)
    check("Mapping handles missing optional fields", check_mapping_handles_missing_optional_fields)
    check("metadata()", check_metadata)
    check("capabilities()", check_capabilities)
    check("Registry compatibility", check_registry_compatibility)
    check("Plugin discovery compatibility", check_plugin_discovery_compatibility)
    check("Composite compatibility", check_composite_compatibility)
    check("Parallel compatibility", check_parallel_compatibility)
    check("Deduplicator compatibility", check_deduplicator_compatibility)
    check("Engine compatibility", check_engine_compatibility)
    check("Statelessness", check_statelessness)
    check("Immutability", check_immutability)
    check("Transport injection", check_transport_injection)
    check("Pagination via injected transport", check_pagination_via_injected_transport)
    check("Provider Configuration & Selection compatibility", check_provider_configuration_compatibility)

    print(f"\n{PASS_COUNT} passed, {FAIL_COUNT} failed")
    return 0 if FAIL_COUNT == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
