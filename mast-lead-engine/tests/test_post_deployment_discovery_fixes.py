"""
Post-Deployment Discovery Failure Regression Tests.

Verifies:
1. _validate_panel_candidate waits for late place anchors on generic feed containers before rejecting.
2. _return_to_results dismisses open detail pane via close/back buttons.
3. MapsScraper.search() allows attempt retries on RETURN_TO_RESULTS_FAILED when attempts remain.
"""

from __future__ import annotations

import asyncio
import os
import sys
import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

from exceptions import DiscoveryFailure, DiscoveryFailureReason
import scraper.maps_scraper as maps_scraper_module
from scraper.maps_scraper import MapsScraper, RawPlace, _validate_panel_candidate, _return_to_results
from utils.runtime import ScraperConfig, RunStats
from utils.perf import RunProfiler


class _FakeElement:
    def __init__(self, tag: str = "div", text: str = "", attrs: dict | None = None) -> None:
        self.tag = tag
        self.text = text
        self.attrs = attrs or {}
        self.clicked = False

    async def inner_text(self) -> str:
        return self.text

    async def get_attribute(self, name: str) -> str | None:
        return self.attrs.get(name)

    async def click(self, **_kwargs) -> None:
        self.clicked = True

    async def is_visible(self) -> bool:
        return True


class _DelayedPanel:
    def __init__(self, anchor_hrefs: list[str]) -> None:
        self.anchor_hrefs = anchor_hrefs
        self.ready = False
        self.polled_count = 0

    async def wait_for_selector(self, selector: str, timeout: int = 0):
        self.polled_count += 1
        if "maps/place" in selector and self.anchor_hrefs:
            self.ready = True
            return _FakeElement("a", attrs={"href": self.anchor_hrefs[0]})
        return None

    async def query_selector_all(self, selector: str):
        if "maps/place" in selector and self.ready:
            return [_FakeElement("a", attrs={"href": h}) for h in self.anchor_hrefs]
        return []

    async def evaluate(self, script: str):
        return {"scrollHeight": 500, "clientHeight": 500, "role": "main"}


@pytest.mark.asyncio
async def test_validate_panel_candidate_waits_for_delayed_place_anchors():
    """Generic feed candidates (div.m6QErb) wait for place anchors before rejecting."""
    delayed_panel = _DelayedPanel(["https://www.google.com/maps/place/Test+Coffee"])
    is_valid, evidence = await _validate_panel_candidate(
        None, delayed_panel, selector="div.m6QErb", strict=True
    )
    assert is_valid is True
    assert "contains 1 place anchor(s)" in evidence
    assert delayed_panel.polled_count >= 1


@pytest.mark.asyncio
async def test_return_to_results_clicks_close_button_when_detail_pane_open():
    """_return_to_results clicks close/back button and verifies detail pane closes."""
    close_button = _FakeElement("button", attrs={"aria-label": "Close"})
    feed = _FakeElement("div", attrs={"role": "feed"})
    place_heading = _FakeElement("h1", text="Intelligentsia Coffee")

    detail_open = True

    class _MockPage:
        def __init__(self) -> None:
            self.url = "https://www.google.com/maps/place/Intelligentsia+Coffee"

        async def query_selector(self, selector: str):
            nonlocal detail_open
            if "h1" in selector:
                return place_heading if detail_open else None
            if "button[aria-label='Close']" in selector:
                return close_button if detail_open else None
            if "div[role='feed']" in selector:
                return feed
            return None

        async def query_selector_all(self, selector: str):
            res = await self.query_selector(selector)
            return [res] if res else []

        async def wait_for_selector(self, *args, **kwargs):
            return None

        async def evaluate(self, script: str):
            if "history" in script:
                return 2
            return None

    page = _MockPage()

    async def mock_click(**kwargs):
        nonlocal detail_open
        close_button.clicked = True
        detail_open = False  # pane closes after click

    close_button.click = mock_click

    config = ScraperConfig(scroll_settle_timeout_ms=100)
    returned = await _return_to_results(page, "div[role='feed']", config=config)
    assert returned is True
    assert close_button.clicked is True


@pytest.mark.asyncio
async def test_search_retries_attempt_on_return_to_results_failed_when_attempts_remain(monkeypatch):
    """When RETURN_TO_RESULTS_FAILED occurs on attempt 1, MapsScraper retries with attempt 2."""
    attempt_count = 0

    class _MockSearchPage:
        def __init__(self) -> None:
            self.url = "https://www.google.com/maps"

        async def goto(self, url, **kwargs):
            self.url = url

        async def wait_for_selector(self, *args, **kwargs):
            return None

        async def query_selector(self, *args, **kwargs):
            return None

        async def evaluate(self, *args, **kwargs):
            return ""

        async def close(self):
            pass

    class _MockContext:
        async def new_page(self):
            return _MockSearchPage()

        async def close(self):
            pass

    async def fake_new_context(*_args, **_kwargs):
        nonlocal attempt_count
        attempt_count += 1
        return _MockContext()

    config = ScraperConfig(
        max_crash_retries=1,  # 2 attempts total
        scroll_settle_timeout_ms=50,
    )
    profiler = RunProfiler()
    scraper = MapsScraper(config=config, stats=RunStats(), profiler=profiler)
    scraper._browser = object()

    # Monkeypatch to raise RETURN_TO_RESULTS_FAILED on attempt 1, then cleanly end on attempt 2
    async def fake_resolve_results_panel(*_args, **_kwargs):
        if attempt_count == 1:
            raise DiscoveryFailure(
                DiscoveryFailureReason.RETURN_TO_RESULTS_FAILED,
                "return_to_results failed 2 consecutive times",
            )
        # Attempt 2: simulates end of results
        raise DiscoveryFailure(
            DiscoveryFailureReason.RETURN_TO_RESULTS_FAILED,
            "return_to_results failed final attempt",
        )

    async def fake_human_scroll(*_args, **_kwargs):
        pass

    async def fake_detect_interstitial(*_args, **_kwargs):
        return None

    monkeypatch.setattr(maps_scraper_module, "_new_stealth_context", fake_new_context)
    monkeypatch.setattr(maps_scraper_module, "_resolve_results_panel", fake_resolve_results_panel)
    monkeypatch.setattr(maps_scraper_module, "_detect_interstitial", fake_detect_interstitial)
    monkeypatch.setattr(maps_scraper_module, "_human_scroll", fake_human_scroll)

    # Attempt 1 fails with RETURN_TO_RESULTS_FAILED, retries attempt 2, then attempt 2 fails (is_last_attempt)
    with pytest.raises(DiscoveryFailure) as exc_info:
        async for _ in scraper.search("coffee", "Los Angeles", max_results=1):
            pass

    assert exc_info.value.reason == DiscoveryFailureReason.RETURN_TO_RESULTS_FAILED
    # Proves attempt 1 was retried and reached attempt 2 before terminating
    assert attempt_count == 2
