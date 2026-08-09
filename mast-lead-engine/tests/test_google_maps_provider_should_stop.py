"""
LIFECYCLE FIX (bridge delivery / watchdog / graceful shutdown phase) —
focused tests for GoogleMapsProvider's cooperative `should_stop` early-stop
mechanism (providers/google_maps_provider.py).

Does NOT touch a real browser or scraper/maps_scraper.py at all — per this
phase's explicit "do not redesign Maps" instruction, these tests verify the
CONSUMPTION-layer behavior added in this phase (GoogleMapsProvider checking
`request.should_stop()` after each candidate, and properly `aclose()`-ing
the underlying scraper generator either way) using a fake MapsScraper
stand-in, the same test-seam pattern validate_service_run_query.py already
uses for the same class.

Run: pytest tests/test_google_maps_provider_should_stop.py -v
"""

from __future__ import annotations

import asyncio
import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

import providers.google_maps_provider as gmp_module
from providers.google_maps_provider import GoogleMapsDiscoveryRequest, GoogleMapsProvider


class _FakeRawPlace:
    """Minimal stand-in for scraper.maps_scraper.RawPlace — only the
    attributes GoogleMapsProvider._to_business_candidate() actually reads."""

    def __init__(self, name: str) -> None:
        self.name = name
        self.category = "Coffee Shop"
        self.address = "123 Main St"
        self.city = "New York"
        self.country = "US"
        self.website = ""
        self.phone = ""
        self.maps_link = ""
        self.rating = 4.5
        self.reviews = 10


class _FakeMapsScraper:
    """
    Stand-in for scraper.maps_scraper.MapsScraper — mirrors its async
    context-manager + async-generator `.search()` shape exactly (the only
    surface GoogleMapsProvider._discover_async actually touches), so this
    phase's new should_stop wiring is exercised without ever importing
    Playwright or scraper/maps_scraper.py.
    """

    instances: list["_FakeMapsScraper"] = []

    def __init__(self, config, proxy_manager, stats, *, place_count: int = 20) -> None:
        self.place_count = place_count
        self.aclosed = False
        self.aexited = False
        self.candidates_produced = 0
        _FakeMapsScraper.instances.append(self)

    async def __aenter__(self) -> "_FakeMapsScraper":
        return self

    async def __aexit__(self, exc_type, exc, tb) -> None:
        self.aexited = True

    async def search(self, *, query, city, country, niche, region, max_results):
        try:
            for i in range(min(self.place_count, max_results)):
                self.candidates_produced += 1
                yield _FakeRawPlace(f"Business {i + 1}")
                # Small await so this behaves like a genuinely async
                # generator (real MapsScraper awaits Playwright between
                # cards) rather than yielding everything synchronously.
                await asyncio.sleep(0)
        finally:
            self.aclosed = True


@pytest.fixture(autouse=True)
def _reset_fake_instances():
    _FakeMapsScraper.instances.clear()
    yield
    _FakeMapsScraper.instances.clear()


@pytest.fixture
def patched_scraper(monkeypatch):
    """Swaps in _FakeMapsScraper for the duration of one test."""
    monkeypatch.setattr(gmp_module, "MapsScraper", _FakeMapsScraper)
    return _FakeMapsScraper


def _drive_sync_generator(gen):
    """GoogleMapsProvider.discover() is a plain (sync) generator per
    DiscoveryProviderInterface — drive it exactly like DiscoveryWorker.process()
    does (workers/discovery_worker.py), a plain `for` loop."""
    return list(gen)


class TestShouldStopAbsent:
    """Backward compatibility: should_stop=None (the default) must behave
    exactly like before this phase — run to exhaustion / max_results."""

    def test_runs_to_exhaustion_without_should_stop(self, patched_scraper):
        provider = GoogleMapsProvider()
        request = GoogleMapsDiscoveryRequest(
            session_id="s1", query="coffee", city="New York", max_results=5,
        )
        candidates = _drive_sync_generator(provider.discover(request))
        assert len(candidates) == 5, "no should_stop => must not stop early"
        assert patched_scraper.instances[0].aclosed is True
        assert patched_scraper.instances[0].aexited is True


class TestShouldStopEarly:
    """Core of this phase: target-reached / shutdown-requested must stop
    discovery from asking for more candidates than needed."""

    def test_stops_after_target_reached(self, patched_scraper):
        """Mirrors section 9 ('target reached must be handled cleanly'):
        once enough candidates have been produced, should_stop flips True
        and no further candidates should be pulled from the scraper."""
        seen = []

        def should_stop():
            return len(seen) >= 3

        provider = GoogleMapsProvider()
        request = GoogleMapsDiscoveryRequest(
            session_id="s2", query="coffee", city="New York", max_results=20,
            should_stop=should_stop,
        )
        for candidate in provider.discover(request):
            seen.append(candidate)

        assert len(seen) == 3, (
            "should_stop() becoming true after the 3rd candidate must stop "
            "discovery there, not continue toward max_results=20"
        )
        # The already-yielded candidates were fully delivered *before* the
        # stop check fires (checked after yielding, never before) — see
        # this phase's docstring in _discover_async.
        assert [c.name for c in seen] == ["Business 1", "Business 2", "Business 3"]

    def test_lead_already_in_flight_is_never_lost(self, patched_scraper):
        """Test D equivalent at the provider layer: 'yield lead #N,
        shutdown requested' — the already-in-flight candidate must still
        be fully delivered to the caller before discovery stops."""
        shutdown_after = 1
        seen = []

        def should_stop():
            return len(seen) >= shutdown_after

        provider = GoogleMapsProvider()
        request = GoogleMapsDiscoveryRequest(
            session_id="s3", query="coffee", city="New York", max_results=20,
            should_stop=should_stop,
        )
        for candidate in provider.discover(request):
            seen.append(candidate)

        assert len(seen) == 1
        assert seen[0].name == "Business 1", "the in-flight candidate must not be dropped"

    def test_browser_cleanup_still_happens_on_early_stop(self, patched_scraper):
        """The critical invariant from this phase: stopping early must
        still properly close the underlying generator/browser — never an
        orphaned resource, and never closed *before* the last candidate is
        yielded either."""

        def should_stop():
            return True  # stop immediately after the very first candidate

        provider = GoogleMapsProvider()
        request = GoogleMapsDiscoveryRequest(
            session_id="s4", query="coffee", city="New York", max_results=20,
            should_stop=should_stop,
        )
        candidates = _drive_sync_generator(provider.discover(request))

        assert len(candidates) == 1
        fake = patched_scraper.instances[0]
        assert fake.aclosed is True, "search() generator must be aclose()'d even on early stop"
        assert fake.aexited is True, "MapsScraper's own __aexit__ (browser close) must still run"
        # Confirms discovery genuinely stopped early rather than the fake
        # scraper simply running out on its own (max_results=20, but
        # should_stop fires after candidate #1).
        assert fake.candidates_produced == 1

    def test_shutdown_event_style_predicate(self, patched_scraper):
        """Exercises the exact composition service.py uses: should_stop as
        `delivered >= target or shutdown_event.is_set()`."""
        import threading

        delivered = {"count": 0}
        shutdown_event = threading.Event()

        def should_stop():
            return delivered["count"] >= 100 or shutdown_event.is_set()

        provider = GoogleMapsProvider()
        request = GoogleMapsDiscoveryRequest(
            session_id="s5", query="coffee", city="New York", max_results=20,
            should_stop=should_stop,
        )

        gen = provider.discover(request)
        first = next(gen)
        assert first.name == "Business 1"
        delivered["count"] += 1

        # Simulate a SIGTERM-triggered cooperative shutdown arriving right
        # after the first candidate was already fully delivered.
        shutdown_event.set()

        remaining = list(gen)
        assert remaining == [], "shutdown_event firing must stop discovery immediately"
        assert patched_scraper.instances[0].aclosed is True
