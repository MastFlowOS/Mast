"""
PHASE 1B parity fix — focused tests for OverpassProvider's new
`should_stop` cooperative-stop wiring (providers/overpass_provider.py).

Root cause this covers: OverpassDiscoveryRequest previously had no
`should_stop` field at all, and `discover()` issued its single HTTP
call via `_http_post_urllib()`, which internally loops over multiple
mirrors x retry attempts with `time.sleep()` backoff on
429/502/503/504 — none of it checking any stop signal. Since
`ParallelCompositeDiscoveryProvider` only checks its own stop_event
between items pulled from a provider's generator, a single
un-interruptible Overpass `discover()` call full of internal retries
could keep hitting the network well after a request-level
TARGET_REACHED.

Scope, deliberately narrow — mirrors tests/test_maps_scraper_should_stop.py's
own scope note: this exercises the should_stop checkpoints added in
this phase (before the request is issued at all; before a retry sleep;
before hopping to the next mirror) via fake `urlopen`/HTTPError
transports. It does not exercise query construction, candidate
mapping, or anything else already covered by validate_overpass_provider.py.

Run: pytest tests/test_overpass_should_stop.py -v
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
)


def _make_request(should_stop=None, **overrides) -> OverpassDiscoveryRequest:
    kwargs = dict(
        session_id="s1",
        tags={"amenity": "cafe"},
        area_name="Austin",
        should_stop=should_stop,
    )
    kwargs.update(overrides)
    return OverpassDiscoveryRequest(**kwargs)


# ---------------------------------------------------------------------------
# 1. discover() itself — checked before the request is issued at all
# ---------------------------------------------------------------------------
class TestDiscoverPreCallCheckpoint:
    def test_should_stop_true_before_call_skips_the_request_entirely(self):
        calls = {"count": 0}

        def fake_http_post(url, data, headers, **_kwargs):
            calls["count"] += 1
            return {"elements": [{"type": "node", "id": 1, "tags": {"name": "X"}}]}

        provider = OverpassProvider(http_post=fake_http_post)
        request = _make_request(should_stop=lambda: True)

        results = list(provider.discover(request))

        assert results == [], "no candidates should be yielded once should_stop() is already true"
        assert calls["count"] == 0, "the HTTP transport must never be called at all"

    def test_should_stop_false_calls_through_normally(self):
        def fake_http_post(url, data, headers, **_kwargs):
            return {"elements": [{"type": "node", "id": 1, "tags": {"name": "X"}}]}

        provider = OverpassProvider(http_post=fake_http_post)
        request = _make_request(should_stop=lambda: False)

        results = list(provider.discover(request))

        assert len(results) == 1

    def test_no_should_stop_preserves_previous_behavior(self):
        """Backward compatibility: should_stop=None (the default) must behave
        exactly like before this phase."""
        def fake_http_post(url, data, headers, **_kwargs):
            return {"elements": [{"type": "node", "id": 1, "tags": {"name": "X"}}]}

        provider = OverpassProvider(http_post=fake_http_post)
        request = _make_request()  # should_stop defaults to None

        results = list(provider.discover(request))

        assert len(results) == 1

    def test_injected_http_post_predating_should_stop_still_works(self):
        """A caller's own custom http_post that doesn't accept `should_stop`
        (or `timeout`) at all must still work — same backward-compat
        fallback discover() already had for `timeout`."""
        def legacy_http_post(url, data, headers):
            return {"elements": [{"type": "node", "id": 1, "tags": {"name": "X"}}]}

        provider = OverpassProvider(http_post=legacy_http_post)
        request = _make_request(should_stop=lambda: False)

        results = list(provider.discover(request))

        assert len(results) == 1


# ---------------------------------------------------------------------------
# 2. _http_post_urllib's own retry/backoff/mirror loop
# ---------------------------------------------------------------------------
class _FakeHTTPResponse:
    def __init__(self, body: bytes):
        self._body = body

    def read(self) -> bytes:
        return self._body

    def __enter__(self):
        return self

    def __exit__(self, *_exc):
        return False


class TestHttpPostUrllibShouldStop:
    def test_should_stop_true_aborts_before_first_mirror_attempt(self, monkeypatch):
        """TARGET_REACHED (or any other stop) flipping true before
        _http_post_urllib does any work must abort immediately —
        no network call is made, no exception is raised, and the
        result is the same 'no elements' shape a genuine empty
        Overpass response would have."""
        calls = {"count": 0}

        def _fake_urlopen(request, timeout=None):
            calls["count"] += 1
            raise AssertionError("urlopen must never be called once should_stop() is true")

        monkeypatch.setattr("providers.overpass_provider.urlopen", _fake_urlopen)

        result = _http_post_urllib(
            "https://overpass-api.de/api/interpreter",
            "[out:json];",
            {},
            should_stop=lambda: True,
        )

        assert result == {"elements": []}
        assert calls["count"] == 0

    def test_should_stop_true_after_429_aborts_instead_of_sleeping(self, monkeypatch):
        """The exact TARGET_REACHED-during-429-backoff scenario from the
        bug report: a 429 comes back, should_stop() is already true by
        then, and the loop must abort rather than sleep and retry."""
        sleep_calls = {"count": 0}
        attempt_count = {"count": 0}

        def _fake_urlopen(request, timeout=None):
            attempt_count["count"] += 1
            raise HTTPError(request.full_url, 429, "Too Many Requests", {}, io.BytesIO(b""))

        def _fake_sleep(_seconds):
            sleep_calls["count"] += 1

        monkeypatch.setattr("providers.overpass_provider.urlopen", _fake_urlopen)
        monkeypatch.setattr("providers.overpass_provider.time.sleep", _fake_sleep)

        # should_stop is false for the very first attempt (matching
        # production: target_reached only flips once a lead has
        # actually been accepted) and true from then on.
        should_stop_state = {"flip_after": 1}

        def should_stop():
            return attempt_count["count"] >= should_stop_state["flip_after"]

        result = _http_post_urllib(
            "https://overpass-api.de/api/interpreter",
            "[out:json];",
            {},
            should_stop=should_stop,
        )

        assert result == {"elements": []}
        assert attempt_count["count"] == 1, "exactly one attempt should have been made before stopping"
        assert sleep_calls["count"] == 0, "no backoff sleep should occur once should_stop() is true"

    def test_should_stop_true_prevents_mirror_failover(self, monkeypatch):
        """Exhausting retries on the primary mirror must not hop to a
        fallback mirror once should_stop() is true — this is the
        exact 'fallback-mirror activity after TARGET_REACHED' symptom
        from the bug report."""
        urls_attempted: list[str] = []

        def _fake_urlopen(request, timeout=None):
            urls_attempted.append(request.full_url)
            raise HTTPError(request.full_url, 504, "Gateway Timeout", {}, io.BytesIO(b""))

        def _fake_sleep(_seconds):
            pass

        monkeypatch.setattr("providers.overpass_provider.urlopen", _fake_urlopen)
        monkeypatch.setattr("providers.overpass_provider.time.sleep", _fake_sleep)

        # Becomes true only once the primary mirror's retries are exhausted
        # (2 attempts on primary), right at the point mirror failover would
        # otherwise kick in.
        def should_stop():
            return len(urls_attempted) >= 2

        result = _http_post_urllib(
            "https://overpass-api.de/api/interpreter",
            "[out:json];",
            {},
            max_retries_per_endpoint=2,
            should_stop=should_stop,
        )

        assert result == {"elements": []}
        assert len(set(urls_attempted)) == 1, "only the primary mirror should have been attempted"

    def test_real_failure_without_should_stop_still_retries_and_fails_over_normally(self, monkeypatch):
        """Regression guard: should_stop=None (the default) must not
        change existing retry/failover behavior at all — a genuine,
        permanent failure across every mirror still raises the last
        exception exactly as before this phase."""
        def _fake_urlopen(request, timeout=None):
            raise HTTPError(request.full_url, 504, "Gateway Timeout", {}, io.BytesIO(b""))

        def _fake_sleep(_seconds):
            pass

        monkeypatch.setattr("providers.overpass_provider.urlopen", _fake_urlopen)
        monkeypatch.setattr("providers.overpass_provider.time.sleep", _fake_sleep)

        with pytest.raises(HTTPError):
            _http_post_urllib(
                "https://overpass-api.de/api/interpreter",
                "[out:json];",
                {},
                max_retries_per_endpoint=1,
            )

    def test_real_failure_with_should_stop_false_still_retries_and_fails_over_normally(self, monkeypatch):
        """should_stop present but always false must behave identically
        to should_stop=None — a permanent failure still propagates."""
        def _fake_urlopen(request, timeout=None):
            raise HTTPError(request.full_url, 504, "Gateway Timeout", {}, io.BytesIO(b""))

        def _fake_sleep(_seconds):
            pass

        monkeypatch.setattr("providers.overpass_provider.urlopen", _fake_urlopen)
        monkeypatch.setattr("providers.overpass_provider.time.sleep", _fake_sleep)

        with pytest.raises(HTTPError):
            _http_post_urllib(
                "https://overpass-api.de/api/interpreter",
                "[out:json];",
                {},
                max_retries_per_endpoint=1,
                should_stop=lambda: False,
            )

    def test_success_on_first_attempt_with_should_stop_false_returns_normally(self, monkeypatch):
        """A clean, immediate success with should_stop present but false
        must return normally — the checkpoint must never interfere with
        the happy path."""
        def _fake_urlopen(request, timeout=None):
            return _FakeHTTPResponse(b'{"elements": [{"type": "node", "id": 1}]}')

        monkeypatch.setattr("providers.overpass_provider.urlopen", _fake_urlopen)

        result = _http_post_urllib(
            "https://overpass-api.de/api/interpreter",
            "[out:json];",
            {},
            should_stop=lambda: False,
        )

        assert result == {"elements": [{"type": "node", "id": 1}]}
