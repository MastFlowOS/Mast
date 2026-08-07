"""
MAST Engine V2 — validate_composite_provider.py
==================================================

Standalone validation script for CompositeDiscoveryProvider, following
this project's existing validate_*.py convention (see
providers/yelp_provider.py's module docstring, which references
validate_yelp_provider.py as its own precedent).

No network access, no real MapsScraper, and no real Yelp Fusion API
call is required to validate the composition logic itself — the
composite's entire job is orchestration, not discovery, so it's
validated here against small, deterministic fake providers that
satisfy DiscoveryProviderInterface directly. This isolates "does
composition work" from "does GoogleMapsProvider/YelpProvider work" —
the latter is each already validated by its own script.

What this script validates, in order:
    1. One provider           — composite of exactly one wrapped
                                 provider behaves as a passthrough.
    2. Two providers           — candidates from both appear, none
                                 dropped, none duplicated-away.
    3. Three providers         — same, generalizes past "two" not being
                                 special-cased.
    4. Streaming order         — candidates arrive sequentially by
                                 provider (construction order), in each
                                 provider's own internal order; and the
                                 composite never materializes a full
                                 result set before yielding (proven by
                                 an instrumented fake provider that
                                 records exactly when each item was
                                 pulled).
    5. Provider substitution   — swapping which concrete providers are
                                 wrapped (e.g. "remove Google Maps,
                                 replace it with Yelp") requires no
                                 change to CompositeDiscoveryProvider
                                 itself, only to what's passed into its
                                 constructor.
    6. Engine compatibility    — a CompositeDiscoveryProvider IS-A
                                 DiscoveryProviderInterface, indistinguishable
                                 from any single concrete provider from
                                 the caller's point of view.
    7. Error handling          — strict mode propagates a wrapped
                                 provider's exception; best-effort mode
                                 (continue_on_provider_error=True)
                                 isolates it and still returns the other
                                 providers' candidates.
    8. Zero engine changes     — nothing in engine/ is imported for any
                                 purpose other than the same two
                                 read-only contracts every other
                                 provider already imports
                                 (BusinessCandidate, DiscoveryProviderInterface).
"""

from __future__ import annotations

import itertools
import sys
import traceback
from typing import Any, Iterator

from engine.contracts import BusinessCandidate
from engine.interfaces import DiscoveryProviderInterface
from providers.composite_provider import (
    CompositeDiscoveryProvider,
    CompositeDiscoveryRequest,
)

_pipeline_ids = itertools.count()


def _candidate(provider: str, name: str, session_id: str = "session-1") -> BusinessCandidate:
    return BusinessCandidate(
        pipeline_id=f"pl-{next(_pipeline_ids)}",
        session_id=session_id,
        provider=provider,
        name=name,
    )


class FakeProvider(DiscoveryProviderInterface):
    """
    Minimal DiscoveryProviderInterface implementation for validation
    only. Yields a fixed, ordered list of BusinessCandidate objects
    and records (on itself) the sequence in which items were actually
    pulled by the caller, so tests can assert streaming behavior
    rather than just final output.
    """

    def __init__(self, provider_id: str, names: list[str], fail_after: int | None = None) -> None:
        self._provider_id = provider_id
        self._names = names
        self._fail_after = fail_after
        self.pulled: list[str] = []

    @property
    def provider_id(self) -> str:
        return self._provider_id

    @property
    def display_name(self) -> str:
        return self._provider_id.replace("_", " ").title()

    def discover(self, request: Any) -> Iterator[BusinessCandidate]:
        for i, name in enumerate(self._names):
            if self._fail_after is not None and i == self._fail_after:
                raise RuntimeError(f"{self._provider_id} simulated failure at index {i}")
            self.pulled.append(name)
            yield _candidate(self._provider_id, name)


def _req(*providers: DiscoveryProviderInterface) -> CompositeDiscoveryRequest:
    return CompositeDiscoveryRequest(
        requests={p.provider_id: object() for p in providers}
    )


def _check(label: str, condition: bool, detail: str = "") -> None:
    status = "PASS" if condition else "FAIL"
    print(f"[{status}] {label}" + (f" — {detail}" if detail and not condition else ""))
    if not condition:
        raise AssertionError(f"{label} — {detail}")


def test_one_provider() -> None:
    p = FakeProvider("solo", ["Alpha Cafe", "Beta Bakery"])
    composite = CompositeDiscoveryProvider([p])
    results = list(composite.discover(_req(p)))
    _check("1. one provider — count", len(results) == 2, f"got {len(results)}")
    _check(
        "1. one provider — passthrough, order preserved",
        [c.name for c in results] == ["Alpha Cafe", "Beta Bakery"],
        [c.name for c in results],
    )
    _check(
        "1. one provider — candidates carry originating provider_id",
        all(c.provider == "solo" for c in results),
    )


def test_two_providers() -> None:
    maps = FakeProvider("google_maps", ["Maps A", "Maps B"])
    yelp = FakeProvider("yelp", ["Yelp X", "Yelp Y", "Yelp Z"])
    composite = CompositeDiscoveryProvider([maps, yelp])
    results = list(composite.discover(_req(maps, yelp)))
    _check("2. two providers — total count", len(results) == 5, len(results))
    names = [c.name for c in results]
    _check(
        "2. two providers — no candidates dropped",
        set(names) == {"Maps A", "Maps B", "Yelp X", "Yelp Y", "Yelp Z"},
        names,
    )
    _check(
        "2. two providers — no fabricated duplicates",
        len(names) == len(set(names)),
        names,
    )


def test_three_providers() -> None:
    a = FakeProvider("provider_a", ["A1"])
    b = FakeProvider("provider_b", ["B1", "B2"])
    c = FakeProvider("provider_c", ["C1", "C2", "C3"])
    composite = CompositeDiscoveryProvider([a, b, c])
    results = list(composite.discover(_req(a, b, c)))
    _check("3. three providers — total count", len(results) == 6, len(results))
    _check(
        "3. three providers — every provider represented",
        {c.provider for c in results} == {"provider_a", "provider_b", "provider_c"},
    )


def test_streaming_order() -> None:
    a = FakeProvider("provider_a", ["A1", "A2"])
    b = FakeProvider("provider_b", ["B1", "B2"])
    composite = CompositeDiscoveryProvider([a, b])

    gen = composite.discover(_req(a, b))
    first = next(gen)
    # At this point, only provider_a should have been touched at all,
    # and only its first item pulled — proof the composite is not
    # materializing provider_b (or the rest of provider_a) up front.
    _check(
        "4. streaming — provider_b untouched before provider_a drains",
        b.pulled == [],
        b.pulled,
    )
    _check(
        "4. streaming — exactly one item pulled from provider_a so far",
        a.pulled == ["A1"] and first.name == "A1",
        (a.pulled, first.name),
    )

    remaining = [first] + list(gen)
    _check(
        "4. streaming — full order is provider_a's order then provider_b's order",
        [c.name for c in remaining] == ["A1", "A2", "B1", "B2"],
        [c.name for c in remaining],
    )


def test_provider_substitution() -> None:
    """
    The blueprint's extensibility test, one layer up: "remove Google
    Maps tomorrow, replace it with Yelp" — how many files change?
    Answer demonstrated here: zero. CompositeDiscoveryProvider's own
    code is never touched; only the list passed into its constructor
    changes, exactly as swapping a bare provider would.
    """
    maps = FakeProvider("google_maps", ["Maps A"])
    yelp = FakeProvider("yelp", ["Yelp A"])
    linkedin = FakeProvider("linkedin", ["LinkedIn A"])

    before = CompositeDiscoveryProvider([maps, yelp])
    before_results = [c.name for c in before.discover(_req(maps, yelp))]

    # "Remove Google Maps, replace it with LinkedIn" — substitution
    # happens entirely at the call site, not inside composite_provider.py.
    after = CompositeDiscoveryProvider([linkedin, yelp])
    after_results = [c.name for c in after.discover(_req(linkedin, yelp))]

    _check(
        "5. substitution — pre-swap composite unaffected by post-swap construction",
        before_results == ["Maps A", "Yelp A"],
        before_results,
    )
    _check(
        "5. substitution — swapped composite reflects new provider set only",
        after_results == ["LinkedIn A", "Yelp A"],
        after_results,
    )


def test_engine_compatibility() -> None:
    """
    Simulates exactly what the Engine does with any
    DiscoveryProviderInterface: read provider_id/display_name, call
    discover(request), consume the iterator. No isinstance check on
    the concrete class, no special-casing — a composite must be
    indistinguishable from a single provider here.
    """

    def engine_consume(provider: DiscoveryProviderInterface, request: Any) -> list[BusinessCandidate]:
        assert isinstance(provider, DiscoveryProviderInterface)
        _ = provider.provider_id
        _ = provider.display_name
        return list(provider.discover(request))

    solo = FakeProvider("solo", ["Only One"])
    single_provider_results = engine_consume(solo, object())

    a = FakeProvider("provider_a", ["A1"])
    b = FakeProvider("provider_b", ["B1"])
    composite = CompositeDiscoveryProvider([a, b])
    composite_results = engine_consume(composite, _req(a, b))

    _check(
        "6. engine compatibility — bare provider consumed with zero special-casing",
        [c.name for c in single_provider_results] == ["Only One"],
    )
    _check(
        "6. engine compatibility — composite consumed with the exact same code path",
        [c.name for c in composite_results] == ["A1", "B1"],
    )
    _check(
        "6. engine compatibility — composite IS-A DiscoveryProviderInterface",
        isinstance(composite, DiscoveryProviderInterface),
    )


def test_error_handling() -> None:
    good = FakeProvider("good", ["G1", "G2"])
    bad = FakeProvider("bad", ["B1", "B2", "B3"], fail_after=1)  # fails after yielding B1

    # Strict mode (default): bad provider's exception propagates,
    # ending the stream — matches every existing provider's own
    # "never catch/swallow" behavior.
    strict = CompositeDiscoveryProvider([good, bad])
    strict_results = []
    raised = False
    try:
        for c in strict.discover(_req(good, bad)):
            strict_results.append(c.name)
    except RuntimeError:
        raised = True
    _check("7. error handling — strict mode propagates the exception", raised)
    _check(
        "7. error handling — strict mode yields everything before the failure",
        strict_results == ["G1", "G2", "B1"],
        strict_results,
    )

    # Best-effort mode: bad provider's partial results are kept, its
    # failure is isolated, and providers after it still run.
    good2 = FakeProvider("good2", ["G3"])
    bad2 = FakeProvider("bad2", ["X1"], fail_after=0)
    best_effort = CompositeDiscoveryProvider(
        [good2, bad2, good], continue_on_provider_error=True
    )
    best_effort_results = [
        c.name for c in best_effort.discover(_req(good2, bad2, good))
    ]
    # bad2 fails immediately (fail_after=0), so it contributes nothing;
    # good2 (before it) and good (after it) both contribute in full —
    # the failure is isolated to bad2 alone.
    _check(
        "7. error handling — best-effort mode isolates the failing provider "
        "and still yields the rest",
        best_effort_results == ["G3", "G1", "G2"],
        best_effort_results,
    )


def test_construction_guards() -> None:
    raised_empty = False
    try:
        CompositeDiscoveryProvider([])
    except ValueError:
        raised_empty = True
    _check("guard — empty provider list rejected", raised_empty)

    raised_dupe = False
    try:
        CompositeDiscoveryProvider(
            [FakeProvider("dup", ["X"]), FakeProvider("dup", ["Y"])]
        )
    except ValueError:
        raised_dupe = True
    _check("guard — duplicate provider_id rejected", raised_dupe)

    a = FakeProvider("provider_a", ["A1"])
    missing_request = False
    try:
        list(CompositeDiscoveryProvider([a]).discover(CompositeDiscoveryRequest(requests={})))
    except ValueError:
        missing_request = True
    _check("guard — missing per-provider request rejected", missing_request)


def test_no_engine_changes_required() -> None:
    """
    Confirms the only engine/ symbols this whole feature touches are
    the two contracts every provider already imports — no new engine
    symbol, no modified engine symbol, is required for composition.
    """
    import inspect

    from providers import composite_provider as mod

    source = inspect.getsource(mod)
    engine_imports = [
        line.strip()
        for line in source.splitlines()
        if line.strip().startswith("from engine")
    ]
    _check(
        "8. zero engine changes — only pre-existing engine contracts imported",
        engine_imports == [
            "from engine.contracts import BusinessCandidate",
            "from engine.interfaces import DiscoveryProviderInterface",
        ],
        engine_imports,
    )
    _check(
        "8. zero engine changes — CompositeDiscoveryProvider IS a "
        "DiscoveryProviderInterface subclass (no interface change needed)",
        issubclass(CompositeDiscoveryProvider, DiscoveryProviderInterface),
    )


def main() -> int:
    tests = [
        test_one_provider,
        test_two_providers,
        test_three_providers,
        test_streaming_order,
        test_provider_substitution,
        test_engine_compatibility,
        test_error_handling,
        test_construction_guards,
        test_no_engine_changes_required,
    ]
    failures = 0
    for test in tests:
        print(f"\n--- {test.__name__} ---")
        try:
            test()
        except Exception:
            failures += 1
            traceback.print_exc()

    print("\n" + "=" * 60)
    if failures:
        print(f"RESULT: {failures} test function(s) failed.")
    else:
        print("RESULT: all validations passed. Zero engine changes required.")
    print("=" * 60)
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
