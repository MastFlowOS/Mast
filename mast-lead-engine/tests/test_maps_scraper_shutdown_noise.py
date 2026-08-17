"""
FINAL SHUTDOWN LATENCY + CONSUMER_STOPPED FIX — item 4: Playwright errors
that are the expected, intentional side effect of tearing down a
page/context mid-attempt during a cooperative shutdown (target reached /
consumer stopped / SIGTERM) must not be logged as fatal crashes, must not
spend a pointless crash-retry attempt, and must not raise
DiscoveryFailure(SCRAPER_ERROR) on the last attempt.

Follows the same minimal fake-Playwright-surface pattern as
tests/test_maps_scraper_should_stop.py: only the handful of methods
search()'s first attempt actually touches are implemented.

Run: pytest tests/test_maps_scraper_shutdown_noise.py -v
"""

from __future__ import annotations

import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

import scraper.maps_scraper as maps_scraper_module
from exceptions import DiscoveryFailure
from scraper.maps_scraper import MapsScraper, _looks_like_shutdown_noise
from utils.runtime import ProxyManager, RunStats, ScraperConfig


class _FakePage:
    """Only implements what the first part of one `search()` attempt
    touches before this test's injected error: `goto()` (raises the
    configured error) and `close()` (always succeeds, called from the
    attempt's `finally`)."""

    def __init__(self, error: Exception) -> None:
        self.goto_calls = 0
        self._error = error

    async def goto(self, *_args, **_kwargs):
        self.goto_calls += 1
        raise self._error

    async def close(self) -> None:
        pass


class _FakeContext:
    def __init__(self, page: _FakePage) -> None:
        self._page = page

    async def new_page(self) -> _FakePage:
        return self._page

    async def close(self) -> None:
        pass


def _patch_context(monkeypatch, error: Exception):
    pages: list[_FakePage] = []

    async def _fake_new_stealth_context(_browser, proxy=None):
        page = _FakePage(error)
        pages.append(page)
        return _FakeContext(page)

    monkeypatch.setattr(maps_scraper_module, "_new_stealth_context", _fake_new_stealth_context)
    return pages


def _make_scraper(max_crash_retries: int = 2) -> MapsScraper:
    config = ScraperConfig(headless=True, max_crash_retries=max_crash_retries)
    scraper = MapsScraper(config, ProxyManager(), RunStats())
    scraper._browser = object()
    return scraper


class TestShutdownNoiseDetection:
    """Unit coverage for the message-sniffing helper itself."""

    @pytest.mark.parametrize(
        "message",
        [
            "Target page, context or browser has been closed",
            "Target closed",
            "Target crashed",
            "Connection closed",
            "Protocol error (Page.navigate): Target closed.",
        ],
    )
    def test_recognizes_known_shutdown_noise(self, message):
        assert _looks_like_shutdown_noise(Exception(message)) is True

    @pytest.mark.parametrize(
        "message",
        [
            "net::ERR_NAME_NOT_RESOLVED",
            "Timeout 30000ms exceeded",
            "some unrelated scraper bug",
        ],
    )
    def test_does_not_flag_genuine_errors(self, message):
        assert _looks_like_shutdown_noise(Exception(message)) is False


class TestSearchSuppressesShutdownNoiseOnlyDuringCooperativeStop:
    @pytest.mark.asyncio
    async def test_closed_target_error_during_shutdown_ends_cleanly(self, monkeypatch):
        """Core of this fix: should_stop()==True + a closed-target-style
        error must return cleanly — no crash log escalation, no retry, and
        (critically) no DiscoveryFailure(SCRAPER_ERROR) even though this
        is the last available attempt."""
        error = Exception("Target page, context or browser has been closed")
        pages = _patch_context(monkeypatch, error)
        scraper = _make_scraper(max_crash_retries=0)  # only one attempt available

        def should_stop() -> bool:
            return True

        results = [
            place
            async for place in scraper.search(
                query="coffee", city="New York", max_results=5, should_stop=should_stop,
            )
        ]

        assert results == []
        assert len(pages) == 1, "must not spend a retry attempt on expected shutdown noise"

    @pytest.mark.asyncio
    async def test_closed_target_error_without_shutdown_request_still_raises(self, monkeypatch):
        """The suppression must be gated on should_stop() also being true
        — a genuine crash whose message happens to resemble shutdown
        noise, with no cooperative stop in play, must still surface as a
        real failure exactly as before this fix."""
        error = Exception("Target page, context or browser has been closed")
        pages = _patch_context(monkeypatch, error)
        scraper = _make_scraper(max_crash_retries=0)

        with pytest.raises(DiscoveryFailure):
            async for _ in scraper.search(query="coffee", city="New York", max_results=5):
                pass

        assert len(pages) == 1

    @pytest.mark.asyncio
    async def test_genuine_error_during_shutdown_still_raises(self, monkeypatch):
        """should_stop()==True alone must not blanket-suppress every
        error — only ones that actually look like shutdown noise. An
        unrelated, genuine crash must still propagate."""
        error = Exception("some unrelated scraper bug")
        pages = _patch_context(monkeypatch, error)
        scraper = _make_scraper(max_crash_retries=0)

        def should_stop() -> bool:
            return True

        with pytest.raises(DiscoveryFailure):
            async for _ in scraper.search(
                query="coffee", city="New York", max_results=5, should_stop=should_stop,
            ):
                pass

        assert len(pages) == 1


class TestBlockHeavyResourcesRouteHandlerNoise:
    @pytest.mark.asyncio
    async def test_route_handler_swallows_closed_target_error(self):
        """`_block_heavy_resources`'s route callback must not propagate a
        closed-target error from `route.abort()`/`route.continue_()` —
        Playwright logs an unhandled route-handler error otherwise,
        flooding Railway logs for every in-flight request during
        shutdown."""

        class _FakeRequest:
            resource_type = "image"

        class _FakeRoute:
            def __init__(self):
                self.request = _FakeRequest()
                self.abort_calls = 0

            async def abort(self):
                self.abort_calls += 1
                raise Exception("Target page, context or browser has been closed")

            async def continue_(self):
                raise AssertionError("should not be called for a blocked resource type")

        class _FakeContext:
            def __init__(self):
                self.handler = None

            async def route(self, _pattern, handler):
                self.handler = handler

        ctx = _FakeContext()
        await maps_scraper_module._block_heavy_resources(ctx)
        route = _FakeRoute()

        # Must not raise — the whole point of this fix.
        await ctx.handler(route)
        assert route.abort_calls == 1

    @pytest.mark.asyncio
    async def test_route_handler_reraises_are_not_swallowed_as_exceptions_upward(self):
        """A non-shutdown-noise route error is still caught (route
        handlers must never crash the page), but logged as a real
        warning rather than silently swallowed at debug level — this
        just proves it doesn't raise back out to the caller either way,
        since `ctx.route()` callbacks can't propagate to `search()`."""

        class _FakeRequest:
            resource_type = "document"

        class _FakeRoute:
            def __init__(self):
                self.request = _FakeRequest()
                self.continue_calls = 0

            async def continue_(self):
                self.continue_calls += 1
                raise Exception("some unrelated route bug")

        class _FakeContext:
            def __init__(self):
                self.handler = None

            async def route(self, _pattern, handler):
                self.handler = handler

        ctx = _FakeContext()
        await maps_scraper_module._block_heavy_resources(ctx)
        route = _FakeRoute()

        await ctx.handler(route)  # must not raise
        assert route.continue_calls == 1
