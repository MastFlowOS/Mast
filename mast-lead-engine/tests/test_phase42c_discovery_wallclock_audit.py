"""
PHASE 42C — DISCOVERY WALL-CLOCK AUDIT — regression tests
(providers/target_aware_provider.py).

Root cause this covers, distinct from Phase 42 / 42B (which bounded
OverpassProvider's own internal per-attempt/retry timeouts —
providers/overpass_provider.py, unmodified by this phase):

Even with Overpass's own HTTP layer correctly bounded,
`TargetAwareDiscoveryProvider.discover()` — the outermost layer
`discovery_composition.py` wraps everything in, and the only layer
that knows about `should_stop()` (target reached / shutdown requested)
— only re-checked `should_stop()` in between fully-produced items from
the wrapped provider. When the wrapped provider is a
`ParallelCompositeDiscoveryProvider`, a single "give me the next item"
call on it can legitimately block for as long as its SLOWEST
still-running wrapped provider takes (that class's own internal
`result_queue.get()` has no timeout) — so `should_stop()` could not be
re-consulted while that single call was in flight, even though the
condition it's checking (target already reached, via a fast provider's
own candidates) had already become true.

Net effect, matching the production telemetry this phase's own
instructions supplied:
  - Case B (Overpass ~74.0s, Google Maps ~2.5s, discovery_total
    ~74.1s): Maps already produced enough candidates in ~2.5s, but
    discovery_total tracked Overpass's full duration anyway.
  - Case C: Maps yields dozens of candidates within seconds, then
    discovery stays "active" for a long time afterward.

The fix (see providers/target_aware_provider.py, "PHASE 42C addendum"
in its own module docstring): `TargetAwareDiscoveryProvider.discover()`
now drains the wrapped provider on a dedicated helper thread and polls
for the next item with a short, bounded timeout, re-checking
`should_stop()` on every poll — not just after an item arrives. This
file proves that fix end to end, using the SAME
`ParallelCompositeDiscoveryProvider` (unmodified) the production code
path actually uses.

Scope, deliberately narrow, per this phase's own instructions: no
worker-count, Overpass-implementation, qualification, Instagram,
pruning, or scan-budget logic is touched or exercised beyond
confirming Google Maps candidates still flow through, and Overpass is
still given a chance to run concurrently (never silently dropped from
the composition).

Run: pytest tests/test_phase42c_discovery_wallclock_audit.py -v
"""

from __future__ import annotations

import sys
import threading
import time
import uuid
from typing import Any, Iterator, List

import pytest

from engine.contracts import BusinessCandidate
from engine.interfaces import DiscoveryProviderInterface
from providers.parallel_composite_provider import (
    ParallelCompositeDiscoveryProvider,
    ParallelDiscoveryRequest,
)
from providers.target_aware_provider import TargetAwareDiscoveryProvider

# A small, deterministic poll interval so these tests run fast and
# don't need to sleep for realistic production durations (~45-75s) to
# prove the fix — see TargetAwareDiscoveryProvider.__init__'s own
# `poll_interval_seconds` parameter, added specifically for this.
_TEST_POLL_INTERVAL = 0.02


@pytest.fixture(autouse=True)
def _no_thread_leaks_into_other_tests():
    """
    Several tests below deliberately exercise the bounded-join
    trade-off (module docstring's "PHASE 42C addendum, subtlety"
    paragraph): a helper/producer thread can legitimately outlive the
    `discover()` call that started it for a short, bounded time. Left
    unchecked, that thread — named `parallel-discovery-*` or
    `target-aware-drain`, same names other test files (e.g.
    test_phase42b_overpass_wall_clock_release.py) scan for globally —
    could still be alive when a LATER, unrelated test's own global
    `threading.enumerate()` assertion runs, failing it for a reason
    that has nothing to do with that test. This fixture is a hygiene
    guarantee, not part of the fix under test: it blocks (briefly,
    bounded) after every test in this file until every thread of these
    two kinds has actually exited, so this file never leaks a
    background thread into whichever test runs next.
    """
    yield
    deadline = time.monotonic() + 3.0
    while time.monotonic() < deadline:
        lingering = [
            t
            for t in threading.enumerate()
            if t.name.startswith("parallel-discovery-") or t.name == "target-aware-drain"
        ]
        if not lingering:
            return
        time.sleep(0.02)


def _candidate(provider: str, name: str) -> BusinessCandidate:
    return BusinessCandidate(
        pipeline_id=str(uuid.uuid4()),
        session_id="s1",
        provider=provider,
        maps_url=f"https://maps.example.invalid/{uuid.uuid4()}",
        name=name,
        city="Testville",
        country="US",
    )


class _FastListProvider(DiscoveryProviderInterface):
    """Stands in for GoogleMapsProvider: yields a fixed list quickly,
    with an optional tiny per-item delay to model real streaming."""

    def __init__(
        self, provider_id: str, candidates: List[BusinessCandidate], delay_s: float = 0.0
    ) -> None:
        self._provider_id = provider_id
        self._candidates = candidates
        self._delay_s = delay_s

    @property
    def provider_id(self) -> str:
        return self._provider_id

    @property
    def display_name(self) -> str:
        return self._provider_id

    def discover(self, request: Any) -> Iterator[BusinessCandidate]:
        for c in self._candidates:
            if self._delay_s:
                time.sleep(self._delay_s)
            yield c


class _SlowProvider(DiscoveryProviderInterface):
    """Stands in for a slow/hanging Overpass call: sleeps for a long
    time (modeling a slow-but-eventually-responding endpoint) before
    ever yielding anything, cooperatively checking a stop signal is
    NOT required of it (mirrors the real interface: no cancellation
    hook), so this deliberately behaves exactly like an
    un-interruptible network call from the caller's point of view."""

    def __init__(self, provider_id: str, sleep_s: float, candidates: List[BusinessCandidate]) -> None:
        self._provider_id = provider_id
        self._sleep_s = sleep_s
        self._candidates = candidates
        self.finished_at: float | None = None

    @property
    def provider_id(self) -> str:
        return self._provider_id

    @property
    def display_name(self) -> str:
        return self._provider_id

    def discover(self, request: Any) -> Iterator[BusinessCandidate]:
        time.sleep(self._sleep_s)
        for c in self._candidates:
            yield c
        self.finished_at = time.monotonic()


class _FailingProvider(DiscoveryProviderInterface):
    """Fails immediately on its first `next()`, after an optional
    short delay — models a provider whose credential/endpoint is
    simply broken."""

    def __init__(self, provider_id: str, delay_s: float = 0.0) -> None:
        self._provider_id = provider_id
        self._delay_s = delay_s

    @property
    def provider_id(self) -> str:
        return self._provider_id

    @property
    def display_name(self) -> str:
        return self._provider_id

    def discover(self, request: Any) -> Iterator[BusinessCandidate]:
        if self._delay_s:
            time.sleep(self._delay_s)
        raise RuntimeError(f"{self._provider_id} is unavailable")
        yield  # pragma: no cover — makes this a generator function


# ---------------------------------------------------------------------------
# 1. Maps' results are not blocked by a dead/slow Overpass provider.
# ---------------------------------------------------------------------------
class TestMapsNotBlockedBySlowOverpass:
    def test_maps_candidates_are_yielded_without_waiting_for_slow_overpass(self):
        """Case B / C reproduction: Overpass is slow (models ~74s in
        production, scaled down here), Google Maps is fast and already
        has everything the caller needs. Once should_stop() reports
        True (simulating the target being reached from Maps' own
        candidates), the whole composed discover() call must return
        promptly — bounded by the poll interval, not by Overpass's
        sleep."""
        overpass = _SlowProvider("overpass", sleep_s=0.4, candidates=[])
        maps_candidates = [_candidate("google_maps", f"Cafe {i}") for i in range(5)]
        maps = _FastListProvider("google_maps", maps_candidates)

        parallel = ParallelCompositeDiscoveryProvider(
            [overpass, maps], continue_on_provider_error=True
        )

        accepted = 0
        target = 5

        def _should_stop() -> bool:
            return accepted >= target

        wrapped = TargetAwareDiscoveryProvider(
            parallel, should_stop=_should_stop, poll_interval_seconds=_TEST_POLL_INTERVAL
        )
        request = ParallelDiscoveryRequest(
            requests={"overpass": object(), "google_maps": object()}
        )

        started = time.monotonic()
        results = []
        for candidate in wrapped.discover(request):
            results.append(candidate)
            accepted += 1
            if accepted >= target:
                break
        elapsed = time.monotonic() - started

        assert accepted == target
        assert {c.name for c in results} == {c.name for c in maps_candidates}
        assert elapsed < 1.0, (
            f"discover() took {elapsed:.2f}s — it must not wait for "
            f"Overpass's 5s sleep once Maps already supplied everything "
            f"needed"
        )

    def test_overpass_still_gets_to_run_concurrently_not_silently_dropped(self):
        """The fix must not discard Overpass from the composition —
        it still runs concurrently and its candidates still stream
        through when they arrive before should_stop() fires. This
        guards against an over-eager fix that just stops calling
        Overpass altogether."""
        overpass = _SlowProvider(
            "overpass", sleep_s=0.05, candidates=[_candidate("overpass", "OSM Diner")]
        )
        maps = _FastListProvider(
            "google_maps", [_candidate("google_maps", "Quick Cafe")]
        )
        parallel = ParallelCompositeDiscoveryProvider(
            [overpass, maps], continue_on_provider_error=True
        )
        # should_stop never fires — a plain, unbounded run should still
        # see both providers' candidates, proving Overpass was never
        # excluded from the composition by this fix.
        wrapped = TargetAwareDiscoveryProvider(
            parallel, should_stop=lambda: False, poll_interval_seconds=_TEST_POLL_INTERVAL
        )
        request = ParallelDiscoveryRequest(
            requests={"overpass": object(), "google_maps": object()}
        )
        results = list(wrapped.discover(request))
        names = {c.name for c in results}
        assert names == {"Quick Cafe", "OSM Diner"}


# ---------------------------------------------------------------------------
# 2. Overpass completion does not delay completion once discovery is
#    already sufficient.
# ---------------------------------------------------------------------------
class TestOverpassDoesNotDelayCompletion:
    def test_discovery_total_is_not_gated_on_overpass_once_target_reached(self):
        """Direct proxy for `discovery_total_ms` in production
        telemetry: times the full `list(wrapped.discover(...))` call
        (mirroring service.py's own `_discover_worker`, which times
        exactly this) and asserts it reflects the fast provider's
        completion time plus a small bounded polling overhead — not
        the slow provider's sleep."""
        overpass_sleep = 2.0
        overpass = _SlowProvider("overpass", sleep_s=overpass_sleep, candidates=[])
        maps = _FastListProvider(
            "google_maps",
            [_candidate("google_maps", f"Shop {i}") for i in range(3)],
            delay_s=0.01,
        )
        parallel = ParallelCompositeDiscoveryProvider(
            [overpass, maps], continue_on_provider_error=True
        )

        accepted = 0

        def _should_stop() -> bool:
            return accepted >= 3

        wrapped = TargetAwareDiscoveryProvider(
            parallel, should_stop=_should_stop, poll_interval_seconds=_TEST_POLL_INTERVAL
        )
        request = ParallelDiscoveryRequest(
            requests={"overpass": object(), "google_maps": object()}
        )

        started = time.monotonic()
        results = []
        for c in wrapped.discover(request):
            results.append(c)
            accepted += 1
        elapsed = time.monotonic() - started

        assert len(results) == 3
        assert elapsed < overpass_sleep / 2, (
            f"discovery_total proxy was {elapsed:.2f}s — must not track "
            f"Overpass's {overpass_sleep}s sleep once target was reached "
            f"from Maps' own candidates"
        )


# ---------------------------------------------------------------------------
# 3. Provider failure does not restart / re-run Maps.
# ---------------------------------------------------------------------------
class TestProviderFailureDoesNotRestartMaps:
    def test_overpass_failure_does_not_cause_maps_to_be_redriven(self):
        """A failing auxiliary provider (e.g. Overpass returning an
        HTTP error) must be isolated (continue_on_provider_error=True,
        matching discovery_composition.py's own production wiring) and
        must never cause Maps' own `discover()` generator to be
        constructed or iterated more than once."""
        call_count = {"n": 0}
        maps_candidates = [_candidate("google_maps", "Solo Cafe")]

        class _CountingMapsProvider(DiscoveryProviderInterface):
            provider_id = "google_maps"
            display_name = "google_maps"

            def discover(self, request: Any) -> Iterator[BusinessCandidate]:
                call_count["n"] += 1
                yield from maps_candidates

        overpass = _FailingProvider("overpass", delay_s=0.02)
        maps = _CountingMapsProvider()
        parallel = ParallelCompositeDiscoveryProvider(
            [overpass, maps], continue_on_provider_error=True
        )
        wrapped = TargetAwareDiscoveryProvider(
            parallel, should_stop=lambda: False, poll_interval_seconds=_TEST_POLL_INTERVAL
        )
        request = ParallelDiscoveryRequest(
            requests={"overpass": object(), "google_maps": object()}
        )

        results = list(wrapped.discover(request))

        assert call_count["n"] == 1, (
            "Maps' discover() must be constructed/driven exactly once — "
            "Overpass's failure must not trigger any re-run of Maps"
        )
        assert {c.name for c in results} == {"Solo Cafe"}

    def test_provider_failure_does_not_block_should_stop_from_firing_promptly(self):
        """A failing provider that raises quickly must not leave the
        helper drain thread, or should_stop polling, stuck — the
        overall call must still return promptly."""
        overpass = _FailingProvider("overpass", delay_s=0.0)
        maps = _SlowProvider(
            "google_maps", sleep_s=0.4, candidates=[_candidate("google_maps", "Late Cafe")]
        )
        parallel = ParallelCompositeDiscoveryProvider(
            [overpass, maps], continue_on_provider_error=True
        )
        wrapped = TargetAwareDiscoveryProvider(
            parallel, should_stop=lambda: True, poll_interval_seconds=_TEST_POLL_INTERVAL
        )
        request = ParallelDiscoveryRequest(
            requests={"overpass": object(), "google_maps": object()}
        )

        started = time.monotonic()
        results = list(wrapped.discover(request))
        elapsed = time.monotonic() - started

        assert results == []
        assert elapsed < 1.0, (
            f"should_stop=True from the start must return almost "
            f"immediately regardless of a failing provider or a slow "
            f"one; took {elapsed:.2f}s"
        )


# ---------------------------------------------------------------------------
# 4. target/budget termination stops discovery promptly.
# ---------------------------------------------------------------------------
class TestTargetBudgetTerminationIsPrompt:
    def test_should_stop_becoming_true_mid_wait_is_noticed_within_one_poll_interval(self):
        """The core Phase 42C fix, isolated: should_stop() flips to
        True from ANOTHER thread while `wrapped.discover()` is
        blocked waiting on a slow provider that has not produced an
        item yet. The generator must notice within a small, bounded
        multiple of poll_interval_seconds — not wait for the slow
        provider."""
        slow = _SlowProvider("slow", sleep_s=0.4, candidates=[_candidate("slow", "Late")])
        composite = ParallelCompositeDiscoveryProvider(
            [slow], continue_on_provider_error=True
        )

        stop_flag = threading.Event()
        wrapped = TargetAwareDiscoveryProvider(
            composite,
            should_stop=stop_flag.is_set,
            poll_interval_seconds=_TEST_POLL_INTERVAL,
        )
        request = ParallelDiscoveryRequest(requests={"slow": object()})

        gen = wrapped.discover(request)

        def _flip_stop_soon() -> None:
            time.sleep(0.1)
            stop_flag.set()

        threading.Thread(target=_flip_stop_soon, daemon=True).start()

        started = time.monotonic()
        results = list(gen)
        elapsed = time.monotonic() - started

        assert results == []
        assert elapsed < 0.5, (
            f"should_stop() flipping true mid-wait took {elapsed:.2f}s "
            f"to be noticed — must be bounded by the poll interval, not "
            f"by the slow provider's 5s sleep"
        )

    def test_target_reached_exactly_at_boundary_stops_without_overshoot(self):
        """Sanity check that the polling rewrite did not introduce an
        off-by-one / overshoot: exactly `target` candidates are
        returned, no more, even though more are available."""
        many = [_candidate("google_maps", f"Biz {i}") for i in range(50)]
        maps = _FastListProvider("google_maps", many, delay_s=0.001)
        composite = ParallelCompositeDiscoveryProvider(
            [maps], continue_on_provider_error=True
        )

        accepted = 0
        target = 7

        def _should_stop() -> bool:
            return accepted >= target

        wrapped = TargetAwareDiscoveryProvider(
            composite, should_stop=_should_stop, poll_interval_seconds=_TEST_POLL_INTERVAL
        )
        request = ParallelDiscoveryRequest(requests={"google_maps": object()})

        results = []
        for c in wrapped.discover(request):
            results.append(c)
            accepted += 1
            if accepted >= target:
                break

        assert len(results) == target

    def test_leftover_threads_are_bounded_and_eventually_clean_themselves_up(self):
        """No thread outlives the call in the common case (a wrapped
        provider that responds within a normal item cadence — the vast
        majority of real discovery calls, where multiple candidates
        stream by well inside the poll interval). This is the
        documented trade-off from module docstring's "PHASE 42C
        addendum, subtlety" paragraph: the helper thread's join is
        bounded, not indefinite, specifically so a single truly
        in-flight, uninterruptible wrapped call never blocks the
        caller — but that same design means such a thread (rare: only
        when should_stop() fires while a wrapped provider's own call
        is genuinely mid-flight) is left to finish tearing itself down
        asynchronously, bounded by that provider's own timeout, same
        as ParallelCompositeDiscoveryProvider's own producer threads
        already are for the identical reason. Uses a short (not 5s)
        sleep so that eventual cleanup can be observed directly within
        this test."""
        overpass = _SlowProvider("overpass", sleep_s=0.2, candidates=[])
        maps = _FastListProvider(
            "google_maps", [_candidate("google_maps", f"Biz {i}") for i in range(3)]
        )
        parallel = ParallelCompositeDiscoveryProvider(
            [overpass, maps], continue_on_provider_error=True
        )

        accepted = 0

        def _should_stop() -> bool:
            return accepted >= 3

        wrapped = TargetAwareDiscoveryProvider(
            parallel, should_stop=_should_stop, poll_interval_seconds=_TEST_POLL_INTERVAL
        )
        request = ParallelDiscoveryRequest(
            requests={"overpass": object(), "google_maps": object()}
        )

        # Snapshot before/after by identity, not name — other tests in
        # this module deliberately leave slow-provider threads of
        # their own alive for up to a few seconds (that IS the
        # documented trade-off), so a name-based global scan would be
        # contaminated by unrelated tests. Tracking this call's own
        # thread objects specifically keeps the assertion accurate
        # regardless of what else is running in the process.
        before = set(threading.enumerate())

        started = time.monotonic()
        for c in wrapped.discover(request):
            accepted += 1
            if accepted >= 3:
                break
        elapsed = time.monotonic() - started

        # The caller-visible call itself must still return promptly —
        # this is the actual fix under test — even though a leftover
        # thread may still be finishing up in the background.
        assert elapsed < 0.15, (
            f"discover() call took {elapsed:.2f}s to return control to "
            f"the caller — must not block on Overpass's still-in-flight "
            f"0.2s sleep"
        )

        new_threads = [
            t
            for t in (set(threading.enumerate()) - before)
            if t.name.startswith("parallel-discovery-") or t.name == "target-aware-drain"
        ]
        assert new_threads, (
            "expected at least one leftover thread from this call to "
            "prove the join is bounded, not that nothing was started"
        )

        # Eventually — bounded by the slow provider's own sleep, run
        # entirely off the caller's critical path — every thread THIS
        # call started must be gone.
        deadline = time.monotonic() + 2.0
        while time.monotonic() < deadline and any(t.is_alive() for t in new_threads):
            time.sleep(0.02)
        still_alive = [t.name for t in new_threads if t.is_alive()]
        assert not still_alive, f"thread(s) never cleaned up: {still_alive}"


if __name__ == "__main__":
    sys.exit(pytest.main([__file__, "-v"]))
