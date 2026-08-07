"""
MAST Engine V2 — OverpassProvider validation suite
=====================================================

Follows the same convention referenced by yelp_provider.py's and
apple_maps_provider.py's own docstrings (validate_yelp_provider.py /
validate_apple_maps_provider.py): no network access, a fake transport
injected in place of the real HTTP call, asserting on the resulting
BusinessCandidate stream and on this provider's own identity/
metadata/capabilities/query-construction/validation behavior.

Run: python3 validate_overpass_provider.py
"""

from __future__ import annotations

import sys

from engine.contracts import BusinessCandidate
from engine.interfaces import DiscoveryProviderInterface
from providers.overpass_provider import (
    OverpassDiscoveryRequest,
    OverpassProvider,
    _build_ql,
)

_FAILURES: list[str] = []


def check(label: str, condition: bool) -> None:
    status = "PASS" if condition else "FAIL"
    print(f"[{status}] {label}")
    if not condition:
        _FAILURES.append(label)


# ---------------------------------------------------------------------------
# 1. Interface conformance
# ---------------------------------------------------------------------------
check(
    "OverpassProvider subclasses DiscoveryProviderInterface",
    issubclass(OverpassProvider, DiscoveryProviderInterface),
)

provider = OverpassProvider()
check("provider_id == 'overpass'", provider.provider_id == "overpass")
check("display_name == 'Overpass (OpenStreetMap)'", provider.display_name == "Overpass (OpenStreetMap)")

# ---------------------------------------------------------------------------
# 2. metadata() / capabilities() are classmethods, callable with no instance
# ---------------------------------------------------------------------------
metadata = OverpassProvider.metadata()
check("metadata() requires_api_key is False (public API)", metadata.requires_api_key is False)
check("metadata() provider_id matches instance provider_id", metadata.provider_id == provider.provider_id)

capabilities = OverpassProvider.capabilities()
check("capabilities() supports_category_search is True", capabilities.supports_category_search is True)
check("capabilities() supports_keyword_search is False (no free-text primitive)", capabilities.supports_keyword_search is False)
check("capabilities() supports_radius_search is True (around: primitive)", capabilities.supports_radius_search is True)
check("capabilities() supports_pagination is False (single-shot endpoint)", capabilities.supports_pagination is False)

# ---------------------------------------------------------------------------
# 3. OverpassDiscoveryRequest validation (__post_init__)
# ---------------------------------------------------------------------------
try:
    OverpassDiscoveryRequest(session_id="s", tags={})
    check("empty tags rejected", False)
except ValueError:
    check("empty tags rejected", True)

try:
    OverpassDiscoveryRequest(
        session_id="s",
        tags={"amenity": "cafe"},
        bbox=(1, 2, 3, 4),
        area_name="Berlin",
    )
    check("multiple geographic scopes rejected", False)
except ValueError:
    check("multiple geographic scopes rejected", True)

try:
    OverpassDiscoveryRequest(session_id="s", tags={"amenity": "cafe"}, element_types=("planet",))
    check("invalid element_types rejected", False)
except ValueError:
    check("invalid element_types rejected", True)

valid_request = OverpassDiscoveryRequest(
    session_id="session-123",
    tags={"amenity": "restaurant"},
    bbox=(52.3, 13.2, 52.6, 13.5),
    limit=10,
)
check("valid request constructs without error", valid_request.tags == {"amenity": "restaurant"})

# ---------------------------------------------------------------------------
# 4. Query construction — no niche translation, pure OSM-native wiring
# ---------------------------------------------------------------------------
ql = _build_ql(valid_request)
check('QL contains the exact caller-supplied tag filter, untranslated', '["amenity"="restaurant"]' in ql)
check("QL contains all three element statements (node/way/rel)", all(kw in ql for kw in ("node[", "way[", "rel[")))
check("QL contains the caller-supplied bbox verbatim", "(52.3,13.2,52.6,13.5)" in ql)
check("QL requests out center with the caller-supplied limit", "out center 10;" in ql)

around_request = OverpassDiscoveryRequest(
    session_id="s", tags={"shop": "bakery"}, around=(500, 40.7, -74.0)
)
around_ql = _build_ql(around_request)
check("around scope builds Overpass QL's own (around:...) primitive", "(around:500,40.7,-74.0)" in around_ql)

area_request = OverpassDiscoveryRequest(
    session_id="s", tags={"tourism": "hotel"}, area_name="Berlin"
)
area_ql = _build_ql(area_request)
check('area_name builds a real area["name"=...] statement', 'area["name"="Berlin"]->.searchArea;' in area_ql)
check("area scope references .searchArea, not a raw bbox", "(area.searchArea)" in area_ql)

# ---------------------------------------------------------------------------
# 5. discover() — fake transport, canned Overpass JSON response shape
# ---------------------------------------------------------------------------
_CANNED_RESPONSE = {
    "elements": [
        {
            "type": "node",
            "id": 111,
            "lat": 52.52,
            "lon": 13.405,
            "tags": {
                "name": "Cafe Nord",
                "amenity": "cafe",
                "addr:housenumber": "12",
                "addr:street": "Torstrasse",
                "addr:city": "Berlin",
                "addr:country": "DE",
                "phone": "+49 30 1234567",
                "website": "https://cafenord.example",
                "contact:instagram": "cafenord_berlin",
            },
        },
        {
            "type": "way",
            "id": 222,
            "center": {"lat": 52.50, "lon": 13.40},
            "tags": {
                "amenity": "cafe",
                # No name, no address, no contact fields — sparse tagging
                # is the normal case for OSM data and must not raise or
                # fabricate.
            },
        },
        {
            "type": "relation",
            "id": 333,
            # No lat/lon and no center at all (should not happen with
            # `out center;`, but handled rather than assumed).
            "tags": {"amenity": "cafe", "name": "Ghost Cafe"},
        },
    ]
}


def fake_http_post(url: str, data: str, headers: dict[str, str]) -> dict:
    assert url == "https://overpass-api.de/api/interpreter"
    assert '["amenity"="cafe"]' in data
    assert headers.get("Content-Type") == "application/x-www-form-urlencoded"
    return _CANNED_RESPONSE


test_provider = OverpassProvider(http_post=fake_http_post)
test_request = OverpassDiscoveryRequest(
    session_id="sess-1", tags={"amenity": "cafe"}, bbox=(52.3, 13.2, 52.6, 13.5)
)
candidates = list(test_provider.discover(test_request))

check("discover() yields one BusinessCandidate per response element", len(candidates) == 3)
check("every yielded object is a BusinessCandidate", all(isinstance(c, BusinessCandidate) for c in candidates))
check("discover() returns a generator (streaming, not pre-materialized)", hasattr(test_provider.discover(test_request), "__next__"))

first, second, third = candidates

check("node: provider_business_id == 'node/111'", first.provider_business_id == "node/111")
check("node: maps_url is the real OSM permalink", first.maps_url == "https://www.openstreetmap.org/node/111")
check("node: name mapped from tags.name", first.name == "Cafe Nord")
check("node: category reports the exact requested tag, k=v format", first.category == "amenity=cafe")
check("node: address composed from housenumber+street", first.address == "12 Torstrasse")
check("node: city/country from addr:city / addr:country", first.city == "Berlin" and first.country == "DE")
check("node: coordinates from top-level lat/lon", first.coordinates == (52.52, 13.405))
check("node: website mapped", first.website == "https://cafenord.example")
check("node: phone mapped", first.phone == "+49 30 1234567")
check("node: rating/review_count always None (OSM has no such concept)", first.rating is None and first.review_count is None)
check("node: instagram_url left None despite contact:instagram tag existing (unnormalized format)", first.instagram_url is None)
check("node: session_id propagated from request", first.session_id == "sess-1")
check("node: provider == 'overpass'", first.provider == "overpass")

check("way: provider_business_id == 'way/222'", second.provider_business_id == "way/222")
check("way: coordinates fall back to center.lat/center.lon", second.coordinates == (52.50, 13.40))
check("way: sparse tags never fabricate name/address/city", second.name is None and second.address is None and second.city is None)

check("relation: no lat/lon and no center -> coordinates is None (never guessed)", third.coordinates is None)
check("relation: name still mapped when present despite missing coordinates", third.name == "Ghost Cafe")

# ---------------------------------------------------------------------------
# 6. Statelessness — two discover() calls do not share state
# ---------------------------------------------------------------------------
second_pass = list(test_provider.discover(test_request))
ids_first_pass = {c.pipeline_id for c in candidates}
ids_second_pass = {c.pipeline_id for c in second_pass}
check("two discover() calls mint independent pipeline_ids (no shared state)", ids_first_pass.isdisjoint(ids_second_pass))

# ---------------------------------------------------------------------------
# 7. Exceptions from the transport propagate unchanged
# ---------------------------------------------------------------------------
def failing_http_post(url: str, data: str, headers: dict[str, str]) -> dict:
    raise ConnectionError("simulated network failure")


failing_provider = OverpassProvider(http_post=failing_http_post)
try:
    list(failing_provider.discover(test_request))
    check("transport exception propagates unchanged", False)
except ConnectionError:
    check("transport exception propagates unchanged", True)

# ---------------------------------------------------------------------------
# 8. No niche-translation table anywhere in the module
# ---------------------------------------------------------------------------
import providers.overpass_provider as mod
import inspect

source = inspect.getsource(mod)
check(
    "no niche->tag lookup dict/table exists in overpass_provider.py",
    not any(
        marker in source
        for marker in ("NICHE_TAG_MAP", "_NICHE_TO_TAG", "niche_to_tag", "TAXONOMY")
    ),
)

print()
if _FAILURES:
    print(f"{len(_FAILURES)} check(s) FAILED:")
    for f in _FAILURES:
        print(f"  - {f}")
    sys.exit(1)
else:
    print("All checks PASSED.")
    sys.exit(0)
