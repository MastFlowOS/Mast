"""
PHASE 1B — focused test for MapsScraper.search()'s new `should_stop`
parameter (scraper/maps_scraper.py).

Scope, deliberately narrow: this only exercises the ONE new checkpoint
added in this phase — "before starting a crash-retry attempt, check
should_stop()" — via the smallest possible fake Playwright surface
(a fake browser/context/page that only implements the handful of methods
`search()`'s first attempt actually touches before it fails). It does not
exercise scrolling, selector resolution, or place extraction at all; those
are unmodified in this phase and are exactly what "do not redesign the
scraper" means to leave alone.

Run: pytest tests/test_maps_scraper_should_stop.py -v
"""

from __future__ import annotations

import os
import sys

import pytest
from playwright.async_api import TimeoutError as PlaywrightTimeoutError

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

import scraper.maps_scraper as maps_scraper_module
from scraper.maps_scraper import MapsScraper
from utils.runtime import ProxyManager, RunStats, ScraperConfig


class _FakePage:
    """Only implements what the first part of one `search()` attempt
    touches before a navigation timeout: `goto()` (always fails) and
    `close()` (always succeeds, called from the attempt's `finally`)."""

    def __init__(self) -> None:
        self.goto_calls = 0

    async def goto(self, *_args, **_kwargs):
        self.goto_calls += 1
        raise PlaywrightTimeoutError("simulated navigation timeout")

    async def close(self) -> None:
        pass


class _FakeContext:
    def __init__(self, page: _FakePage) -> None:
        self._page = page

    async def new_page(self) -> _FakePage:
        return self._page

    async def close(self) -> None:
        pass


@pytest.fixture
def patched_context(monkeypatch):
    """Swaps in a fake `_new_stealth_context` so `search()` never touches
    real Playwright/Chromium — every attempt gets a fresh _FakePage whose
    goto() always raises, forcing the crash-retry path every time."""
    pages: list[_FakePage] = []

    async def _fake_new_stealth_context(_browser, proxy=None):
        page = _FakePage()
        pages.append(page)
        return _FakeContext(page)

    monkeypatch.setattr(maps_scraper_module, "_new_stealth_context", _fake_new_stealth_context)
    return pages


def _make_scraper(max_crash_retries: int = 2) -> MapsScraper:
    config = ScraperConfig(headless=True, max_crash_retries=max_crash_retries)
    scraper = MapsScraper(config, ProxyManager(), RunStats())
    # Bypass __aenter__ (real Playwright/Chromium launch) entirely — only
    # `self.browser` needs to exist, and nothing in the code path under
    # test (through the first raised PlaywrightTimeoutError) reads any of
    # its attributes; it's only ever handed opaquely to the patched
    # `_new_stealth_context`.
    scraper._browser = object()
    return scraper


@pytest.mark.asyncio
async def test_without_should_stop_uses_every_configured_retry(patched_context):
    """Backward compatibility: should_stop=None (the default) must behave
    exactly like before this phase — every crash-retry attempt is used."""
    scraper = _make_scraper(max_crash_retries=2)

    with pytest.raises(Exception):
        async for _ in scraper.search(query="coffee", city="New York", max_results=5):
            pass

    assert len(patched_context) == 3, "max_crash_retries=2 => 3 total attempts (1 initial + 2 retries)"


@pytest.mark.asyncio
async def test_should_stop_skips_pending_retry(patched_context):
    """Core of this phase: once should_stop() is true, a crash-triggered
    retry must not begin — the search ends there instead of spending a
    new browser attempt on it."""
    scraper = _make_scraper(max_crash_retries=2)

    def should_stop() -> bool:
        return True  # already true before the very first retry decision

    results = [
        place
        async for place in scraper.search(
            query="coffee", city="New York", max_results=5, should_stop=should_stop,
        )
    ]

    assert results == [], "no places were ever yielded before the first attempt failed"
    assert len(patched_context) == 1, (
        "should_stop()==True must prevent attempt 2 from starting at all — "
        "only the first (always-allowed) attempt should have run"
    )


@pytest.mark.asyncio
async def test_should_stop_flips_true_between_attempts(patched_context):
    """A more realistic timing: should_stop() reports false until the
    first attempt has already failed once (matching production, where
    target_reached only flips once a lead has actually been accepted),
    and only becomes true right at the retry decision — the retry must
    still be skipped rather than started."""

    def should_stop() -> bool:
        # True from the second retry-decision check onward — i.e. it is
        # false for attempt 1 (always allowed) and true by the time
        # attempt 2 is being decided, since one context has already been
        # created by then.
        return len(patched_context) >= 1

    scraper = _make_scraper(max_crash_retries=2)

    results = [
        place
        async for place in scraper.search(
            query="coffee", city="New York", max_results=5, should_stop=should_stop,
        )
    ]

    assert results == []
    assert len(patched_context) == 1, "should_stop flipping true before the retry decision must skip it"
