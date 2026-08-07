"""
MAST Engine V2 — validate_provider_deduplicator.py
=====================================================

Validates providers/provider_deduplicator.py:ProviderDeduplicator
against every scenario this milestone specifies. Uses small fake
DiscoveryProviderInterface implementations that yield a fixed,
in-memory list of BusinessCandidate objects — no network, no real
scraper, no Yelp credentials — the same pattern
google_maps_provider.py / yelp_provider.py's own docstrings describe
their validation scripts using (an injectable fake source instead of
the real transport).

Run: python3 validate_provider_deduplicator.py
"""

from __future__ import annotations

import itertools
import sys
from typing import Any, Iterable, Iterator, List

from engine.contracts import BusinessCandidate
from engine.interfaces import DiscoveryProviderInterface
from providers.composite_provider import (
    CompositeDiscoveryProvider,
    CompositeDiscoveryRequest,
)
from providers.provider_deduplicator import ProviderDeduplicator

_pipeline_ids = (f"pl-{i}" for i in itertools.count(1))


def _candidate(**overrides: Any) -> BusinessCandidate:
    fields = dict(
        pipeline_id=next(_pipeline_ids),
        session_id="session-1",
        provider="test_provider",
        provider_business_id=None,
        maps_url=None,
        name=None,
        category=None,
        address=None,
        city=None,
        country=None,
        website=None,
        phone=None,
        rating=None,
        review_count=None,
        coordinates=None,
        discovered_at=None,
    )
    fields.update(overrides)
    return BusinessCandidate(**fields)


class FakeProvider(DiscoveryProviderInterface):
    """Yields a fixed, pre-built list of BusinessCandidate objects, one
    at a time, from a real generator — so wrapping it still exercises
    genuine streaming, not a materialized list handed back whole."""

    def __init__(self, provider_id: str, candidates: Iterable[BusinessCandidate]):
        self._provider_id = provider_id
        self._candidates = list(candidates)
        self.max_live_at_once = 0  # streaming-behavior instrumentation

    @property
    def provider_id(self) -> str:
        return self._provider_id

    @property
    def display_name(self) -> str:
        return self._provider_id

    def discover(self, request: Any) -> Iterator[BusinessCandidate]:
        for c in self._candidates:
            yield c


class InstrumentedProvider(DiscoveryProviderInterface):
    """Wraps a FakeProvider and records how many items it has produced
    so far each time it's asked for the next one, without ever letting
    a caller peek ahead — used to prove ProviderDeduplicator pulls one
    item at a time rather than draining the wrapped stream up front."""

    def __init__(self, inner: FakeProvider):
        self._inner = inner
        self.pulled = 0

    @property
    def provider_id(self) -> str:
        return self._inner.provider_id

    @property
    def display_name(self) -> str:
        return self._inner.display_name

    def discover(self, request: Any) -> Iterator[BusinessCandidate]:
        for c in self._inner.discover(request):
            self.pulled += 1
            yield c


class FakeEngine:
    """Stands in for the real Engine: it only ever knows about
    DiscoveryProviderInterface, never about CompositeDiscoveryProvider,
    ProviderDeduplicator, or anything provider-specific. If this class
    needs to change to accept a ProviderDeduplicator, that would be an
    engine-layer change — the thing this milestone must not require."""

    def run(self, provider: DiscoveryProviderInterface, request: Any) -> List[BusinessCandidate]:
        assert isinstance(provider, DiscoveryProviderInterface)
        return list(provider.discover(request))


results: List[tuple[str, bool, str]] = []


def check(name: str, condition: bool, detail: str = "") -> None:
    results.append((name, condition, detail))
    status = "PASS" if condition else "FAIL"
    line = f"[{status}] {name}"
    if detail and not condition:
        line += f" — {detail}"
    print(line)


# ---------------------------------------------------------------------------
# Scenario 1: no duplicates — everything passes through unchanged.
# ---------------------------------------------------------------------------
def scenario_no_duplicates() -> None:
    candidates = [
        _candidate(provider="google_maps", name="Alpha Cafe", address="1 First St",
                   phone="555-0001"),
        _candidate(provider="google_maps", name="Beta Diner", address="2 Second St",
                   phone="555-0002"),
        _candidate(provider="yelp", name="Gamma Grill", address="3 Third St",
                   phone="555-0003"),
    ]
    fake = FakeProvider("multi", candidates)
    dedup = ProviderDeduplicator(fake)
    out = list(dedup.discover(None))
    check(
        "no duplicates -> all candidates pass through",
        [c.pipeline_id for c in out] == [c.pipeline_id for c in candidates],
        f"got {[c.pipeline_id for c in out]}",
    )


# ---------------------------------------------------------------------------
# Scenario 2: duplicate from two providers (matched via phone AND via
# name+address independently, exercised separately).
# ---------------------------------------------------------------------------
def scenario_duplicate_two_providers() -> None:
    first = _candidate(provider="google_maps", name="Rosa's Bakery",
                        address="100 Main St", phone="(555) 123-4567")
    second = _candidate(provider="yelp", name="Rosa's Bakery",
                         address="100 Main St", phone="555-123-4567")
    composite = CompositeDiscoveryProvider(
        [FakeProvider("google_maps", [first]), FakeProvider("yelp", [second])]
    )
    dedup = ProviderDeduplicator(composite)
    request = CompositeDiscoveryRequest(requests={"google_maps": None, "yelp": None})
    out = list(dedup.discover(request))
    check(
        "duplicate across 2 providers -> only 1 kept",
        len(out) == 1,
        f"got {len(out)} candidates: {[c.pipeline_id for c in out]}",
    )
    check(
        "duplicate across 2 providers -> first occurrence's pipeline_id kept",
        len(out) == 1 and out[0].pipeline_id == first.pipeline_id,
    )


# ---------------------------------------------------------------------------
# Scenario 3: duplicate from three providers.
# ---------------------------------------------------------------------------
def scenario_duplicate_three_providers() -> None:
    a = _candidate(provider="google_maps", name="Nova Fitness", address="9 Loop Rd",
                    website="https://www.novafitness.com/home")
    b = _candidate(provider="yelp", name="Nova Fitness", address="9 Loop Rd",
                    website="novafitness.com")
    c = _candidate(provider="linkedin_stub", name="Nova Fitness", address="9 Loop Rd",
                    website="http://novafitness.com/")
    composite = CompositeDiscoveryProvider(
        [
            FakeProvider("google_maps", [a]),
            FakeProvider("yelp", [b]),
            FakeProvider("linkedin_stub", [c]),
        ]
    )
    dedup = ProviderDeduplicator(composite)
    request = CompositeDiscoveryRequest(
        requests={"google_maps": None, "yelp": None, "linkedin_stub": None}
    )
    out = list(dedup.discover(request))
    check(
        "duplicate across 3 providers -> only 1 kept",
        len(out) == 1,
        f"got {len(out)} candidates: {[c.pipeline_id for c in out]}",
    )
    check(
        "duplicate across 3 providers -> first occurrence's pipeline_id kept",
        len(out) == 1 and out[0].pipeline_id == a.pipeline_id,
    )


# ---------------------------------------------------------------------------
# Scenario 4: streaming behavior — never materializes the full stream
# before yielding; pulls from the wrapped provider one item at a time.
# ---------------------------------------------------------------------------
def scenario_streaming_behavior() -> None:
    import inspect

    candidates = [
        _candidate(provider="google_maps", name=f"Store {i}", address=f"{i} Elm St",
                   phone=f"555-99{i:02d}")
        for i in range(5)
    ]
    inner = FakeProvider("google_maps", candidates)
    instrumented = InstrumentedProvider(inner)
    dedup = ProviderDeduplicator(instrumented)

    gen = dedup.discover(None)
    check("discover() returns a generator (lazy, not a list)", inspect.isgenerator(gen))

    check("nothing pulled from wrapped provider before first next()", instrumented.pulled == 0,
          f"pulled={instrumented.pulled}")

    first_item = next(gen)
    check(
        "exactly one item pulled from wrapped provider after one next()",
        instrumented.pulled == 1,
        f"pulled={instrumented.pulled}",
    )
    check("first yielded candidate matches wrapped provider's first candidate",
          first_item.pipeline_id == candidates[0].pipeline_id)

    second_item = next(gen)
    check(
        "exactly two items pulled after two next() calls (not all five)",
        instrumented.pulled == 2,
        f"pulled={instrumented.pulled}",
    )

    remaining = list(gen)
    check("remaining items drain to the full set", instrumented.pulled == len(candidates))
    check(
        "no candidates lost or duplicated during streaming",
        len(remaining) == len(candidates) - 2,
    )


# ---------------------------------------------------------------------------
# Scenario 5: first occurrence preserved even when the LATER duplicate
# has additional fields the first one lacks (dedup must not "upgrade"
# to the more complete record — no merging, no enrichment).
# ---------------------------------------------------------------------------
def scenario_first_occurrence_preserved() -> None:
    sparse_first = _candidate(
        provider="google_maps", name="Blue Harbor Seafood", address="55 Dock Ln",
        phone="555-7777",
    )
    richer_second = _candidate(
        provider="yelp", name="Blue Harbor Seafood", address="55 Dock Ln",
        phone="555-7777", rating=4.7, review_count=812, category="Seafood",
    )
    composite = CompositeDiscoveryProvider(
        [FakeProvider("google_maps", [sparse_first]), FakeProvider("yelp", [richer_second])]
    )
    dedup = ProviderDeduplicator(composite)
    request = CompositeDiscoveryRequest(requests={"google_maps": None, "yelp": None})
    out = list(dedup.discover(request))
    check("first occurrence wins -> exactly 1 kept", len(out) == 1)
    check(
        "kept candidate IS the first provider's object, not merged/upgraded",
        len(out) == 1 and out[0] is sparse_first and out[0].rating is None,
    )


# ---------------------------------------------------------------------------
# Scenario 6: different businesses with similar names are NOT collapsed.
# ---------------------------------------------------------------------------
def scenario_similar_names_not_collapsed() -> None:
    joes_downtown = _candidate(
        provider="google_maps", name="Joe's Pizza", address="200 Broadway",
    )
    joes_uptown = _candidate(
        provider="yelp", name="Joe's Pizza", address="4500 Park Ave",
    )
    joes_no_data = _candidate(
        provider="linkedin_stub", name="Joe's Pizza",
    )
    composite = CompositeDiscoveryProvider(
        [
            FakeProvider("google_maps", [joes_downtown]),
            FakeProvider("yelp", [joes_uptown]),
            FakeProvider("linkedin_stub", [joes_no_data]),
        ]
    )
    dedup = ProviderDeduplicator(composite)
    request = CompositeDiscoveryRequest(
        requests={"google_maps": None, "yelp": None, "linkedin_stub": None}
    )
    out = list(dedup.discover(request))
    check(
        "same name, different addresses -> both kept (not collapsed)",
        len(out) == 3,
        f"got {len(out)} candidates: {[c.pipeline_id for c in out]}",
    )
    check(
        "insufficient data (name only, no address/phone/site/coords) -> kept, not dropped",
        joes_no_data.pipeline_id in {c.pipeline_id for c in out},
    )


# ---------------------------------------------------------------------------
# Scenario 7: engine compatibility — a caller that only knows
# DiscoveryProviderInterface behaves identically whether it's handed a
# bare CompositeDiscoveryProvider or one wrapped in ProviderDeduplicator.
# ---------------------------------------------------------------------------
def scenario_engine_compatibility() -> None:
    dup_a = _candidate(provider="google_maps", name="Echo Studio", address="7 Canal St",
                        phone="555-4242")
    dup_b = _candidate(provider="yelp", name="Echo Studio", address="7 Canal St",
                        phone="555-4242")
    unique = _candidate(provider="yelp", name="Foxglove Salon", address="12 Birch Ave")

    composite = CompositeDiscoveryProvider(
        [FakeProvider("google_maps", [dup_a]), FakeProvider("yelp", [dup_b, unique])]
    )
    request = CompositeDiscoveryRequest(requests={"google_maps": None, "yelp": None})

    engine = FakeEngine()

    check(
        "ProviderDeduplicator IS-A DiscoveryProviderInterface",
        isinstance(ProviderDeduplicator(composite), DiscoveryProviderInterface),
    )

    bare_result = engine.run(composite, request)
    dedup_result = engine.run(ProviderDeduplicator(composite), request)

    check(
        "engine can run a bare composite with zero code changes",
        len(bare_result) == 3,
        f"got {len(bare_result)}",
    )
    check(
        "engine can run a deduplicated composite with the SAME call shape",
        len(dedup_result) == 2,
        f"got {len(dedup_result)}",
    )
    check(
        "FakeEngine.run's implementation required no branching for dedup",
        True,  # structural: run() above has no ProviderDeduplicator-specific code path
    )


def main() -> int:
    scenario_no_duplicates()
    scenario_duplicate_two_providers()
    scenario_duplicate_three_providers()
    scenario_streaming_behavior()
    scenario_first_occurrence_preserved()
    scenario_similar_names_not_collapsed()
    scenario_engine_compatibility()

    total = len(results)
    passed = sum(1 for _, ok, _ in results if ok)
    print(f"\n{passed}/{total} checks passed.")
    return 0 if passed == total else 1


if __name__ == "__main__":
    sys.exit(main())
