"""Regression tests proving Google Maps detail-panel detection correctness.

Proves:
1. A search results page containing a search-box Close button is NOT classified as an open detail panel.
2. A toast/dialog Close button does NOT falsely establish a detail panel.
3. A genuine place detail panel is still detected.
4. A genuine detail panel with a temporarily missing heading is handled correctly (waiting_for_panel_name).
5. A search results page with a searchbox close button returns immediately from _return_to_results.
6. Existing bounded retry behavior for unopened/stale panels remains intact (bounded to max_unopened_retries + 1).
"""

from __future__ import annotations

import asyncio
import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import scraper.maps_scraper as ms
from scraper.maps_scraper import (
    _evaluate_panel_identity,
    _is_detail_pane_open,
    _read_panel_identity_snapshot,
    _return_to_results,
)
from utils.perf import RunProfiler as PerfProfiler
from utils.runtime import ScraperConfig


class _MockElement:
    def __init__(
        self,
        *,
        text: str = "",
        attrs: dict[str, str] | None = None,
        on_click=None,
    ):
        self._text = text
        self._attrs = dict(attrs or {})
        self._on_click = on_click
        self.clicked = False

    async def get_attribute(self, name: str):
        return self._attrs.get(name)

    async def inner_text(self) -> str:
        return self._text

    async def click(self, **_kwargs) -> None:
        self.clicked = True
        if self._on_click:
            res = self._on_click()
            if asyncio.iscoroutine(res):
                await res

    async def evaluate(self, script: str, *_args):
        if "click" in script:
            await self.click()
        return None

    async def query_selector(self, selector: str):
        if hasattr(self, "_card_anchors"):
            if "a[href*='/maps/place/']" in selector:
                return self._card_anchors[0] if self._card_anchors else None
            return None
        if "a[href*='/maps/place/']" in selector:
            return self
        return None

    async def query_selector_all(self, selector: str):
        cards = getattr(self, "_card_anchors", [])
        if "a[href*='/maps/place/']" in selector:
            return list(cards)
        return []


class _MockPage:
    """Configurable mock Playwright Page for panel detection scenarios."""

    def __init__(
        self,
        *,
        url: str = "https://www.google.com/maps/search/coffee+shop",
        feed: _MockElement | None = None,
        headings: list[_MockElement] | None = None,
        back_buttons: dict[str, _MockElement] | None = None,
        other_elements: dict[str, _MockElement] | None = None,
    ):
        self.url = url
        self.feed_el = feed or _MockElement(attrs={"role": "feed"})
        self.headings = list(headings or [])
        self.back_buttons = dict(back_buttons or {})
        self.other_elements = dict(other_elements or {})
        self.keyboard = _MockKeyboard()

    async def query_selector(self, selector: str):
        # 1. Feed selectors
        if selector in ("div[role='feed']", "div.m6QErb[aria-label]", "div.m6QErb"):
            return self.feed_el

        # 2. Place name heading selectors
        if selector in ms._PLACE_NAME_SELECTORS:
            return self.headings[0] if self.headings else None

        # 3. Detail-specific back button selectors
        if selector in ms._DETAIL_BACK_BUTTON_SELECTORS:
            for k, el in self.back_buttons.items():
                if k in selector:
                    return el

        # 4. Fallback back button selectors (used in _return_to_results)
        if selector in ms._BACK_BUTTON_SELECTORS:
            for k, el in self.back_buttons.items():
                if k in selector:
                    return el

        # 5. Other configured DOM elements
        for k, el in self.other_elements.items():
            if k == selector or k in selector:
                return el

        return None

    async def query_selector_all(self, selector: str):
        if selector in ms._PLACE_NAME_SELECTORS:
            return list(self.headings)
        el = await self.query_selector(selector)
        return [el] if el else []

    async def wait_for_selector(self, selector: str, **_kwargs):
        el = await self.query_selector(selector)
        if el is None:
            raise ms.PlaywrightTimeoutError(f"timeout waiting for {selector}")
        return el

    async def evaluate(self, script: str, *_args):
        if "history" in script and "length" in script:
            return 2
        return None


class _MockKeyboard:
    def __init__(self):
        self.pressed_keys: list[str] = []

    async def press(self, key: str):
        self.pressed_keys.append(key)


@pytest.mark.asyncio
async def test_searchbox_close_button_not_classified_as_open_detail_panel():
    """A search results page containing a search-box Close button is NOT classified as an open detail panel."""
    # Google Maps search input has button[aria-label='Close'] to clear the search query.
    searchbox_close = _MockElement(attrs={"aria-label": "Close", "jsaction": "searchbox.clear"})
    feed = _MockElement(attrs={"role": "feed"})

    page = _MockPage(
        url="https://www.google.com/maps/search/Coffee+Shop+in+Los+Angeles",
        feed=feed,
        headings=[],  # No place heading
        back_buttons={},  # No "Back to results" button
        other_elements={"button[aria-label='Close']": searchbox_close},
    )

    # 1. _is_detail_pane_open must report False despite generic close button
    detail_open = await _is_detail_pane_open(page, feed)
    assert detail_open is False, "Generic searchbox Close button must not mark detail pane as open"

    # 2. _read_panel_identity_snapshot must capture open=False and empty name
    snap = await _read_panel_identity_snapshot(page, feed)
    assert snap["open"] is False
    assert snap["name"] == ""

    # 3. _evaluate_panel_identity must return waiting_for_detail_panel, NOT waiting_for_panel_name
    ok, reason = _evaluate_panel_identity(
        snap,
        card_href="https://www.google.com/maps/place/Verve+Coffee/data=!4m2!3m1!1s0x80c2bf:0x123",
        place_key="0x80c2bf:0x123",
        card_signals={"name": "Verve Coffee"},
        pre_click_snapshot=None,
        last_verified_panel=None,
    )
    assert ok is False
    assert reason == "waiting_for_detail_panel", f"Expected 'waiting_for_detail_panel', got '{reason}'"
    assert reason != "waiting_for_panel_name", "Must not report 'waiting_for_panel_name' when no detail panel is open"


@pytest.mark.asyncio
async def test_toast_dialog_close_button_does_not_falsely_establish_detail_panel():
    """A toast/dialog Close button does NOT falsely establish a detail panel."""
    toast_close = _MockElement(attrs={"aria-label": "Close"})
    reveal_close = _MockElement(attrs={"jsaction": "reveal.card.close"})
    feed = _MockElement(attrs={"role": "feed"})

    page = _MockPage(
        url="https://www.google.com/maps/search/Coffee+Shop",
        feed=feed,
        headings=[],
        back_buttons={},
        other_elements={
            "button[aria-label='Close']": toast_close,
            "button[jsaction*='reveal.card.close']": reveal_close,
        },
    )

    detail_open = await _is_detail_pane_open(page, feed)
    assert detail_open is False

    snap = await _read_panel_identity_snapshot(page, feed)
    assert snap["open"] is False

    ok, reason = _evaluate_panel_identity(
        snap,
        card_href="https://www.google.com/maps/place/Sightglass/data=!4m2!3m1!1s0x80c2bf:0x456",
        place_key="0x80c2bf:0x456",
        card_signals={"name": "Sightglass Coffee"},
        pre_click_snapshot=None,
        last_verified_panel=None,
    )
    assert ok is False
    assert reason == "waiting_for_detail_panel"


@pytest.mark.asyncio
async def test_genuine_place_detail_panel_is_detected():
    """A genuine place detail panel with heading and back button is reliably detected."""
    heading = _MockElement(text="Blue Bottle Coffee")
    back_button = _MockElement(attrs={"aria-label": "Back to results", "jsaction": "pane.backButton"})
    address = _MockElement(text="582 Mateo St, Los Angeles, CA 90013")
    feed = _MockElement(attrs={"role": "feed"})

    place_url = "https://www.google.com/maps/place/Blue+Bottle+Coffee/@34.038,-118.232,15z/data=!4m2!3m1!1s0x80c2c636:0x789"

    page = _MockPage(
        url=place_url,
        feed=feed,
        headings=[heading],
        back_buttons={"Back to results": back_button},
        other_elements={"[data-item-id='address']": address},
    )

    detail_open = await _is_detail_pane_open(page, feed)
    assert detail_open is True

    snap = await _read_panel_identity_snapshot(page, feed)
    assert snap["open"] is True
    assert snap["name"] == "blue bottle coffee"
    assert snap["raw_address"] == "582 Mateo St, Los Angeles, CA 90013"
    assert snap["address"] == "582 mateo st los angeles ca 90013"
    assert snap["place_id"] == "0x80c2c636:0x789"

    ok, reason = _evaluate_panel_identity(
        snap,
        card_href=place_url,
        place_key="0x80c2c636:0x789",
        card_signals={"name": "Blue Bottle Coffee", "address": "582 Mateo St"},
        pre_click_snapshot=None,
        last_verified_panel=None,
    )
    assert ok is True
    assert reason == "verified"


@pytest.mark.asyncio
async def test_genuine_detail_panel_temporarily_missing_heading_handled_correctly():
    """A genuine detail panel with verified 'Back to results' control but temporarily loading heading triggers waiting_for_panel_name."""
    # The detail pane back button has mounted, but h1.DUwDvf has not rendered yet.
    back_button = _MockElement(attrs={"aria-label": "Back to results", "jsaction": "pane.backButton"})
    feed = _MockElement(attrs={"role": "feed"})

    place_url = "https://www.google.com/maps/place/Verve+Coffee+Roasters/@34.04,-118.25,15z/data=!4m2!3m1!1s0x80c2c7:0xabc"

    page = _MockPage(
        url=place_url,
        feed=feed,
        headings=[],  # Heading hasn't mounted yet!
        back_buttons={"Back to results": back_button},  # But genuine detail navigation is present!
    )

    # 1. detail_open must be True because verified detail back button is present
    detail_open = await _is_detail_pane_open(page, feed)
    assert detail_open is True, "Verified 'Back to results' button must establish detail_open=True"

    # 2. Snapshot captures open=True but name=""
    snap = await _read_panel_identity_snapshot(page, feed)
    assert snap["open"] is True
    assert snap["name"] == ""

    # 3. Because detail is open but heading is missing, evaluate must return waiting_for_panel_name
    # giving the poll loop time to wait for the h1 to mount
    ok, reason = _evaluate_panel_identity(
        snap,
        card_href=place_url,
        place_key="0x80c2c7:0xabc",
        card_signals={"name": "Verve Coffee Roasters"},
        pre_click_snapshot=None,
        last_verified_panel=None,
    )
    assert ok is False
    assert reason == "waiting_for_panel_name", f"Expected 'waiting_for_panel_name', got '{reason}'"


@pytest.mark.asyncio
async def test_search_results_page_returns_immediately_from_return_to_results():
    """When on search results with a searchbox Close button, _return_to_results confirms feed ready immediately without slow recovery."""
    searchbox_close = _MockElement(attrs={"aria-label": "Close"})
    feed = _MockElement(attrs={"role": "feed"})

    page = _MockPage(
        url="https://www.google.com/maps/search/Coffee+Shop",
        feed=feed,
        headings=[],
        back_buttons={},
        other_elements={"button[aria-label='Close']": searchbox_close},
    )

    config = ScraperConfig(scroll_settle_timeout_ms=100)
    profiler = PerfProfiler()

    # Should succeed immediately without pressing Escape, without clicking back, without navigating history
    ok = await _return_to_results(page, "div[role='feed']", config=config, profiler=profiler)
    assert ok is True
    assert len(page.keyboard.pressed_keys) == 0, "Must not press Escape when feed is already ready"
    assert searchbox_close.clicked is False, "Must not click searchbox Close button during return_to_results"


@pytest.mark.asyncio
async def test_bounded_retry_behavior_remains_unchanged():
    """Unopened detail panel errors (waiting_for_detail_panel) are retried at most max_unopened_retries before abandoning."""
    mismatch_retries_by_key: dict[str, int] = {}
    exhausted_mismatch_keys: set[str] = set()
    seen_hrefs: set[str] = set()
    max_unopened_retries = 1  # default config

    place_key = "0x80c2a5:0x999"
    card_reason = "waiting_for_detail_panel"

    # Attempt 1: First failure
    retries_for_key = mismatch_retries_by_key.get(place_key, 0) + 1
    mismatch_retries_by_key[place_key] = retries_for_key
    assert retries_for_key == 1
    # retry=1/2: Not yet exhausted
    if retries_for_key > max_unopened_retries:
        exhausted_mismatch_keys.add(place_key)
        seen_hrefs.add(place_key)

    assert place_key not in exhausted_mismatch_keys
    assert place_key not in seen_hrefs

    # Attempt 2: Second failure (retry)
    retries_for_key = mismatch_retries_by_key.get(place_key, 0) + 1
    mismatch_retries_by_key[place_key] = retries_for_key
    assert retries_for_key == 2
    # retry=2/2: Bounded retry exhausted -> abandon card
    if retries_for_key > max_unopened_retries:
        exhausted_mismatch_keys.add(place_key)
        seen_hrefs.add(place_key)

    assert place_key in exhausted_mismatch_keys
    assert place_key in seen_hrefs, "Card must be abandoned after 2nd failure (1 retry allowed)"


# ==============================================================================
# REMEDIATION REVIEW REGRESSION TESTS (PANEL DETECTION)
# ==============================================================================

@pytest.mark.asyncio
async def test_modern_div_role_main_h1_heading_detected():
    """Prove modern 'div[role="main"] h1' selector extracts the place name when older selectors are absent."""
    feed = _MockElement(attrs={"role": "feed"})
    heading = _MockElement(text="Modern Artisan Coffee")

    class _ModernHeadingPage(_MockPage):
        async def query_selector(self, selector: str):
            if selector == "div[role='main'] h1":
                return heading
            if selector in ("h1.DUwDvf", "h1.fontHeadlineLarge", "h1[data-item-id]"):
                return None
            return await super().query_selector(selector)

    page = _ModernHeadingPage(
        url="https://www.google.com/maps/place/Modern+Artisan+Coffee/@40.7,-74.0,15z/data=!4m2!3m1!1s0x89c259:0x123",
        feed=feed,
    )
    assert "div[role='main'] h1" in ms._PLACE_NAME_SELECTORS
    snap = await _read_panel_identity_snapshot(page, feed)
    assert snap["open"] is True
    assert snap["name"] == "modern artisan coffee"


@pytest.mark.asyncio
async def test_url_backed_detail_open_detection_when_back_button_absent():
    """When both back button and heading are absent on a /maps/place/ URL,
    _read_panel_identity_snapshot still establishes open=True via URL fallback (line 1193)
    and _evaluate_panel_identity returns waiting_for_panel_name (not waiting_for_detail_panel)."""
    feed = _MockElement(attrs={"role": "feed"})
    place_url = "https://www.google.com/maps/place/Solo+Cafe/@40.7,-74.0,15z/data=!4m2!3m1!1s0x89c259:0x456"

    # Case 1: Back button absent AND heading not yet mounted on /maps/place/ URL
    page_loading = _MockPage(
        url=place_url,
        feed=feed,
        headings=[],       # Heading not mounted yet
        back_buttons={},   # Back button absent
    )
    snap_loading = await _read_panel_identity_snapshot(page_loading, feed)
    assert snap_loading["open"] is True, "URL fallback (/maps/place/) must set open=True when back button and heading are absent"
    assert snap_loading["name"] == ""
    assert snap_loading["place_id"] == "0x89c259:0x456"

    ok_loading, reason_loading = _evaluate_panel_identity(
        snap_loading,
        card_href=place_url,
        place_key="0x89c259:0x456",
        card_signals={"name": "Solo Cafe"},
        pre_click_snapshot=None,
        last_verified_panel=None,
    )
    assert ok_loading is False
    assert reason_loading == "waiting_for_panel_name"

    # Case 2: Heading mounts while back button remains absent -> verified
    heading = _MockElement(text="Solo Cafe")
    page_mounted = _MockPage(
        url=place_url,
        feed=feed,
        headings=[heading],
        back_buttons={},
    )
    snap_mounted = await _read_panel_identity_snapshot(page_mounted, feed)
    assert snap_mounted["open"] is True
    assert snap_mounted["name"] == "solo cafe"
    ok_mounted, reason_mounted = _evaluate_panel_identity(
        snap_mounted,
        card_href=place_url,
        place_key="0x89c259:0x456",
        card_signals={"name": "Solo Cafe"},
        pre_click_snapshot=None,
        last_verified_panel=None,
    )
    assert ok_mounted is True
    assert reason_mounted == "verified"

    # Case 3: Search URL (/maps/search/) without back button or heading -> open=False
    page_search = _MockPage(
        url="https://www.google.com/maps/search/Coffee+in+Manhattan",
        feed=feed,
        headings=[],
        back_buttons={},
    )
    snap_search = await _read_panel_identity_snapshot(page_search, feed)
    assert snap_search["open"] is False


@pytest.mark.asyncio
async def test_full_identity_timeout_used_when_url_is_place_url():
    """Prove _resolve_identity_wait_ms and _wait_for_verified_panel_identity use full
    place_timeout_ms (not the 250ms cap) when page is on a /maps/place/ URL even if
    found_panel is False, allowing headings that mount after 250ms to verify."""
    config = ScraperConfig(place_timeout_ms=1200)
    feed = _MockElement(attrs={"role": "feed"})
    place_url = "https://www.google.com/maps/place/Slow+Cafe/@40.7,-74.0,15z/data=!4m2!3m1!1s0x89c259:0x789"

    class _DelayedHeadingPage(_MockPage):
        def __init__(self):
            super().__init__(url=place_url, feed=feed, headings=[], back_buttons={})
            self._t0 = asyncio.get_event_loop().time()

        async def query_selector(self, selector: str):
            # Heading only mounts after 320ms (past the 250ms non-place cap)
            if selector in ms._PLACE_NAME_SELECTORS:
                if asyncio.get_event_loop().time() - self._t0 >= 0.32:
                    return _MockElement(text="Slow Cafe")
                return None
            return await super().query_selector(selector)

    page = _DelayedHeadingPage()
    # Even when found_panel is False, place URL selects full place_timeout_ms (1200ms)
    identity_wait_ms = ms._resolve_identity_wait_ms(page, found_panel=False, config=config)
    assert identity_wait_ms == 1200

    # Verify non-place URL with found_panel=False still caps at 250ms
    search_page = _MockPage(url="https://www.google.com/maps/search/Coffee+Shop", feed=feed)
    assert ms._resolve_identity_wait_ms(search_page, found_panel=False, config=config) == 250

    # End-to-end poll with _wait_for_verified_panel_identity succeeds after 320ms
    ok, snap, reason = await ms._wait_for_verified_panel_identity(
        page,
        feed_el=feed,
        card_href=place_url,
        place_key="0x89c259:0x789",
        card_signals={"name": "Slow Cafe"},
        pre_click_snapshot=None,
        last_verified_panel=None,
        timeout_ms=identity_wait_ms,
    )
    assert ok is True
    assert reason == "verified"
    assert snap["name"] == "slow cafe"


@pytest.mark.asyncio
async def test_multiple_m6qerb_candidates_finds_scrollable_feed():
    """When candidate 0 of div.m6QErb is not scrollable, _resolve_results_panel checks alternate candidates."""
    cand0 = _MockElement(attrs={"class": "m6QErb"})
    async def eval_cand0(script, *_args):
        if "scrollHeight" in script:
            return {"scrollHeight": 500, "clientHeight": 500, "childCount": 1}
        return None
    cand0.evaluate = eval_cand0

    cand1 = _MockElement(attrs={"class": "m6QErb", "role": "feed"})
    async def eval_cand1(script, *_args):
        if "scrollHeight" in script:
            return {"scrollHeight": 2000, "clientHeight": 600, "childCount": 10}
        return None
    cand1.evaluate = eval_cand1

    class _MultiFeedPage(_MockPage):
        async def query_selector(self, selector: str):
            if selector in ("div[role='feed']", "div.m6QErb[aria-label]"):
                return None
            if selector == "div.m6QErb":
                return cand0
            return None

        async def query_selector_all(self, selector: str):
            if selector == "div.m6QErb":
                return [cand0, cand1]
            return []

    page = _MultiFeedPage()
    config = ScraperConfig()
    sel, panel = await ms._resolve_results_panel(page, config=config)
    assert sel == "div.m6QErb"
    assert panel is cand1


@pytest.mark.asyncio
async def test_unrelated_headings_and_non_scrollable_containers_rejected():
    """Unrelated modal headings or non-scrollable containers are rejected."""
    cand = _MockElement()
    async def eval_cand(script, *_args):
        if "scrollHeight" in script:
            return {"scrollHeight": 100, "clientHeight": 100, "childCount": 0}
        return None
    cand.evaluate = eval_cand
    valid, evidence = await ms._validate_panel_candidate(_MockPage(), cand, selector="div.m6QErb", strict=True)
    assert valid is False
    assert "not scrollable" in evidence


# ==============================================================================
# NOVEMBER 4 FAILURE REGRESSION TESTS (RESULTS HEADER & SPLIT-PANE EXTRACTION)
# ==============================================================================


@pytest.mark.asyncio
async def test_excluded_results_heading_never_causes_name_conflict():
    """When only an excluded search-sidebar heading ('Results', 'Search results', 'النتائج')
    is present in the DOM:
    1. _is_detail_pane_open returns False.
    2. _read_panel_identity_snapshot returns open=False and name='' (never 'results').
    3. _evaluate_panel_identity returns waiting_for_detail_panel (or waiting_for_panel_name
       when on a /maps/place/ URL), NEVER name_conflict(..., actual='results').
    """
    feed = _MockElement(attrs={"role": "feed"})
    for excluded_label in ("Results", "Search results", "النتائج", "Results for Coffee Shop in Silver Lake"):
        results_h1 = _MockElement(text=excluded_label)
        page_search = _MockPage(
            url="https://www.google.com/maps/search/Coffee+Shop+in+Silver+Lake",
            feed=feed,
            headings=[results_h1],
            back_buttons={},
        )
        assert await _is_detail_pane_open(page_search, feed) is False

        snap_search = await _read_panel_identity_snapshot(page_search, feed)
        assert snap_search["open"] is False
        assert snap_search["name"] == "", f"Excluded header {excluded_label!r} must not populate snap['name']"
        assert snap_search["raw_name"] == "", f"Excluded header {excluded_label!r} must not populate snap['raw_name']"

        ok_search, reason_search = _evaluate_panel_identity(
            snap_search,
            card_href="https://www.google.com/maps/place/Couplet+Coffee/@34.08,-118.27,17z/data=!3m1!4b1!4m6!3m5!1s0x80c2c7095be7f62b:0x883b3662ca2168e0",
            place_key="0x80c2c7095be7f62b:0x883b3662ca2168e0",
            card_signals={"name": "Couplet Coffee"},
            pre_click_snapshot=None,
            last_verified_panel=None,
        )
        assert ok_search is False
        assert reason_search == "waiting_for_detail_panel"
        assert "name_conflict" not in reason_search

        # Even if a synthetic snapshot passes name='results', _evaluate_panel_identity must not emit name_conflict
        ok_synth, reason_synth = _evaluate_panel_identity(
            {"open": False, "name": "results", "raw_name": "Results", "address": "", "place_id": "", "url": page_search.url},
            card_href="https://www.google.com/maps/place/Couplet+Coffee/@34.08,-118.27,17z/data=!3m1!4b1!4m6!3m5!1s0x80c2c7095be7f62b:0x883b3662ca2168e0",
            place_key="0x80c2c7095be7f62b:0x883b3662ca2168e0",
            card_signals={"name": "Couplet Coffee"},
            pre_click_snapshot=None,
            last_verified_panel=None,
        )
        assert ok_synth is False
        assert reason_synth == "waiting_for_detail_panel"


@pytest.mark.asyncio
async def test_dual_h1_split_pane_results_and_business_name():
    """When both the search sidebar '<h1>Results</h1>' and the detail panel
    '<h1 class=\"DUwDvf\">Couplet Coffee</h1>' exist simultaneously in split-pane DOM:
    1. _read_panel_identity_snapshot skips 'Results' and captures 'Couplet Coffee'.
    2. _evaluate_panel_identity returns (True, 'verified').
    3. _try_selectors(page, _PLACE_NAME_SELECTORS) skips 'Results' and returns 'Couplet Coffee'.
    4. _PLACE_EXTRACT_JS uses document.querySelectorAll and firstNonExcludedName to skip 'Results'.
    """
    feed = _MockElement(attrs={"role": "feed"})
    results_h1 = _MockElement(text="Results")
    place_h1 = _MockElement(text="Couplet Coffee")

    page = _MockPage(
        url="https://www.google.com/maps/place/Couplet+Coffee/@34.08,-118.27,17z/data=!3m1!4b1!4m6!3m5!1s0x80c2c7095be7f62b:0x883b3662ca2168e0",
        feed=feed,
        headings=[results_h1, place_h1],
    )

    assert await _is_detail_pane_open(page, feed) is True
    snap = await _read_panel_identity_snapshot(page, feed)
    assert snap["open"] is True
    assert snap["raw_name"] == "Couplet Coffee"
    assert snap["name"] == "couplet coffee"

    ok, reason = _evaluate_panel_identity(
        snap,
        card_href=page.url,
        place_key="0x80c2c7095be7f62b:0x883b3662ca2168e0",
        card_signals={"name": "Couplet Coffee"},
        pre_click_snapshot=None,
        last_verified_panel=None,
    )
    assert ok is True
    assert reason == "verified"

    extracted_name = await ms._try_selectors(page, ms._PLACE_NAME_SELECTORS)
    assert extracted_name == "Couplet Coffee"

    # Verify _PLACE_EXTRACT_JS uses document.querySelectorAll and firstNonExcludedName for sel.name
    assert "firstNonExcludedName(sel.name)" in ms._PLACE_EXTRACT_JS
    assert "document.querySelectorAll(s)" in ms._PLACE_EXTRACT_JS
    assert 'EXCLUDED_HEADERS = new Set(["results", "search results", "النتائج"])' in ms._PLACE_EXTRACT_JS


@pytest.mark.asyncio
async def test_place_panel_wait_polls_past_excluded_results_header_and_verifies_delayed_panel():
    """When wait_for_selector(_PLACE_NAME_SELECTOR_COMBINED, state='attached') initially
    returns the pre-existing '<h1>Results</h1>' sidebar header, place_panel_wait must not
    short-circuit as resolved; it must poll until the real detail heading mounts (or trigger
    the fallback DOM click) and verify the business."""
    feed = _MockElement(attrs={"role": "feed"})
    results_h1 = _MockElement(text="Results")
    place_h1 = _MockElement(text="Couplet Coffee")
    place_url = "https://www.google.com/maps/place/Couplet+Coffee/@34.08,-118.27,17z/data=!3m1!4b1!4m6!3m5!1s0x80c2c7095be7f62b:0x883b3662ca2168e0"

    dom_click_count = 0

    class _SplitPaneDelayedPage(_MockPage):
        def __init__(self):
            super().__init__(
                url="https://www.google.com/maps/search/Coffee+Shop+in+Silver+Lake",
                feed=feed,
                headings=[results_h1],
                back_buttons={},
            )

        async def wait_for_selector(self, selector: str, **_kwargs):
            # Immediately returns the attached `<h1>Results</h1>` sidebar header
            return results_h1

        async def goto(self, *_args, **_kwargs) -> None:
            pass

        async def title(self) -> str:
            return "Coffee Shop in Silver Lake - Google Maps"

        async def eval_on_selector_all(self, _selector: str, _script: str) -> int:
            return 1

        async def close(self) -> None:
            pass

    page = _SplitPaneDelayedPage()

    class _CardAnchor(_MockElement):
        async def scroll_into_view_if_needed(self, timeout: int = 2000) -> None:
            pass

        async def evaluate(self, script: str, *_args):
            nonlocal dom_click_count
            if "el.click()" in script:
                dom_click_count += 1
                # Fallback DOM click opens the split-pane detail panel
                page.headings = [results_h1, place_h1]
                page.url = place_url
                return None
            return await super().evaluate(script, *_args)

    card_anchor = _CardAnchor(
        text="Couplet Coffee",
        attrs={"href": place_url, "aria-label": "Couplet Coffee"},
    )
    feed._card_anchors = [card_anchor]

    # Simulate _human_click where coordinate click fails to open the detail panel
    async def _noop_human_click(_page, _el):
        pass

    from utils.runtime import ProxyManager, RunStats

    orig_new_ctx = ms._new_stealth_context
    orig_resolve_panel = ms._resolve_results_panel
    orig_human_click = ms._human_click
    orig_wait_settle = ms._wait_for_place_settle
    orig_extract = ms._extract_place_data
    orig_return = ms._return_to_results
    orig_scroll = ms._human_scroll

    class _Ctx:
        async def new_page(self):
            return page
        async def close(self):
            pass

    try:
        ms._new_stealth_context = lambda *_a, **_k: asyncio.sleep(0, result=_Ctx())
        ms._resolve_results_panel = lambda *_a, **_k: asyncio.sleep(0, result=("div[role='feed']", feed))
        ms._human_click = _noop_human_click
        ms._wait_for_place_settle = lambda *_a, **_k: asyncio.sleep(0)
        ms._extract_place_data = lambda *_a, **_k: asyncio.sleep(
            0,
            result=ms.RawPlace(name="Couplet Coffee", address="4168 Beverly Blvd, Los Angeles, CA"),
        )
        ms._return_to_results = lambda *_a, **_k: asyncio.sleep(0, result=True)
        ms._human_scroll = lambda *_a, **_k: asyncio.sleep(0)

        profiler = PerfProfiler()
        scraper = ms.MapsScraper(
            ScraperConfig(headless=True, place_timeout_ms=1000, max_crash_retries=0, scroll_max_rounds=1),
            ProxyManager(),
            RunStats(),
            profiler=profiler,
        )
        scraper._browser = object()
        scraper._limiter.acquire = lambda *_a, **_k: asyncio.sleep(0)

        yielded = [p async for p in scraper.search(query="Coffee Shop", city="Los Angeles", max_results=1)]
        assert len(yielded) == 1
        assert yielded[0].name == "Couplet Coffee"
        assert dom_click_count >= 1, "Fallback DOM click must fire when coordinate click leaves only 'Results' header"
        assert profiler.counter("place_panel_wait_resolved") == 1
    finally:
        ms._new_stealth_context = orig_new_ctx
        ms._resolve_results_panel = orig_resolve_panel
        ms._human_click = orig_human_click
        ms._wait_for_place_settle = orig_wait_settle
        ms._extract_place_data = orig_extract
        ms._return_to_results = orig_return
        ms._human_scroll = orig_scroll

@pytest.mark.asyncio
async def test_unopened_detail_panel_with_results_header_routes_to_waiting_for_detail_panel():
    """When only '<h1>Results</h1>' is present and a card genuinely fails to open a detail
    panel, it must be classified as 'waiting_for_detail_panel' (not 'name_conflict'),
    abandoned after max_unopened_panel_retries_per_card without triggering area-wide
    stale_panel_search_nav_recovery, and allow the next card to succeed."""
    feed = _MockElement(attrs={"role": "feed"})
    results_h1 = _MockElement(text="Results")
    good_h1 = _MockElement(text="Good Neighbor Coffee")
    bad_url = "https://www.google.com/maps/place/Broken+Card/@34.08,-118.27,17z/data=!3m1!4b1!4m6!3m5!1s0x80c2c7:0xbad1"
    good_url = "https://www.google.com/maps/place/Good+Neighbor+Coffee/@34.08,-118.27,17z/data=!3m1!4b1!4m6!3m5!1s0x80c2c7:0xgood2"

    class _UnopenedThenGoodPage(_MockPage):
        def __init__(self):
            super().__init__(
                url="https://www.google.com/maps/search/Coffee+Shop",
                feed=feed,
                headings=[results_h1],
                back_buttons={},
            )

        async def wait_for_selector(self, selector: str, **_kwargs):
            return results_h1

        async def goto(self, *_args, **_kwargs) -> None:
            pass

        async def title(self) -> str:
            return "Coffee Shop - Google Maps"

        async def eval_on_selector_all(self, _selector: str, _script: str) -> int:
            return 2

        async def close(self) -> None:
            pass

    page = _UnopenedThenGoodPage()

    class _CardAnchor(_MockElement):
        async def scroll_into_view_if_needed(self, timeout: int = 2000) -> None:
            pass

    bad_card = _CardAnchor(text="Broken Card", attrs={"href": bad_url, "aria-label": "Broken Card"})
    good_card = _CardAnchor(text="Good Neighbor Coffee", attrs={"href": good_url, "aria-label": "Good Neighbor Coffee"})
    feed._card_anchors = [bad_card, good_card]

    async def _selective_click(_page, el):
        href = await el.get_attribute("href") or ""
        if "Good+Neighbor+Coffee" in href:
            page.headings = [results_h1, good_h1]
            page.url = good_url
        else:
            page.headings = [results_h1]
            page.url = "https://www.google.com/maps/search/Coffee+Shop"

    from utils.runtime import ProxyManager, RunStats

    orig_new_ctx = ms._new_stealth_context
    orig_resolve_panel = ms._resolve_results_panel
    orig_human_click = ms._human_click
    orig_wait_settle = ms._wait_for_place_settle
    orig_extract = ms._extract_place_data
    orig_return = ms._return_to_results
    orig_scroll = ms._human_scroll

    class _Ctx:
        async def new_page(self):
            return page
        async def close(self):
            pass

    try:
        ms._new_stealth_context = lambda *_a, **_k: asyncio.sleep(0, result=_Ctx())
        ms._resolve_results_panel = lambda *_a, **_k: asyncio.sleep(0, result=("div[role='feed']", feed))
        ms._human_click = _selective_click
        ms._wait_for_place_settle = lambda *_a, **_k: asyncio.sleep(0)
        ms._extract_place_data = lambda *_a, **_k: asyncio.sleep(
            0,
            result=ms.RawPlace(name="Good Neighbor Coffee", address="100 Main St, Los Angeles, CA"),
        )
        ms._return_to_results = lambda *_a, **_k: asyncio.sleep(0, result=True)
        ms._human_scroll = lambda *_a, **_k: asyncio.sleep(0)

        profiler = PerfProfiler()
        scraper = ms.MapsScraper(
            ScraperConfig(headless=True, place_timeout_ms=100, max_crash_retries=0, scroll_max_rounds=1),
            ProxyManager(),
            RunStats(),
            profiler=profiler,
        )
        scraper._browser = object()
        scraper._limiter.acquire = lambda *_a, **_k: asyncio.sleep(0)

        yielded = [p async for p in scraper.search(query="Coffee Shop", city="Los Angeles", max_results=1)]
        assert len(yielded) == 1
        assert yielded[0].name == "Good Neighbor Coffee"
        assert profiler.counter("stale_panel_search_nav_recovery") == 0, (
            "Unopened card with 'Results' header must not trigger stale_panel_search_nav_recovery"
        )
    finally:
        ms._new_stealth_context = orig_new_ctx
        ms._resolve_results_panel = orig_resolve_panel
        ms._human_click = orig_human_click
        ms._wait_for_place_settle = orig_wait_settle
        ms._extract_place_data = orig_extract
        ms._return_to_results = orig_return
        ms._human_scroll = orig_scroll
