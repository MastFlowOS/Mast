"""
validate_parallel_provider.py
================================

Validates ParallelCompositeDiscoveryProvider against the real,
unmodified DiscoveryProviderInterface (engine/interfaces.py) and
BusinessCandidate (engine/contracts.py) — same validation style as
this project's existing provider validation scripts: canned/fake
providers injected directly, no live network, no engine changes.

Fake providers below are the only test doubles used. They are
themselves real DiscoveryProviderInterface implementations (not
mocks of the interface) — same approach the existing validation
scripts for GoogleMapsProvider / YelpProvider / CompositeDiscoveryProvider
use for injecting canned data instead of live sources.
"""

from __future__ import annotations

import threading
import time
import traceback
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Iterator, List

from engine.contracts import BusinessCandidate
from engine.interfaces import DiscoveryProviderInterface
from providers.composite_provider import CompositeDiscoveryProvider, CompositeDiscoveryRequest
from providers.parallel_composite_provider import (
    ParallelCompositeDiscoveryProvider,
    ParallelDiscoveryRequest,
)


# ---------------------------------------------------------------------------
# Fake provider — a real DiscoveryProviderInterface implementation that
# yields a configurable number of candidates with a configurable delay
# between each, optionally raising after N items. This is what lets the
# tests below observe concurrency (wall-clock time) and failure handling
# without any live network or real scraper/API dependency.
# ---------------------------------------------------------------------------
@dataclass(frozen=True, slots=True)
class FakeRequest:
    session_id: str = "session-1"


class FakeProvider(DiscoveryProviderInterface):
    def __init__(
        self,
        pid: str,
        count: int,
        delay: float,
        fail_after: int | None = None,
    ) -> None:
        self._pid = pid
        self._count = count
        self._delay = delay
        self._fail_after = fail_after

    @property
    def provider_id(self) -> str:
        return self._pid

    @property
    def display_name(self) -> str:
        return self._pid.replace("_", " ").title()

    def discover(self, request: FakeRequest) -> Iterator[BusinessCandidate]:
        for i in range(self._count):
            if self._fail_after is not None and i == self._fail_after:
                raise RuntimeError(f"{self._pid} simulated failure at item {i}")
            time.sleep(self._delay)
            yield BusinessCandidate(
                pipeline_id=str(uuid.uuid4()),
                session_id=request.session_id,
                provider=self._pid,
                name=f"{self._pid}-business-{i}",
                discovered_at=datetime.now(timezone.utc).isoformat(),
            )


def _req(providers: list[DiscoveryProviderInterface]) -> ParallelDiscoveryRequest:
    return ParallelDiscoveryRequest(
        requests={p.provider_id: FakeRequest() for p in providers}
    )


def _check(label: str, condition: bool, detail: str = "") -> None:
    status = "PASS" if condition else "FAIL"
    print(f"[{status}] {label}" + (f" — {detail}" if detail and not condition else ""))
    assert condition, f"{label} — {detail}"


def _thread_count() -> int:
    return threading.active_count()


# ---------------------------------------------------------------------------
# 1. One provider
# ---------------------------------------------------------------------------
def test_one_provider() -> None:
    print("\n== one provider ==")
    baseline = _thread_count()
    p1 = FakeProvider("p1", count=5, delay=0.01)
    parallel = ParallelCompositeDiscoveryProvider([p1])
    results = list(parallel.discover(_req([p1])))
    _check("one provider yields all candidates", len(results) == 5, str(len(results)))
    _check(
        "one provider — no leaked threads",
        _thread_count() == baseline,
        f"before={baseline} after={_thread_count()}",
    )


# ---------------------------------------------------------------------------
# 2. Two providers
# ---------------------------------------------------------------------------
def test_two_providers() -> None:
    print("\n== two providers ==")
    baseline = _thread_count()
    p1 = FakeProvider("p1", count=5, delay=0.01)
    p2 = FakeProvider("p2", count=5, delay=0.01)
    parallel = ParallelCompositeDiscoveryProvider([p1, p2])
    results = list(parallel.discover(_req([p1, p2])))
    _check("two providers yield all candidates", len(results) == 10, str(len(results)))
    provider_names = {c.provider for c in results}
    _check("two providers both represented", provider_names == {"p1", "p2"}, str(provider_names))
    _check(
        "two providers — no leaked threads",
        _thread_count() == baseline,
        f"before={baseline} after={_thread_count()}",
    )


# ---------------------------------------------------------------------------
# 3. Three providers
# ---------------------------------------------------------------------------
def test_three_providers() -> None:
    print("\n== three providers ==")
    baseline = _thread_count()
    p1 = FakeProvider("p1", count=4, delay=0.01)
    p2 = FakeProvider("p2", count=4, delay=0.01)
    p3 = FakeProvider("p3", count=4, delay=0.01)
    parallel = ParallelCompositeDiscoveryProvider([p1, p2, p3])
    results = list(parallel.discover(_req([p1, p2, p3])))
    _check("three providers yield all candidates", len(results) == 12, str(len(results)))
    provider_names = {c.provider for c in results}
    _check(
        "three providers all represented",
        provider_names == {"p1", "p2", "p3"},
        str(provider_names),
    )
    _check(
        "three providers — no leaked threads",
        _thread_count() == baseline,
        f"before={baseline} after={_thread_count()}",
    )


# ---------------------------------------------------------------------------
# 4. Providers actually execute concurrently (wall-clock proof)
# ---------------------------------------------------------------------------
def test_actual_concurrency() -> None:
    print("\n== actual concurrency (wall-clock) ==")
    # 3 providers x 10 items x 0.03s = 0.3s each if sequential per-provider.
    # Sequential composite: ~0.9s total. Parallel: should be ~0.3s total
    # (bounded by the slowest single provider, not the sum of all three).
    providers = [FakeProvider(f"p{i}", count=10, delay=0.03) for i in range(3)]

    sequential = CompositeDiscoveryProvider(list(providers))
    seq_request = CompositeDiscoveryRequest(
        requests={p.provider_id: FakeRequest() for p in providers}
    )
    start = time.monotonic()
    seq_results = list(sequential.discover(seq_request))
    sequential_time = time.monotonic() - start

    parallel = ParallelCompositeDiscoveryProvider(list(providers))
    start = time.monotonic()
    par_results = list(parallel.discover(_req(providers)))
    parallel_time = time.monotonic() - start

    print(f"    sequential composite: {sequential_time:.3f}s for {len(seq_results)} candidates")
    print(f"    parallel composite:   {parallel_time:.3f}s for {len(par_results)} candidates")

    _check(
        "parallel is meaningfully faster than sequential for the same providers",
        parallel_time < sequential_time * 0.6,
        f"parallel={parallel_time:.3f}s sequential={sequential_time:.3f}s",
    )
    _check(
        "parallel candidate count matches sequential candidate count",
        len(par_results) == len(seq_results),
        f"parallel={len(par_results)} sequential={len(seq_results)}",
    )


# ---------------------------------------------------------------------------
# 5. Streaming begins before all providers finish
# ---------------------------------------------------------------------------
def test_streaming_begins_early() -> None:
    print("\n== streaming begins before all providers finish ==")
    # One fast provider, one deliberately slow (long-running) provider.
    fast = FakeProvider("fast", count=3, delay=0.01)
    slow = FakeProvider("slow", count=1, delay=1.0)  # still "running" long after fast finishes
    parallel = ParallelCompositeDiscoveryProvider([fast, slow])

    start = time.monotonic()
    first_item_time = None
    seen_providers: List[str] = []
    for candidate in parallel.discover(_req([fast, slow])):
        if first_item_time is None:
            first_item_time = time.monotonic() - start
        seen_providers.append(candidate.provider)
        if len(seen_providers) == 3:
            # All 3 "fast" candidates should be seen well before slow's
            # 1.0s delay elapses — proves the consumer isn't blocked
            # waiting for `slow` before it can see `fast`'s output.
            elapsed = time.monotonic() - start
            _check(
                "all of fast's candidates arrive before slow's delay elapses",
                elapsed < 0.5,
                f"elapsed={elapsed:.3f}s",
            )
            break

    _check("first candidate arrived quickly", first_item_time is not None and first_item_time < 0.5)
    # Stop iterating early (simulates an Engine that only wants the first
    # few results) — this also exercises early-shutdown cleanup, see
    # test_clean_shutdown_on_early_stop below.


# ---------------------------------------------------------------------------
# 6. Provider failure handling — strict (default) mode
# ---------------------------------------------------------------------------
def test_failure_strict_mode() -> None:
    print("\n== provider failure — strict mode (default) ==")
    good = FakeProvider("good", count=20, delay=0.005)
    bad = FakeProvider("bad", count=10, delay=0.005, fail_after=3)
    parallel = ParallelCompositeDiscoveryProvider([good, bad])  # continue_on_provider_error=False

    raised = None
    collected: List[BusinessCandidate] = []
    try:
        for candidate in parallel.discover(_req([good, bad])):
            collected.append(candidate)
    except RuntimeError as exc:
        raised = exc

    _check("strict mode re-raises the provider's exception", raised is not None)
    _check(
        "strict mode error message identifies the failing provider",
        raised is not None and "bad" in str(raised),
        str(raised),
    )
    _check(
        "strict mode still yielded candidates produced before the failure",
        len(collected) > 0,
        str(len(collected)),
    )


# ---------------------------------------------------------------------------
# 7. Provider failure handling — best-effort (opt-in) mode
# ---------------------------------------------------------------------------
def test_failure_best_effort_mode() -> None:
    print("\n== provider failure — best-effort mode (opt-in) ==")
    good = FakeProvider("good", count=15, delay=0.005)
    bad = FakeProvider("bad", count=10, delay=0.005, fail_after=3)
    parallel = ParallelCompositeDiscoveryProvider(
        [good, bad], continue_on_provider_error=True
    )

    raised = None
    collected: List[BusinessCandidate] = []
    try:
        for candidate in parallel.discover(_req([good, bad])):
            collected.append(candidate)
    except RuntimeError as exc:
        raised = exc

    _check("best-effort mode does not propagate the failing provider's exception", raised is None)
    good_count = sum(1 for c in collected if c.provider == "good")
    bad_count = sum(1 for c in collected if c.provider == "bad")
    _check("best-effort mode still yields every candidate from the healthy provider", good_count == 15, str(good_count))
    _check("best-effort mode yields only the candidates the failing provider produced before failing", bad_count == 3, str(bad_count))


# ---------------------------------------------------------------------------
# 8. Clean shutdown when the caller stops iterating early
# ---------------------------------------------------------------------------
def test_clean_shutdown_on_early_stop() -> None:
    print("\n== clean shutdown on early stop ==")
    baseline = _thread_count()
    providers = [FakeProvider(f"p{i}", count=50, delay=0.02) for i in range(3)]
    parallel = ParallelCompositeDiscoveryProvider(list(providers))

    gen = parallel.discover(_req(providers))
    for _ in range(3):
        next(gen)
    gen.close()  # simulates an Engine/caller that stops early

    # Give producer threads a brief window to observe stop_event and exit
    # (see module docstring's honest note on shutdown speed).
    time.sleep(0.3)
    _check(
        "no leaked threads after caller closes the generator early",
        _thread_count() == baseline,
        f"before={baseline} after={_thread_count()}",
    )


# ---------------------------------------------------------------------------
# 9. No leaked threads/tasks across the full suite
# ---------------------------------------------------------------------------
def test_no_leaks_overall(baseline: int) -> None:
    print("\n== overall thread leak check ==")
    _check(
        "thread count back to baseline after entire suite",
        _thread_count() == baseline,
        f"baseline={baseline} current={_thread_count()}",
    )


# ---------------------------------------------------------------------------
# 10. Engine compatibility — no engine changes required
# ---------------------------------------------------------------------------
def test_engine_compatibility() -> None:
    print("\n== engine compatibility ==")
    p1 = FakeProvider("p1", count=3, delay=0.0)
    p2 = FakeProvider("p2", count=3, delay=0.0)
    parallel = ParallelCompositeDiscoveryProvider([p1, p2])

    # 1. It IS-A DiscoveryProviderInterface — the only type the Engine
    #    ever holds a reference to.
    _check(
        "ParallelCompositeDiscoveryProvider satisfies DiscoveryProviderInterface",
        isinstance(parallel, DiscoveryProviderInterface),
    )

    # 2. A caller written purely against DiscoveryProviderInterface
    #    (i.e. an "Engine" stand-in that knows nothing about this file)
    #    can consume it with zero special-casing.
    def engine_stand_in(provider: DiscoveryProviderInterface, request) -> int:
        """Represents the Engine's own consumption pattern: hold a bare
        DiscoveryProviderInterface, iterate it, do nothing parallel-
        specific. This function is written against the interface only —
        it never imports or references ParallelCompositeDiscoveryProvider."""
        return sum(1 for _ in provider.discover(request))

    n = engine_stand_in(parallel, _req([p1, p2]))
    _check("a plain DiscoveryProviderInterface consumer works unmodified", n == 6, str(n))

    # 3. It composes with the OTHER existing provider-layer classes
    #    exactly like any other provider — nesting inside
    #    CompositeDiscoveryProvider, unmodified.
    p3 = FakeProvider("p3", count=2, delay=0.0)
    nested = CompositeDiscoveryProvider([parallel, p3], provider_id="nested")
    nested_request = CompositeDiscoveryRequest(
        requests={
            parallel.provider_id: _req([p1, p2]),
            p3.provider_id: FakeRequest(),
        }
    )
    nested_results = list(nested.discover(nested_request))
    _check(
        "ParallelCompositeDiscoveryProvider nests inside CompositeDiscoveryProvider unmodified",
        len(nested_results) == 8,
        str(len(nested_results)),
    )


# ---------------------------------------------------------------------------
# Runner
# ---------------------------------------------------------------------------
def main() -> None:
    baseline = _thread_count()
    tests = [
        test_one_provider,
        test_two_providers,
        test_three_providers,
        test_actual_concurrency,
        test_streaming_begins_early,
        test_failure_strict_mode,
        test_failure_best_effort_mode,
        test_clean_shutdown_on_early_stop,
        test_engine_compatibility,
    ]
    failures = 0
    for test in tests:
        try:
            test()
        except AssertionError:
            failures += 1
            print(f"    ^^^ {test.__name__} FAILED")
        except Exception:
            failures += 1
            print(f"    ^^^ {test.__name__} CRASHED")
            traceback.print_exc()

    time.sleep(0.2)  # let any straggler threads finish joining
    try:
        test_no_leaks_overall(baseline)
    except AssertionError:
        failures += 1

    print("\n" + "=" * 60)
    if failures == 0:
        print("ALL VALIDATIONS PASSED — Engine 2.0 required zero architectural changes.")
    else:
        print(f"{failures} VALIDATION(S) FAILED")
    print("=" * 60)


if __name__ == "__main__":
    main()
