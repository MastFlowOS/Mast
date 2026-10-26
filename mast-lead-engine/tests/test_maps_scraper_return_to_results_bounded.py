"""
Tests for Priority 1: Bounded return_to_results failure handling and recovery in MapsScraper.
"""

from __future__ import annotations

import asyncio
import os
import sys
import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

from exceptions import DiscoveryFailure, DiscoveryFailureReason
import scraper.maps_scraper as maps_scraper_module
from scraper.maps_scraper import MapsScraper, RawPlace
from utils.runtime import ScraperConfig, RunStats
from utils.perf import RunProfiler


class _FakeAnchor:
    def __init__(self, href: str) -> None:
        self._href = href

    async def get_attribute(self, name: str) -> str:
        assert name == "href"
        return self._href

    async def scroll_into_view_if_needed(self, timeout: int = 2000) -> None:
        pass


class _FakePanel:
    def __init__(self, anchors: list[str]) -> None:
        self.anchors = anchors

    async def query_selector_all(self, _selector: str):
        return [_FakeAnchor(href) for href in self.anchors]

    async def evaluate(self, *_args, **_kwargs):
        return ""


class _FakePage:
    def __init__(self, panel: _FakePanel) -> None:
        self._panel = panel
        self.url = "https://www.google.com/maps/search/coffee+Chicago"
        self.goto_calls = 0

    async def goto(self, *_args, **_kwargs) -> None:
        self.goto_calls += 1

    async def title(self) -> str:
        return "Fake Maps Results"

    async def evaluate(self, script: str):
        if "innerText" in script and "length" not in script:
            return ""
        return 0

    async def eval_on_selector_all(self, _selector: str, _script: str) -> int:
        return len(self._panel.anchors)

    async def query_selector(self, _selector: str):
        return self._panel

    async def wait_for_selector(self, _selector: str, timeout: int = 0) -> None:
        return None

    async def close(self) -> None:
        pass


class _FakeContext:
    def __init__(self, page: _FakePage) -> None:
        self._page = page

    async def new_page(self) -> _FakePage:
        return self._page

    async def close(self) -> None:
        pass


@pytest.mark.asyncio
async def test_return_to_results_bounded_failure(monkeypatch):
    """When _return_to_results repeatedly fails, scraper stops after bound with RETURN_TO_RESULTS_FAILED."""
    anchors = [
        "https://www.google.com/maps/place/Cafe+A/@41.8,-87.6,17z/data=!4m6!3m5!1s0x1:0xa",
        "https://www.google.com/maps/place/Cafe+B/@41.8,-87.6,17z/data=!4m6!3m5!1s0x2:0xb",
        "https://www.google.com/maps/place/Cafe+C/@41.8,-87.6,17z/data=!4m6!3m5!1s0x3:0xc",
        "https://www.google.com/maps/place/Cafe+D/@41.8,-87.6,17z/data=!4m6!3m5!1s0x4:0xd",
    ]
    panel = _FakePanel(anchors)
    page = _FakePage(panel)
    context = _FakeContext(page)

    config = ScraperConfig(
        headless=True,
        scroll_max_rounds=15,
        max_crash_retries=0,
        card_operation_timeout_ms=5000,
        scroll_settle_timeout_ms=50,
    )
    profiler = RunProfiler()
    scraper = MapsScraper(config=config, stats=RunStats(), profiler=profiler)
    scraper._browser = object()

    async def fake_context(*_args, **_kwargs):
        return context

    async def fake_resolve_results_panel(*_args, **_kwargs):
        return ("div[role='feed']", None)

    async def fake_detect_interstitial(*_args, **_kwargs):
        return None

    async def fake_human_scroll(*_args, **_kwargs):
        return None

    async def fake_human_click(p, a, *_args, **_kwargs):
        p.url = a._href

    async def fake_read_panel_identity_snapshot(*_args, **_kwargs):
        return {"open": False, "name": ""}

    async def fake_wait_for_verified_panel_identity(*_args, **_kwargs):
        return (True, {"open": True, "name": "cafe"}, "verified")

    async def fake_extract_place_data(*_args, **_kwargs):
        return RawPlace(
            name="Cafe",
            address="123 Main St",
            maps_link="https://www.google.com/maps/place/Cafe",
            extra={"maps_place_id": "0x1:0xa"},
        )

    return_calls = 0

    async def fake_return_fail(*_args, **_kwargs):
        nonlocal return_calls
        return_calls += 1
        return False

    async def fake_wait_for_place_settle(*_args, **_kwargs):
        return None

    monkeypatch.setattr(maps_scraper_module, "_new_stealth_context", fake_context)
    monkeypatch.setattr(maps_scraper_module, "_resolve_results_panel", fake_resolve_results_panel)
    monkeypatch.setattr(maps_scraper_module, "_detect_interstitial", fake_detect_interstitial)
    monkeypatch.setattr(maps_scraper_module, "_human_scroll", fake_human_scroll)
    monkeypatch.setattr(maps_scraper_module, "_human_click", fake_human_click)
    monkeypatch.setattr(maps_scraper_module, "_read_panel_identity_snapshot", fake_read_panel_identity_snapshot)
    monkeypatch.setattr(maps_scraper_module, "_wait_for_verified_panel_identity", fake_wait_for_verified_panel_identity)
    monkeypatch.setattr(maps_scraper_module, "_wait_for_place_settle", fake_wait_for_place_settle)
    monkeypatch.setattr(maps_scraper_module, "_extract_place_data", fake_extract_place_data)
    monkeypatch.setattr(maps_scraper_module, "_return_to_results", fake_return_fail)

    with pytest.raises(DiscoveryFailure) as excinfo:
        async for _ in scraper.search(query="coffee", city="Chicago", max_results=10):
            pass

    assert excinfo.value.reason == DiscoveryFailureReason.RETURN_TO_RESULTS_FAILED
    # Bounded: stopped after bound + 1 recovery retry, NOT running 15 full rounds of failures
    assert return_calls <= 4
    assert scraper._profiler.counter("return_to_results_failures") >= 2


@pytest.mark.asyncio
async def test_return_to_results_success_unaffected(monkeypatch):
    """When _return_to_results succeeds, search proceeds normally."""
    anchors = [
        "https://www.google.com/maps/place/Cafe+A/@41.8,-87.6,17z/data=!4m6!3m5!1s0x1:0xa",
    ]
    panel = _FakePanel(anchors)
    page = _FakePage(panel)
    context = _FakeContext(page)

    config = ScraperConfig(
        headless=True,
        scroll_max_rounds=2,
        max_crash_retries=0,
        card_operation_timeout_ms=5000,
        scroll_settle_timeout_ms=50,
    )
    profiler = RunProfiler()
    scraper = MapsScraper(config=config, stats=RunStats(), profiler=profiler)
    scraper._browser = object()

    async def fake_context(*_args, **_kwargs):
        return context

    async def fake_resolve_results_panel(*_args, **_kwargs):
        return ("div[role='feed']", None)

    async def fake_detect_interstitial(*_args, **_kwargs):
        return None

    async def fake_human_scroll(*_args, **_kwargs):
        return None

    async def fake_human_click(p, a, *_args, **_kwargs):
        p.url = a._href

    async def fake_read_panel_identity_snapshot(*_args, **_kwargs):
        return {"open": False, "name": ""}

    async def fake_wait_for_verified_panel_identity(*_args, **_kwargs):
        return (True, {"open": True, "name": "cafe a"}, "verified")

    async def fake_extract_place_data(*_args, **_kwargs):
        return RawPlace(
            name="Cafe A",
            address="123 Main St",
            maps_link="https://www.google.com/maps/place/Cafe+A",
            extra={"maps_place_id": "0x1:0xa"},
        )

    async def fake_return_ok(*_args, **_kwargs):
        return True

    async def fake_wait_for_place_settle(*_args, **_kwargs):
        return None

    monkeypatch.setattr(maps_scraper_module, "_new_stealth_context", fake_context)
    monkeypatch.setattr(maps_scraper_module, "_resolve_results_panel", fake_resolve_results_panel)
    monkeypatch.setattr(maps_scraper_module, "_detect_interstitial", fake_detect_interstitial)
    monkeypatch.setattr(maps_scraper_module, "_human_scroll", fake_human_scroll)
    monkeypatch.setattr(maps_scraper_module, "_human_click", fake_human_click)
    monkeypatch.setattr(maps_scraper_module, "_read_panel_identity_snapshot", fake_read_panel_identity_snapshot)
    monkeypatch.setattr(maps_scraper_module, "_wait_for_verified_panel_identity", fake_wait_for_verified_panel_identity)
    monkeypatch.setattr(maps_scraper_module, "_wait_for_place_settle", fake_wait_for_place_settle)
    monkeypatch.setattr(maps_scraper_module, "_extract_place_data", fake_extract_place_data)
    monkeypatch.setattr(maps_scraper_module, "_return_to_results", fake_return_ok)

    results = []
    async for p in scraper.search(query="coffee", city="Chicago", max_results=1):
        results.append(p)

    assert len(results) == 1
    assert results[0].name == "Cafe A"
    assert scraper._profiler.counter("return_to_results_failures") == 0
