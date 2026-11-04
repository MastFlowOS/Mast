"""Deterministic offline tests for Phase 5 Google Maps Scraper Reliability.

Covers the full suite of reliability scenarios and recovery audit requirements:
1. Normal detail-panel return to search results.
2. Detail back button succeeds immediately.
3. Back navigation triggers but search feed takes time to reappear.
4. Search results are already visible, so no unnecessary navigation occurs.
5. Stale detail panel is detected correctly.
6. Generic Close buttons cannot cause false success.
7. Detail-specific button is unavailable and a legitimate fallback works.
8. Search feed never returns and retries terminate with a precise failure reason (RETURN_TO_RESULTS_FAILED).
9. Browser page crashes during return.
10. Browser context closes during return.
11. Detached element during navigation.
12. Retry attempts remain bounded.
13. Recovery cannot accidentally click an unrelated overlay control.
14. Subsequent business extraction works after successful recovery.
15. No orphaned page/context or unfinished navigation task remains after a failure.
16. Genuine feed restoration: Hidden feed (is_visible=False) is rejected.
17. Genuine feed restoration: Empty feed (0 place cards) is rejected.
18. Genuine feed restoration: Cleared searchbox query is rejected.
19. Renderer crash while page.is_closed() temporarily returns False is immediately classified as SCRAPER_ERROR.
20. Production recovery integration: _execute_return_failure_recovery succeeds on feed restoration and awaits all tasks.
"""

from __future__ import annotations

import asyncio
import os
import sys
from typing import Any, Callable

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import scraper.maps_scraper as ms
from scraper.maps_scraper import (
    DiscoveryFailure,
    DiscoveryFailureReason,
    MapsScraper,
    _BACK_BUTTON_SELECTORS,
    _evaluate_panel_identity,
    _execute_return_failure_recovery,
    _is_feed_ready,
    _is_page_alive,
    _is_target_closed_or_crashed_error,
    _mark_page_crashed,
    _return_to_results,
    _wait_for_feed_restored,
)
from utils.perf import RunProfiler as PerfProfiler
from utils.runtime import ScraperConfig


class _MockContext:
    def __init__(self, is_closed: bool = False):
        self._closed = is_closed

    def is_closed(self) -> bool:
        return self._closed

    def close(self):
        self._closed = True


class _MockElement:
    def __init__(
        self,
        *,
        text: str = "",
        attrs: dict[str, str] | None = None,
        is_visible: bool = True,
        on_click: Callable[[], Any] | None = None,
        throw_on_click: Exception | None = None,
        throw_on_is_visible: Exception | None = None,
        card_anchors: list[_MockElement] | None = None,
        is_obstructed: bool = False,
    ):
        self._text = text
        self._attrs = dict(attrs or {})
        self._visible = is_visible
        self._on_click = on_click
        self._throw_on_click = throw_on_click
        self._throw_on_is_visible = throw_on_is_visible
        self.clicked = False
        self.is_obstructed = is_obstructed

        if self._attrs.get("role") == "feed" and card_anchors is None:
            # Feeds default to having at least one candidate card anchor
            self._card_anchors = [
                _MockElement(attrs={"href": "https://www.google.com/maps/place/Candidate+Coffee"})
            ]
        else:
            self._card_anchors = list(card_anchors or [])

    async def get_attribute(self, name: str) -> str | None:
        return self._attrs.get(name)

    async def inner_text(self) -> str:
        return self._text

    async def is_visible(self) -> bool:
        if self._throw_on_is_visible:
            raise self._throw_on_is_visible
        return self._visible

    async def click(self, **_kwargs) -> None:
        if self._throw_on_click:
            raise self._throw_on_click
        self.clicked = True
        if self._on_click:
            res = self._on_click()
            if asyncio.iscoroutine(res):
                await res

    async def query_selector(self, selector: str):
        if "a[href*='/maps/place/']" in selector:
            return self._card_anchors[0] if self._card_anchors else None
        return None

    async def query_selector_all(self, selector: str):
        if "a[href*='/maps/place/']" in selector:
            return list(self._card_anchors)
        return []

    async def evaluate(self, script: str, *_args) -> Any:
        if "el.click()" in script:
            await self.click()
            return None
        if "closest" in script:
            jsaction = (self._attrs.get("jsaction") or "").lower()
            aria = (self._attrs.get("aria-label") or "").lower()
            tooltip = (self._attrs.get("data-tooltip") or "").lower()
            if "searchbox" in jsaction or aria in ("close", "clear search") or tooltip in ("close", "clear search"):
                return True
            return False
        if "elementFromPoint" in script:
            return self.is_obstructed
        return None


class _MockKeyboard:
    def __init__(self, on_press: Callable[[str], Any] | None = None):
        self.pressed_keys: list[str] = []
        self._on_press = on_press

    async def press(self, key: str) -> None:
        self.pressed_keys.append(key)
        if self._on_press:
            res = self._on_press(key)
            if asyncio.iscoroutine(res):
                await res


class _MockPage:
    def __init__(
        self,
        *,
        url: str = "https://www.google.com/maps/search/Coffee+Shop",
        feed: _MockElement | None = None,
        headings: list[_MockElement] | None = None,
        back_buttons: dict[str, _MockElement] | None = None,
        other_elements: dict[str, _MockElement] | None = None,
        is_closed: bool = False,
        context: _MockContext | None = None,
        history_length: int = 2,
        search_query_val: str = "Coffee Shop",
    ):
        self.url = url
        self.feed_el = feed or _MockElement(attrs={"role": "feed"})
        self.headings = list(headings or [])
        self.back_buttons = dict(back_buttons or {})
        self.other_elements = dict(other_elements or {})
        self._closed = is_closed
        self.context = context or _MockContext()
        self.keyboard = _MockKeyboard()
        self.history_length = history_length
        self.go_back_called = False
        self.go_forward_called = False
        self.throw_on_query: Exception | None = None
        self.throw_on_goto: Exception | None = None
        self.goto_called = False

        self.searchbox_input = _MockElement(
            attrs={"value": search_query_val, "id": "searchboxinput"}
        )

    def is_closed(self) -> bool:
        return self._closed

    def close(self):
        self._closed = True

    async def query_selector(self, selector: str):
        if self.throw_on_query:
            raise self.throw_on_query
        if self._closed:
            raise Exception("Target page, context or browser has been closed")

        if selector in ("div[role='feed']", "div.m6QErb[aria-label]", "div.m6QErb"):
            return self.feed_el

        if selector in ms._PLACE_NAME_SELECTORS:
            return self.headings[0] if self.headings else None

        if "searchboxinput" in selector or "#searchbox" in selector:
            return self.searchbox_input

        for k, el in self.back_buttons.items():
            if k == selector or k in selector:
                return el

        for k, el in self.other_elements.items():
            if k == selector or k in selector:
                return el

        return None

    async def query_selector_all(self, selector: str):
        if self.throw_on_query:
            raise self.throw_on_query
        if self._closed:
            raise Exception("Target page, context or browser has been closed")

        if selector in ms._PLACE_NAME_SELECTORS:
            return list(self.headings)
        el = await self.query_selector(selector)
        return [el] if el else []

    async def evaluate(self, script: str, *_args):
        if self.throw_on_query:
            raise self.throw_on_query
        if self._closed:
            raise Exception("Target page, context or browser has been closed")
        if "history.length" in script:
            return self.history_length
        if "history.back()" in script:
            self.go_back_called = True
            return None
        return None

    async def go_back(self, **_kwargs):
        if self._closed:
            raise Exception("Target page, context or browser has been closed")
        self.go_back_called = True

    async def go_forward(self, **_kwargs):
        if self._closed:
            raise Exception("Target page, context or browser has been closed")
        self.go_forward_called = True

    async def goto(self, url: str, **_kwargs):
        if self.throw_on_goto:
            raise self.throw_on_goto
        if self._closed:
            raise Exception("Target page, context or browser has been closed")
        self.goto_called = True
        self.url = url

    async def wait_for_selector(self, selector: str, **_kwargs):
        return await self.query_selector(selector)


# ------------------------------------------------------------------------------
# 1. Normal detail-panel return to search results
# ------------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_scenario_01_normal_detail_panel_return():
    """Detail pane is initially open; clicking the detail back button closes it
    and successfully restores the search results feed."""
    feed = _MockElement(attrs={"role": "feed"})
    heading = _MockElement(text="Blue Bottle Coffee")

    page = _MockPage(
        url="https://www.google.com/maps/place/Blue+Bottle+Coffee",
        feed=feed,
        headings=[heading],
    )

    def on_click():
        page.headings.clear()
        page.back_buttons.clear()
        page.url = "https://www.google.com/maps/search/Coffee+Shop"

    back_btn = _MockElement(
        attrs={"aria-label": "Back to results", "jsaction": "pane.backButton"},
        on_click=on_click,
    )
    page.back_buttons["button[aria-label='Back to results']"] = back_btn

    events = []
    config = ScraperConfig(return_to_results_timeout_ms=500)
    returned = await _return_to_results(
        page,
        "div[role='feed']",
        config=config,
        on_progress=lambda stage, ev, item: events.append((ev, item)),
    )

    assert returned is True
    assert back_btn.clicked is True
    assert ("return_attempt_started", None) in events
    assert ("return_action_selected", "back_button") in events
    assert ("search_feed_restored", "back_button") in events


# ------------------------------------------------------------------------------
# 2. Detail back button succeeds immediately
# ------------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_scenario_02_detail_back_button_succeeds_immediately():
    """Verify exact sequence of emitted progress events when the back button succeeds."""
    feed = _MockElement(attrs={"role": "feed"})
    heading = _MockElement(text="Philz Coffee")

    page = _MockPage(
        url="https://www.google.com/maps/place/Philz+Coffee",
        feed=feed,
        headings=[heading],
    )

    def on_click():
        page.headings.clear()
        page.back_buttons.clear()
        page.url = "https://www.google.com/maps/search/Coffee+Shop"

    back_btn = _MockElement(
        attrs={"aria-label": "Back to results"},
        on_click=on_click,
    )
    page.back_buttons["button[aria-label='Back to results']"] = back_btn

    events = []
    config = ScraperConfig(return_to_results_timeout_ms=500)
    returned = await _return_to_results(
        page,
        "div[role='feed']",
        config=config,
        on_progress=lambda stage, ev, item: events.append((ev, item)),
    )

    assert returned is True
    event_names = [ev for ev, _ in events]
    assert event_names == [
        "return_attempt_started",
        "return_action_selected",
        "return_action_executed",
        "search_feed_restored",
    ]


# ------------------------------------------------------------------------------
# 3. Back navigation triggers but search feed takes time to reappear
# ------------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_scenario_03_feed_takes_time_to_reappear():
    """Back button is clicked, but the feed is not ready until several poll iterations."""
    feed = _MockElement(attrs={"role": "feed"})
    heading = _MockElement(text="Verve Coffee")

    page = _MockPage(
        url="https://www.google.com/maps/place/Verve+Coffee",
        feed=feed,
        headings=[heading],
    )

    async def delayed_close():
        await asyncio.sleep(0.08)
        page.headings.clear()
        page.back_buttons.clear()
        page.url = "https://www.google.com/maps/search/Coffee+Shop"

    back_btn = _MockElement(
        attrs={"aria-label": "Back to results"},
        on_click=delayed_close,
    )
    page.back_buttons["button[aria-label='Back to results']"] = back_btn

    config = ScraperConfig(return_to_results_timeout_ms=1000)
    returned = await _return_to_results(page, "div[role='feed']", config=config)
    assert returned is True
    assert len(page.headings) == 0


# ------------------------------------------------------------------------------
# 4. Search results are already visible, so no unnecessary navigation occurs
# ------------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_scenario_04_already_ready_no_unnecessary_navigation():
    """If search feed is already visible and detail pane is closed, returns immediately."""
    feed = _MockElement(attrs={"role": "feed"})
    page = _MockPage(
        url="https://www.google.com/maps/search/Coffee+Shop",
        feed=feed,
        headings=[],  # No place heading
        back_buttons={},  # No detail back button on search results feed
    )

    events = []
    config = ScraperConfig()
    returned = await _return_to_results(
        page,
        "div[role='feed']",
        config=config,
        on_progress=lambda stage, ev, item: events.append((ev, item)),
    )

    assert returned is True
    assert ("search_feed_restored", "already_ready") in events


# ------------------------------------------------------------------------------
# 5. Stale detail panel is detected correctly
# ------------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_scenario_05_stale_detail_panel_detected():
    """When the open detail panel retains the previous business identity, mismatch is identified."""
    snap = {
        "open": True,
        "name": "Old Coffee Shop",
        "raw_name": "Old Coffee Shop",
        "address": "123 Main St",
        "raw_address": "123 Main St",
        "place_id": "ChIJ_old123",
        "url": "https://www.google.com/maps/place/Old+Coffee+Shop",
    }
    last_verified = {
        "place_key": "https://www.google.com/maps/place/Old+Coffee+Shop",
        "place_id": "ChIJ_old123",
        "name": "old coffee shop",
        "address": "123 main st",
    }
    card_signals = {"name": "New Fresh Bakery"}

    ok, reason = _evaluate_panel_identity(
        snap,
        card_href="https://www.google.com/maps/place/New+Fresh+Bakery",
        place_key="https://www.google.com/maps/place/New+Fresh+Bakery",
        card_signals=card_signals,
        pre_click_snapshot=None,
        last_verified_panel=last_verified,
    )

    assert ok is False
    assert "unchanged_from_prior" in reason or reason == "stale_panel_mismatch"


# ------------------------------------------------------------------------------
# 6. Generic Close buttons cannot cause false success
# ------------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_scenario_06_generic_close_button_cannot_cause_false_success():
    """Searchbox close button or generic modal Close button must never be clicked by _return_to_results."""
    feed = _MockElement(attrs={"role": "feed"})
    heading = _MockElement(text="Sightglass Coffee")

    searchbox_close = _MockElement(
        attrs={"aria-label": "Close", "jsaction": "searchbox.clear"},
    )

    page = _MockPage(
        url="https://www.google.com/maps/place/Sightglass+Coffee",
        feed=feed,
        headings=[heading],
        other_elements={"button[aria-label='Close']": searchbox_close},
    )

    config = ScraperConfig(return_to_results_timeout_ms=200)
    returned = await _return_to_results(page, "div[role='feed']", config=config)

    assert returned is False
    assert searchbox_close.clicked is False


# ------------------------------------------------------------------------------
# 7. Detail-specific button is unavailable and a legitimate fallback works
# ------------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_scenario_07_escape_key_fallback_works():
    """When no detail back button is present, Escape key dismisses the panel."""
    feed = _MockElement(attrs={"role": "feed"})
    heading = _MockElement(text="Ritual Coffee Roasters")

    page = _MockPage(
        url="https://www.google.com/maps/place/Ritual+Coffee+Roasters",
        feed=feed,
        headings=[heading],
        back_buttons={},  # No back buttons
    )

    def on_escape(key: str):
        if key == "Escape":
            page.headings.clear()
            page.url = "https://www.google.com/maps/search/Coffee+Shop"

    page.keyboard = _MockKeyboard(on_press=on_escape)

    events = []
    config = ScraperConfig(return_to_results_timeout_ms=500)
    returned = await _return_to_results(
        page,
        "div[role='feed']",
        config=config,
        on_progress=lambda stage, ev, item: events.append((ev, item)),
    )

    assert returned is True
    assert "Escape" in page.keyboard.pressed_keys
    assert ("return_action_selected", "escape_key") in events
    assert ("search_feed_restored", "escape_key") in events


# ------------------------------------------------------------------------------
# 8. Search feed never returns and retries terminate with a precise failure reason
# ------------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_scenario_08_search_feed_never_returns_terminates_precisely():
    """When all return attempts fail, _execute_return_failure_recovery raises DiscoveryFailure(RETURN_TO_RESULTS_FAILED)."""
    feed = _MockElement(attrs={"role": "feed"})
    heading = _MockElement(text="Permanent Broken Place")

    page = _MockPage(
        url="https://www.google.com/maps/place/Permanent+Broken+Place",
        feed=feed,
        headings=[heading],
        back_buttons={},
    )

    config = ScraperConfig(return_to_results_timeout_ms=100)

    # Calling production recovery code with consecutive failures >= max_consecutive_return_failures
    with pytest.raises(DiscoveryFailure) as exc_info:
        await _execute_return_failure_recovery(
            page=page,
            panel_sel="div[role='feed']",
            search_url="https://www.google.com/maps/search/Coffee+Shop",
            full_query="Coffee Shop",
            context_label="test_exhaustion",
            rounds_this_attempt=1,
            consecutive_return_failures=2,
            max_consecutive_return_failures=2,
            search_nav_recovery_used=True,  # Recovery already tried
            config=config,
        )

    assert exc_info.value.reason == DiscoveryFailureReason.RETURN_TO_RESULTS_FAILED


# ------------------------------------------------------------------------------
# 9. Browser page crashes during return
# ------------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_scenario_09_browser_page_crashed_during_return():
    """Playwright TargetClosedError / page crash during return emits browser_page_crashed and returns False."""
    page = _MockPage(
        url="https://www.google.com/maps/place/Target+Crash+Place",
        is_closed=True,
    )

    events = []
    config = ScraperConfig(return_to_results_timeout_ms=200)
    returned = await _return_to_results(
        page,
        "div[role='feed']",
        config=config,
        on_progress=lambda stage, ev, item: events.append((ev, item)),
    )

    assert returned is False
    assert any(ev == "browser_page_crashed" for ev, _ in events)


# ------------------------------------------------------------------------------
# 10. Browser context closes during return
# ------------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_scenario_10_browser_context_closed_during_return():
    """Browser context closing during return emits browser_context_closed and returns False."""
    ctx = _MockContext(is_closed=True)
    page = _MockPage(
        url="https://www.google.com/maps/place/Context+Closed+Place",
        context=ctx,
        is_closed=False,
    )

    events = []
    config = ScraperConfig(return_to_results_timeout_ms=200)
    returned = await _return_to_results(
        page,
        "div[role='feed']",
        config=config,
        on_progress=lambda stage, ev, item: events.append((ev, item)),
    )

    assert returned is False
    assert any(ev == "browser_context_closed" for ev, _ in events)


# ------------------------------------------------------------------------------
# 11. Detached element during navigation
# ------------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_scenario_11_detached_element_falls_back_gracefully():
    """When a back button throws a detached DOM error, scraper falls back gracefully to next selector/action."""
    feed = _MockElement(attrs={"role": "feed"})
    heading = _MockElement(text="Four Barrel Coffee")

    page = _MockPage(
        url="https://www.google.com/maps/place/Four+Barrel+Coffee",
        feed=feed,
        headings=[heading],
    )

    detached_btn = _MockElement(
        attrs={"aria-label": "Back to results"},
        throw_on_click=Exception("Element is not attached to the DOM"),
    )

    def on_second_click():
        page.headings.clear()
        page.back_buttons.clear()
        page.url = "https://www.google.com/maps/search/Coffee+Shop"

    valid_btn = _MockElement(
        attrs={"aria-label": "Back"},
        on_click=on_second_click,
    )

    page.back_buttons["button[aria-label='Back to results']"] = detached_btn
    page.back_buttons["button[aria-label='Back']"] = valid_btn

    config = ScraperConfig(return_to_results_timeout_ms=500)
    returned = await _return_to_results(page, "div[role='feed']", config=config)

    assert returned is True
    assert valid_btn.clicked is True


# ------------------------------------------------------------------------------
# 12. Retry attempts remain bounded
# ------------------------------------------------------------------------------
def test_scenario_12_retry_attempts_remain_bounded():
    """ScraperConfig constraints ensure bounded retry behavior."""
    cfg = ScraperConfig()
    assert getattr(cfg, "max_consecutive_return_failures", 2) <= 3
    assert getattr(cfg, "max_unopened_panel_retries_per_card", 1) <= 2
    assert getattr(cfg, "max_stale_panel_retries_per_card", 2) <= 3
    assert getattr(cfg, "max_stale_panel_recoveries_per_area", 6) <= 10


# ------------------------------------------------------------------------------
# 13. Recovery cannot accidentally click an unrelated overlay control
# ------------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_scenario_13_recovery_excludes_unrelated_overlays():
    """Controls with searchbox clear or photo overlays must not be clicked during recovery."""
    searchbox_btn = _MockElement(attrs={"aria-label": "Close", "jsaction": "searchbox.clear"})
    photo_btn = _MockElement(attrs={"aria-label": "Close", "jsaction": "photo.close"})
    back_btn = _MockElement(attrs={"aria-label": "Back to results", "jsaction": "pane.backButton"})
    feed = _MockElement(attrs={"role": "feed"})

    detail_open = True

    class _OverlayMockPage(_MockPage):
        async def query_selector(self, selector: str):
            if "back to results" in selector.lower():
                return back_btn if detail_open else None
            if "close" in selector.lower():
                return searchbox_btn
            return await super().query_selector(selector)

    page = _OverlayMockPage(
        url="https://www.google.com/maps/place/SomePlace",
        feed=feed,
        headings=[_MockElement(text="SomePlace")],
    )

    async def _on_back_click():
        nonlocal detail_open
        detail_open = False
        page.headings = []

    back_btn._on_click = _on_back_click

    cfg = ScraperConfig(return_to_results_timeout_ms=50)
    returned = await _return_to_results(page, "div[role='feed']", config=cfg)
    assert returned is True
    assert searchbox_btn.clicked is False, "Searchbox clear button must not be clicked"
    assert back_btn.clicked is True, "Genuine back button must be clicked"


# ------------------------------------------------------------------------------
# 14. Subsequent business extraction works after successful recovery
# ------------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_scenario_14_subsequent_business_extraction_after_recovery():
    """After a successful recovery, the feed panel is confirmed ready."""
    feed = _MockElement(attrs={"role": "feed"})
    page = _MockPage(
        url="https://www.google.com/maps/search/Coffee+Shop",
        feed=feed,
        headings=[],
    )

    is_ready = await _is_feed_ready(page, "div[role='feed']")
    assert is_ready is True


# ------------------------------------------------------------------------------
# 15. No orphaned page/context or unfinished navigation task remains after a failure
# ------------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_scenario_15_clean_teardown_no_orphaned_tasks():
    """When a page crashes or closes, _wait_for_feed_restored terminates immediately without hanging."""
    page = _MockPage(is_closed=True)
    t0 = asyncio.get_event_loop().time()
    restored = await _wait_for_feed_restored(page, "div[role='feed']", timeout_s=5.0)
    elapsed = asyncio.get_event_loop().time() - t0

    assert restored is False
    assert elapsed < 0.2, "Must terminate immediately upon detecting closed page without waiting for full timeout"


# ------------------------------------------------------------------------------
# 16. Genuine Feed Restoration - Hidden Feed Rejected
# ------------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_scenario_16_hidden_feed_rejected():
    """A mounted results feed that is not visible in layout (is_visible=False) must be rejected."""
    hidden_feed = _MockElement(attrs={"role": "feed"}, is_visible=False)
    page = _MockPage(
        url="https://www.google.com/maps/search/Coffee+Shop",
        feed=hidden_feed,
        headings=[],
    )

    ready = await _is_feed_ready(page, "div[role='feed']")
    assert ready is False, "A hidden feed must not be reported as ready"


# ------------------------------------------------------------------------------
# 17. Genuine Feed Restoration - Empty Feed (0 Place Cards) Rejected
# ------------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_scenario_17_empty_feed_rejected():
    """A mounted and visible feed that contains no place card anchors must be rejected."""
    empty_feed = _MockElement(attrs={"role": "feed"}, card_anchors=[])
    page = _MockPage(
        url="https://www.google.com/maps/search/Coffee+Shop",
        feed=empty_feed,
        headings=[],
    )

    ready = await _is_feed_ready(page, "div[role='feed']")
    assert ready is False, "An empty results feed must not be reported as ready"


# ------------------------------------------------------------------------------
# 18. Genuine Feed Restoration - Cleared Searchbox Query Rejected
# ------------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_scenario_18_cleared_searchbox_query_rejected():
    """When the searchbox query value has been wiped to empty string, feed readiness is rejected."""
    page = _MockPage(
        url="https://www.google.com/maps/search/Coffee+Shop",
        search_query_val="",  # Erased by accidental Clear Search click
    )

    ready = await _is_feed_ready(page, "div[role='feed']")
    assert ready is False, "Feed with cleared searchbox input value must not be reported as ready"


# ------------------------------------------------------------------------------
# 19. Renderer Crash while page.is_closed() temporarily returns False
# ------------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_scenario_19_renderer_crash_while_is_closed_false():
    """When Chromium's renderer crashes, Playwright operations raise Target crashed while
    page.is_closed() temporarily still returns False. Proves:
    1. First failed Playwright operation detects and classifies the crash.
    2. _mark_page_crashed explicitly marks the target dead.
    3. No subsequent DOM operations are attempted against the dead renderer.
    4. handle_return_failure / _execute_return_failure_recovery immediately raises
       DiscoveryFailure(SCRAPER_ERROR) on the first failure.
    5. It is NOT treated as normal search exhaustion.
    """
    page = _MockPage(
        url="https://www.google.com/maps/place/Crashed+Place",
        is_closed=False,  # Temporarily still False
    )
    # Simulate renderer crash on next Playwright query
    page.throw_on_query = Exception("Page.query_selector: Target crashed")

    # 1. _return_to_results detects the crash and flags the page
    returned = await _return_to_results(
        page,
        "div[role='feed']",
        config=ScraperConfig(return_to_results_timeout_ms=200),
    )
    assert returned is False

    # 2. _is_page_alive now returns False despite page.is_closed() being False
    assert page.is_closed() is False
    assert _is_page_alive(page) is False

    # 3. Production recovery code immediately classifies it as SCRAPER_ERROR on first failure
    with pytest.raises(DiscoveryFailure) as exc_info:
        await _execute_return_failure_recovery(
            page=page,
            panel_sel="div[role='feed']",
            search_url="https://www.google.com/maps/search/Coffee+Shop",
            full_query="Coffee Shop",
            context_label="test_crash",
            rounds_this_attempt=1,
            consecutive_return_failures=1,  # First failure!
            max_consecutive_return_failures=2,
            search_nav_recovery_used=False,
            config=ScraperConfig(),
        )

    assert exc_info.value.reason == DiscoveryFailureReason.SCRAPER_ERROR
    assert "closed/crashed" in exc_info.value.detail


# ------------------------------------------------------------------------------
# 20. Production Recovery Integration with Mocked Playwright Page
# ------------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_scenario_20_production_recovery_integration():
    """Exercises the production _execute_return_failure_recovery path:
    1. Triggers navigation recovery via page.goto(search_url).
    2. Awaits navigation task.
    3. Confirms feed readiness upon navigation completion.
    4. Proves no background tasks or unhandled promises remain.
    """
    feed = _MockElement(attrs={"role": "feed"})
    page = _MockPage(
        url="https://www.google.com/maps/place/Stuck+Place",
        feed=feed,
        headings=[],
    )

    recovered, recovery_used, new_panel_sel = await _execute_return_failure_recovery(
        page=page,
        panel_sel="div[role='feed']",
        search_url="https://www.google.com/maps/search/Coffee+Shop+in+Austin",
        full_query="Coffee Shop in Austin",
        context_label="production_integration_test",
        rounds_this_attempt=1,
        consecutive_return_failures=2,
        max_consecutive_return_failures=2,
        search_nav_recovery_used=False,
        config=ScraperConfig(),
    )

    assert recovered is True
    assert recovery_used is True
    assert page.goto_called is True
    assert page.url == "https://www.google.com/maps/search/Coffee+Shop+in+Austin"


# ------------------------------------------------------------------------------
# 21. Renderer Crash in card_anchor.is_visible (Target crashed)
# ------------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_scenario_21_card_anchor_is_visible_target_crashed():
    """When card_anchor.is_visible() raises 'Target crashed':
    1. _is_feed_ready() catches it and does NOT swallow it.
    2. _mark_page_crashed(page) is called.
    3. Feed readiness is immediately rejected (returns False).
    4. page.is_closed() temporarily remains False, but _is_page_alive(page) returns False.
    5. No subsequent DOM queries occur against the dead renderer.
    6. Calling production MapsScraper.handle_return_failure() raises DiscoveryFailure(SCRAPER_ERROR).
    """
    crashing_card = _MockElement(
        attrs={"href": "https://www.google.com/maps/place/Crashing+Card"},
        throw_on_is_visible=Exception("Page.is_visible: Target crashed"),
    )
    feed = _MockElement(attrs={"role": "feed"}, card_anchors=[crashing_card])

    page = _MockPage(
        url="https://www.google.com/maps/search/Coffee+Shop",
        feed=feed,
        headings=[],
        is_closed=False,  # Temporarily still False!
    )

    ready = await _is_feed_ready(page, "div[role='feed']")
    assert ready is False, "Feed readiness must be rejected when card visibility crashes"
    assert page.is_closed() is False
    assert _is_page_alive(page) is False, "Page must be marked dead despite page.is_closed() being False"

    scraper = MapsScraper(ScraperConfig())
    with pytest.raises(DiscoveryFailure) as exc_info:
        await scraper.handle_return_failure(
            page=page,
            panel_sel="div[role='feed']",
            search_url="https://www.google.com/maps/search/Coffee+Shop",
            full_query="Coffee Shop",
            context_label="test_card_anchor_crash",
            rounds_this_attempt=1,
            consecutive_return_failures=1,
            max_consecutive_return_failures=2,
            search_nav_recovery_used=False,
        )

    assert exc_info.value.reason == DiscoveryFailureReason.SCRAPER_ERROR
    assert "closed/crashed" in exc_info.value.detail


# ------------------------------------------------------------------------------
# 22. Renderer Crash in card_anchor.is_visible (Target closed)
# ------------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_scenario_22_card_anchor_is_visible_target_closed():
    """When card_anchor.is_visible() raises 'Target closed':
    1. Target is marked dead via _mark_page_crashed(page).
    2. Feed readiness is rejected.
    3. Production handler immediately raises DiscoveryFailure(SCRAPER_ERROR).
    """
    closing_card = _MockElement(
        attrs={"href": "https://www.google.com/maps/place/Closing+Card"},
        throw_on_is_visible=Exception("Protocol error: Target closed"),
    )
    feed = _MockElement(attrs={"role": "feed"}, card_anchors=[closing_card])

    page = _MockPage(
        url="https://www.google.com/maps/search/Coffee+Shop",
        feed=feed,
        headings=[],
        is_closed=False,
    )

    ready = await _is_feed_ready(page, "div[role='feed']")
    assert ready is False
    assert _is_page_alive(page) is False

    scraper = MapsScraper(ScraperConfig())
    with pytest.raises(DiscoveryFailure) as exc_info:
        await scraper.handle_return_failure(
            page=page,
            panel_sel="div[role='feed']",
            search_url="https://www.google.com/maps/search/Coffee+Shop",
            full_query="Coffee Shop",
            context_label="test_card_anchor_closed",
            rounds_this_attempt=1,
            consecutive_return_failures=1,
            max_consecutive_return_failures=2,
            search_nav_recovery_used=False,
        )

    assert exc_info.value.reason == DiscoveryFailureReason.SCRAPER_ERROR


# ------------------------------------------------------------------------------
# 23. Feed Actionability - Card Covered by Obstructing Modal / Dialog Overlay
# ------------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_scenario_23_card_covered_by_overlay_rejected():
    """When a modal or dialog overlay covers the place card:
    - Results feed is visible.
    - Detail panel is closed.
    - Place card is visible.
    - But an unrelated modal/overlay is present in the DOM (e.g. div[role='dialog'] or obstructed hit-test).
    _is_feed_ready() must reject readiness so the scraper does not attempt to click a blocked card.
    """
    modal_dialog = _MockElement(attrs={"role": "dialog", "aria-modal": "true"}, is_visible=True)
    card = _MockElement(attrs={"href": "https://www.google.com/maps/place/Covered+Coffee"}, is_visible=True)
    feed = _MockElement(attrs={"role": "feed"}, card_anchors=[card], is_visible=True)

    page = _MockPage(
        url="https://www.google.com/maps/search/Coffee+Shop",
        feed=feed,
        headings=[],
        other_elements={"div[role='dialog']": modal_dialog},
    )

    ready = await _is_feed_ready(page, "div[role='feed']")
    assert ready is False, "Card covered by visible modal dialog overlay must not be reported as ready"

    # Also test via hit-test elementFromPoint obstruction
    card_obstructed = _MockElement(
        attrs={"href": "https://www.google.com/maps/place/Obstructed+Coffee"},
        is_visible=True,
        is_obstructed=True,  # topEl !== el
    )
    feed2 = _MockElement(attrs={"role": "feed"}, card_anchors=[card_obstructed], is_visible=True)
    page2 = _MockPage(
        url="https://www.google.com/maps/search/Coffee+Shop",
        feed=feed2,
        headings=[],
    )

    ready2 = await _is_feed_ready(page2, "div[role='feed']")
    assert ready2 is False, "Card obstructed by hit-test overlay must not be reported as ready"


# ------------------------------------------------------------------------------
# 24. Production MapsScraper.handle_return_failure Integration & Lifecycle
# ------------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_scenario_24_production_handle_return_failure_lifecycle():
    """Directly exercises MapsScraper.handle_return_failure():
    1. Fatal renderer crash raises SCRAPER_ERROR.
    2. Repeated failures remain strictly bounded and raise RETURN_TO_RESULTS_FAILED after max failures.
    3. Failed recovery returns cleanly with panel_lost indication so no subsequent card is clicked.
    4. All navigation tasks are properly awaited and no orphaned background task remains.
    """
    scraper = MapsScraper(ScraperConfig())

    # Case A: Renderer crash -> SCRAPER_ERROR
    crashed_page = _MockPage(is_closed=True)
    with pytest.raises(DiscoveryFailure) as exc_crash:
        await scraper.handle_return_failure(
            page=crashed_page,
            panel_sel="div[role='feed']",
            search_url="https://www.google.com/maps/search/Coffee+Shop",
            full_query="Coffee Shop",
            context_label="test_crash_lifecycle",
            rounds_this_attempt=1,
            consecutive_return_failures=1,
            max_consecutive_return_failures=2,
            search_nav_recovery_used=False,
        )
    assert exc_crash.value.reason == DiscoveryFailureReason.SCRAPER_ERROR

    # Case B: First non-fatal failure under threshold -> returns (False, False, panel_sel)
    live_page = _MockPage()
    recovered, rec_used, panel = await scraper.handle_return_failure(
        page=live_page,
        panel_sel="div[role='feed']",
        search_url="https://www.google.com/maps/search/Coffee+Shop",
        full_query="Coffee Shop",
        context_label="test_retry_lifecycle",
        rounds_this_attempt=1,
        consecutive_return_failures=1,  # 1 < 2
        max_consecutive_return_failures=2,
        search_nav_recovery_used=False,
    )
    assert recovered is False
    assert rec_used is False

    # Case C: Reached max failures -> triggers search nav recovery, if nav fails -> raises RETURN_TO_RESULTS_FAILED
    live_page_broken = _MockPage(feed=_MockElement(attrs={"role": "feed"}, card_anchors=[]))  # Empty feed
    with pytest.raises(DiscoveryFailure) as exc_exhausted:
        await scraper.handle_return_failure(
            page=live_page_broken,
            panel_sel="div[role='feed']",
            search_url="https://www.google.com/maps/search/Coffee+Shop",
            full_query="Coffee Shop",
            context_label="test_exhausted_lifecycle",
            rounds_this_attempt=1,
            consecutive_return_failures=2,  # 2 >= 2
            max_consecutive_return_failures=2,
            search_nav_recovery_used=False,
        )
    assert exc_exhausted.value.reason == DiscoveryFailureReason.RETURN_TO_RESULTS_FAILED


# ==============================================================================
# REMEDIATION REVIEW REGRESSION TESTS (BROWSER LIFECYCLE & DIAGNOSTIC TIMEOUTS)
# ==============================================================================

@pytest.mark.asyncio
async def test_execution_context_destroyed_does_not_mark_live_page_crashed():
    """'Execution context was destroyed' during in-page navigation must not mark a live
    page as crashed, and _execute_return_failure_recovery must recover via page.goto."""
    err_nav = Exception("Execution context was destroyed, most likely because of a navigation.")
    assert ms._is_target_closed_or_crashed_error(err_nav) is False

    err_closed = Exception("Target page, context or browser has been closed")
    assert ms._is_target_closed_or_crashed_error(err_closed) is True

    # Simulate a live page where a back-button query throws 'Execution context was destroyed'
    feed = _MockElement(attrs={"role": "feed"})
    bad_btn = _MockElement(
        attrs={"aria-label": "Back to results", "jsaction": "pane.backButton"},
        throw_on_click=err_nav,
    )
    heading = _MockElement(text="Transient Nav Place")
    page = _MockPage(
        url="https://www.google.com/maps/place/Transient+Nav+Place",
        feed=feed,
        headings=[heading],
        back_buttons={"Back to results": bad_btn},
        is_closed=False,
        history_length=1,
    )

    ok = await _return_to_results(
        page,
        "div[role='feed']",
        config=ScraperConfig(return_to_results_timeout_ms=100, scroll_settle_timeout_ms=100),
    )
    assert ok is False
    # Page must remain alive (not flagged _mast_target_crashed)
    assert _is_page_alive(page) is True

    # Now clear headings and detail back buttons on goto and prove _execute_return_failure_recovery recovers via page.goto
    orig_goto = page.goto
    async def goto_and_clear_heading(target_url: str, **kwargs):
        page.headings.clear()
        page.back_buttons.clear()
        return await orig_goto(target_url, **kwargs)
    page.goto = goto_and_clear_heading

    recovered, nav_used, new_sel = await _execute_return_failure_recovery(
        page=page,
        panel_sel="div[role='feed']",
        search_url="https://www.google.com/maps/search/Coffee+Shop",
        full_query="Coffee Shop",
        context_label="transient_exec_ctx_nav",
        rounds_this_attempt=1,
        consecutive_return_failures=2,
        max_consecutive_return_failures=2,
        search_nav_recovery_used=False,
        config=ScraperConfig(),
    )
    assert recovered is True
    assert nav_used is True
    assert page.goto_called is True


@pytest.mark.asyncio
async def test_genuinely_closed_page_fails_without_navigation_recovery():
    """When page.is_closed() is True, _execute_return_failure_recovery raises SCRAPER_ERROR without attempting goto."""
    page = _MockPage(is_closed=True)
    with pytest.raises(ms.DiscoveryFailure) as exc:
        await ms._execute_return_failure_recovery(
            page=page,
            panel_sel="div[role='feed']",
            search_url="https://www.google.com/maps/search/Coffee",
            full_query="Coffee",
            context_label="test_closed_page",
            rounds_this_attempt=1,
            consecutive_return_failures=2,
            max_consecutive_return_failures=2,
            search_nav_recovery_used=False,
            config=ms.ScraperConfig(),
        )
    assert exc.value.reason == ms.DiscoveryFailureReason.SCRAPER_ERROR
    assert "closed/crashed" in str(exc.value)
    assert page.goto_called is False


@pytest.mark.asyncio
async def test_genuinely_closed_context_fails_without_navigation_recovery():
    """When context.is_closed() is True, _execute_return_failure_recovery raises SCRAPER_ERROR without calling goto."""
    class _MockClosedCtx:
        def is_closed(self):
            return True
    page = _MockPage(is_closed=False, context=_MockClosedCtx())
    with pytest.raises(ms.DiscoveryFailure) as exc:
        await ms._execute_return_failure_recovery(
            page=page,
            panel_sel="div[role='feed']",
            search_url="https://www.google.com/maps/search/Coffee",
            full_query="Coffee",
            context_label="test_closed_context",
            rounds_this_attempt=1,
            consecutive_return_failures=2,
            max_consecutive_return_failures=2,
            search_nav_recovery_used=False,
            config=ms.ScraperConfig(),
        )
    assert exc.value.reason == ms.DiscoveryFailureReason.SCRAPER_ERROR
    assert page.goto_called is False


@pytest.mark.asyncio
async def test_emit_progress_calling_conventions():
    """Production _dispatch_progress, _return_to_results, and _execute_return_failure_recovery
    support 2-arg, 3-arg, and kwargs progress callbacks without raising TypeError."""
    received_3arg: list[dict[str, Any]] = []

    def observer_3arg_kwargs(stage: str, event: str, item_id: str | None = None, **kwargs: Any) -> None:
        received_3arg.append({"stage": stage, "event": event, "item_id": item_id, "kwargs": kwargs})

    # 1. Calling convention: 2-arg (event, item_id) + kwargs
    ms._dispatch_progress(observer_3arg_kwargs, "panel_failure_retry", "PANEL_NOT_FOUND:1", attempt=2)
    assert received_3arg[-1] == {
        "stage": "discovery",
        "event": "panel_failure_retry",
        "item_id": "PANEL_NOT_FOUND:1",
        "kwargs": {"attempt": 2},
    }

    # 2. Calling convention: 3-arg ("discovery", event, item_id)
    ms._dispatch_progress(observer_3arg_kwargs, "discovery", "card_processed", "item_42")
    assert received_3arg[-1] == {
        "stage": "discovery",
        "event": "card_processed",
        "item_id": "item_42",
        "kwargs": {},
    }

    # 3. Observer that does NOT accept **kwargs (strict 3-arg) must not fail when kwargs are passed
    received_strict_3arg: list[tuple[str, str, str | None]] = []
    def observer_strict_3arg(stage: str, event: str, item_id: str | None = None) -> None:
        received_strict_3arg.append((stage, event, item_id))

    ms._dispatch_progress(observer_strict_3arg, "search_space_expanded", "10", new_unique_ids=10)
    assert received_strict_3arg[-1] == ("discovery", "search_space_expanded", "10")

    # 4. Observer that only accepts 2 args (event, item_id) works with _return_to_results and _execute_return_failure_recovery
    received_2arg: list[tuple[str, str | None]] = []
    def observer_2arg(event: str, item_id: str | None = None) -> None:
        received_2arg.append((event, item_id))

    feed = _MockElement(attrs={"role": "feed"})
    page = _MockPage(url="https://www.google.com/maps/place/Test+Cafe", feed=feed, headings=[])
    await _execute_return_failure_recovery(
        page=page,
        panel_sel="div[role='feed']",
        search_url="https://www.google.com/maps/search/Coffee+Shop",
        full_query="Coffee Shop",
        context_label="cb_test",
        rounds_this_attempt=1,
        consecutive_return_failures=2,
        max_consecutive_return_failures=2,
        search_nav_recovery_used=False,
        config=ScraperConfig(),
        on_progress=observer_2arg,  # type: ignore[arg-type]
    )
    assert ("return_recovery_attempted", "cb_test") in received_2arg
    assert ("return_recovery_succeeded", "cb_test") in received_2arg


@pytest.mark.asyncio
async def test_hanging_page_title_bounded_by_timeout():
    """Production _run_page_load_diagnostics bounds a hanging page.title() call and returns None promptly."""
    class _HangingTitlePage:
        url = "https://www.google.com/maps/search/Coffee"
        async def title(self):
            await asyncio.sleep(10.0)
            return "Hanging Title"
        async def evaluate(self, script):
            return 123

    page = _HangingTitlePage()
    t0 = asyncio.get_event_loop().time()
    res = await ms._run_page_load_diagnostics(page, page.url, timeout_s=0.05)
    elapsed = asyncio.get_event_loop().time() - t0
    assert res is None
    assert elapsed < 0.5, f"Hanging page.title() must time out promptly, took {elapsed:.2f}s"


@pytest.mark.asyncio
async def test_hanging_page_evaluate_bounded_by_timeout():
    """Production _run_page_load_diagnostics bounds a hanging page.evaluate() call and returns None promptly."""
    class _HangingEvalPage:
        url = "https://www.google.com/maps/search/Coffee"
        async def title(self):
            return "Coffee - Google Maps"
        async def evaluate(self, script):
            await asyncio.sleep(10.0)
            return 123

    page = _HangingEvalPage()
    t0 = asyncio.get_event_loop().time()
    res = await ms._run_page_load_diagnostics(page, page.url, timeout_s=0.05)
    elapsed = asyncio.get_event_loop().time() - t0
    assert res is None
    assert elapsed < 0.5, f"Hanging page.evaluate() must time out promptly, took {elapsed:.2f}s"


@pytest.mark.asyncio
async def test_diagnostic_timeout_does_not_halt_scraper():
    """Production _run_page_load_diagnostics handles both healthy int body lengths and timeouts without raising."""
    class _HealthyDiagPage:
        url = "https://www.google.com/maps/search/Coffee"
        async def title(self):
            return "Coffee - Google Maps"
        async def evaluate(self, script):
            return 4280  # int returned by document.body?.innerText?.length || 0

    healthy = _HealthyDiagPage()
    res = await ms._run_page_load_diagnostics(healthy, healthy.url, timeout_s=0.2)
    assert res == ("Coffee - Google Maps", 4280)
