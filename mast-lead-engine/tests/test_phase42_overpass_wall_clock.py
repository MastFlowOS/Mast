"""
PHASE 42 FIX #2 — regression tests for OverpassProvider's new wall-clock
ceiling (providers/overpass_provider.py).

Root cause this covers: `_http_post_urllib`'s per-attempt `timeout` and
per-endpoint `max_retries_per_endpoint` were each individually bounded,
but nothing bounded their PRODUCT. With 4 candidate URLs (the primary
endpoint + 3 `_DEFAULT_MIRRORS` fallbacks) x 2 attempts each x up to
~35s per attempt, a fully-unresponsive Overpass episode could take up
to ~280s end to end — matching the production evidence of 60-150+
second Overpass calls, and unbounded above that range in a worse
episode. That single un-interruptible call runs on
ParallelCompositeDiscoveryProvider's own dedicated per-provider thread,
whose `discover()` generator only finishes once every producer thread
has (`finally: thread.join()`, no timeout) — so the whole area worker
was held hostage for as long as Overpass's own retry/mirror loop
happened to take.

Scope, deliberately narrow — mirrors tests/test_overpass_should_stop.py's
own scope note: this exercises the new `max_wall_clock_seconds`
checkpoint (folded into the same `_stop_requested()` helper
`should_stop` already used) via fake `urlopen`/HTTPError transports and
a controllable fake clock. It does not exercise query construction,
candidate mapping, or should_stop itself (already covered by
test_overpass_should_stop.py).

Run: pytest tests/test_phase42_overpass_wall_clock.py -v
"""

from __future__ import annotations

import io
import os
import sys
from urllib.error import HTTPError

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

from providers.overpass_provider import (
    OverpassDiscoveryRequest,
    OverpassProvider,
    _http_post_urllib,
    _overpass_max_wall_clock_seconds,
    _DEFAULT_MAX_WALL_CLOCK_SECONDS,
    _DEFAULT_MIRRORS,
)


def _make_request(**overrides) -> OverpassDiscoveryRequest:
    kwargs = dict(session_id="s1", tags={"amenity": "cafe"}, area_name="Austin")
    kwargs.update(overrides)
    return OverpassDiscoveryRequest(**kwargs)


class _FakeClock:
    """Deterministic stand-in for time.monotonic(): advances by a fixed
    step every time it's read, so a retry loop that calls it N times
    behaves exactly like N seconds (or whatever step) really elapsed —
    no real sleeping required for the test to be deterministic."""

    def __init__(self, step: float = 5.0):
        self._now = 0.0
        self._step = step

    def __call__(self) -> float:
        value = self._now
        self._now += self._step
        return value


# ---------------------------------------------------------------------------
# 1. _http_post_urllib's new max_wall_clock_seconds checkpoint
# ---------------------------------------------------------------------------
class TestWallClockCeiling:
    def test_budget_exhausted_aborts_before_next_mirror_instead_of_hopping(self, monkeypatch):
        """The exact production scenario: primary endpoint's retries are
        exhausted and the loop is about to fail over to a fallback
        mirror, but the wall-clock budget is already spent — failover
        must be skipped, not paid for."""
        urls_attempted: list[str] = []

        def _fake_urlopen(request, timeout=None):
            urls_attempted.append(request.full_url)
            raise HTTPError(request.full_url, 504, "Gateway Timeout", {}, io.BytesIO(b""))

        monkeypatch.setattr("providers.overpass_provider.urlopen", _fake_urlopen)
        monkeypatch.setattr("providers.overpass_provider.time.sleep", lambda _s: None)
        monkeypatch.setattr(
            "providers.overpass_provider.time.monotonic", _FakeClock(step=30.0)
        )

        result = _http_post_urllib(
            "https://overpass-api.de/api/interpreter",
            "[out:json];",
            {},
            max_retries_per_endpoint=2,
            max_wall_clock_seconds=45.0,
        )

        assert result == {"elements": []}
        assert len(set(urls_attempted)) == 1, (
            "the budget should already be exhausted by the time failover "
            "to a second mirror would happen — only the primary endpoint "
            "should have been attempted"
        )

    def test_budget_exhausted_aborts_before_a_retry_sleep(self, monkeypatch):
        attempt_count = {"count": 0}
        sleep_calls = {"count": 0}

        def _fake_urlopen(request, timeout=None):
            attempt_count["count"] += 1
            raise HTTPError(request.full_url, 429, "Too Many Requests", {}, io.BytesIO(b""))

        def _fake_sleep(_seconds):
            sleep_calls["count"] += 1

        monkeypatch.setattr("providers.overpass_provider.urlopen", _fake_urlopen)
        monkeypatch.setattr("providers.overpass_provider.time.sleep", _fake_sleep)
        monkeypatch.setattr(
            "providers.overpass_provider.time.monotonic", _FakeClock(step=25.0)
        )

        result = _http_post_urllib(
            "https://overpass-api.de/api/interpreter",
            "[out:json];",
            {},
            max_retries_per_endpoint=3,
            max_wall_clock_seconds=45.0,
        )

        assert result == {"elements": []}
        assert attempt_count["count"] == 1, "exactly one attempt before the budget trips"
        assert sleep_calls["count"] == 0, "no backoff sleep should occur once the budget is spent"

    def test_no_budget_preserves_previous_unbounded_behavior(self, monkeypatch):
        """Backward compatibility: max_wall_clock_seconds=None (the
        default) must not change existing retry/failover behavior at
        all — every configured retry across every mirror still runs."""
        urls_attempted: list[str] = []

        def _fake_urlopen(request, timeout=None):
            urls_attempted.append(request.full_url)
            raise HTTPError(request.full_url, 504, "Gateway Timeout", {}, io.BytesIO(b""))

        monkeypatch.setattr("providers.overpass_provider.urlopen", _fake_urlopen)
        monkeypatch.setattr("providers.overpass_provider.time.sleep", lambda _s: None)

        with pytest.raises(HTTPError):
            _http_post_urllib(
                "https://overpass-api.de/api/interpreter",
                "[out:json];",
                {},
                max_retries_per_endpoint=1,
            )

        # Primary endpoint == _DEFAULT_MIRRORS[0], so candidate_urls dedups
        # to exactly len(_DEFAULT_MIRRORS) unique endpoints; one attempt
        # each (max_retries_per_endpoint=1) with no budget to cut it short.
        assert len(urls_attempted) == len(_DEFAULT_MIRRORS)

    def test_within_budget_succeeds_normally(self, monkeypatch):
        """A budget that comfortably covers a normal, fast response must
        not interfere with a successful call at all."""
        class _FakeResponse:
            def __enter__(self):
                return self

            def __exit__(self, *_exc):
                return False

            def read(self):
                return b'{"elements": [{"type": "node", "id": 1, "tags": {"name": "X"}}]}'

        def _fake_urlopen(request, timeout=None):
            return _FakeResponse()

        monkeypatch.setattr("providers.overpass_provider.urlopen", _fake_urlopen)

        result = _http_post_urllib(
            "https://overpass-api.de/api/interpreter",
            "[out:json];",
            {},
            max_wall_clock_seconds=45.0,
        )

        assert result["elements"][0]["id"] == 1


# ---------------------------------------------------------------------------
# 2. OverpassProvider.discover() actually wires a bounded budget through
# ---------------------------------------------------------------------------
class TestDiscoverWiresWallClockBudget:
    def test_discover_passes_a_positive_max_wall_clock_seconds(self):
        captured = {}

        def fake_http_post(url, data, headers, **kwargs):
            captured.update(kwargs)
            return {"elements": []}

        provider = OverpassProvider(http_post=fake_http_post)
        list(provider.discover(_make_request()))

        assert captured.get("max_wall_clock_seconds") is not None
        assert captured["max_wall_clock_seconds"] > 0

    def test_discover_still_works_against_a_legacy_http_post_without_the_new_kwarg(self):
        """A caller-injected http_post that predates this phase (accepts
        only url/data/headers) must still work — same backward-compat
        fallback discover() already had for should_stop/timeout/on_attempt."""

        def legacy_http_post(url, data, headers):
            return {"elements": [{"type": "node", "id": 1, "tags": {"name": "X"}}]}

        provider = OverpassProvider(http_post=legacy_http_post)
        results = list(provider.discover(_make_request()))

        assert len(results) == 1

    def test_env_override_is_respected(self, monkeypatch):
        monkeypatch.setenv("OVERPASS_MAX_WALL_CLOCK_SECONDS", "12.5")
        assert _overpass_max_wall_clock_seconds() == 12.5

    def test_env_override_invalid_falls_back_to_default(self, monkeypatch):
        monkeypatch.setenv("OVERPASS_MAX_WALL_CLOCK_SECONDS", "not-a-number")
        assert _overpass_max_wall_clock_seconds() == _DEFAULT_MAX_WALL_CLOCK_SECONDS

    def test_no_env_override_uses_default(self, monkeypatch):
        monkeypatch.delenv("OVERPASS_MAX_WALL_CLOCK_SECONDS", raising=False)
        assert _overpass_max_wall_clock_seconds() == _DEFAULT_MAX_WALL_CLOCK_SECONDS

    def test_default_budget_is_far_below_the_old_worst_case(self):
        """Sanity check on the fix's actual production impact: the old
        worst case was (1 primary + 3 mirrors) x 2 retries x ~35s per
        attempt = ~280s. The new default budget must be a small
        fraction of that."""
        old_worst_case_seconds = 4 * 2 * 35.0
        assert _DEFAULT_MAX_WALL_CLOCK_SECONDS < old_worst_case_seconds / 3
