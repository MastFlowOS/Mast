"""Regression tests for Oct 25, 2026 discovery fixes (Areas 1, 2, 3, 5, 6)."""

from __future__ import annotations

import asyncio
import logging
import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import scraper.maps_scraper as ms
from scraper.maps_scraper import MapsScraper, RawPlace, _return_to_results
from storage.dedup import fingerprints_for, norm_maps_place_id
from utils.perf import RunProfiler as PerfProfiler
from utils.runtime import RunStats, ScraperConfig


class _FakeElement:
    def __init__(self, *, text: str = "", attrs: dict[str, str] | None = None, on_click=None):
        self._text = text
        self._attrs = dict(attrs or {})
        self._on_click = on_click

    async def get_attribute(self, name: str):
        return self._attrs.get(name)

    async def inner_text(self) -> str:
        return self._text

    async def scroll_into_view_if_needed(self, **_kwargs) -> None:
        return None

    async def bounding_box(self):
        return None

    async def click(self, **_kwargs) -> None:
        if self._on_click:
            res = self._on_click()
            if asyncio.iscoroutine(res):
                await res


class _FakeFeedPanel:
    def __init__(self, anchor_factory):
        self._anchor_factory = anchor_factory

    async def query_selector_all(self, selector: str):
        if "a[href*='/maps/place/']" in selector:
            return self._anchor_factory()
        return []

    async def evaluate(self, script: str, *_args):
        if "scrollHeight" in script:
            return {"scrollHeight": 2000, "clientHeight": 600, "scrollTop": 0, "role": "feed"}
        return None


class _FakeSplitLayoutPage:
    """Simulates desktop Google Maps where `div[role='feed']` remains in the DOM
    even while a place's detail pane (`h1.DUwDvf`) is open alongside it."""

    def __init__(
        self,
        *,
        detail_open: bool = True,
        back_closes_detail: bool = True,
        go_back_closes_detail: bool = False,
    ):
        self.detail_open = detail_open
        self.back_closes_detail = back_closes_detail
        self.go_back_closes_detail = go_back_closes_detail
        self.back_clicks = 0
        self.go_back_calls = 0
        self.feed_el = _FakeElement(attrs={"role": "feed"})
        self.h1_el = _FakeElement(text="Alpha Dental")

        def _click_back():
            self.back_clicks += 1
            if self.back_closes_detail:
                self.detail_open = False

        self.back_btn = _FakeElement(attrs={"aria-label": "Back"}, on_click=_click_back)

    async def query_selector(self, selector: str):
        if selector in ("div[role='feed']", "div.m6QErb[aria-label]", "div.m6QErb"):
            return self.feed_el
        if selector in ms._PLACE_NAME_SELECTORS:
            return self.h1_el if self.detail_open else None
        if selector in ms._BACK_BUTTON_SELECTORS:
            return self.back_btn if self.detail_open else None
        return None

    async def wait_for_selector(self, selector: str, **_kwargs):
        el = await self.query_selector(selector)
        if el is None:
            raise ms.PlaywrightTimeoutError(f"timeout waiting for {selector}")
        return el

    async def go_back(self, **_kwargs):
        self.go_back_calls += 1
        if self.go_back_closes_detail:
            self.detail_open = False


@pytest.mark.asyncio
async def test_return_to_results_cannot_report_success_while_detail_pane_open():
    """Exercise the real `_return_to_results()` implementation with a mocked page
    where `div[role='feed']` is present while the detail pane remains open."""
    config = ScraperConfig(scroll_settle_timeout_ms=100)
    profiler = PerfProfiler()

    # Case 1: Back button and go_back both fail to close the detail pane.
    stuck_page = _FakeSplitLayoutPage(
        detail_open=True,
        back_closes_detail=False,
        go_back_closes_detail=False,
    )
    ok_stuck = await _return_to_results(
        stuck_page, "div[role='feed']", config=config, profiler=profiler
    )
    assert ok_stuck is False, "_return_to_results must not return True while detail pane remains open"
    assert stuck_page.back_clicks >= 1
    snap = profiler.summary()
    assert "return_to_results" in snap["stages"], "return_to_results must be recorded as its own profiler stage"
    assert snap["counters"].get("return_to_results_failed", 0) >= 1

    # Case 2: Clicking Back closes the detail pane -> verified return-to-results succeeds.
    working_page = _FakeSplitLayoutPage(
        detail_open=True,
        back_closes_detail=True,
    )
    profiler_ok = PerfProfiler()
    ok_closed = await _return_to_results(
        working_page, "div[role='feed']", config=config, profiler=profiler_ok
    )
    assert ok_closed is True
    assert working_page.detail_open is False
    assert working_page.back_clicks == 1
    assert "return_to_results" in profiler_ok.summary()["stages"]


class _ScenarioMapsPage:
    """Controllable Google Maps page simulation for stale-panel & identity tests."""

    def __init__(self, cards: list[dict], *, close_detail_on_back: bool = True):
        """Each card in `cards` is a dict:
        {
            "href": str,
            "aria": str,
            "text": str,
            "outcomes": list[dict | None]  # per-click panel state: {"name", "address", "url", "phone", "website"}
        }
        """
        self.cards = cards
        self.close_detail_on_back = close_detail_on_back
        self.click_counts: dict[str, int] = {}
        self.goto_urls: list[str] = []
        self.url = "https://www.google.com/maps/search/dentists+in+Chicago"
        self.detail_open = False
        self.current_panel: dict | None = None
        self.feed_panel = _FakeFeedPanel(self._build_anchors)
        self.mouse = type(
            "_M",
            (),
            {"move": staticmethod(lambda *_a, **_kw: asyncio.sleep(0))},
        )()

    def _build_anchors(self):
        anchors = []
        for card in self.cards:
            href = card["href"]

            def _make_click(c=card):
                def _on_click():
                    h = c["href"]
                    idx = self.click_counts.get(h, 0)
                    self.click_counts[h] = idx + 1
                    outcomes = c["outcomes"]
                    outcome = outcomes[min(idx, len(outcomes) - 1)]
                    if outcome is not None:
                        self.detail_open = True
                        self.current_panel = dict(outcome)
                        if "url" in outcome and outcome["url"]:
                            self.url = outcome["url"]

                return _on_click

            anchors.append(
                _FakeElement(
                    text=card.get("text", card.get("aria", "")),
                    attrs={"href": href, "aria-label": card.get("aria", "")},
                    on_click=_make_click(card),
                )
            )
        return anchors

    async def goto(self, url: str, **_kwargs):
        self.goto_urls.append(url)
        self.url = url
        self.detail_open = False
        self.current_panel = None

    async def wait_for_selector(self, selector: str, **_kwargs):
        el = await self.query_selector(selector)
        if el is None:
            raise ms.PlaywrightTimeoutError(f"timeout waiting for {selector}")
        return el

    async def query_selector(self, selector: str):
        if selector in ms._PANEL_SELECTORS:
            return self.feed_panel
        if selector in ms._PLACE_NAME_SELECTORS:
            if self.detail_open and self.current_panel:
                return _FakeElement(text=self.current_panel.get("name", ""))
            return None
        if selector in ms._ADDRESS_SELECTORS:
            if self.detail_open and self.current_panel:
                return _FakeElement(text=self.current_panel.get("address", ""))
            return None
        if selector in ms._BACK_BUTTON_SELECTORS:
            if self.detail_open:
                def _close():
                    if self.close_detail_on_back:
                        self.detail_open = False
                        self.current_panel = None
                        self.url = "https://www.google.com/maps/search/dentists+in+Chicago"

                return _FakeElement(attrs={"aria-label": "Back"}, on_click=_close)
            return None
        return None

    async def query_selector_all(self, selector: str):
        if "a[href*='/maps/place/']" in selector:
            return self._build_anchors()
        return []

    async def eval_on_selector_all(self, selector: str, *_args):
        if "a[href*='/maps/place/']" in selector:
            return len(self.cards)
        return 0

    async def wait_for_function(self, *_args, **_kwargs):
        return None

    async def evaluate(self, script: str, arg=None):
        if "document.body?.innerText" in script:
            return "You've reached the end of the list"
        if isinstance(arg, dict) and "name" in arg and "address" in arg:
            # _PLACE_EXTRACT_JS evaluation
            panel = self.current_panel or {}
            phone = panel.get("phone", "+1 312-555-0100")
            website = panel.get("website", "https://example.com")
            return {
                "name": panel.get("name", ""),
                "category": panel.get("category", "Dentist"),
                "address": panel.get("address", ""),
                "ratingRaw": "4.8",
                "reviewRaw": "42 reviews",
                "reviewFallbackAria": [],
                "phoneCandidates": (
                    [{"aria": f"Phone: {phone}", "href": f"tel:{phone}", "text": phone}]
                    if phone
                    else []
                ),
                "websiteCandidates": (
                    [{"href": website, "text": website}] if website else []
                ),
                "html": panel.get("html", "<html><body>Verified</body></html>"),
                "photosTabText": "Photos",
                "hoursSummary": "Open 9AM-5PM",
            }
        return None

    async def go_back(self, **_kwargs):
        if self.close_detail_on_back:
            self.detail_open = False
            self.current_panel = None
            self.url = "https://www.google.com/maps/search/dentists+in+Chicago"

    async def close(self):
        return None


def _wire_page_into_scraper(monkeypatch, page: _ScenarioMapsPage):
    class _FakeCtx:
        async def new_page(self):
            return page

        async def close(self):
            return None

    async def _fake_new_stealth_context(_browser, proxy=None):
        return _FakeCtx()

    monkeypatch.setattr(ms, "_new_stealth_context", _fake_new_stealth_context)
    monkeypatch.setattr(ms, "_diag_dump_panel_dom", lambda *_a, **_kw: asyncio.sleep(0))


@pytest.mark.asyncio
async def test_stale_panel_produces_no_candidate_and_retries_card(monkeypatch):
    """When clicking Card B leaves Card A's detail panel open on the first attempt:
    - No `candidate_discovered` is emitted on the stale attempt
    - Card B's place_key is NOT added to `seen_hrefs` on the stale attempt
    - `stale_panel_mismatch` counter is incremented
    - Card B is re-acquired and retried, yielding Card B once its panel loads
    - First candidate retains its verified `maps_link` and `mapsPlaceId` even when `page.url` is `/maps/search/...`
    """
    href_a = "https://www.google.com/maps/place/Alpha+Dental/data=!4m2!3m1!1s0x880fd2:0x111111"
    href_b = "https://www.google.com/maps/place/Beta+Dental/data=!4m2!3m1!1s0x880fd2:0x222222"

    panel_a = {
        "name": "Alpha Dental",
        "address": "100 Main St, Chicago, IL",
        # Simulate first click keeping page.url on /maps/search/... (no URL update)
        "url": "https://www.google.com/maps/search/dentists+in+Chicago",
        "phone": "+1 312-555-0101",
        "website": "https://alphadental.example.com",
    }
    panel_b = {
        "name": "Beta Dental",
        "address": "200 Oak Ave, Chicago, IL",
        "url": href_b,
        "phone": "+1 312-555-0202",
        "website": "https://betadental.example.com",
    }

    # Card B's 1st click leaves panel_a stuck on screen; 2nd click updates to panel_b.
    page = _ScenarioMapsPage(
        cards=[
            {
                "href": href_a,
                "aria": "Alpha Dental · 4.8 stars · 100 Main St",
                "outcomes": [panel_a],
            },
            {
                "href": href_b,
                "aria": "Beta Dental · 4.9 stars · 200 Oak Ave",
                "outcomes": [panel_a, panel_b],
            },
        ],
        close_detail_on_back=True,
    )
    _wire_page_into_scraper(monkeypatch, page)

    config = ScraperConfig(
        scroll_max_rounds=2,
        max_crash_retries=0,
        place_timeout_ms=150,
        place_settle_ms=50,
        scroll_settle_timeout_ms=50,
        maps_rpm=6000,
    )
    profiler = PerfProfiler()
    scraper = MapsScraper(config, stats=RunStats(), profiler=profiler)
    scraper._browser = object()
    scraper._limiter.acquire = lambda *_a, **_kw: asyncio.sleep(0)

    events: list[tuple[str, str | None]] = []
    yielded: list[RawPlace] = []
    async for place in scraper.search(
        "dentists",
        "Chicago",
        max_results=10,
        on_progress=lambda _stage, ev, item_id: events.append((ev, item_id)),
    ):
        yielded.append(place)

    assert [p.name for p in yielded] == ["Alpha Dental", "Beta Dental"]
    # Card B was retried after the stale-panel mismatch on its first click
    assert page.click_counts[href_b] == 2
    snap = profiler.summary()
    assert snap["counters"].get("stale_panel_mismatch", 0) == 1

    discovered_events = [item_id for ev, item_id in events if ev == "candidate_discovered"]
    assert discovered_events == ["0x880fd2:0x111111", "0x880fd2:0x222222"]

    # First valid candidate retains its maps_link and place identity even though page.url was /maps/search/...
    first = yielded[0]
    assert "/maps/place/" in first.maps_link
    assert norm_maps_place_id(first.maps_link) == "0x880fd2:0x111111"
    assert "place:0x880fd2:0x111111" in fingerprints_for(first.to_dict())


@pytest.mark.asyncio
async def test_same_name_different_address_distinguished_and_genuine_duplicates_deduped(monkeypatch):
    """Two legitimate businesses with the same name ('Smile Dental') but different
    addresses/place IDs must both be yielded, while a stale panel with the same name
    but old address/place ID is rejected, and a genuine duplicate name+address is deduplicated."""
    href_branch_1 = "https://www.google.com/maps/place/Smile+Dental/data=!4m2!3m1!1s0x880fd2:0xaaaa11"
    href_branch_2 = "https://www.google.com/maps/place/Smile+Dental/data=!4m2!3m1!1s0x880fd2:0xbbbb22"
    href_dup_1 = "https://www.google.com/maps/place/Smile+Dental/data=!4m2!3m1!1s0x880fd2:0xcccc33"

    panel_branch_1 = {
        "name": "Smile Dental",
        "address": "100 North Ave, Chicago, IL",
        "url": href_branch_1,
        "phone": "+1 312-555-0111",
        "website": "https://smiledental.example.com/north",
    }
    panel_branch_2 = {
        "name": "Smile Dental",
        "address": "500 South Blvd, Chicago, IL",
        "url": href_branch_2,
        "phone": "+1 312-555-0222",
        "website": "https://smiledental.example.com/south",
    }

    # Branch 2's first click stays on Branch 1's panel (same business name "Smile Dental",
    # conflicting place ID / address). It must be treated as a stale panel, then succeed on retry.
    # Card 3 (href_dup_1) opens a panel with the exact same name+address as Branch 1 -> genuine duplicate.
    page = _ScenarioMapsPage(
        cards=[
            {
                "href": href_branch_1,
                "aria": "Smile Dental · 100 North Ave",
                "outcomes": [panel_branch_1],
            },
            {
                "href": href_branch_2,
                "aria": "Smile Dental · 500 South Blvd",
                "outcomes": [panel_branch_1, panel_branch_2],
            },
            {
                "href": href_dup_1,
                "aria": "Smile Dental · 100 North Ave",
                "outcomes": [{**panel_branch_1, "url": href_dup_1}],
            },
        ],
        close_detail_on_back=True,
    )
    _wire_page_into_scraper(monkeypatch, page)

    config = ScraperConfig(
        scroll_max_rounds=2,
        max_crash_retries=0,
        place_timeout_ms=150,
        place_settle_ms=50,
        scroll_settle_timeout_ms=50,
        maps_rpm=6000,
    )
    profiler = PerfProfiler()
    scraper = MapsScraper(config, stats=RunStats(), profiler=profiler)
    scraper._browser = object()
    scraper._limiter.acquire = lambda *_a, **_kw: asyncio.sleep(0)

    events: list[tuple[str, str | None]] = []
    yielded: list[RawPlace] = []
    async for place in scraper.search(
        "dentists",
        "Chicago",
        max_results=10,
        on_progress=lambda _stage, ev, item_id: events.append((ev, item_id)),
    ):
        yielded.append(place)

    assert len(yielded) == 2
    assert [p.address for p in yielded] == [
        "100 North Ave, Chicago, IL",
        "500 South Blvd, Chicago, IL",
    ]
    # Genuine duplicate must not emit a 3rd candidate_discovered event
    discovered_events = [item_id for ev, item_id in events if ev == "candidate_discovered"]
    assert discovered_events == ["0x880fd2:0xaaaa11", "0x880fd2:0xbbbb22"]


@pytest.mark.asyncio
async def test_repeated_mismatch_recovery_is_bounded_and_performs_single_search_nav(monkeypatch):
    """When detail panel remains permanently stuck on Card 1:
    - Each subsequent card is retried at most twice (max 3 clicks per card)
    - After 3 consecutive mismatches in one round, at most one search-navigation recovery runs
    - The search terminates safely within bounded operations without yielding stale candidates
    """
    href_1 = "https://www.google.com/maps/place/Alpha+Dental/data=!4m2!3m1!1s0x880fd2:0x111111"
    href_2 = "https://www.google.com/maps/place/Beta+Dental/data=!4m2!3m1!1s0x880fd2:0x222222"
    href_3 = "https://www.google.com/maps/place/Gamma+Dental/data=!4m2!3m1!1s0x880fd2:0x333333"
    href_4 = "https://www.google.com/maps/place/Delta+Dental/data=!4m2!3m1!1s0x880fd2:0x444444"

    stuck_panel = {
        "name": "Alpha Dental",
        "address": "100 Main St, Chicago, IL",
        "url": href_1,
        "phone": "+1 312-555-0101",
        "website": "https://alphadental.example.com",
    }

    page = _ScenarioMapsPage(
        cards=[
            {"href": href_1, "aria": "Alpha Dental · 100 Main St", "outcomes": [stuck_panel]},
            {"href": href_2, "aria": "Beta Dental · 200 Oak Ave", "outcomes": [stuck_panel]},
            {"href": href_3, "aria": "Gamma Dental · 300 Pine Rd", "outcomes": [stuck_panel]},
            {"href": href_4, "aria": "Delta Dental · 400 Elm St", "outcomes": [stuck_panel]},
        ],
        close_detail_on_back=False,
    )
    _wire_page_into_scraper(monkeypatch, page)

    config = ScraperConfig(
        scroll_max_rounds=10,
        max_crash_retries=0,
        place_timeout_ms=80,
        place_settle_ms=30,
        scroll_settle_timeout_ms=50,
        maps_rpm=6000,
    )
    profiler = PerfProfiler()
    scraper = MapsScraper(config, stats=RunStats(), profiler=profiler)
    scraper._browser = object()
    scraper._limiter.acquire = lambda *_a, **_kw: asyncio.sleep(0)

    yielded: list[RawPlace] = []
    async for place in scraper.search("dentists", "Chicago", max_results=10):
        yielded.append(place)

    assert [p.name for p in yielded] == ["Alpha Dental"]
    # Retry at most twice for any single place_key (<= 3 clicks total)
    assert page.click_counts.get(href_2, 0) <= 3
    snap = profiler.summary()
    assert snap["counters"].get("stale_panel_mismatch", 0) >= 3
    # At most one search-navigation recovery after 3 consecutive mismatches
    assert snap["counters"].get("stale_panel_search_nav_recovery", 0) == 1
    assert len(page.goto_urls) == 2  # initial search goto + 1 search-navigation recovery


@pytest.mark.asyncio
async def test_per_card_deadline_bounds_stalled_operation_and_enters_recovery(monkeypatch):
    """A stalled per-card operation sequence (click + panel wait + settle + extract + return)
    must be bounded by `card_operation_timeout_ms` and enter the recovery/cleanup path."""
    from exceptions import DiscoveryFailure

    href_1 = "https://www.google.com/maps/place/Alpha+Dental/data=!4m2!3m1!1s0x880fd2:0x111111"
    panel_1 = {
        "name": "Alpha Dental",
        "address": "100 Main St, Chicago, IL",
        "url": href_1,
    }
    page = _ScenarioMapsPage(
        cards=[{"href": href_1, "aria": "Alpha Dental", "outcomes": [panel_1]}],
        close_detail_on_back=True,
    )

    async def _stalled_settle(*_a, **_kw):
        await asyncio.sleep(5.0)

    _wire_page_into_scraper(monkeypatch, page)
    monkeypatch.setattr(ms, "_wait_for_place_settle", _stalled_settle)

    config = ScraperConfig(
        scroll_max_rounds=1,
        max_crash_retries=0,
        place_timeout_ms=500,
        place_settle_ms=500,
        scroll_settle_timeout_ms=50,
        card_operation_timeout_ms=120,
        maps_rpm=6000,
    )
    profiler = PerfProfiler()
    scraper = MapsScraper(config, stats=RunStats(), profiler=profiler)
    scraper._browser = object()
    scraper._limiter.acquire = lambda *_a, **_kw: asyncio.sleep(0)

    yielded: list[RawPlace] = []
    with pytest.raises(DiscoveryFailure):
        async for place in scraper.search("dentists", "Chicago", max_results=5):
            yielded.append(place)

    assert yielded == []
    snap = profiler.summary()
    assert snap["counters"].get("card_operation_timeouts", 0) == 1


@pytest.mark.asyncio
async def test_phone_extraction_diagnostics_recorded_without_logging_raw_phone(caplog):
    """When a place has no extracted phone, diagnostics record whether phone selectors
    matched without logging any raw phone number."""
    href_1 = "https://www.google.com/maps/place/NoPhone+Dental/data=!4m2!3m1!1s0x880fd2:0x999999"
    panel_no_phone = {
        "name": "NoPhone Dental",
        "address": "900 Clark St, Chicago, IL",
        "url": href_1,
        "phone": "",
        "website": "https://nophone.example.com",
    }
    page = _ScenarioMapsPage(
        cards=[{"href": href_1, "aria": "NoPhone Dental", "outcomes": [panel_no_phone]}],
        close_detail_on_back=True,
    )
    config = ScraperConfig(place_extract_timeout_ms=1000)
    profiler = PerfProfiler()

    page.detail_open = True
    page.current_panel = panel_no_phone

    with caplog.at_level(logging.INFO):
        place = await ms._extract_place_data(
            page,
            config=config,
            query="dentists in Chicago",
            niche="dentists",
            city="Chicago",
            country="US",
            profiler=profiler,
        )

    assert place is not None
    assert place.phone == ""
    snap = profiler.summary()
    assert snap["counters"].get("maps_phone_missing_total", 0) == 1
    assert any("[maps][phone-diag]" in rec.message for rec in caplog.records)
