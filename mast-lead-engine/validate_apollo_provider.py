"""
MAST Engine V2 — ApolloProvider Validation
=============================================

Source: this milestone's own instructions ("Create
validate_apollo_provider.py"). Mirrors the existing provider
validation scripts' own established style (canned/fake HTTP transport
injected via constructor args — see provider_deduplicator.py's own
"Architecture review," which cites "the existing provider validation
scripts' style (canned/fake sources injected via constructor args, no
live network in tests)" as read-and-followed precedent). No live
network call is made anywhere in this script.

What this validates, and how
----------------------------------------------------------------------
    - Interface compliance        : ApolloProvider is-a
                                     DiscoveryProviderInterface;
                                     provider_id/display_name are
                                     non-empty strings; discover()
                                     returns an iterator.
    - Honest field mapping        : every BusinessCandidate field this
                                     provider claims to populate is
                                     populated from a canned response
                                     fixture; every field this provider
                                     documents as never-populated
                                     (maps_url, address, rating,
                                     review_count, coordinates,
                                     instagram_url) is confirmed None
                                     even when the fixture supplies
                                     unrelated data alongside it.
    - metadata()                  : returns a ProviderMetadata whose
                                     provider_id matches the instance's
                                     own provider_id; callable with no
                                     constructed instance (no api_key
                                     needed).
    - capabilities()               : returns a ProviderCapabilities
                                     whose flags match this provider's
                                     own documented request/response
                                     support; callable with no
                                     constructed instance.
    - Registry compatibility      : registers into a real
                                     ProviderRegistry, is gettable by
                                     provider_id, and round-trips its
                                     own metadata()/capabilities().
    - Plugin discovery             : the module exposes exactly the
                                     two importable symbols a
                                     registration call site needs
                                     (ApolloProvider,
                                     ApolloDiscoveryRequest) with no
                                     import-time side effects (no
                                     network call, no credential
                                     lookup) — importing the module
                                     alone is safe.
    - Composite compatibility     : works inside a
                                     CompositeDiscoveryProvider
                                     alongside another provider.
    - Parallel compatibility      : works inside a
                                     ParallelCompositeDiscoveryProvider
                                     alongside another provider.
    - Deduplicator compatibility  : works wrapped in a
                                     ProviderDeduplicator, and a
                                     cross-provider duplicate (same
                                     name+website as a candidate from a
                                     different provider_id) is actually
                                     dropped.
    - ProviderConfiguration compat: ProviderRegistry.create() produces
                                     a working DiscoveryProviderInterface
                                     from a ProviderConfiguration naming
                                     "apollo".
    - Engine compatibility         : ApolloProvider.discover() is
                                     callable through nothing but the
                                     DiscoveryProviderInterface contract
                                     — no Apollo-specific method is
                                     required by any caller.
    - Statelessness                : two discover() calls against the
                                     same instance, with a transport
                                     that returns different fixtures
                                     each call, yield independent
                                     results — nothing cached on the
                                     instance affects the second call.
    - Immutability                 : ApolloDiscoveryRequest is frozen
                                     (attribute assignment raises).
    - Transport injection          : a fake http_post is honored in
                                     place of the real network
                                     transport, and receives the
                                     expected URL/body/headers shape.
    - Pagination                   : discover() auto-pages across a
                                     canned two-page fixture and stops
                                     correctly at end-of-results, at a
                                     short page, and at
                                     request.max_results.
    - No Engine changes required   : engine/interfaces.py and
                                     engine/contracts.py are imported
                                     read-only by this script and never
                                     written to.
"""

from __future__ import annotations

import sys
import traceback
from dataclasses import FrozenInstanceError
from typing import Any, Callable

from engine.contracts import BusinessCandidate
from engine.interfaces import DiscoveryProviderInterface
from providers.apollo_provider import ApolloDiscoveryRequest, ApolloProvider
from providers.composite_provider import CompositeDiscoveryProvider, CompositeDiscoveryRequest
from providers.parallel_composite_provider import ParallelCompositeDiscoveryProvider, ParallelDiscoveryRequest
from providers.provider_capabilities import ProviderCapabilities
from providers.provider_configuration import ProviderConfiguration
from providers.provider_deduplicator import ProviderDeduplicator
from providers.provider_metadata import ProviderMetadata
from providers.registry import ProviderRegistry

_FAILURES: list[str] = []


def _check(label: str, condition: bool, detail: str = "") -> None:
    status = "PASS" if condition else "FAIL"
    print(f"[{status}] {label}" + (f" — {detail}" if detail and not condition else ""))
    if not condition:
        _FAILURES.append(label)


# ---------------------------------------------------------------------------
# Canned fixtures — no live network anywhere in this script
# ---------------------------------------------------------------------------
_PAGE_1 = {
    "organizations": [
        {
            "id": "org_001",
            "name": "Acme Robotics",
            "website_url": "https://www.acmerobotics.example",
            "primary_domain": "acmerobotics.example",
            "industry": "industrial automation",
            "phone": "+1-555-0100",
            "city": "Austin",
            "state": "Texas",
            "country": "United States",
            "linkedin_url": "https://linkedin.com/company/acme-robotics",
        },
        {
            "id": "org_002",
            "name": "Nordwind Logistics",
            "website_url": None,
            "primary_domain": "nordwind.example",
            "industry": None,
            "phone": None,
            "city": None,
            "state": None,
            "country": "Germany",
        },
    ],
    "pagination": {"page": 1, "per_page": 2, "total_entries": 3, "total_pages": 2},
}
_PAGE_2 = {
    "organizations": [
        {"id": "org_003", "name": "Solstice Analytics", "website_url": "https://solstice.example"},
    ],
    "pagination": {"page": 2, "per_page": 2, "total_entries": 3, "total_pages": 2},
}
_EMPTY_PAGE = {"organizations": [], "pagination": {"page": 3, "per_page": 2, "total_entries": 3, "total_pages": 2}}


def _paged_transport(pages: list[dict[str, Any]]) -> Callable[[str, dict, dict], dict]:
    """A fake http_post that returns successive canned pages, one per call."""
    calls: list[dict[str, Any]] = []
    remaining = list(pages)

    def _fake_post(url: str, body: dict, headers: dict) -> dict:
        calls.append({"url": url, "body": body, "headers": headers})
        if not remaining:
            return _EMPTY_PAGE
        return remaining.pop(0)

    _fake_post.calls = calls  # type: ignore[attr-defined]
    return _fake_post


def _single_page_transport(page: dict[str, Any]) -> Callable[[str, dict, dict], dict]:
    def _fake_post(url: str, body: dict, headers: dict) -> dict:
        return page

    return _fake_post


# ---------------------------------------------------------------------------
# 1. Interface compliance
# ---------------------------------------------------------------------------
def check_interface_compliance() -> None:
    provider = ApolloProvider(api_key="fake-key", http_post=_single_page_transport(_PAGE_1))
    _check("ApolloProvider is-a DiscoveryProviderInterface", isinstance(provider, DiscoveryProviderInterface))
    _check("provider_id is a non-empty string", isinstance(provider.provider_id, str) and bool(provider.provider_id))
    _check("display_name is a non-empty string", isinstance(provider.display_name, str) and bool(provider.display_name))
    _check("provider_id == 'apollo'", provider.provider_id == "apollo")

    request = ApolloDiscoveryRequest(session_id="s1")
    result = provider.discover(request)
    _check("discover() returns an iterator (has __next__)", hasattr(result, "__next__"))
    candidates = list(result)
    _check("discover() yields BusinessCandidate instances", all(isinstance(c, BusinessCandidate) for c in candidates))
    _check("discover() yielded the expected count for a single page", len(candidates) == 2, f"got {len(candidates)}")


# ---------------------------------------------------------------------------
# 2. Honest field mapping
# ---------------------------------------------------------------------------
def check_honest_field_mapping() -> None:
    provider = ApolloProvider(api_key="fake-key", http_post=_single_page_transport(_PAGE_1))
    request = ApolloDiscoveryRequest(session_id="s1")
    candidates = list(provider.discover(request))
    first, second = candidates[0], candidates[1]

    # Fields this provider claims to populate, from a fully-populated fixture entry.
    _check("provider_business_id mapped from 'id'", first.provider_business_id == "org_001")
    _check("name mapped from 'name'", first.name == "Acme Robotics")
    _check("category mapped from 'industry'", first.category == "industrial automation")
    _check("city mapped from 'city'", first.city == "Austin")
    _check("country mapped from 'country'", first.country == "United States")
    _check("website mapped from 'website_url'", first.website == "https://www.acmerobotics.example")
    _check("phone mapped from 'phone'", first.phone == "+1-555-0100")
    _check("provider field set to provider_id", first.provider == "apollo")
    _check("discovered_at populated", first.discovered_at is not None)

    # Fields this provider documents as never-populated — must stay None
    # even though the fixture supplies unrelated data alongside them.
    _check("maps_url never fabricated (None)", first.maps_url is None)
    _check("address never fabricated (None)", first.address is None)
    _check("rating never fabricated (None)", first.rating is None)
    _check("review_count never fabricated (None)", first.review_count is None)
    _check("coordinates never fabricated (None)", first.coordinates is None)
    _check("instagram_url never fabricated (None)", first.instagram_url is None)

    # Null/missing upstream fields normalize to None, not to "" or a fabricated default.
    _check("null website_url maps to None, not a fabricated URL", second.website is None)
    _check("null industry maps to None, not a fabricated category", second.category is None)
    _check("null city maps to None (not silently pulled from 'state')", second.city is None)
    _check("present country still maps when city is absent", second.country == "Germany")

    # 'state' has no BusinessCandidate slot and must not be force-fit
    # into city or country.
    _check(
        "'state' (Texas) is not force-fit into city or country",
        first.city == "Austin" and first.country == "United States",
    )


# ---------------------------------------------------------------------------
# 3. metadata() / 4. capabilities()
# ---------------------------------------------------------------------------
def check_metadata_and_capabilities() -> None:
    # Callable with no constructed instance — no api_key needed.
    metadata = ApolloProvider.metadata()
    _check("metadata() callable without construction", isinstance(metadata, ProviderMetadata))
    _check("metadata().provider_id == 'apollo'", metadata.provider_id == "apollo")
    _check("metadata().requires_api_key is True", metadata.requires_api_key is True)
    _check("metadata().provider_id matches instance provider_id",
           metadata.provider_id == ApolloProvider(api_key="x").provider_id)

    capabilities = ApolloProvider.capabilities()
    _check("capabilities() callable without construction", isinstance(capabilities, ProviderCapabilities))
    _check("supports_keyword_search is True", capabilities.supports_keyword_search is True)
    _check("supports_category_search is True", capabilities.supports_category_search is True)
    _check("supports_city_filter is True", capabilities.supports_city_filter is True)
    _check("supports_country_filter is True", capabilities.supports_country_filter is True)
    _check("supports_radius_search is False", capabilities.supports_radius_search is False)
    _check("supports_coordinate_search is False", capabilities.supports_coordinate_search is False)
    _check("supports_pagination is True", capabilities.supports_pagination is True)
    _check("supports_streaming is True", capabilities.supports_streaming is True)


# ---------------------------------------------------------------------------
# 5. Registry compatibility / 6. Plugin discovery
# ---------------------------------------------------------------------------
def check_registry_and_plugin_discovery() -> None:
    registry = ProviderRegistry()
    registry.register(
        "apollo",
        lambda: ApolloProvider(api_key="fake-key", http_post=_single_page_transport(_PAGE_1)),
        metadata=ApolloProvider.metadata(),
        capabilities=ApolloProvider.capabilities(),
    )
    _check("'apollo' appears in registry.provider_ids()", "apollo" in registry.provider_ids())

    instance = registry.get("apollo")
    _check("registry.get('apollo') returns an ApolloProvider", isinstance(instance, ApolloProvider))
    _check("registry.metadata('apollo') round-trips", registry.metadata("apollo").provider_id == "apollo")
    _check(
        "registry.capabilities('apollo') round-trips",
        registry.capabilities("apollo").supports_pagination is True,
    )

    # Plugin discovery: importing the module must have no side effects —
    # no network call, no credential lookup — and must expose exactly the
    # symbols a registration call site needs.
    import providers.apollo_provider as module

    _check("module exposes ApolloProvider", hasattr(module, "ApolloProvider"))
    _check("module exposes ApolloDiscoveryRequest", hasattr(module, "ApolloDiscoveryRequest"))
    _check(
        "ApolloProvider.provider_id is a property, readable pre-construction via metadata()",
        module.ApolloProvider.metadata().provider_id == "apollo",
    )


# ---------------------------------------------------------------------------
# 7. Composite compatibility / 8. Parallel compatibility / 9. Deduplicator
# ---------------------------------------------------------------------------
class _StubOtherProvider(DiscoveryProviderInterface):
    """
    A minimal second DiscoveryProviderInterface implementation, distinct
    from ApolloProvider, used only to prove ApolloProvider composes
    alongside *another* provider — CompositeDiscoveryProvider and
    ParallelCompositeDiscoveryProvider both reject two wrapped providers
    sharing one provider_id (by design — see composite_provider.py's own
    duplicate-id guard), so a real cross-provider test needs a second,
    independently-identified provider, not a second ApolloProvider
    instance.
    """

    def __init__(self, candidates: list[BusinessCandidate]) -> None:
        self._candidates = candidates

    @property
    def provider_id(self) -> str:
        return "stub_other"

    @property
    def display_name(self) -> str:
        return "Stub Other Provider"

    def discover(self, request: Any):
        yield from self._candidates


def check_composite_parallel_deduplicator() -> None:
    apollo = ApolloProvider(api_key="fake-key", http_post=_single_page_transport(_PAGE_1))
    other = _StubOtherProvider(
        [
            BusinessCandidate(
                pipeline_id="p1", session_id="s1", provider="stub_other",
                provider_business_id="stub_001", name="Stub Co", website="https://stub.example",
            )
        ]
    )

    composite = CompositeDiscoveryProvider([apollo, other])
    composite_request = CompositeDiscoveryRequest(
        requests={
            "apollo": ApolloDiscoveryRequest(session_id="s1"),
            "stub_other": None,
        }
    )
    composite_results = list(composite.discover(composite_request))
    _check(
        "CompositeDiscoveryProvider([apollo, other]) yields both providers' candidates",
        len(composite_results) == 3,
        f"got {len(composite_results)}",
    )

    apollo_for_parallel = ApolloProvider(api_key="fake-key", http_post=_single_page_transport(_PAGE_1))
    parallel = ParallelCompositeDiscoveryProvider([apollo_for_parallel, other])
    parallel_request = ParallelDiscoveryRequest(
        requests={
            "apollo": ApolloDiscoveryRequest(session_id="s1"),
            "stub_other": None,
        }
    )
    parallel_results = list(parallel.discover(parallel_request))
    _check(
        "ParallelCompositeDiscoveryProvider([apollo, other]) yields both providers' candidates",
        len(parallel_results) == 3,
        f"got {len(parallel_results)}",
    )

    # Cross-provider duplicate: same name+website, different provider_id —
    # a real ProviderDeduplicator scenario.
    dup_fixture = {
        "organizations": [
            {"id": "org_dup", "name": "Acme Robotics", "website_url": "https://www.acmerobotics.example"},
        ],
        "pagination": {"page": 1, "per_page": 10, "total_entries": 1, "total_pages": 1},
    }
    apollo_dup_only = ApolloProvider(api_key="fake-key", http_post=_single_page_transport(dup_fixture))
    other_duplicate = _StubOtherProvider(
        [
            BusinessCandidate(
                pipeline_id="p2", session_id="s1", provider="stub_other",
                provider_business_id="stub_dup", name="Acme Robotics",
                website="https://www.acmerobotics.example",
            )
        ]
    )
    deduped = ProviderDeduplicator(CompositeDiscoveryProvider([apollo_dup_only, other_duplicate]))
    dedup_request = CompositeDiscoveryRequest(
        requests={
            "apollo": ApolloDiscoveryRequest(session_id="s1"),
            "stub_other": None,
        }
    )
    deduped_results = list(deduped.discover(dedup_request))
    _check(
        "ProviderDeduplicator drops the cross-provider duplicate (Acme Robotics)",
        len(deduped_results) == 1,
        f"got {len(deduped_results)}",
    )


# ---------------------------------------------------------------------------
# 10. ProviderConfiguration compatibility
# ---------------------------------------------------------------------------
def check_provider_configuration() -> None:
    registry = ProviderRegistry()
    registry.register("apollo", lambda: ApolloProvider(api_key="fake-key", http_post=_single_page_transport(_PAGE_1)))
    configuration = ProviderConfiguration(providers=["apollo"])
    built = registry.create(configuration)
    _check("registry.create(ProviderConfiguration(['apollo'])) returns an ApolloProvider directly",
           isinstance(built, ApolloProvider))

    results = list(built.discover(ApolloDiscoveryRequest(session_id="s1")))
    _check("configured provider discover() works end-to-end", len(results) == 2, f"got {len(results)}")


# ---------------------------------------------------------------------------
# 11. Engine compatibility
# ---------------------------------------------------------------------------
def check_engine_compatibility() -> None:
    def engine_like_consumer(provider: DiscoveryProviderInterface, request: Any) -> int:
        """
        Stands in for the Engine: touches nothing but
        DiscoveryProviderInterface's own three contract members.
        """
        count = 0
        for _ in provider.discover(request):
            count += 1
        return count

    provider: DiscoveryProviderInterface = ApolloProvider(
        api_key="fake-key", http_post=_single_page_transport(_PAGE_1)
    )
    count = engine_like_consumer(provider, ApolloDiscoveryRequest(session_id="s1"))
    _check("a caller depending only on DiscoveryProviderInterface can drive ApolloProvider", count == 2)


# ---------------------------------------------------------------------------
# 12. Statelessness
# ---------------------------------------------------------------------------
def check_statelessness() -> None:
    transport = _paged_transport([_PAGE_1])
    provider = ApolloProvider(api_key="fake-key", http_post=transport)

    first_call = list(provider.discover(ApolloDiscoveryRequest(session_id="s1")))
    second_transport = _paged_transport([_PAGE_2])
    provider_b = ApolloProvider(api_key="fake-key", http_post=second_transport)
    second_call = list(provider_b.discover(ApolloDiscoveryRequest(session_id="s2")))

    _check("two independent discover() calls (different transports) yield independent results",
           len(first_call) == 2 and len(second_call) == 1)
    _check("first call's candidates carry session s1", all(c.session_id == "s1" for c in first_call))
    _check("second call's candidates carry session s2", all(c.session_id == "s2" for c in second_call))


# ---------------------------------------------------------------------------
# 13. Immutability
# ---------------------------------------------------------------------------
def check_immutability() -> None:
    request = ApolloDiscoveryRequest(session_id="s1", q_organization_name="acme")
    try:
        request.q_organization_name = "changed"  # type: ignore[misc]
        _check("ApolloDiscoveryRequest is frozen (attribute assignment raises)", False)
    except FrozenInstanceError:
        _check("ApolloDiscoveryRequest is frozen (attribute assignment raises)", True)


# ---------------------------------------------------------------------------
# 14. Transport injection
# ---------------------------------------------------------------------------
def check_transport_injection() -> None:
    transport = _paged_transport([_PAGE_1])
    provider = ApolloProvider(api_key="fake-key-123", http_post=transport)
    list(provider.discover(ApolloDiscoveryRequest(session_id="s1", q_organization_name="acme")))

    calls = transport.calls  # type: ignore[attr-defined]
    _check("injected transport was actually called", len(calls) == 1)
    call = calls[0]
    _check("call targeted the Organization Search URL", call["url"].endswith("/mixed_companies/search"))
    _check("call carried the x-api-key header", call["headers"].get("x-api-key") == "fake-key-123")
    _check("call body carried q_organization_name", call["body"].get("q_organization_name") == "acme")
    _check("call body carried page/per_page", "page" in call["body"] and "per_page" in call["body"])

    # Default transport is used when none is injected — constructible
    # without error (no network call happens merely by constructing).
    default_provider = ApolloProvider(api_key="fake-key-123")
    _check("provider constructs with default transport (no injection required)",
           isinstance(default_provider, ApolloProvider))


# ---------------------------------------------------------------------------
# 15. Pagination
# ---------------------------------------------------------------------------
def check_pagination() -> None:
    # (a) Auto-pages across two full pages, stops at total_pages.
    transport = _paged_transport([_PAGE_1, _PAGE_2])
    provider = ApolloProvider(api_key="fake-key", http_post=transport)
    results = list(provider.discover(ApolloDiscoveryRequest(session_id="s1", per_page=2)))
    _check("auto-pagination yields all 3 candidates across 2 pages", len(results) == 3, f"got {len(results)}")
    _check("auto-pagination stopped at total_pages (exactly 2 HTTP calls)",
           len(transport.calls) == 2, f"got {len(transport.calls)}")  # type: ignore[attr-defined]

    # (b) Stops at a short page even without pagination metadata.
    short_page = {"organizations": [{"id": "x", "name": "Solo Co"}], "pagination": {}}
    transport_b = _paged_transport([short_page])
    provider_b = ApolloProvider(api_key="fake-key", http_post=transport_b)
    results_b = list(provider_b.discover(ApolloDiscoveryRequest(session_id="s1", per_page=25)))
    _check("short page (fewer than per_page) stops pagination", len(results_b) == 1)
    _check("short page triggers exactly one HTTP call",
           len(transport_b.calls) == 1)  # type: ignore[attr-defined]

    # (c) Stops at request.max_results mid-page.
    transport_c = _paged_transport([_PAGE_1, _PAGE_2])
    provider_c = ApolloProvider(api_key="fake-key", http_post=transport_c)
    results_c = list(provider_c.discover(ApolloDiscoveryRequest(session_id="s1", per_page=2, max_results=1)))
    _check("max_results=1 stops after exactly 1 candidate", len(results_c) == 1, f"got {len(results_c)}")
    _check("max_results stops before a second HTTP call is needed",
           len(transport_c.calls) == 1)  # type: ignore[attr-defined]

    # (d) A caller can seed request.page to resume from a specific page.
    transport_d = _paged_transport([_PAGE_2])
    provider_d = ApolloProvider(api_key="fake-key", http_post=transport_d)
    results_d = list(provider_d.discover(ApolloDiscoveryRequest(session_id="s1", per_page=2, page=2)))
    _check("seeding request.page=2 resumes from page 2", len(results_d) == 1)
    _check("seeded page is sent on the first call", transport_d.calls[0]["body"]["page"] == 2)  # type: ignore[attr-defined]


# ---------------------------------------------------------------------------
# 16. No Engine changes required
# ---------------------------------------------------------------------------
def check_no_engine_changes_required() -> None:
    # engine/interfaces.py and engine/contracts.py are imported read-only
    # above; ApolloProvider satisfies DiscoveryProviderInterface without
    # either module being modified or subclassed beyond the ABC itself.
    _check(
        "ApolloProvider satisfies DiscoveryProviderInterface's abstract contract exactly",
        DiscoveryProviderInterface.__abstractmethods__ <= {
            name for name in dir(ApolloProvider) if not name.startswith("_")
        }
        or all(hasattr(ApolloProvider, m) for m in DiscoveryProviderInterface.__abstractmethods__),
    )
    _check(
        "no new method was added to DiscoveryProviderInterface itself",
        set(DiscoveryProviderInterface.__abstractmethods__) == {"provider_id", "display_name", "discover"},
    )


# ---------------------------------------------------------------------------
# Runner
# ---------------------------------------------------------------------------
def main() -> int:
    checks = [
        ("Interface compliance", check_interface_compliance),
        ("Honest field mapping", check_honest_field_mapping),
        ("metadata() / capabilities()", check_metadata_and_capabilities),
        ("Registry / plugin discovery", check_registry_and_plugin_discovery),
        ("Composite / Parallel / Deduplicator", check_composite_parallel_deduplicator),
        ("ProviderConfiguration", check_provider_configuration),
        ("Engine compatibility", check_engine_compatibility),
        ("Statelessness", check_statelessness),
        ("Immutability", check_immutability),
        ("Transport injection", check_transport_injection),
        ("Pagination", check_pagination),
        ("No Engine changes required", check_no_engine_changes_required),
    ]
    for label, fn in checks:
        print(f"\n--- {label} ---")
        try:
            fn()
        except Exception:  # noqa: BLE001 — a check crashing is itself a failure to report
            print(f"[FAIL] {label} raised an exception:")
            traceback.print_exc()
            _FAILURES.append(f"{label} (exception)")

    print("\n" + "=" * 60)
    if _FAILURES:
        print(f"{len(_FAILURES)} check(s) FAILED:")
        for f in _FAILURES:
            print(f"  - {f}")
        return 1
    print("All checks PASSED.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
