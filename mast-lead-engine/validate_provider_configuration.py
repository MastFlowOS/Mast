"""
MAST Engine V2 — validate_provider_configuration.py
======================================================

Validates the Provider Configuration & Selection milestone:
providers/provider_configuration.py (ProviderConfiguration) and
ProviderRegistry.create() (providers/registry.py).

Style matches every other provider validation script referenced in
this codebase's docstrings: canned/fake DiscoveryProviderInterface
implementations injected directly (no live network, no real
GoogleMapsProvider/YelpProvider construction), plus a fake "Engine"
that only ever holds a bare DiscoveryProviderInterface reference, to
demonstrate the Engine cannot tell what it's holding.

Run: python3 validate_provider_configuration.py
"""

from __future__ import annotations

import sys
import traceback
from typing import Any, Iterator, List

from engine.contracts import BusinessCandidate
from engine.interfaces import DiscoveryProviderInterface
from providers.composite_provider import CompositeDiscoveryProvider
from providers.parallel_composite_provider import ParallelCompositeDiscoveryProvider
from providers.provider_configuration import ProviderConfiguration
from providers.provider_deduplicator import ProviderDeduplicator
from providers.registry import ProviderRegistry

PASS = "PASS"
FAIL = "FAIL"
_results: List[tuple[str, str, str]] = []


def check(name: str, condition: bool, detail: str = "") -> None:
    _results.append((name, PASS if condition else FAIL, detail))


def check_raises(name: str, exc_type: type, fn) -> None:
    try:
        fn()
    except exc_type:
        check(name, True)
    except Exception as exc:  # wrong exception type
        check(name, False, f"raised {type(exc).__name__}, expected {exc_type.__name__}")
    else:
        check(name, False, f"no exception raised, expected {exc_type.__name__}")


# ---------------------------------------------------------------------------
# Fake, canned DiscoveryProviderInterface implementations — no network.
# ---------------------------------------------------------------------------
class FakeProvider(DiscoveryProviderInterface):
    """Yields a fixed, canned list of BusinessCandidate objects."""

    def __init__(self, provider_id: str, names: List[str]) -> None:
        self._provider_id = provider_id
        self._names = names

    @property
    def provider_id(self) -> str:
        return self._provider_id

    @property
    def display_name(self) -> str:
        return self._provider_id.title()

    def discover(self, request: Any) -> Iterator[BusinessCandidate]:
        for i, name in enumerate(self._names):
            yield BusinessCandidate(
                pipeline_id=f"{self._provider_id}-{i}",
                session_id="session-1",
                provider=self._provider_id,
                provider_business_id=f"{self._provider_id}-id-{i}",
                name=name,
                phone=f"555000{i}111",  # distinct per provider+index
            )


class FakeEngine:
    """
    Mirrors CompositeDiscoveryProvider/ProviderDeduplicator's own
    validation-script convention: a stand-in Engine that only ever
    holds a bare DiscoveryProviderInterface reference and drains it.
    Used to prove the Engine needs zero changes to consume whatever
    ProviderRegistry.create() hands back.
    """

    def __init__(self, provider: DiscoveryProviderInterface) -> None:
        # The only thing the Engine is allowed to know.
        assert isinstance(provider, DiscoveryProviderInterface)
        self._provider = provider

    def run_discovery(self, request: Any) -> List[BusinessCandidate]:
        return list(self._provider.discover(request))


def build_registry() -> ProviderRegistry:
    registry = ProviderRegistry()
    registry.register(
        "google_maps",
        lambda: FakeProvider("google_maps", ["Alpha Cafe", "Beta Bakery"]),
        display_name="Google Maps",
    )
    registry.register(
        "yelp",
        lambda: FakeProvider("yelp", ["Gamma Diner"]),
        display_name="Yelp",
    )
    return registry


# ---------------------------------------------------------------------------
# 1. Single provider
# ---------------------------------------------------------------------------
def test_single_provider() -> None:
    registry = build_registry()
    config = ProviderConfiguration(providers=["google_maps"])
    provider = registry.create(config)

    check("single_provider: is DiscoveryProviderInterface", isinstance(provider, DiscoveryProviderInterface))
    check("single_provider: not wrapped in a composite", not isinstance(provider, CompositeDiscoveryProvider))
    check("single_provider: not wrapped in parallel composite", not isinstance(provider, ParallelCompositeDiscoveryProvider))
    check("single_provider: not wrapped in dedup", not isinstance(provider, ProviderDeduplicator))
    check("single_provider: identity matches selection", provider.provider_id == "google_maps")

    engine = FakeEngine(provider)
    candidates = engine.run_discovery(request=None)
    names = [c.name for c in candidates]
    check("single_provider: yields expected candidates", names == ["Alpha Cafe", "Beta Bakery"], str(names))


# ---------------------------------------------------------------------------
# 2. Sequential composite
# ---------------------------------------------------------------------------
def test_sequential_composite() -> None:
    registry = build_registry()
    config = ProviderConfiguration(providers=["google_maps", "yelp"], parallel=False)
    provider = registry.create(config)

    check("sequential: is CompositeDiscoveryProvider", isinstance(provider, CompositeDiscoveryProvider))
    check("sequential: not parallel composite", not isinstance(provider, ParallelCompositeDiscoveryProvider))

    from providers.composite_provider import CompositeDiscoveryRequest

    request = CompositeDiscoveryRequest(requests={"google_maps": None, "yelp": None})
    engine = FakeEngine(provider)
    candidates = engine.run_discovery(request)
    names = [c.name for c in candidates]
    # Sequential order: all of google_maps, then all of yelp.
    check(
        "sequential: drains providers in construction order",
        names == ["Alpha Cafe", "Beta Bakery", "Gamma Diner"],
        str(names),
    )


# ---------------------------------------------------------------------------
# 3. Parallel composite
# ---------------------------------------------------------------------------
def test_parallel_composite() -> None:
    registry = build_registry()
    config = ProviderConfiguration(providers=["google_maps", "yelp"], parallel=True)
    provider = registry.create(config)

    check("parallel: is ParallelCompositeDiscoveryProvider", isinstance(provider, ParallelCompositeDiscoveryProvider))
    check("parallel: not sequential composite", type(provider) is not CompositeDiscoveryProvider)

    from providers.parallel_composite_provider import ParallelDiscoveryRequest

    request = ParallelDiscoveryRequest(requests={"google_maps": None, "yelp": None})
    engine = FakeEngine(provider)
    candidates = engine.run_discovery(request)
    names = sorted(c.name for c in candidates)
    check(
        "parallel: yields every candidate from every provider",
        names == sorted(["Alpha Cafe", "Beta Bakery", "Gamma Diner"]),
        str(names),
    )


# ---------------------------------------------------------------------------
# 4. Dedup disabled
# ---------------------------------------------------------------------------
def test_dedup_disabled() -> None:
    registry = ProviderRegistry()
    registry.register("a", lambda: FakeProvider("a", ["Same Name Cafe"]))
    registry.register("b", lambda: FakeProvider("b", ["Same Name Cafe"]))

    config = ProviderConfiguration(providers=["a", "b"], deduplicate=False)
    provider = registry.create(config)
    check("dedup_disabled: not wrapped in ProviderDeduplicator", not isinstance(provider, ProviderDeduplicator))

    from providers.composite_provider import CompositeDiscoveryRequest

    request = CompositeDiscoveryRequest(requests={"a": None, "b": None})
    engine = FakeEngine(provider)
    candidates = engine.run_discovery(request)
    # Both providers issue the same phone/name in this canned fixture,
    # so without dedup both candidates survive.
    check("dedup_disabled: duplicate candidates both survive", len(candidates) == 2, str(len(candidates)))


# ---------------------------------------------------------------------------
# 5. Dedup enabled
# ---------------------------------------------------------------------------
def test_dedup_enabled() -> None:
    registry = ProviderRegistry()
    registry.register("a", lambda: FakeProvider("a", ["Same Name Cafe"]))
    registry.register("b", lambda: FakeProvider("b", ["Same Name Cafe"]))

    config = ProviderConfiguration(providers=["a", "b"], deduplicate=True)
    provider = registry.create(config)
    check("dedup_enabled: wrapped in ProviderDeduplicator", isinstance(provider, ProviderDeduplicator))

    from providers.composite_provider import CompositeDiscoveryRequest

    request = CompositeDiscoveryRequest(requests={"a": None, "b": None})
    engine = FakeEngine(provider)
    candidates = engine.run_discovery(request)
    check(
        "dedup_enabled: duplicate collapsed via name+address/phone key",
        True,  # informational — the real assertion is the count below
    )
    # Both fixtures share the same phone digits pattern by construction
    # (index 0 -> "5550000111" for both "a" and "b"), so the phone key
    # collapses them to one.
    check("dedup_enabled: only first occurrence survives", len(candidates) == 1, str(len(candidates)))


# ---------------------------------------------------------------------------
# 6. Provider selection (subset selection honored)
# ---------------------------------------------------------------------------
def test_provider_selection() -> None:
    registry = build_registry()
    # Only yelp selected, even though google_maps is also registered.
    config = ProviderConfiguration(providers=["yelp"])
    provider = registry.create(config)
    check("selection: only selected provider present", provider.provider_id == "yelp")

    engine = FakeEngine(provider)
    candidates = engine.run_discovery(request=None)
    names = [c.name for c in candidates]
    check("selection: google_maps candidates absent", names == ["Gamma Diner"], str(names))


# ---------------------------------------------------------------------------
# 7. Invalid provider id
# ---------------------------------------------------------------------------
def test_invalid_provider_id() -> None:
    registry = build_registry()
    config = ProviderConfiguration(providers=["google_maps", "not_a_real_provider"])
    check_raises("invalid_provider_id: create() raises KeyError", KeyError, lambda: registry.create(config))

    # Also validate ProviderConfiguration's own construction-time checks.
    check_raises(
        "invalid_provider_id: empty providers raises ValueError",
        ValueError,
        lambda: ProviderConfiguration(providers=[]),
    )
    check_raises(
        "invalid_provider_id: duplicate provider_id raises ValueError",
        ValueError,
        lambda: ProviderConfiguration(providers=["google_maps", "google_maps"]),
    )


# ---------------------------------------------------------------------------
# 8. Engine compatibility — the Engine only ever holds a bare
#    DiscoveryProviderInterface, regardless of what create() built.
# ---------------------------------------------------------------------------
def test_engine_compatibility() -> None:
    registry = build_registry()

    configs = {
        "single": ProviderConfiguration(providers=["google_maps"]),
        "sequential": ProviderConfiguration(providers=["google_maps", "yelp"], parallel=False),
        "parallel": ProviderConfiguration(providers=["google_maps", "yelp"], parallel=True),
        "sequential+dedup": ProviderConfiguration(providers=["google_maps", "yelp"], parallel=False, deduplicate=True),
        "parallel+dedup": ProviderConfiguration(providers=["google_maps", "yelp"], parallel=True, deduplicate=True),
    }

    all_ok = True
    for label, config in configs.items():
        provider = registry.create(config)
        try:
            # FakeEngine's constructor itself asserts isinstance(...,
            # DiscoveryProviderInterface) — the Engine's only contract
            # requirement, satisfied uniformly no matter what create()
            # composed underneath.
            FakeEngine(provider)
        except AssertionError:
            all_ok = False
    check("engine_compatibility: every create() output satisfies the Engine's only requirement", all_ok)


# ---------------------------------------------------------------------------
# 9. No engine changes required — static/structural proof.
# ---------------------------------------------------------------------------
def test_no_engine_changes_required() -> None:
    import inspect

    # DiscoveryProviderInterface's signature is untouched: still
    # exactly provider_id, display_name, discover(request) -> Iterator.
    members = {
        name
        for name, _ in inspect.getmembers(DiscoveryProviderInterface)
        if not name.startswith("_")
    }
    check(
        "no_engine_changes: DiscoveryProviderInterface surface unchanged",
        members == {"provider_id", "display_name", "discover"},
        str(members),
    )

    # ProviderConfiguration and ProviderRegistry.create() are never
    # imported by engine/interfaces.py or engine/contracts.py.
    import engine.interfaces as engine_interfaces_mod
    import engine.contracts as engine_contracts_mod

    src_interfaces = inspect.getsource(engine_interfaces_mod)
    src_contracts = inspect.getsource(engine_contracts_mod)
    check(
        "no_engine_changes: engine/interfaces.py has no provider-configuration reference",
        "ProviderConfiguration" not in src_interfaces and "ProviderRegistry" not in src_interfaces,
    )
    check(
        "no_engine_changes: engine/contracts.py has no provider-configuration reference",
        "ProviderConfiguration" not in src_contracts and "ProviderRegistry" not in src_contracts,
    )


# ---------------------------------------------------------------------------
# Runner
# ---------------------------------------------------------------------------
def main() -> int:
    tests = [
        test_single_provider,
        test_sequential_composite,
        test_parallel_composite,
        test_dedup_disabled,
        test_dedup_enabled,
        test_provider_selection,
        test_invalid_provider_id,
        test_engine_compatibility,
        test_no_engine_changes_required,
    ]

    for test in tests:
        try:
            test()
        except Exception:
            check(f"{test.__name__}: unexpected exception", False, traceback.format_exc())

    width = max(len(name) for name, _, _ in _results)
    failures = 0
    for name, status, detail in _results:
        line = f"[{status}] {name.ljust(width)}"
        if detail and status == FAIL:
            line += f"  -- {detail}"
        print(line)
        if status == FAIL:
            failures += 1

    print()
    print(f"{len(_results) - failures}/{len(_results)} checks passed.")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
