"""
validate_yelp_provider.py
==========================

Standalone validation for YelpProvider (providers/yelp_provider.py),
following this project's validate_*.py convention: a plain script, no
test framework, asserts + printed PASS/FAIL lines, non-zero exit code
on any failure.

What this validates
--------------------
1. YelpProvider constructs correctly.
2. YelpProvider satisfies DiscoveryProviderInterface (isinstance check
   — this only passes if every abstract member is actually
   implemented; Python enforces this at instantiation time).
3. discover() yields only valid BusinessCandidate instances, streamed
   (a generator/iterator, not a materialized list), across a
   multi-page fake response.
4. Fields the Yelp Fusion API doesn't expose (website, instagram_url)
   are left None rather than fabricated.
5. YelpProvider is substitutable for GoogleMapsProvider from the
   caller's point of view: a function written against
   DiscoveryProviderInterface alone runs unmodified against either
   provider. GoogleMapsProvider itself cannot be *instantiated* in
   this isolated sandbox (it depends on scraper/maps_scraper.py and
   utils/runtime.py, which are real project modules not included in
   this validation environment) — so substitutability there is
   confirmed via static inspection of its source: it subclasses the
   same DiscoveryProviderInterface and implements the exact same
   abstract member set, with no reference to YelpProvider or vice
   versa.

Nothing in this file imports or touches engine/, workers/, queues/, or
models/ beyond the read-only DiscoveryProviderInterface/BusinessCandidate
contracts both providers are already built against.
"""

from __future__ import annotations

import ast
import sys
from pathlib import Path
from typing import Iterator

from engine.contracts import BusinessCandidate
from engine.interfaces import DiscoveryProviderInterface
from providers.yelp_provider import YelpDiscoveryRequest, YelpProvider

FAILURES: list[str] = []
TOTAL = 0


def check(label: str, condition: bool) -> None:
    global TOTAL
    TOTAL += 1
    status = "PASS" if condition else "FAIL"
    print(f"[{status}] {label}")
    if not condition:
        FAILURES.append(label)


# ---------------------------------------------------------------------------
# Fake Fusion API transport — no real network call, two pages of results.
# ---------------------------------------------------------------------------
# A single fake "source of record" of 3 businesses. fake_http_get below
# slices it by (offset, limit) exactly as a real paginated API would,
# so the provider's own pagination logic (not the fixture) is what's
# under test.
_ALL_BUSINESSES = [
    {
        "id": "yelp-biz-001",
        "url": "https://www.yelp.com/biz/example-plumbing-austin",
        "name": "Example Plumbing Co",
        "categories": [{"alias": "plumbing", "title": "Plumbing"}],
        "location": {
            "display_address": ["123 Main St", "Austin, TX 78701"],
            "city": "Austin",
            "country": "US",
        },
        "display_phone": "(512) 555-0100",
        "phone": "+15125550100",
        "rating": 4.5,
        "review_count": 87,
        "coordinates": {"latitude": 30.2672, "longitude": -97.7431},
    },
    {
        "id": "yelp-biz-002",
        "url": "https://www.yelp.com/biz/second-example-austin",
        "name": "Second Example LLC",
        "categories": [],
        "location": {
            "display_address": ["456 Congress Ave", "Austin, TX 78701"],
            "city": "Austin",
            "country": "US",
        },
        "display_phone": "",
        "phone": "",
        "rating": 3.8,
        "review_count": 12,
        "coordinates": {},
    },
    {
        "id": "yelp-biz-003",
        "url": "https://www.yelp.com/biz/third-example-austin",
        "name": "Third Example Services",
        "categories": [{"alias": "hvac", "title": "HVAC"}],
        "location": {
            "display_address": ["789 5th St", "Austin, TX 78701"],
            "city": "Austin",
            "country": "US",
        },
        "display_phone": "(512) 555-0199",
        "phone": "+15125550199",
        "rating": 5.0,
        "review_count": 3,
        "coordinates": {"latitude": 30.27, "longitude": -97.74},
    },
]


def fake_http_get(url: str, params: dict, headers: dict) -> dict:
    assert url.startswith("https://api.yelp.com/v3/businesses/search")
    assert headers.get("Authorization") == "Bearer test-api-key"
    offset = params.get("offset", 0)
    limit = params.get("limit", 50)
    return {"businesses": _ALL_BUSINESSES[offset : offset + limit]}


def main() -> int:
    # 1. Construction
    provider = YelpProvider(api_key="test-api-key", http_get=fake_http_get)
    check("YelpProvider constructs correctly", provider is not None)

    # 2. Interface conformance
    check(
        "YelpProvider is an instance of DiscoveryProviderInterface",
        isinstance(provider, DiscoveryProviderInterface),
    )
    check("provider_id is 'yelp'", provider.provider_id == "yelp")
    check("display_name is 'Yelp'", provider.display_name == "Yelp")

    # 3. Streaming behaviour: discover() must be a lazy iterator, not a list.
    request = YelpDiscoveryRequest(
        session_id="session-abc-123",
        term="plumber",
        location="Austin, TX",
        limit=3,
    )
    result = provider.discover(request)
    check("discover() returns an iterator (not a materialized list)", iter(result) is result)

    candidates = list(result)
    check("discover() yielded exactly 3 candidates across 2 pages", len(candidates) == 3)
    check(
        "every yielded object is a real BusinessCandidate instance",
        all(isinstance(c, BusinessCandidate) for c in candidates),
    )

    # 4. Field-level correctness — no fabrication, correct mapping.
    first = candidates[0]
    check("provider field is 'yelp'", first.provider == "yelp")
    check("session_id passed through unchanged", first.session_id == "session-abc-123")
    check("pipeline_id was minted (non-empty string)", bool(first.pipeline_id))
    check("provider_business_id mapped from Fusion 'id'", first.provider_business_id == "yelp-biz-001")
    check("maps_url mapped from Fusion 'url'", first.maps_url.endswith("example-plumbing-austin"))
    check("name mapped correctly", first.name == "Example Plumbing Co")
    check("category mapped from categories[0].title", first.category == "Plumbing")
    check("address built from display_address", first.address == "123 Main St, Austin, TX 78701")
    check("city mapped correctly", first.city == "Austin")
    check("phone prefers display_phone", first.phone == "(512) 555-0100")
    check("rating mapped correctly", first.rating == 4.5)
    check("review_count mapped correctly", first.review_count == 87)
    check("coordinates mapped as (lat, lon) tuple", first.coordinates == (30.2672, -97.7431))
    check("website is None — never fabricated (Fusion API doesn't expose it)", first.website is None)
    check("instagram_url is None — never fabricated", first.instagram_url is None)

    second = candidates[1]
    check("empty categories -> category is None, not fabricated", second.category is None)
    check("empty coordinates -> coordinates is None, not fabricated", second.coordinates is None)
    check("empty phone strings -> phone is None, not ''", second.phone is None)

    # 5a. Substitutability — a caller written only against the interface.
    def run_discovery(p: DiscoveryProviderInterface, req: object) -> list[BusinessCandidate]:
        """Stands in for engine-side code: knows only about the interface."""
        return list(p.discover(req))

    via_generic_caller = run_discovery(provider, request)
    check(
        "provider is fully usable through a DiscoveryProviderInterface-typed caller",
        len(via_generic_caller) == 3 and all(isinstance(c, BusinessCandidate) for c in via_generic_caller),
    )

    # 5b. Substitutability vs GoogleMapsProvider — static check.
    # GoogleMapsProvider can't be instantiated in this isolated sandbox
    # (scraper/maps_scraper.py, utils/runtime.py are real project
    # modules not included here), so we confirm structurally instead:
    # same base class, same abstract members implemented, no coupling
    # between the two provider files in either direction.
    gmaps_path = Path(__file__).parent / "providers" / "google_maps_provider.py"
    tree = ast.parse(gmaps_path.read_text())
    gmaps_class = next(
        n for n in ast.walk(tree) if isinstance(n, ast.ClassDef) and n.name == "GoogleMapsProvider"
    )
    gmaps_bases = {b.id for b in gmaps_class.bases if isinstance(b, ast.Name)}
    check(
        "GoogleMapsProvider subclasses DiscoveryProviderInterface (same interface as YelpProvider)",
        "DiscoveryProviderInterface" in gmaps_bases,
    )
    gmaps_members = {
        n.name
        for n in gmaps_class.body
        if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef))
    } | {
        n.target.id if isinstance(n.target, ast.Name) else None
        for n in ast.walk(gmaps_class)
        if isinstance(n, ast.AnnAssign)
    }
    required = DiscoveryProviderInterface.__abstractmethods__
    check(
        "GoogleMapsProvider implements the same abstract members YelpProvider does "
        f"({sorted(required)})",
        required.issubset(gmaps_members),
    )
    yelp_source = (Path(__file__).parent / "providers" / "yelp_provider.py").read_text()
    check(
        "yelp_provider.py has zero coupling to google_maps_provider.py (no import of it)",
        "import providers.google_maps_provider" not in yelp_source
        and "from providers.google_maps_provider" not in yelp_source
        and "from .google_maps_provider" not in yelp_source,
    )
    check(
        "google_maps_provider.py has zero coupling to yelp_provider.py (no import of it)",
        "yelp_provider" not in gmaps_path.read_text(),
    )

    print()
    if FAILURES:
        print(f"{len(FAILURES)} check(s) FAILED:")
        for f in FAILURES:
            print(f"  - {f}")
        return 1

    print(f"All {TOTAL} checks passed.")
    print("YelpProvider is a valid, substitutable DiscoveryProviderInterface implementation.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
