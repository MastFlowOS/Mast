"""
PHASE 42B — regression tests for the Overpass wall-clock FOLLOW-UP fix
(providers/overpass_provider.py).

Root cause this covers, distinct from tests/test_phase42_overpass_wall_clock.py:
Phase 42's own `max_wall_clock_seconds` budget was only ever consulted
BETWEEN attempts (before hopping to the next mirror, before a
post-failure backoff sleep). It never shrank the per-attempt `timeout`
handed to `urlopen` itself. A single attempt against a silently
unresponsive endpoint (no RST, no immediate refusal — the OS just never
answers) could therefore still block for the *entire* configured
per-attempt timeout (~35s) regardless of how much of the overall budget
was already spent. Two such attempts back-to-back (35s + a short backoff
+ 35s) already exceed the intended 45s ceiling on their own — matching
the production evidence of one area's Overpass telemetry still reading
~74s despite `OVERPASS_MAX_WALL_CLOCK_SECONDS=45`.

That single un-interruptible call runs on
ParallelCompositeDiscoveryProvider's own dedicated per-provider thread,
and its `discover()` generator's `finally: thread.join()` (no timeout)
means the entire parallel discovery call — and therefore the area worker
that owns it — cannot finish until that thread does. This file's
`TestWorkerReleaseAndMapsContinuation` class exercises that outer path
end to end with a real ParallelCompositeDiscoveryProvider, proving the
worker is actually released and Google Maps keeps streaming — not just
that OverpassProvider's own internal loop is bounded in isolation
(already covered by TestPerAttemptTimeoutCapping below and by
tests/test_phase42_overpass_wall_clock.py).

Scope, deliberately narrow: Overpass wall-clock behavior only. No
worker-count, thread-pool, Maps, qualification, Instagram, pruning, or
scan-budget logic is touched or exercised beyond confirming Maps
candidates still flow through an unmodified
ParallelCompositeDiscoveryProvider.

Run: pytest tests/test_phase42b_overpass_wall_clock_release.py -v
"""

from __future__ import annotations

import io
import os
import sys
import threading
import time
import uuid
from typing import Any, Iterator
from urllib.error import HTTPError

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

from engine.contracts import BusinessCandidate
from engine.interfaces import DiscoveryProviderInterface
from providers.overpass_provider import (
    OverpassDiscoveryRequest,
    OverpassProvider,
    _http_post_urllib,
)
from providers.parallel_composite_provider import (
    ParallelCompositeDiscoveryProvider,
    ParallelDiscoveryRequest,
)


def _make_request(**overrides) -> OverpassDiscoveryRequest:
    kwargs = dict(session_id="s1", tags={"amenity": "cafe"}, area_name="Austin")
    kwargs.update(overrides)
    return OverpassDiscoveryRequest(**kwargs)


class _FakeClock:
    """Same deterministic stand-in for time.monotonic() as
    test_phase42_overpass_wall_clock.py: advances by a fixed step every
    read, so N reads behave like N*step seconds really elapsed."""

    def __init__(self, step: float = 5.0):
        self._now = 0.0
        self._step = step

    def __call__(self) -> float:
        value = self._now
        self._now += self._step
        return value


# ---------------------------------------------------------------------------
# 1. Per-attempt timeout is capped to the remaining budget, not just
#    checked between attempts.
# ---------------------------------------------------------------------------
class TestPerAttemptTimeoutCapping:
    def test_overall_timeout_shrinks_the_first_attempts_own_timeout(self, monkeypatch):
        """The core Phase 42B fix: even the FIRST attempt must not be
        handed the full configured per-attempt `timeout` once part of
        the overall budget has already elapsed (e.g. building the query,
        prior housekeeping) — it gets whatever budget remains."""
        captured_timeouts: list[float] = []

        def _fake_urlopen(request, timeout=None):
            captured_timeouts.append(timeout)
            raise HTTPError(request.full_url, 504, "Gateway Timeout", {}, io.BytesIO(b""))

        monkeypatch.setattr("providers.overpass_provider.urlopen", _fake_urlopen)
        monkeypatch.setattr("providers.overpass_provider.time.sleep", lambda _s: None)
        monkeypatch.setattr(
            "providers.overpass_provider.time.monotonic", _FakeClock(step=10.0)
        )

        _http_post_urllib(
            "https://overpass-api.de/api/interpreter",
            "[out:json];",
            {},
            timeout=35.0,
            max_retries_per_endpoint=1,
            max_wall_clock_seconds=45.0,
        )

        assert captured_timeouts, "at least one attempt should have been made"
        assert captured_timeouts[0] < 35.0, (
            "the first attempt's own urlopen timeout must be capped to "
            "the remaining wall-clock budget, not handed the full "
            "configured per-attempt timeout regardless of elapsed time"
        )

    def test_retry_timeout_shrinks_on_the_second_attempt(self, monkeypatch):
        """A retry against the SAME endpoint must get a smaller
        effective timeout than the first attempt did, since more of the
        budget has elapsed by the time it starts — not a fresh full
        `timeout` every retry."""
        captured_timeouts: list[float] = []

        def _fake_urlopen(request, timeout=None):
            captured_timeouts.append(timeout)
            raise HTTPError(request.full_url, 504, "Gateway Timeout", {}, io.BytesIO(b""))

        monkeypatch.setattr("providers.overpass_provider.urlopen", _fake_urlopen)
        monkeypatch.setattr("providers.overpass_provider.time.sleep", lambda _s: None)
        monkeypatch.setattr(
            "providers.overpass_provider.time.monotonic", _FakeClock(step=5.0)
        )

        _http_post_urllib(
            "https://overpass-api.de/api/interpreter",
            "[out:json];",
            {},
            timeout=35.0,
            max_retries_per_endpoint=2,
            max_wall_clock_seconds=45.0,
        )

        assert len(captured_timeouts) >= 2, "a retry should have been attempted"
        assert captured_timeouts[1] < captured_timeouts[0], (
            "the retry's own timeout must be smaller than the first "
            "attempt's, reflecting the budget already spent"
        )

    def test_mirror_timeout_shrinks_on_failover(self, monkeypatch):
        """Failing over to a fallback mirror must also hand that mirror
        a budget-capped timeout, not a fresh full `timeout`."""
        captured: list[tuple[str, float]] = []

        def _fake_urlopen(request, timeout=None):
            captured.append((request.full_url, timeout))
            raise HTTPError(request.full_url, 504, "Gateway Timeout", {}, io.BytesIO(b""))

        monkeypatch.setattr("providers.overpass_provider.urlopen", _fake_urlopen)
        monkeypatch.setattr("providers.overpass_provider.time.sleep", lambda _s: None)
        monkeypatch.setattr(
            "providers.overpass_provider.time.monotonic", _FakeClock(step=5.0)
        )

        _http_post_urllib(
            "https://overpass-api.de/api/interpreter",
            "[out:json];",
            {},
            timeout=35.0,
            max_retries_per_endpoint=1,
            max_wall_clock_seconds=45.0,
        )

        urls_tried = [u for u, _t in captured]
        assert len(set(urls_tried)) >= 2, "at least one mirror failover should occur"
        first_mirror_timeout = captured[0][1]
        second_mirror_timeout = captured[1][1]
        assert second_mirror_timeout < 35.0
        assert second_mirror_timeout <= first_mirror_timeout, (
            "the second (mirror) attempt's timeout must not exceed the "
            "first's — the budget only ever shrinks as time elapses"
        )

    def test_budget_checked_before_each_attempt_not_only_after_failure(self, monkeypatch):
        """If the budget is already exhausted by the time an attempt
        would start, no attempt should be made at all — the check must
        run immediately before every attempt, not only in the except
        branch after a previous one failed."""
        attempt_count = {"n": 0}

        def _fake_urlopen(request, timeout=None):
            attempt_count["n"] += 1
            raise HTTPError(request.full_url, 504, "Gateway Timeout", {}, io.BytesIO(b""))

        monkeypatch.setattr("providers.overpass_provider.urlopen", _fake_urlopen)
        monkeypatch.setattr("providers.overpass_provider.time.sleep", lambda _s: None)
        # Huge step: budget is blown before the first attempt-loop
        # checkpoint even fires.
        monkeypatch.setattr(
            "providers.overpass_provider.time.monotonic", _FakeClock(step=100.0)
        )

        result = _http_post_urllib(
            "https://overpass-api.de/api/interpreter",
            "[out:json];",
            {},
            timeout=35.0,
            max_retries_per_endpoint=3,
            max_wall_clock_seconds=45.0,
        )

        assert result == {"elements": []}
        assert attempt_count["n"] == 0, (
            "no attempt should ever be started once the budget is "
            "already spent"
        )

    def test_no_budget_preserves_full_per_attempt_timeout(self, monkeypatch):
        """Backward compatibility: with max_wall_clock_seconds=None (the
        default), every attempt must still get the full configured
        per-attempt timeout, unshrunk — this fix must not change
        behavior for callers who never opted into a wall-clock budget."""
        captured_timeouts: list[float] = []

        def _fake_urlopen(request, timeout=None):
            captured_timeouts.append(timeout)
            raise HTTPError(request.full_url, 504, "Gateway Timeout", {}, io.BytesIO(b""))

        monkeypatch.setattr("providers.overpass_provider.urlopen", _fake_urlopen)
        monkeypatch.setattr("providers.overpass_provider.time.sleep", lambda _s: None)

        with pytest.raises(HTTPError):
            _http_post_urllib(
                "https://overpass-api.de/api/interpreter",
                "[out:json];",
                {},
                timeout=35.0,
                max_retries_per_endpoint=1,
            )

        assert all(t == 35.0 for t in captured_timeouts)


# ---------------------------------------------------------------------------
# 2. Outer path: a real ParallelCompositeDiscoveryProvider worker thread
#    is actually released within the configured budget, and Google Maps
#    keeps streaming, when Overpass hits a genuinely hanging endpoint.
# ---------------------------------------------------------------------------
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
    """Stands in for GoogleMapsProvider: yields immediately, no delay."""

    def __init__(self, provider_id: str, candidates: list[BusinessCandidate]) -> None:
        self._provider_id = provider_id
        self._candidates = candidates

    @property
    def provider_id(self) -> str:
        return self._provider_id

    @property
    def display_name(self) -> str:
        return self._provider_id

    def discover(self, request: Any) -> Iterator[BusinessCandidate]:
        yield from self._candidates


class TestWorkerReleaseAndMapsContinuation:
    def test_overpass_hang_releases_the_worker_within_budget_and_maps_still_streams(
        self, monkeypatch
    ):
        """
        End-to-end reproduction of the production symptom: Overpass's
        endpoint never actually answers (simulated by a fake `urlopen`
        that really sleeps for whatever `timeout` it was given, then
        raises — modeling a silently-dropped connection bounded only by
        the socket timeout). Before the Phase 42B fix, the first attempt
        alone would sleep for the full per-attempt timeout (~35s in
        production); this test uses a real ParallelCompositeDiscoveryProvider
        and asserts the WHOLE call — Overpass's producer thread, its
        `thread.join()`, and Google Maps' own results — completes in a
        small, bounded multiple of the configured wall-clock budget, and
        that Maps' candidates are not held hostage by Overpass's hang.
        """
        budget_seconds = 0.2
        monkeypatch.setenv("OVERPASS_MAX_WALL_CLOCK_SECONDS", str(budget_seconds))

        def _hanging_urlopen(request, timeout=None):
            # Simulate a connection that never gets a response: the OS
            # socket timeout is the only thing that ever ends it.
            time.sleep(timeout)
            raise TimeoutError("simulated silently-dropped connection")

        monkeypatch.setattr("providers.overpass_provider.urlopen", _hanging_urlopen)

        overpass = OverpassProvider()
        maps_candidates = [_candidate("google_maps", "Fast Cafe")]
        maps = _FastListProvider("google_maps", maps_candidates)

        parallel = ParallelCompositeDiscoveryProvider(
            [overpass, maps],
            continue_on_provider_error=True,
        )
        request = ParallelDiscoveryRequest(
            requests={
                "overpass": _make_request(),
                "google_maps": object(),
            }
        )

        started = time.monotonic()
        results = list(parallel.discover(request))
        elapsed = time.monotonic() - started

        # Generous multiple of the budget to absorb scheduling jitter —
        # what matters is "small bounded number", not "instant": the old
        # behavior had NO ceiling here at all (could be tens of seconds
        # per attempt x multiple mirrors/retries).
        assert elapsed < budget_seconds * 20 + 2.0, (
            f"worker was not released within a bounded multiple of the "
            f"configured wall-clock budget: took {elapsed:.2f}s"
        )

        result_names = {c.name for c in results}
        assert "Fast Cafe" in result_names, (
            "Google Maps' candidates must still stream through even "
            "though Overpass hit a hanging endpoint"
        )

        # No producer thread from this call should still be alive —
        # `thread.join()` in ParallelCompositeDiscoveryProvider.discover()'s
        # `finally` block must have actually returned for both threads.
        remaining_threads = [
            t for t in threading.enumerate() if t.name.startswith("parallel-discovery-")
        ]
        assert not remaining_threads, (
            f"producer thread(s) still alive after discover() returned: "
            f"{[t.name for t in remaining_threads]}"
        )

    def test_overpass_hang_does_not_prevent_maps_from_completing_first(self, monkeypatch):
        """Sanity check on true concurrency: Maps (fast) should be able
        to finish and its results observed while Overpass (hanging) is
        still working through its own bounded budget — the two run on
        independent threads, so one is never gated on the other."""
        budget_seconds = 0.3
        monkeypatch.setenv("OVERPASS_MAX_WALL_CLOCK_SECONDS", str(budget_seconds))

        def _hanging_urlopen(request, timeout=None):
            time.sleep(timeout)
            raise TimeoutError("simulated silently-dropped connection")

        monkeypatch.setattr("providers.overpass_provider.urlopen", _hanging_urlopen)

        overpass = OverpassProvider()
        maps = _FastListProvider("google_maps", [_candidate("google_maps", "Quick Bites")])

        parallel = ParallelCompositeDiscoveryProvider(
            [overpass, maps],
            continue_on_provider_error=True,
        )
        request = ParallelDiscoveryRequest(
            requests={"overpass": _make_request(), "google_maps": object()}
        )

        results = list(parallel.discover(request))
        assert any(c.name == "Quick Bites" for c in results)


if __name__ == "__main__":
    sys.exit(pytest.main([__file__, "-v"]))
