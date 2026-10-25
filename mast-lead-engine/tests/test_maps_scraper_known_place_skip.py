"""
Deterministic regression tests for pre-click known Google Maps place ID skipping.

Verifies:
1. A card with a known place ID (CID, ChIJ, or place: prefixed) is skipped
   BEFORE clicking detail panel (_human_click is never called).
2. An unknown place ID is clicked and processed normally.
3. A card with no recognizable place ID is clicked and processed safely without false skipping.
4. Correct metrics ('maps_candidates_known_place_skipped') and progress events
   ('candidate_duplicate_skipped') are recorded.

Run: pytest tests/test_maps_scraper_known_place_skip.py -v
"""

from __future__ import annotations

import os
import sys
import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

import scraper.maps_scraper as maps_scraper_module
from scraper.maps_scraper import MapsScraper, RawPlace
from utils.perf import RunProfiler
from utils.runtime import ProxyManager, RunStats, ScraperConfig


class _FakeAnchor:
    def __init__(self, href: str, *, aria_label: str = "", visible_text: str = "") -> None:
        self._href = href
        self._aria_label = aria_label
        self._visible_text = visible_text

    async def get_attribute(self, name: str) -> str | None:
        if name == "href":
            return self._href
        if name == "aria-label":
            return self._aria_label
        return None

    async def inner_text(self) -> str:
        return self._visible_text

    async def scroll_into_view_if_needed(self, timeout: int = 2000) -> None:
        pass


class _FakePanel:
    def __init__(self, rounds: list[list[_FakeAnchor]]) -> None:
        self._rounds = rounds
        self.round_index = 0

    async def query_selector_all(self, _selector: str):
        idx = min(self.round_index, len(self._rounds) - 1)
        return self._rounds[idx]


class _FakePage:
    def __init__(self, panel: _FakePanel) -> None:
        self._panel = panel
        self.url = "https://www.google.com/maps/search/fake"
        self.eol_reached = False

    async def goto(self, *_args, **_kwargs) -> None:
        pass

    async def title(self) -> str:
        return "Fake Maps Results"

    async def evaluate(self, script: str):
        if "innerText" in script and "length" not in script:
            return "You've reached the end of the list" if self.eol_reached else ""
        return 0

    async def eval_on_selector_all(self, _selector: str, _script: str) -> int:
        idx = min(self._panel.round_index, len(self._panel._rounds) - 1)
        return len(self._panel._rounds[idx])

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


class _AsyncNoop:
    async def __call__(self, *_args, **_kwargs):
        return None


class _AsyncReturns:
    def __init__(self, value):
        self._value = value

    async def __call__(self, *_args, **_kwargs):
        return self._value


class _FakeHumanClick:
    def __init__(self) -> None:
        self.clicked_hrefs: list[str] = []

    async def __call__(self, _page, anchor) -> None:
        self.clicked_hrefs.append(anchor._href)


def _end_after(page: _FakePage, extract_calls: dict, total: int, place: RawPlace):
    async def _fake_extract(*_args, **_kwargs) -> RawPlace:
        extract_calls["n"] += 1
        if extract_calls["n"] >= total:
            page.eol_reached = True
        return place
    return _fake_extract


@pytest.fixture
def patched_scraper_env(monkeypatch):
    monkeypatch.setattr(maps_scraper_module, "_diag_dump_panel_dom", _AsyncNoop())
    monkeypatch.setattr(maps_scraper_module, "_detect_interstitial", _AsyncReturns(None))
    monkeypatch.setattr(maps_scraper_module, "_human_scroll", _AsyncNoop())
    monkeypatch.setattr(maps_scraper_module, "_return_to_results", _AsyncReturns(True))
    monkeypatch.setattr(maps_scraper_module, "_wait_for_place_settle", _AsyncNoop())
    monkeypatch.setattr(
        maps_scraper_module,
        "_resolve_results_panel",
        _AsyncReturns(('div[role="feed"]', "dummy")),
    )
    monkeypatch.setattr(
        maps_scraper_module,
        "_is_detail_pane_open",
        _AsyncReturns(False),
    )


def _make_scraper(page: _FakePage, monkeypatch, *, human_click=None, profiler=None) -> tuple[MapsScraper, RunProfiler]:
    async def _fake_new_stealth_context(_browser, proxy=None):
        return _FakeContext(page)

    monkeypatch.setattr(maps_scraper_module, "_new_stealth_context", _fake_new_stealth_context)
    if human_click is not None:
        monkeypatch.setattr(maps_scraper_module, "_human_click", human_click)

    config = ScraperConfig(headless=True, max_crash_retries=0)
    prof = profiler or RunProfiler()
    scraper = MapsScraper(config, ProxyManager(), RunStats(), profiler=prof)
    scraper._browser = object()
    scraper._limiter.acquire = _AsyncNoop()
    return scraper, prof


@pytest.mark.asyncio
async def test_known_place_id_skipped_pre_click(monkeypatch, patched_scraper_env):
    """A card whose href contains a known place ID is skipped BEFORE clicking into it."""
    known_cid = "0x89c2598f988156a9:0x891ab01234567890"
    card_href = f"https://www.google.com/maps/place/Known+Coffee/@40.71,-74.00,17z/data=!4m6!3m5!1s{known_cid}!8m2!3d40.71!4d-74.00"

    anchor = _FakeAnchor(card_href, aria_label="Known Coffee")
    page = _FakePage(_FakePanel([[anchor]]))
    page.eol_reached = True

    click_recorder = _FakeHumanClick()
    scraper, profiler = _make_scraper(page, monkeypatch, human_click=click_recorder)

    progress_events: list[tuple[str, str, str | None]] = []

    def on_progress(stage: str, event: str, item_id: str | None = None) -> None:
        progress_events.append((stage, event, item_id))

    yielded = []
    async for place in scraper.search(
        "coffee",
        "New York",
        known_place_ids={known_cid},
        on_progress=on_progress,
    ):
        yielded.append(place)

    # 1. _human_click was NEVER called
    assert click_recorder.clicked_hrefs == [], "Known place ID must not be clicked"

    # 2. Place was not yielded
    assert len(yielded) == 0

    # 3. Profiler counter was incremented
    assert profiler.counter("maps_candidates_known_place_skipped") == 1

    # 4. Progress event candidate_duplicate_skipped was emitted
    duplicate_events = [e for e in progress_events if e[1] == "candidate_duplicate_skipped"]
    assert len(duplicate_events) == 1
    assert duplicate_events[0][2] == known_cid.lower()


@pytest.mark.asyncio
async def test_unknown_place_id_clicked_and_yielded(monkeypatch, patched_scraper_env):
    """A card with an unknown place ID is clicked, extracted, and yielded."""
    unknown_cid = "0x89c2598f988156a9:0x1111111111111111"
    card_href = f"https://www.google.com/maps/place/New+Coffee/@40.71,-74.00,17z/data=!4m6!3m5!1s{unknown_cid}!8m2!3d40.71!4d-74.00"

    anchor = _FakeAnchor(card_href, aria_label="New Coffee")
    page = _FakePage(_FakePanel([[anchor]]))

    click_recorder = _FakeHumanClick()
    extract_calls = {"n": 0}
    raw_place = RawPlace(name="New Coffee", address="123 Test St")
    monkeypatch.setattr(
        maps_scraper_module,
        "_extract_place_data",
        _end_after(page, extract_calls, 1, raw_place),
    )
    scraper, profiler = _make_scraper(page, monkeypatch, human_click=click_recorder)

    yielded = []
    async for place in scraper.search(
        "coffee",
        "New York",
        known_place_ids={"0x89c2598f988156a9:0x9999999999999999"},  # different ID
    ):
        yielded.append(place)

    # 1. _human_click WAS called
    assert len(click_recorder.clicked_hrefs) == 1
    assert click_recorder.clicked_hrefs[0] == card_href

    # 2. Place was yielded
    assert len(yielded) == 1
    assert yielded[0].name == "New Coffee"

    # 3. No known_place_skipped increment
    assert profiler.counter("maps_candidates_known_place_skipped") == 0


@pytest.mark.asyncio
async def test_missing_place_id_clicked_safely(monkeypatch, patched_scraper_env):
    """A card with no recognizable place ID continues safely to detail click."""
    card_href = "https://www.google.com/maps/place/Ambiguous+Coffee+Shop"

    anchor = _FakeAnchor(card_href, aria_label="Ambiguous Coffee Shop")
    page = _FakePage(_FakePanel([[anchor]]))

    click_recorder = _FakeHumanClick()
    extract_calls = {"n": 0}
    raw_place = RawPlace(name="Ambiguous Coffee Shop", address="456 Other St")
    monkeypatch.setattr(
        maps_scraper_module,
        "_extract_place_data",
        _end_after(page, extract_calls, 1, raw_place),
    )
    scraper, profiler = _make_scraper(page, monkeypatch, human_click=click_recorder)

    yielded = []
    async for place in scraper.search(
        "coffee",
        "New York",
        known_place_ids={"0x89c2598f988156a9:0x891ab01234567890"},
    ):
        yielded.append(place)

    # Must NOT skip based on ambiguous name or missing ID
    assert len(click_recorder.clicked_hrefs) == 1
    assert len(yielded) == 1
    assert profiler.counter("maps_candidates_known_place_skipped") == 0


@pytest.mark.asyncio
async def test_chij_and_prefixed_known_place_id_skipped(monkeypatch, patched_scraper_env):
    """Supports ChIJ place IDs and place: prefix normalization."""
    chij_id = "ChIJN1t_tDeuEmsRUsoyG83frY4"
    card_href = f"https://www.google.com/maps/place/Sydney+Cafe/@40.71,-74.00,17z/data=!4m2!3m1!1s{chij_id}"

    anchor = _FakeAnchor(card_href, aria_label="Sydney Cafe")
    page = _FakePage(_FakePanel([[anchor]]))
    page.eol_reached = True

    click_recorder = _FakeHumanClick()
    scraper, profiler = _make_scraper(page, monkeypatch, human_click=click_recorder)

    yielded = []
    # Test place: prefix normalization
    async for place in scraper.search(
        "coffee",
        "Sydney",
        known_place_ids=[f"place:{chij_id}"],
    ):
        yielded.append(place)

    assert click_recorder.clicked_hrefs == []
    assert len(yielded) == 0
    assert profiler.counter("maps_candidates_known_place_skipped") == 1
