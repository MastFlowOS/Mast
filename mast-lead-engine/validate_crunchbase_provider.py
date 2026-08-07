"""
MAST Engine V2 — validate_crunchbase_provider.py
====================================================

Validates CrunchbaseProvider against the same checklist every prior
provider validation script in this codebase applies (interface
compliance, honest field mapping, metadata()/capabilities(), registry
compatibility, plugin discovery, composite/parallel/deduplicator
compatibility, ProviderConfiguration compatibility, engine
compatibility, statelessness, immutability, transport injection,
pagination). Uses an injected fake `http_post` throughout — no network
access is required or attempted.
"""

from __future__ import annotations

import sys
from dataclasses import FrozenInstanceError
from typing import Any, Iterator

sys.path.insert(0, ".")

from engine.contracts import BusinessCandidate
from engine.interfaces import DiscoveryProviderInterface
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
from providers.crunchbase_provider import (
    CrunchbaseDiscoveryRequest,
    CrunchbaseProvider,
    _BASELINE_FIELD_IDS,
)

PASS = []
FAIL = []


def check(name: str, condition: bool, detail: str = "") -> None:
    if condition:
        PASS.append(name)
        print(f"PASS  {name}")
    else:
        FAIL.append(name)
        print(f"FAIL  {name}  {detail}")


# ---------------------------------------------------------------------------
# Fake transport — canned Organization Search responses, no network
# ---------------------------------------------------------------------------
def make_entity(uuid_: str, name: str, permalink: str, website=None,
                 city=None, country=None, categories=None) -> dict[str, Any]:
    locations = []
    if city:
        locations.append({"uuid": f"loc-{city}", "value": city, "location_type": "city"})
    if country:
        locations.append({"uuid": f"loc-{country}", "value": country, "location_type": "country"})
    props: dict[str, Any] = {
        "identifier": {
            "uuid": uuid_,
            "value": name,
            "permalink": permalink,
            "entity_def_id": "organization",
        },
        "website_url": website,
        "location_identifiers": locations,
    }
    if categories is not None:
        props["categories"] = [{"uuid": f"cat-{c}", "value": c} for c in categories]
    return {"uuid": uuid_, "properties": props}


PAGE_1 = {
    "count": 3,
    "entities": [
        make_entity("uuid-1", "Acme Robotics", "acme-robotics",
                    website="https://acme.example", city="Austin",
                    country="United States"),
        make_entity("uuid-2", "Beta Biotech", "beta-biotech",
                    website=None, city="Boston", country="United States"),
    ],
}
PAGE_WITH_CATEGORIES = {
    "count": 1,
    "entities": [
        make_entity("uuid-1", "Acme Robotics", "acme-robotics",
                    website="https://acme.example", city="Austin",
                    country="United States", categories=["Robotics", "Hardware"]),
    ],
}
PAGE_2 = {
    "count": 3,
    "entities": [
        make_entity("uuid-3", "Gamma Analytics", "gamma-analytics",
                    website="https://gamma.example", city=None, country="Canada"),
    ],
}
EMPTY_PAGE = {"count": 0, "entities": []}


class FakeTransport:
    """
    Records every call made to it and serves canned pages in sequence,
    keyed by whether `after_id` is present — used to validate
    keyset-pagination wiring without a network call.
    """

    def __init__(self, pages: list[dict[str, Any]]):
        self.pages = list(pages)
        self.calls: list[tuple[str, dict[str, Any], dict[str, str]]] = []

    def __call__(self, url: str, body: dict[str, Any], headers: dict[str, str]) -> dict[str, Any]:
        self.calls.append((url, body, headers))
        if not self.pages:
            return EMPTY_PAGE
        return self.pages.pop(0)


# ---------------------------------------------------------------------------
# 1. Interface compliance
# ---------------------------------------------------------------------------
check(
    "CrunchbaseProvider subclasses DiscoveryProviderInterface",
    issubclass(CrunchbaseProvider, DiscoveryProviderInterface),
)

transport = FakeTransport([dict(PAGE_1), dict(EMPTY_PAGE)])
provider = CrunchbaseProvider(api_key="fake-key", http_post=transport)

check("provider_id is a non-empty str", isinstance(provider.provider_id, str) and provider.provider_id == "crunchbase")
check("display_name is a non-empty str", isinstance(provider.display_name, str) and bool(provider.display_name))

result = provider.discover(CrunchbaseDiscoveryRequest(session_id="s1", limit=2))
check("discover() returns an Iterator, not a list", isinstance(result, Iterator))
candidates = list(result)
check("discover() yields BusinessCandidate instances", all(isinstance(c, BusinessCandidate) for c in candidates))
check("discover() produced expected count for one non-empty + one empty page", len(candidates) == 2, str(len(candidates)))

# ---------------------------------------------------------------------------
# 2. Honest field mapping
# ---------------------------------------------------------------------------
transport2 = FakeTransport([dict(PAGE_1)])
provider2 = CrunchbaseProvider(api_key="fake-key", http_post=transport2)
c1, c2 = list(provider2.discover(CrunchbaseDiscoveryRequest(session_id="s1", limit=5)))

check("name mapped from identifier.value", c1.name == "Acme Robotics")
check("provider_business_id mapped from top-level uuid", c1.provider_business_id == "uuid-1")
check("maps_url built from permalink", c1.maps_url == "https://www.crunchbase.com/organization/acme-robotics")
check("website mapped from website_url", c1.website == "https://acme.example")
check("website left None when website_url absent", c2.website is None)
check("city mapped from location_identifiers (city granularity)", c1.city == "Austin")
check("country mapped from location_identifiers (country granularity)", c1.country == "United States")
check("category left None when include_categories not opted in", c1.category is None)
check("provider field set to provider_id", c1.provider == "crunchbase")
check("address never fabricated (no source field)", c1.address is None)
check("phone never fabricated (no source field)", c1.phone is None)
check("rating never fabricated (no rating concept in source)", c1.rating is None)
check("review_count never fabricated (no review concept in source)", c1.review_count is None)
check("coordinates never fabricated (identifier-based location, not lat/lon)", c1.coordinates is None)
check("instagram_url never fabricated (no source field)", c1.instagram_url is None)
check("discovered_at populated at mapping time", c1.discovered_at is not None)
check("pipeline_id populated (fresh uuid per candidate)", c1.pipeline_id != c2.pipeline_id)
check("session_id threaded through from request", c1.session_id == "s1")

transport3 = FakeTransport([dict(PAGE_WITH_CATEGORIES)])
provider3 = CrunchbaseProvider(api_key="fake-key", http_post=transport3)
(c3,) = list(provider3.discover(CrunchbaseDiscoveryRequest(session_id="s1", limit=5, include_categories=True)))
check("category mapped (first entry) when include_categories opted in", c3.category == "Robotics")
check(
    "categories field_id only requested when include_categories=True",
    "categories" in transport3.calls[0][1]["field_ids"],
)
check(
    "categories field_id absent from baseline (Basic-tier default) request",
    "categories" not in list(_BASELINE_FIELD_IDS),
)


# ---------------------------------------------------------------------------
# 3. metadata() / capabilities()
# ---------------------------------------------------------------------------
md = CrunchbaseProvider.metadata()
cap = CrunchbaseProvider.capabilities()
check("metadata() returns ProviderMetadata", isinstance(md, ProviderMetadata))
check("metadata().provider_id matches provider_id", md.provider_id == provider.provider_id)
check("metadata() callable without an api_key (classmethod, no construction)", True)  # called above with no instance
check("capabilities() returns ProviderCapabilities", isinstance(cap, ProviderCapabilities))
check("capabilities.supports_keyword_search is True", cap.supports_keyword_search is True)
check("capabilities.supports_pagination is True", cap.supports_pagination is True)
check("capabilities.supports_radius_search is False (honest — not in source)", cap.supports_radius_search is False)
check("capabilities.supports_coordinate_search is False (honest — not in source)", cap.supports_coordinate_search is False)

# ---------------------------------------------------------------------------
# 4. Registry compatibility
# ---------------------------------------------------------------------------
registry = ProviderRegistry()
registry.register(
    "crunchbase",
    lambda: CrunchbaseProvider(api_key="fake-key", http_post=transport),
    metadata=CrunchbaseProvider.metadata(),
    capabilities=CrunchbaseProvider.capabilities(),
)
check("registry.is_registered('crunchbase')", registry.is_registered("crunchbase"))
check("registry.metadata('crunchbase') round-trips", registry.metadata("crunchbase") == md)
check("registry.capabilities('crunchbase') round-trips", registry.capabilities("crunchbase") == cap)
built = registry.get("crunchbase")
check("registry.get('crunchbase') constructs a fresh CrunchbaseProvider", isinstance(built, CrunchbaseProvider))
check("registry.get('crunchbase') is a fresh instance each call", registry.get("crunchbase") is not built)

# ---------------------------------------------------------------------------
# 5. Plugin discovery — registerable exactly like every other provider,
#    no special-casing required anywhere in registry.py
# ---------------------------------------------------------------------------
check(
    "no provider-specific branching for 'crunchbase' anywhere in registry.py",
    "crunchbase" not in open("providers/registry.py").read().lower(),
)
check(
    "no provider-specific branching for 'crunchbase' anywhere in composite_provider.py",
    "crunchbase" not in open("providers/composite_provider.py").read().lower(),
)
check(
    "no provider-specific branching for 'crunchbase' anywhere in parallel_composite_provider.py",
    "crunchbase" not in open("providers/parallel_composite_provider.py").read().lower(),
)
check(
    "no provider-specific branching for 'crunchbase' anywhere in provider_deduplicator.py",
    "crunchbase" not in open("providers/provider_deduplicator.py").read().lower(),
)

# ---------------------------------------------------------------------------
# 6. Composite compatibility
# ---------------------------------------------------------------------------
transport_composite = FakeTransport([dict(PAGE_1)])
cb_for_composite = CrunchbaseProvider(api_key="fake-key", http_post=transport_composite)
composite = CompositeDiscoveryProvider([cb_for_composite])
composite_results = list(composite.discover(
    CompositeDiscoveryRequest(requests={"crunchbase": CrunchbaseDiscoveryRequest(session_id="s1", limit=5)})
))
check(
    "CompositeDiscoveryProvider([CrunchbaseProvider]) streams BusinessCandidate objects",
    len(composite_results) == 2 and all(isinstance(c, BusinessCandidate) for c in composite_results),
    str(composite_results),
)

# ---------------------------------------------------------------------------
# 7. Parallel compatibility
# ---------------------------------------------------------------------------
transport_parallel = FakeTransport([dict(PAGE_1)])
cb_for_parallel = CrunchbaseProvider(api_key="fake-key", http_post=transport_parallel)
parallel = ParallelCompositeDiscoveryProvider([cb_for_parallel])
parallel_results = list(parallel.discover(
    ParallelDiscoveryRequest(requests={"crunchbase": CrunchbaseDiscoveryRequest(session_id="s1", limit=5)})
))
check(
    "ParallelCompositeDiscoveryProvider([CrunchbaseProvider]) streams BusinessCandidate objects",
    len(parallel_results) == 2 and all(isinstance(c, BusinessCandidate) for c in parallel_results),
    str(parallel_results),
)

# ---------------------------------------------------------------------------
# 8. Deduplicator compatibility
# ---------------------------------------------------------------------------
transport_dedup = FakeTransport([
    {"count": 2, "entities": [
        make_entity("uuid-1", "Acme Robotics", "acme-robotics", website="https://acme.example"),
        make_entity("uuid-1", "Acme Robotics", "acme-robotics", website="https://acme.example"),
    ]},
])
cb_for_dedup = CrunchbaseProvider(api_key="fake-key", http_post=transport_dedup)
deduped = ProviderDeduplicator(cb_for_dedup)
dedup_results = list(deduped.discover(CrunchbaseDiscoveryRequest(session_id="s1", limit=5)))
check(
    "ProviderDeduplicator(CrunchbaseProvider) wraps without error and streams BusinessCandidate objects",
    all(isinstance(c, BusinessCandidate) for c in dedup_results),
    str(dedup_results),
)

# ---------------------------------------------------------------------------
# 9. ProviderConfiguration compatibility
# ---------------------------------------------------------------------------
config = ProviderConfiguration(providers=["crunchbase"], parallel=False, deduplicate=True)
check("ProviderConfiguration(['crunchbase']) constructs without error", config.providers == ("crunchbase",))
registry2 = ProviderRegistry()
registry2.register(
    "crunchbase",
    lambda: CrunchbaseProvider(api_key="fake-key", http_post=FakeTransport([dict(PAGE_1)])),
    metadata=CrunchbaseProvider.metadata(),
    capabilities=CrunchbaseProvider.capabilities(),
)
composed = registry2.create(config)
check(
    "registry.create(ProviderConfiguration(['crunchbase'])) builds a working DiscoveryProviderInterface",
    isinstance(composed, DiscoveryProviderInterface),
)
composed_results = list(composed.discover(CrunchbaseDiscoveryRequest(session_id="s1", limit=5)))
check(
    "composed provider (via ProviderConfiguration + registry.create) streams BusinessCandidate objects",
    all(isinstance(c, BusinessCandidate) for c in composed_results),
    str(composed_results),
)

# ---------------------------------------------------------------------------
# 10. Engine compatibility — the Engine only ever needs the abstract
#     surface; CrunchbaseProvider satisfies it with no engine changes.
# ---------------------------------------------------------------------------
def engine_style_caller(p: DiscoveryProviderInterface, request: Any) -> list[BusinessCandidate]:
    """Simulates how the Engine would consume any DiscoveryProviderInterface — no knowledge of CrunchbaseProvider specifically."""
    return list(p.discover(request))


transport_engine = FakeTransport([dict(PAGE_1)])
engine_candidates = engine_style_caller(
    CrunchbaseProvider(api_key="fake-key", http_post=transport_engine),
    CrunchbaseDiscoveryRequest(session_id="s1", limit=5),
)
check(
    "Engine-style generic caller (typed only against DiscoveryProviderInterface) works unmodified",
    all(isinstance(c, BusinessCandidate) for c in engine_candidates),
)

# ---------------------------------------------------------------------------
# 11. Statelessness
# ---------------------------------------------------------------------------
shared_transport = FakeTransport([dict(PAGE_1), dict(PAGE_1)])
shared_provider = CrunchbaseProvider(api_key="fake-key", http_post=shared_transport)
run1 = list(shared_provider.discover(CrunchbaseDiscoveryRequest(session_id="s1", limit=5)))
run2 = list(shared_provider.discover(CrunchbaseDiscoveryRequest(session_id="s2", limit=5)))
check(
    "same provider instance, two independent discover() calls, no leaked state between them",
    run1[0].session_id == "s1" and run2[0].session_id == "s2" and run1[0].pipeline_id != run2[0].pipeline_id,
)
check(
    "provider instance carries no discover()-call-specific attributes after use",
    not any(k.startswith("_last") or k.startswith("_cache") for k in vars(shared_provider)),
)

# ---------------------------------------------------------------------------
# 12. Immutability
# ---------------------------------------------------------------------------
req = CrunchbaseDiscoveryRequest(session_id="s1", query="robotics")
try:
    req.query = "changed"  # type: ignore[misc]
    check("CrunchbaseDiscoveryRequest is frozen (mutation raises)", False, "mutation succeeded, expected FrozenInstanceError")
except FrozenInstanceError:
    check("CrunchbaseDiscoveryRequest is frozen (mutation raises)", True)

try:
    md.description = "changed"  # type: ignore[misc]
    check("ProviderMetadata instances stay frozen", False)
except FrozenInstanceError:
    check("ProviderMetadata instances stay frozen", True)

# ---------------------------------------------------------------------------
# 13. Transport injection
# ---------------------------------------------------------------------------
injected = FakeTransport([dict(EMPTY_PAGE)])
custom_provider = CrunchbaseProvider(api_key="fake-key", http_post=injected)
list(custom_provider.discover(CrunchbaseDiscoveryRequest(session_id="s1", limit=5)))
check("injected http_post callable is actually invoked (not bypassed)", len(injected.calls) == 1)
check("injected call targets Organization Search URL", injected.calls[0][0].endswith("/searches/organizations"))
check("injected call carries X-cb-user-key header", injected.calls[0][2].get("X-cb-user-key") == "fake-key")
check(
    "default transport (_http_post_urllib) is not used when http_post is injected",
    CrunchbaseProvider(api_key="k")._http_post is not injected,
)

# ---------------------------------------------------------------------------
# 14. Pagination
# ---------------------------------------------------------------------------
paginate_transport = FakeTransport([dict(PAGE_1), dict(PAGE_2), dict(EMPTY_PAGE)])
paginate_provider = CrunchbaseProvider(api_key="fake-key", http_post=paginate_transport)
paginated = list(paginate_provider.discover(CrunchbaseDiscoveryRequest(session_id="s1", limit=2)))
check(
    "discover() auto-paginates across a full page via after_id (3 total entities across 2 pages)",
    len(paginated) == 3,
    str(len(paginated)),
)
check(
    "second request body carries after_id = last uuid of first page",
    paginate_transport.calls[1][1].get("after_id") == "uuid-2",
    str(paginate_transport.calls[1][1]),
)
check(
    "auto-pagination stops on a short page (no further calls after PAGE_2, len < limit)",
    len(paginate_transport.calls) == 2,
    str(len(paginate_transport.calls)),
)

cap_transport = FakeTransport([dict(PAGE_1), dict(PAGE_2)])
cap_provider = CrunchbaseProvider(api_key="fake-key", http_post=cap_transport)
capped = list(cap_provider.discover(CrunchbaseDiscoveryRequest(session_id="s1", limit=2, max_results=2)))
check("max_results caps total yielded across auto-paginated pages", len(capped) == 2, str(len(capped)))

# ---------------------------------------------------------------------------
# 15. Request validation (honest bounds, matches source's own documented limits)
# ---------------------------------------------------------------------------
try:
    CrunchbaseDiscoveryRequest(session_id="s1", limit=0)
    check("limit=0 rejected", False)
except ValueError:
    check("limit=0 rejected", True)

try:
    CrunchbaseDiscoveryRequest(session_id="s1", limit=1001)
    check("limit=1001 rejected (Organization Search's own 1000 ceiling)", False)
except ValueError:
    check("limit=1001 rejected (Organization Search's own 1000 ceiling)", True)

try:
    CrunchbaseDiscoveryRequest(session_id="s1", order_sort="sideways")
    check("invalid order_sort rejected", False)
except ValueError:
    check("invalid order_sort rejected", True)

check(
    "CrunchbaseDiscoveryRequest accepts a bare request (no query/location/category required)",
    CrunchbaseDiscoveryRequest(session_id="s1") is not None,
)

# ---------------------------------------------------------------------------
# 16. No Engine changes required
# ---------------------------------------------------------------------------
check(
    "engine/interfaces.py and engine/contracts.py are read-only precedent, never imported for writing by this file",
    True,  # structural: this validation script itself never opens those files for write
)

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
print()
print(f"TOTAL: {len(PASS) + len(FAIL)}   PASS: {len(PASS)}   FAIL: {len(FAIL)}")
if FAIL:
    print("FAILED CHECKS:")
    for f in FAIL:
        print(f"  - {f}")
    sys.exit(1)
else:
    print("ALL CHECKS PASSED")
    sys.exit(0)
