"""
tests/test_overpass_retry_deadline.py
=========================================

CRITMODE — retry/fallback deadline interaction fix.

Focused regression coverage for `street_inventory/overpass_source.py`'s
`_post_with_retry_and_fallback()` deadline-awareness — the fix that stops
the worker thread from continuing retry/backoff/fallback activity after
the caller's hard wall-clock deadline has already fired.

Scope, deliberately narrow (mirrors this repo's other CRITMODE test
files): this does NOT re-test geography resolution, boundary verification,
parsing, or the existing 429-retry behavior without a deadline (already
covered by tests/test_overpass_429_retry_fallback.py and
tests/test_street_inventory_geography.py). It tests ONLY the interaction
between the `deadline` parameter and the retry loop's budget checks.

Every test here uses a controllable fake clock (monkeypatched
`time.monotonic`) and patches `time.sleep` to a recording no-op — same
pattern tests/test_overpass_429_retry_fallback.py already uses — so no
real wall-clock time is consumed.

Run: pytest tests/test_overpass_retry_deadline.py -v
"""

from __future__ import annotations

import time as _time_module
import urllib.error

import pytest

from providers.overpass_provider import _DEFAULT_MIRRORS
from street_inventory.overpass_source import (
    DEFAULT_ENDPOINT_URL,
    _MAX_RETRIES_PER_ENDPOINT,
    _post_with_retry_and_fallback,
)


def _http_error(url: str, code: int, retry_after: str | None = None) -> urllib.error.HTTPError:
    hdrs = None
    if retry_after is not None:
        import email.message

        hdrs = email.message.Message()
        hdrs["Retry-After"] = retry_after
    return urllib.error.HTTPError(url, code, f"HTTP {code}", hdrs=hdrs, fp=None)  # type: ignore[arg-type]


_STREET_OK_PAYLOAD = {
    "elements": [
        {"type": "way", "id": 1, "tags": {"highway": "residential", "name": "Main St"}},
    ]
}


class _FakeClock:
    """Deterministic stand-in for time.monotonic() — starts at `start`,
    advances by `step` every time it is called. Lets tests control
    exactly how much 'time' elapses per retry-loop iteration without
    any real sleeping."""

    def __init__(self, start: float = 0.0, step: float = 1.0):
        self._now = start
        self._step = step

    def __call__(self) -> float:
        value = self._now
        self._now += self._step
        return value


# ---------------------------------------------------------------------------
# A. Deadline expires during endpoint A → endpoint B is never started.
# ---------------------------------------------------------------------------
class TestDeadlinePreventsEndpointB:
    def test_deadline_during_endpoint_A_prevents_endpoint_B(self, monkeypatch):
        """When the deadline expires during endpoint A's attempts, the
        retry loop must NOT start any attempt against endpoint B (or any
        further mirror). This is the exact production scenario: the
        caller returned 'deadline exceeded' at 04:08:47 but endpoint B
        (kumi.systems) logged at 04:08:49."""
        monkeypatch.setattr("street_inventory.overpass_source.time.sleep", lambda _s: None)
        # Each monotonic() call advances 30s. With a deadline at 50s
        # (start=0, so deadline=50), after two monotonic reads (budget
        # check + timeout cap = 60s elapsed) the first attempt's poster
        # call happens, then the next budget check at 90s is past the
        # 50s deadline.
        fake_clock = _FakeClock(start=0.0, step=30.0)
        monkeypatch.setattr("street_inventory.overpass_source.time.monotonic", fake_clock)

        urls_hit: list[str] = []

        def poster(url, query, headers, timeout):
            urls_hit.append(url)
            raise _http_error(url, 429)

        deadline = 50.0  # absolute monotonic timestamp

        with pytest.raises(TimeoutError):
            _post_with_retry_and_fallback(
                poster, DEFAULT_ENDPOINT_URL, "query", {}, 60.0,
                deadline=deadline,
            )

        # Only the primary endpoint should have been attempted — never
        # endpoint B (any mirror).
        assert all(u == DEFAULT_ENDPOINT_URL for u in urls_hit), (
            f"expected only primary endpoint, got: {urls_hit}"
        )
        mirror_urls = [u for u in urls_hit if u != DEFAULT_ENDPOINT_URL]
        assert mirror_urls == [], (
            f"mirror endpoints were attempted after deadline: {mirror_urls}"
        )


# ---------------------------------------------------------------------------
# B. Remaining budget is passed into the HTTP attempt.
# ---------------------------------------------------------------------------
class TestRemainingBudgetPassedAsTimeout:
    def test_remaining_budget_caps_per_attempt_timeout(self, monkeypatch):
        """When less than `timeout_seconds` remains in the deadline, the
        poster must receive `remaining` (not the full timeout_seconds)
        as its timeout argument — so a late attempt cannot outlive the
        overall budget."""
        monkeypatch.setattr("street_inventory.overpass_source.time.sleep", lambda _s: None)

        # Clock: start=0, step=5. deadline=20.
        # Outer check4 reads 0 (remaining=20, ok).
        # Attempt 0: check1 reads 5 (remaining=15, ok).
        #            check2 reads 10 (remaining=10).
        #            effective_timeout = min(60, max(10, 0.1)) = 10.
        fake_clock = _FakeClock(start=0.0, step=5.0)
        monkeypatch.setattr("street_inventory.overpass_source.time.monotonic", fake_clock)

        captured_timeouts: list[float] = []

        def poster(url, query, headers, timeout):
            captured_timeouts.append(timeout)
            return _STREET_OK_PAYLOAD

        deadline = 20.0
        result = _post_with_retry_and_fallback(
            poster, DEFAULT_ENDPOINT_URL, "query", {}, 60.0,
            deadline=deadline,
        )

        assert result == _STREET_OK_PAYLOAD
        # The poster received 10s (remaining budget), not 60s (full timeout).
        assert len(captured_timeouts) == 1
        assert captured_timeouts[0] < 60.0
        assert captured_timeouts[0] == pytest.approx(10.0, abs=0.5)


# ---------------------------------------------------------------------------
# C. Retry-After/backoff is capped by remaining deadline.
# ---------------------------------------------------------------------------
class TestBackoffCappedByDeadline:
    def test_retry_after_delay_capped_at_remaining_budget(self, monkeypatch):
        """When Overpass sends Retry-After: 30 but only 5 seconds of
        budget remain, the actual sleep must be capped at 5s — not 30s."""
        sleeps: list[float] = []
        monkeypatch.setattr(
            "street_inventory.overpass_source.time.sleep", lambda s: sleeps.append(s)
        )

        # Clock: start=0, step=2. deadline=12.
        # Outer endpoint loop: check4 reads 0 (remaining=12, ok)
        # Attempt 0: check1 reads 2 (remaining=10, ok)
        #            check2 reads 4 (remaining=8, effective_timeout=min(60,8)=8)
        #            poster raises 429
        #            check3 (backoff cap) reads 6 (remaining=6)
        #            delay = min(30, 6) = 6  ← capped
        #            sleep(6)
        # Attempt 1: check1 reads 8 (remaining=4, ok)
        #            check2 reads 10 (remaining=2, effective_timeout=min(60,2)=2)
        #            poster returns OK
        fake_clock = _FakeClock(start=0.0, step=2.0)
        monkeypatch.setattr("street_inventory.overpass_source.time.monotonic", fake_clock)

        call_count = {"n": 0}

        def poster(url, query, headers, timeout):
            call_count["n"] += 1
            if call_count["n"] == 1:
                raise _http_error(url, 429, retry_after="30")
            return _STREET_OK_PAYLOAD

        deadline = 12.0
        result = _post_with_retry_and_fallback(
            poster, DEFAULT_ENDPOINT_URL, "query", {}, 60.0,
            deadline=deadline,
        )

        assert result == _STREET_OK_PAYLOAD
        # The Retry-After was 30s but budget only allowed 6s.
        assert len(sleeps) == 1
        assert sleeps[0] <= 6.0


# ---------------------------------------------------------------------------
# D. No retry occurs after deadline.
# ---------------------------------------------------------------------------
class TestNoRetryAfterDeadline:
    def test_no_retry_attempt_after_deadline_expired(self, monkeypatch):
        """Once the deadline has passed, no further poster() calls are
        made — even if _MAX_RETRIES_PER_ENDPOINT has not been reached."""
        monkeypatch.setattr("street_inventory.overpass_source.time.sleep", lambda _s: None)

        # Clock: start=0, step=20. deadline=25.
        # Outer check4: reads 0 (remaining=25, ok)
        # Attempt 0: check1 reads 20 (remaining=5, ok)
        #            check2 reads 40 (remaining=-15, effective_timeout=max(-15,0.1)=0.1,
        #                              but wait — remaining is negative, so
        #                              effective_timeout = min(60, 0.1) = 0.1)
        #            poster raises 429
        #            check3: reads 60 (remaining=-35), break
        # Actually let me recalculate with a better step.
        #
        # step=15, deadline=20.
        # Outer check4: reads 0 (remaining=20, ok)
        # Attempt 0: check1 reads 15 (remaining=5, ok)
        #            check2 reads 30 (remaining=-10) → effective_timeout=0.1
        #            poster raises 429
        #            check3: reads 45 (remaining=-25) → break (no retry)
        # Inner break → outer break → TimeoutError
        fake_clock = _FakeClock(start=0.0, step=15.0)
        monkeypatch.setattr("street_inventory.overpass_source.time.monotonic", fake_clock)

        call_count = {"n": 0}

        def poster(url, query, headers, timeout):
            call_count["n"] += 1
            raise _http_error(url, 429)

        deadline = 20.0

        with pytest.raises(TimeoutError):
            _post_with_retry_and_fallback(
                poster, DEFAULT_ENDPOINT_URL, "query", {}, 60.0,
                deadline=deadline,
            )

        # Exactly one attempt — the retry was prevented by the deadline.
        assert call_count["n"] == 1


# ---------------------------------------------------------------------------
# E. Existing 429 → fallback success still works when enough budget exists.
# ---------------------------------------------------------------------------
class TestFallbackSuccessWithinBudget:
    def test_429_then_mirror_fallback_succeeds_with_sufficient_budget(self, monkeypatch):
        """The existing behavior must be preserved: when the primary
        endpoint returns 429 on every attempt but a mirror succeeds,
        the result is successful — as long as the deadline has not
        expired."""
        monkeypatch.setattr("street_inventory.overpass_source.time.sleep", lambda _s: None)
        # step=1s, deadline=9999 — plenty of budget, never expires.
        fake_clock = _FakeClock(start=0.0, step=1.0)
        monkeypatch.setattr("street_inventory.overpass_source.time.monotonic", fake_clock)

        urls_hit: list[str] = []

        def poster(url, query, headers, timeout):
            urls_hit.append(url)
            if url == DEFAULT_ENDPOINT_URL:
                raise _http_error(url, 429)
            return _STREET_OK_PAYLOAD

        deadline = 9999.0
        result = _post_with_retry_and_fallback(
            poster, DEFAULT_ENDPOINT_URL, "query", {}, 60.0,
            deadline=deadline,
        )

        assert result == _STREET_OK_PAYLOAD
        # Primary endpoint was tried _MAX_RETRIES_PER_ENDPOINT times,
        # then the mirror succeeded.
        assert urls_hit.count(DEFAULT_ENDPOINT_URL) == _MAX_RETRIES_PER_ENDPOINT
        assert urls_hit[-1] != DEFAULT_ENDPOINT_URL
        assert urls_hit[-1] in _DEFAULT_MIRRORS


# ---------------------------------------------------------------------------
# F. Existing all-endpoints-failed behavior remains intact.
# ---------------------------------------------------------------------------
class TestAllEndpointsFailedWithinBudget:
    def test_all_endpoints_429_with_budget_raises_last_exception(self, monkeypatch):
        """When all endpoints fail but the deadline has NOT expired, the
        behavior is identical to the no-deadline case: the last
        exception is re-raised (not a TimeoutError)."""
        monkeypatch.setattr("street_inventory.overpass_source.time.sleep", lambda _s: None)
        # step=0.001, deadline=9999 — effectively infinite budget.
        fake_clock = _FakeClock(start=0.0, step=0.001)
        monkeypatch.setattr("street_inventory.overpass_source.time.monotonic", fake_clock)

        urls_hit: list[str] = []

        def poster(url, query, headers, timeout):
            urls_hit.append(url)
            raise _http_error(url, 429)

        deadline = 9999.0

        with pytest.raises(urllib.error.HTTPError) as exc_info:
            _post_with_retry_and_fallback(
                poster, DEFAULT_ENDPOINT_URL, "query", {}, 60.0,
                deadline=deadline,
            )

        assert exc_info.value.code == 429

        candidate_count = len({DEFAULT_ENDPOINT_URL, *_DEFAULT_MIRRORS})
        # Same bounded total as without a deadline — every endpoint
        # attempted exactly _MAX_RETRIES_PER_ENDPOINT times.
        assert len(urls_hit) == candidate_count * _MAX_RETRIES_PER_ENDPOINT
"""
tests/test_overpass_retry_deadline.py
"""
