"""
Tests for Priority 3: Pre-click deduplication using canonical place IDs and known ID set.
"""

from __future__ import annotations

import asyncio
import os
import sys
import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

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

    async def goto(self, *_args, **_kwargs) -> None:
        pass

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
async def test_pre_click_skip_known_place_hex_and_chij(monkeypatch):
    """Assert that a card with a known place ID (either hex or ChIJ) is skipped before click."""
    # Cafe Calida hex pair and ChIJ:
    # hex: 0x880fcd7f8fee01b5:0x89b38e817d796008
    # ChIJ: ChIJtQHuj3_ND4gRCGB5fYGOs4k
    calida_hex = "0x880fcd7f8fee01b5:0x89b38e817d796008"
    calida_chij = "ChIJtQHuj3_ND4gRCGB5fYGOs4k"

    anchors = [
        f"https://www.google.com/maps/place/Cafe+Calida/@41.8,-87.6,17z/data=!4m6!3m5!1s{calida_hex}",
        "https://www.google.com/maps/place/New+Place/@41.8,-87.6,17z/data=!4m6!3m5!1s0x880e2d8be7e51999:0x67a9389ccd491477",
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

    clicked_hrefs = []
    emitted_progress = []

    async def fake_context(*_args, **_kwargs):
        return context

    async def fake_resolve_results_panel(*_args, **_kwargs):
        return ("div[role='feed']", None)

    async def fake_detect_interstitial(*_args, **_kwargs):
        return None

    async def fake_human_scroll(*_args, **_kwargs):
        return None

    async def fake_human_click(p, a, *_args, **_kwargs):
        clicked_hrefs.append(a._href)
        p.url = a._href

    async def fake_read_panel_identity_snapshot(*_args, **_kwargs):
        return {"open": False, "name": ""}

    async def fake_wait_for_verified_panel_identity(*_args, **_kwargs):
        return (True, {"open": True, "name": "new place"}, "verified")

    async def fake_wait_for_place_settle(*_args, **_kwargs):
        return None

    async def fake_extract_place_data(*_args, **_kwargs):
        return RawPlace(
            name="New Place",
            address="456 Main St",
            maps_link="https://www.google.com/maps/place/New+Place",
            extra={"maps_place_id": "0x880e2d8be7e51999:0x67a9389ccd491477"},
        )

    async def fake_return_ok(*_args, **_kwargs):
        return True

    def fake_on_progress(stage: str, event: str, item_id: str = ""):
        emitted_progress.append((event, item_id))

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

    # Seed known_place_ids with the ChIJ form of Cafe Calida
    # The card in DOM has the hex form, so normalizer must cross-match
    results = []
    async for p in scraper.search(
        query="coffee",
        city="Chicago",
        max_results=1,
        known_place_ids={calida_chij},
        on_progress=fake_on_progress,
    ):
        results.append(p)

    # Assertions:
    # 1. Cafe Calida was NEVER clicked
    assert not any(calida_hex in href for href in clicked_hrefs)
    # 2. Only New Place was clicked
    assert len(clicked_hrefs) == 1
    assert "New+Place" in clicked_hrefs[0]
    # 3. Exactly 1 result yielded
    assert len(results) == 1
    assert results[0].name == "New Place"
    # 4. known_place_skipped counter incremented
    assert profiler.counter("known_place_skipped") == 1
    # 5. Progress event emitted
    assert any(evt == "candidate_duplicate_skipped" for evt, _ in emitted_progress)
