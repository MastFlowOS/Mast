"""
tests/test_overpass_429_retry_fallback.py
============================================

CRITMODE — Overpass 429 handling.

Focused regression coverage for `street_inventory/overpass_source.py`'s
`_post_with_retry_and_fallback()` — the fix that stops a single
transient 429 (or 502/503/504, or a network error) from one Overpass
endpoint from immediately sending an otherwise-valid, boundary-
verified city to `status="unavailable"`.

Scope, deliberately narrow (mirrors this repo's other CRITMODE test
files' own "scope" notes): this does NOT re-test geography resolution
or boundary verification themselves (already covered by
tests/test_street_inventory_geography.py) — every fixture here uses a
boundary/street response shape those tests already prove is handled
correctly, and changes only how many times, and against how many
endpoints, a failing response is retried before that existing logic
ever sees a result. It also does not re-test the *existing*
"unavailable" conversion for a non-retryable failure (already covered
by tests/test_street_inventory.py::TestUnavailableFallback) except
where needed to prove that path is unchanged.

Every test here patches `street_inventory.overpass_source.time.sleep`
to a no-op — same pattern tests/test_overpass_should_stop.py and
tests/test_phase42_overpass_wall_clock.py already use for
providers/overpass_provider.py's own retry loop — so bounded retry
effort costs no real wall-clock time in the test suite.

Run: pytest tests/test_overpass_429_retry_fallback.py -v
"""

from __future__ import annotations

import urllib.error

import pytest

from providers.overpass_provider import _DEFAULT_MIRRORS
from street_inventory.overpass_source import (
    DEFAULT_ENDPOINT_URL,
    _MAX_RETRIES_PER_ENDPOINT,
    _post_with_retry_and_fallback,
    fetch_city_street_inventory,
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


# ---------------------------------------------------------------------------
# 1. 429 on the primary endpoint retries the SAME endpoint and recovers
#    without ever needing to fail over.
# ---------------------------------------------------------------------------
class TestSameEndpointRetry:
    def test_429_then_success_on_same_endpoint_does_not_fall_over(self, monkeypatch):
        monkeypatch.setattr("street_inventory.overpass_source.time.sleep", lambda _s: None)
        urls_hit: list[str] = []

        def poster(url, query, headers, timeout):
            urls_hit.append(url)
            if len(urls_hit) == 1:
                raise _http_error(url, 429)
            return _STREET_OK_PAYLOAD

        result = _post_with_retry_and_fallback(
            poster, DEFAULT_ENDPOINT_URL, "query", {}, 30.0
        )
        assert result == _STREET_OK_PAYLOAD
        # Both attempts were against the SAME (primary) endpoint — a
        # transient 429 must not trigger a mirror hop when a retry on
        # the original endpoint would have (and did) succeed.
        assert urls_hit == [DEFAULT_ENDPOINT_URL, DEFAULT_ENDPOINT_URL]

    def test_end_to_end_city_fetch_succeeds_after_one_429(self, monkeypatch):
        # Same scenario, but through the real fetch_city_street_inventory
        # entry point — proves the wrapper is actually wired in, not
        # just correct in isolation.
        monkeypatch.setattr("street_inventory.overpass_source.time.sleep", lambda _s: None)
        calls = {"n": 0}

        def transport(url, query, headers, timeout):
            calls["n"] += 1
            if calls["n"] == 1:
                raise _http_error(url, 429)
            return _STREET_OK_PAYLOAD

        result = fetch_city_street_inventory(
            country_code="US", city="Queens", area_name="Queens", http_post=transport
        )
        assert result.status == "ok"
        assert len(result.streets) == 1

    def test_retry_after_header_is_honored_as_the_backoff_delay(self, monkeypatch):
        sleeps: list[float] = []
        monkeypatch.setattr(
            "street_inventory.overpass_source.time.sleep", lambda s: sleeps.append(s)
        )

        def poster(url, query, headers, timeout):
            if poster.calls == 0:
                poster.calls += 1
                raise _http_error(url, 429, retry_after="7")
            return _STREET_OK_PAYLOAD

        poster.calls = 0

        result = _post_with_retry_and_fallback(
            poster, DEFAULT_ENDPOINT_URL, "query", {}, 30.0
        )
        assert result == _STREET_OK_PAYLOAD
        # Overpass told us exactly how long to wait — that must be
        # honored verbatim rather than overridden by the generic
        # exponential-backoff guess.
        assert sleeps == [7.0]


# ---------------------------------------------------------------------------
# 2. Primary endpoint's retries are exhausted -> falls over to the next
#    configured mirror (reusing providers/overpass_provider.py's own
#    already-vetted mirror list, not a new hardcoded one).
# ---------------------------------------------------------------------------
class TestMirrorFallover:
    def test_exhausting_primary_endpoint_falls_over_to_next_mirror(self, monkeypatch):
        monkeypatch.setattr("street_inventory.overpass_source.time.sleep", lambda _s: None)
        urls_hit: list[str] = []

        def poster(url, query, headers, timeout):
            urls_hit.append(url)
            if url == DEFAULT_ENDPOINT_URL:
                raise _http_error(url, 429)
            return _STREET_OK_PAYLOAD

        result = _post_with_retry_and_fallback(
            poster, DEFAULT_ENDPOINT_URL, "query", {}, 30.0
        )
        assert result == _STREET_OK_PAYLOAD
        # Exactly _MAX_RETRIES_PER_ENDPOINT attempts against the primary
        # endpoint (all 429), then exactly one successful attempt
        # against the next candidate — never every mirror, since the
        # second one already succeeded.
        assert urls_hit.count(DEFAULT_ENDPOINT_URL) == _MAX_RETRIES_PER_ENDPOINT
        assert urls_hit[-1] != DEFAULT_ENDPOINT_URL
        assert urls_hit[-1] in _DEFAULT_MIRRORS

    def test_fallover_endpoint_is_drawn_from_the_existing_configured_mirror_list(self):
        # This is the "if the repository already supports/configures
        # endpoints" check: the fallover list is NOT a new, separately
        # maintained list — it IS providers/overpass_provider.py's own
        # _DEFAULT_MIRRORS, imported as data. Two independently
        # hand-maintained lists could silently drift; a shared one
        # cannot.
        from street_inventory.overpass_source import _DEFAULT_MIRRORS as imported_mirrors

        assert imported_mirrors is _DEFAULT_MIRRORS
        assert DEFAULT_ENDPOINT_URL in imported_mirrors

    def test_end_to_end_city_fetch_succeeds_via_mirror_fallover(self, monkeypatch):
        monkeypatch.setattr("street_inventory.overpass_source.time.sleep", lambda _s: None)

        def transport(url, query, headers, timeout):
            if url == DEFAULT_ENDPOINT_URL:
                raise _http_error(url, 429)
            return _STREET_OK_PAYLOAD

        result = fetch_city_street_inventory(
            country_code="US", city="Queens", area_name="Queens", http_post=transport
        )
        assert result.status == "ok"
        assert len(result.streets) == 1


# ---------------------------------------------------------------------------
# 3. Every candidate endpoint exhausted -> "unavailable", with a BOUNDED
#    (never infinite) total number of attempts.
# ---------------------------------------------------------------------------
class TestAllEndpointsFailed:
    def test_all_endpoints_429_yields_unavailable_with_bounded_attempts(self, monkeypatch):
        monkeypatch.setattr("street_inventory.overpass_source.time.sleep", lambda _s: None)
        urls_hit: list[str] = []

        def poster(url, query, headers, timeout):
            urls_hit.append(url)
            raise _http_error(url, 429)

        with pytest.raises(urllib.error.HTTPError) as exc_info:
            _post_with_retry_and_fallback(poster, DEFAULT_ENDPOINT_URL, "query", {}, 30.0)
        assert exc_info.value.code == 429

        candidate_count = len({DEFAULT_ENDPOINT_URL, *_DEFAULT_MIRRORS})
        # Bounded: never more than every candidate endpoint x the
        # per-endpoint retry cap — never unbounded/infinite retry.
        assert len(urls_hit) == candidate_count * _MAX_RETRIES_PER_ENDPOINT

    def test_all_endpoints_429_end_to_end_is_unavailable_not_an_exception(self, monkeypatch):
        # The behavior this phase's instructions require to be
        # preserved: even when every attempt against every endpoint
        # genuinely fails, the caller still gets a clean
        # status="unavailable" result, never a raised exception, and
        # zero streets — the exact pre-existing shape.
        monkeypatch.setattr("street_inventory.overpass_source.time.sleep", lambda _s: None)

        def transport(url, query, headers, timeout):
            raise _http_error(url, 429)

        result = fetch_city_street_inventory(
            country_code="US", city="Queens", area_name="Queens", http_post=transport
        )
        assert result.status == "unavailable"
        assert result.reason
        assert result.streets == ()

    def test_all_endpoints_network_error_is_also_unavailable(self, monkeypatch):
        # Non-HTTP transient failures (DNS, connection reset, etc.)
        # follow the identical bounded retry-then-fallover-then-give-up
        # shape as 429 — not a special case.
        monkeypatch.setattr("street_inventory.overpass_source.time.sleep", lambda _s: None)
        urls_hit: list[str] = []

        def poster(url, query, headers, timeout):
            urls_hit.append(url)
            raise urllib.error.URLError("simulated DNS failure")

        with pytest.raises(urllib.error.URLError):
            _post_with_retry_and_fallback(poster, DEFAULT_ENDPOINT_URL, "query", {}, 30.0)

        candidate_count = len({DEFAULT_ENDPOINT_URL, *_DEFAULT_MIRRORS})
        assert len(urls_hit) == candidate_count * _MAX_RETRIES_PER_ENDPOINT


# ---------------------------------------------------------------------------
# 4. A non-retryable HTTP error (not 429/502/503/504) is raised
#    immediately — no wasted retry or mirror hop for a failure no
#    retry could ever fix (e.g. a malformed query).
# ---------------------------------------------------------------------------
class TestNonRetryableErrorsAreNotRetried:
    def test_404_is_raised_immediately_with_no_retry_or_fallover(self, monkeypatch):
        monkeypatch.setattr("street_inventory.overpass_source.time.sleep", lambda _s: None)
        urls_hit: list[str] = []

        def poster(url, query, headers, timeout):
            urls_hit.append(url)
            raise _http_error(url, 404)

        with pytest.raises(urllib.error.HTTPError) as exc_info:
            _post_with_retry_and_fallback(poster, DEFAULT_ENDPOINT_URL, "query", {}, 30.0)
        assert exc_info.value.code == 404
        # Exactly ONE attempt, against the primary endpoint only.
        assert urls_hit == [DEFAULT_ENDPOINT_URL]

    def test_end_to_end_404_is_unavailable_after_a_single_attempt(self, monkeypatch):
        monkeypatch.setattr("street_inventory.overpass_source.time.sleep", lambda _s: None)
        calls = {"n": 0}

        def transport(url, query, headers, timeout):
            calls["n"] += 1
            raise _http_error(url, 404)

        result = fetch_city_street_inventory(
            country_code="US", city="Queens", area_name="Queens", http_post=transport
        )
        assert result.status == "unavailable"
        assert calls["n"] == 1


# ---------------------------------------------------------------------------
# 5. The boundary-VERIFICATION query (STAGE 1b/4, runs before the real
#    street query for an auto-resolved-from-city area) is ALSO covered
#    by retry/fallover — not just the street query the incident report
#    named — since it hits the same rate-limited endpoint, usually
#    first. Geography resolution/verification logic itself is untouched
#    (per this phase's own instruction); only transport resilience
#    changed.
# ---------------------------------------------------------------------------
class TestBoundaryVerificationAlsoRetries:
    def test_429_during_boundary_verification_retries_then_succeeds(self, monkeypatch):
        monkeypatch.setattr("street_inventory.overpass_source.time.sleep", lambda _s: None)
        calls = {"boundary": 0, "main": 0}

        def transport(url, query, headers, timeout):
            is_boundary_check = ".a out tags;" in query
            if is_boundary_check:
                calls["boundary"] += 1
                if calls["boundary"] == 1:
                    raise _http_error(url, 429)
                # CRITMODE — way-derived area ID fix, single-match gap:
                # realistic relation-derived area id (>= 3600000000), not
                # a small arbitrary integer — see overpass_source.py.
                return {"elements": [{"type": "area", "id": 3_600_000_001, "tags": {"admin_level": "8"}}]}
            calls["main"] += 1
            return _STREET_OK_PAYLOAD

        # No area_name -> auto-resolved from city -> boundary
        # verification (STAGE 1b/4) runs before the street query.
        result = fetch_city_street_inventory(country_code="US", city="Somewhereville", http_post=transport)
        assert result.status == "ok"
        assert len(result.streets) == 1
        # One 429 + one successful retry on the boundary check; exactly
        # one successful main-query attempt.
        assert calls["boundary"] == 2
        assert calls["main"] == 1

    def test_boundary_verification_failing_on_every_endpoint_is_unavailable(self, monkeypatch):
        monkeypatch.setattr("street_inventory.overpass_source.time.sleep", lambda _s: None)

        def transport(url, query, headers, timeout):
            raise _http_error(url, 429)

        result = fetch_city_street_inventory(country_code="US", city="Somewhereville", http_post=transport)
        assert result.status == "unavailable"
        assert result.reason
