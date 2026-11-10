"""Verification tests for the Google Maps SPA Interaction & Reliability Architecture.

Covers the 10 critical scenarios required by the production audit:
1. URL changes but no detail DOM exists -> NOT ready / waiting for rendered DOM.
2. URL matches AND correct visible H1 exists -> ready and identity verified.
3. URL changes to Business B but DOM still contains Business A -> rejected as stale.
4. First interaction target fails to mount panel; second controlled interaction target succeeds -> successful extraction without page.goto.
5. Business has no phone -> panel still considered mounted and extracted.
6. Business has no website -> panel still considered mounted and extracted.
7. Real detail DOM absent after all controlled SPA attempts -> exceptional recovery attempted.
8. page.goto times out -> candidate is NOT classified as verified_but_empty (classified as navigation_timeout).
9. Normal successful SPA path -> page.goto is never called.
10. Retry limit -> bounded at most 1 controlled retry, no infinite loop.
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
    _has_panel_content_marker,
    _interact_with_target,
    _is_real_detail_dom_mounted,
    _resolve_card_interaction_targets,
    _wait_for_panel_content_markers,
    MapsScraper,
    RawPlace,
)
from utils.perf import RunProfiler as PerfProfiler
from utils.runtime import ProxyManager, RunStats, ScraperConfig


class _MockElement:
    def __init__(
        self,
        *,
        text: str = "",
        attrs: dict[str, str] | None = None,
        is_visible: bool = True,
        on_click=None,
    ):
        self._text = text
        self._attrs = dict(attrs or {})
        self._visible = is_visible
        self._on_click = on_click
        self.clicked = False
        self.click_count = 0

    async def get_attribute(self, name: str):
        return self._attrs.get(name)

    async def inner_text(self) -> str:
        return self._text

    async def is_visible(self) -> bool:
        return self._visible

    async def click(self, **_kwargs) -> None:
        self.clicked = True
        self.click_count += 1
        if self._on_click:
            res = self._on_click()
            if asyncio.iscoroutine(res):
                await res

    async def evaluate(self, script: str, *_args):
        if "click" in script:
            await self.click()
        if "scrollHeight" in script:
            return {"scrollHeight": 1000, "clientHeight": 500, "childCount": 5}
        if "nodeType" in script:
            return True
        return None

    async def evaluate_handle(self, script: str, *_args):
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

    async def scroll_into_view_if_needed(self, **_kwargs):
        pass


class _MockPage:
    def __init__(
        self,
        *,
        url: str = "https://www.google.com/maps/search/Coffee+Shop",
        title: str = "Coffee Shop - Google Maps",
        feed: _MockElement | None = None,
        headings: list[_MockElement] | None = None,
        back_buttons: dict[str, _MockElement] | None = None,
        other_elements: dict[str, _MockElement] | None = None,
    ):
        self.url = url
        self._title = title
        self.feed_el = feed or _MockElement(attrs={"role": "feed"})
        self.headings = list(headings or [])
        self.back_buttons = dict(back_buttons or {})
        self.other_elements = dict(other_elements or {})
        self.goto_calls: list[str] = []
        self.keyboard = _MockKeyboard()
        self.context = object()

    async def title(self) -> str:
        return self._title

    async def query_selector(self, selector: str):
        if selector in ("div[role='feed']", "div.m6QErb[aria-label]", "div.m6QErb"):
            return self.feed_el
        if selector in ms._PLACE_NAME_SELECTORS:
            return self.headings[0] if self.headings else None
        if selector in ms._DETAIL_BACK_BUTTON_SELECTORS or selector in ms._BACK_BUTTON_SELECTORS:
            for k, el in self.back_buttons.items():
                if k in selector or selector in k:
                    return el
        if "a[href*='/maps/place/']" in selector:
            anchors = getattr(self.feed_el, "_card_anchors", [])
            return anchors[0] if anchors else None
        for k, el in self.other_elements.items():
            if k == selector or k in selector:
                return el
        return None

    async def query_selector_all(self, selector: str):
        if selector in ms._PLACE_NAME_SELECTORS:
            return list(self.headings)
        if "a[href*='/maps/place/']" in selector:
            return list(getattr(self.feed_el, "_card_anchors", []))
        el = await self.query_selector(selector)
        return [el] if el else []

    async def wait_for_selector(self, selector: str, **_kwargs):
        el = await self.query_selector(selector)
        if el is None:
            raise ms.PlaywrightTimeoutError(f"timeout waiting for {selector}")
        return el

    async def goto(self, url: str, **_kwargs):
        self.goto_calls.append(url)
        self.url = url

    async def evaluate(self, script: str, *_args):
        if "history" in script and "length" in script:
            return 2
        return None

    async def eval_on_selector_all(self, _selector: str, _script: str) -> int:
        return 2

    async def close(self) -> None:
        pass


class _MockKeyboard:
    def __init__(self):
        self.pressed_keys: list[str] = []

    async def press(self, key: str):
        self.pressed_keys.append(key)


# ==============================================================================
# TEST 1: URL changes without detail DOM -> NOT ready / waiting for rendered DOM
# ==============================================================================
@pytest.mark.asyncio
async def test_01_url_changes_without_detail_dom_not_ready():
    """When URL changes to /maps/place/... but no detail DOM exists (no H1 or excluded header),
    _is_real_detail_dom_mounted is False and _evaluate_panel_identity with
    require_rendered_dom=True returns (False, 'waiting_for_rendered_dom')."""
    place_url = "https://www.google.com/maps/place/Artisan+Roast/@40.7,-74.0,17z/data=!4m2!3m1!1s0x89c259:0x111"
    snap_no_dom = {
        "open": True,
        "name": "",
        "raw_name": "",
        "h1_name": "",
        "raw_h1": "",
        "page_url": place_url,
        "place_id": "0x89c259:0x111",
        "place_key": "0x89c259:0x111",
    }

    # 1. Detail DOM is NOT mounted
    assert _is_real_detail_dom_mounted(snap_no_dom, expected_name="Artisan Roast") is False

    # 2. Strict evaluation reports waiting_for_rendered_dom
    ok, reason = _evaluate_panel_identity(
        snap_no_dom,
        card_href=place_url,
        place_key="0x89c259:0x111",
        card_signals={"name": "Artisan Roast"},
        pre_click_snapshot=None,
        last_verified_panel=None,
        require_rendered_dom=True,
    )
    assert ok is False
    assert reason == "waiting_for_rendered_dom"

    # 3. Even with generic 'Results' header, it must not be treated as mounted
    snap_results_h1 = dict(snap_no_dom, h1_name="Results", raw_h1="Results")
    assert _is_real_detail_dom_mounted(snap_results_h1, expected_name="Artisan Roast") is False
    ok, reason = _evaluate_panel_identity(
        snap_results_h1,
        card_href=place_url,
        place_key="0x89c259:0x111",
        card_signals={"name": "Artisan Roast"},
        pre_click_snapshot=None,
        last_verified_panel=None,
        require_rendered_dom=True,
    )
    assert ok is False
    assert reason == "waiting_for_rendered_dom"


# ==============================================================================
# TEST 2: URL matches AND correct visible H1 exists -> ready and verified
# ==============================================================================
@pytest.mark.asyncio
async def test_02_url_matches_and_correct_h1_exists_ready_and_verified():
    """When URL matches AND a genuine visible place H1 exists matching expected name,
    _is_real_detail_dom_mounted is True and identity is verified."""
    place_url = "https://www.google.com/maps/place/Artisan+Roast/@40.7,-74.0,17z/data=!4m2!3m1!1s0x89c259:0x111"
    snap_verified = {
        "open": True,
        "name": "artisan roast",
        "raw_name": "Artisan Roast",
        "h1_name": "Artisan Roast",
        "raw_h1": "Artisan Roast",
        "page_url": place_url,
        "place_id": "0x89c259:0x111",
        "place_key": "0x89c259:0x111",
    }

    assert _is_real_detail_dom_mounted(snap_verified, expected_name="Artisan Roast") is True

    ok, reason = _evaluate_panel_identity(
        snap_verified,
        card_href=place_url,
        place_key="0x89c259:0x111",
        card_signals={"name": "Artisan Roast"},
        pre_click_snapshot=None,
        last_verified_panel=None,
        require_rendered_dom=True,
    )
    assert ok is True
    assert reason == "verified"
    assert snap_verified.get("verdict_source") == "h1"


# ==============================================================================
# TEST 3: URL changes to Business B but DOM still contains Business A -> rejected
# ==============================================================================
@pytest.mark.asyncio
async def test_03_url_changes_to_b_but_dom_still_contains_a_rejected_as_stale():
    """When URL changes to Business B but DOM still retains Business A from a prior card,
    stale protection rejects it immediately even if URL place ID matched."""
    prior_verified = {
        "name": "alpha cafe",
        "raw_name": "Alpha Cafe",
        "h1_name": "Alpha Cafe",
        "place_key": "0x111:0x111",
        "page_url": "https://www.google.com/maps/place/Alpha+Cafe/data=!4m2!3m1!1s0x111:0x111",
    }

    url_b = "https://www.google.com/maps/place/Beta+Bakery/data=!4m2!3m1!1s0x222:0x222"
    # DOM still has Business A's H1
    stale_snap = {
        "open": True,
        "name": "alpha cafe",
        "raw_name": "Alpha Cafe",
        "h1_name": "Alpha Cafe",
        "raw_h1": "Alpha Cafe",
        "page_url": url_b,
        "place_id": "0x222:0x222",
        "place_key": "0x222:0x222",
    }

    # Must be rejected by _is_real_detail_dom_mounted
    assert _is_real_detail_dom_mounted(
        stale_snap,
        expected_name="Beta Bakery",
        last_verified_panel=prior_verified,
    ) is False

    # Must be rejected by _evaluate_panel_identity (name conflict, NOT falsely verified via url_id)
    ok, reason = _evaluate_panel_identity(
        stale_snap,
        card_href=url_b,
        place_key="0x222:0x222",
        card_signals={"name": "Beta Bakery"},
        pre_click_snapshot=None,
        last_verified_panel=prior_verified,
        require_rendered_dom=True,
    )
    assert ok is False
    assert "name_conflict" in reason or "panel_name" in reason


# ==============================================================================
# TEST 4: First interaction target fails; second target succeeds without goto
# ==============================================================================
@pytest.mark.asyncio
async def test_04_first_target_fails_second_target_succeeds_without_goto():
    """When the first interaction target (e.g. title) fails to mount the detail panel,
    the controlled Stage B retry clicks the alternate target (e.g. card/anchor),
    which mounts the detail panel. Full extraction succeeds with zero page.goto calls."""
    feed = _MockElement(attrs={"role": "feed"})
    place_url = "https://www.google.com/maps/place/Stumptown+Coffee/@45.5,-122.6,17z/data=!4m2!3m1!1s0x54950a:0xabc"
    h1_el = _MockElement(text="Stumptown Coffee")
    back_btn = _MockElement(attrs={"aria-label": "Back to results"})

    page = _MockPage(
        url="https://www.google.com/maps/search/Coffee+Shop",
        feed=feed,
        headings=[],
        back_buttons={"Back to results": back_btn},
    )

    # Mock card element with separate targets
    title_target = _MockElement(text="Stumptown Coffee")
    card_container = _MockElement(attrs={"class": "Nv2PK"})
    anchor_target = _MockElement(attrs={"href": place_url, "aria-label": "Stumptown Coffee"})

    class _SmartCardAnchor(_MockElement):
        async def scroll_into_view_if_needed(self, **_kwargs):
            pass

    card_anchor = _SmartCardAnchor(attrs={"href": place_url, "aria-label": "Stumptown Coffee"})
    feed._card_anchors = [card_anchor]

    # Target resolution returns title first, card container second
    async def mock_resolve_targets(_page, _el):
        return [("title", title_target), ("card", card_container), ("overlay_anchor", anchor_target)]

    click_history = []

    async def mock_interact(_page, target_el, target_name, **_kwargs):
        click_history.append(target_name)
        if target_name == "title":
            # Target 1 fails to trigger DOM mount (e.g. unhandled click on sub-span)
            page.url = place_url
            page.headings = []
            return True
        elif target_name in ("card", "overlay_anchor"):
            # Target 2 succeeds: mounts H1 and updates browser title
            page.url = place_url
            page._title = "Stumptown Coffee - Google Maps"
            page.headings = [h1_el]
            return True
        return False

    orig_new_ctx = ms._new_stealth_context
    orig_resolve_panel = ms._resolve_results_panel
    orig_resolve_targets = ms._resolve_card_interaction_targets
    orig_interact = ms._interact_with_target
    orig_wait_settle = ms._wait_for_place_settle
    orig_extract = ms._extract_place_data
    orig_return = ms._return_to_results
    orig_scroll = ms._human_scroll

    class _Ctx:
        async def new_page(self):
            return page
        async def close(self):
            pass

    profiler = PerfProfiler()
    try:
        ms._new_stealth_context = lambda *_a, **_k: asyncio.sleep(0, result=_Ctx())
        ms._resolve_results_panel = lambda *_a, **_k: asyncio.sleep(0, result=("div[role='feed']", feed))
        ms._resolve_card_interaction_targets = mock_resolve_targets
        ms._interact_with_target = mock_interact
        ms._wait_for_place_settle = lambda *_a, **_k: asyncio.sleep(0)
        ms._extract_place_data = lambda *_a, **_k: asyncio.sleep(
            0,
            result=RawPlace(name="Stumptown Coffee", address="128 SW 3rd Ave, Portland, OR"),
        )
        ms._return_to_results = lambda *_a, **_k: asyncio.sleep(0, result=True)
        ms._human_scroll = lambda *_a, **_k: asyncio.sleep(0)

        config = ScraperConfig(headless=True, place_timeout_ms=100, max_crash_retries=0, scroll_max_rounds=1)
        scraper = MapsScraper(
            config,
            ProxyManager(),
            RunStats(),
            profiler=profiler,
        )
        scraper._browser = object()
        scraper._limiter.acquire = lambda *_a, **_k: asyncio.sleep(0)

        yielded = [p async for p in scraper.search(query="Coffee Shop", city="Portland", max_results=1)]

        assert len(yielded) == 1
        assert yielded[0].name == "Stumptown Coffee"
        assert not any("/maps/place/" in u for u in page.goto_calls), f"page.goto must NOT be called on successful retry: {page.goto_calls}"
        assert "title" in click_history, "Title target must have been tried first"
        assert "card" in click_history or "overlay_anchor" in click_history, "Alternate target must have been tried on Stage B retry"
        assert profiler.counter("stage_b_panel_retry_attempted") >= 1
        assert profiler.counter("stage_b_panel_retry_succeeded") >= 1
    finally:
        ms._new_stealth_context = orig_new_ctx
        ms._resolve_results_panel = orig_resolve_panel
        ms._resolve_card_interaction_targets = orig_resolve_targets
        ms._interact_with_target = orig_interact
        ms._wait_for_place_settle = orig_wait_settle
        ms._extract_place_data = orig_extract
        ms._return_to_results = orig_return
        ms._human_scroll = orig_scroll


# ==============================================================================
# TEST 5: Business without phone mounts and extracts
# ==============================================================================
@pytest.mark.asyncio
async def test_05_business_without_phone_mounts_and_extracts():
    """A business without a phone number has address and back button markers.
    _has_panel_content_marker must return True and extraction must proceed without stalling."""
    feed = _MockElement(attrs={"role": "feed"})
    address_el = _MockElement(attrs={"data-item-id": "address"}, text="456 Library Rd")
    back_btn = _MockElement(attrs={"aria-label": "Back to results"})

    page = _MockPage(
        url="https://www.google.com/maps/place/Quiet+Bookshop",
        feed=feed,
        headings=[],
        back_buttons={"Back to results": back_btn},
        other_elements={"[data-item-id='address']": address_el},
    )

    has_marker = await _has_panel_content_marker(page, feed_el=feed)
    assert has_marker is True, "Phone is NOT mandatory; address and back button satisfy panel content markers"

    snap = {
        "open": True,
        "name": "quiet bookshop",
        "raw_name": "Quiet Bookshop",
        "h1_name": "Quiet Bookshop",
        "raw_h1": "Quiet Bookshop",
        "page_url": page.url,
        "place_id": "0x1:0x1",
        "place_key": "0x1:0x1",
    }
    assert _is_real_detail_dom_mounted(snap, expected_name="Quiet Bookshop") is True


# ==============================================================================
# TEST 6: Business without website mounts and extracts
# ==============================================================================
@pytest.mark.asyncio
async def test_06_business_without_website_mounts_and_extracts():
    """A business without a website (no data-item-id='authority') has address and phone markers.
    _has_panel_content_marker must return True and extraction must proceed without stalling."""
    feed = _MockElement(attrs={"role": "feed"})
    address_el = _MockElement(attrs={"data-item-id": "address"}, text="789 Elm St")
    phone_el = _MockElement(attrs={"data-item-id": "phone:tel:123"}, text="(555) 012-3456")

    page = _MockPage(
        url="https://www.google.com/maps/place/Corner+Bodega",
        feed=feed,
        headings=[],
        back_buttons={},
        other_elements={
            "[data-item-id='address']": address_el,
            "[data-item-id*='phone']": phone_el,
        },
    )

    has_marker = await _has_panel_content_marker(page, feed_el=feed)
    assert has_marker is True, "Website is NOT mandatory; address and phone satisfy panel content markers"

    snap = {
        "open": True,
        "name": "corner bodega",
        "raw_name": "Corner Bodega",
        "h1_name": "Corner Bodega",
        "raw_h1": "Corner Bodega",
        "page_url": page.url,
        "place_id": "0x2:0x2",
        "place_key": "0x2:0x2",
    }
    assert _is_real_detail_dom_mounted(snap, expected_name="Corner Bodega") is True


# ==============================================================================
# TEST 7: Real detail DOM absent after all controlled SPA attempts -> goto attempted
# ==============================================================================
@pytest.mark.asyncio
async def test_07_real_detail_dom_absent_after_all_controlled_spa_attempts_goto_attempted():
    """When both Stage A and Stage B fail to mount detail DOM, the engine falls back to
    exceptional recovery (page.goto)."""
    feed = _MockElement(attrs={"role": "feed"})
    place_url = "https://www.google.com/maps/place/Stubborn+Place/@40.7,-74.0,17z/data=!4m2!3m1!1s0xstub:0x1"

    page = _MockPage(
        url="https://www.google.com/maps/search/Coffee+Shop",
        feed=feed,
        headings=[],
        back_buttons={},
    )

    class _StubCardAnchor(_MockElement):
        async def scroll_into_view_if_needed(self, **_kwargs):
            pass

    card_anchor = _StubCardAnchor(attrs={"href": place_url, "aria-label": "Stubborn Place"})
    feed._card_anchors = [card_anchor]

    async def mock_resolve_targets(_page, _el):
        return [("title", _MockElement(text="Stubborn Place")), ("overlay_anchor", card_anchor)]

    async def mock_interact(_page, _target_el, _target_name, **_kwargs):
        # Targets click but never mount detail DOM
        page.url = place_url
        page.headings = []
        return True

    orig_new_ctx = ms._new_stealth_context
    orig_resolve_panel = ms._resolve_results_panel
    orig_resolve_targets = ms._resolve_card_interaction_targets
    orig_interact = ms._interact_with_target
    orig_wait_settle = ms._wait_for_place_settle
    orig_extract = ms._extract_place_data
    orig_return = ms._return_to_results
    orig_scroll = ms._human_scroll

    class _Ctx:
        async def new_page(self):
            return page
        async def close(self):
            pass

    profiler = PerfProfiler()
    try:
        ms._new_stealth_context = lambda *_a, **_k: asyncio.sleep(0, result=_Ctx())
        ms._resolve_results_panel = lambda *_a, **_k: asyncio.sleep(0, result=("div[role='feed']", feed))
        ms._resolve_card_interaction_targets = mock_resolve_targets
        ms._interact_with_target = mock_interact
        ms._wait_for_place_settle = lambda *_a, **_k: asyncio.sleep(0)
        ms._extract_place_data = lambda *_a, **_k: asyncio.sleep(0, result=None)
        ms._return_to_results = lambda *_a, **_k: asyncio.sleep(0, result=True)
        ms._human_scroll = lambda *_a, **_k: asyncio.sleep(0)

        config = ScraperConfig(
            headless=True,
            place_timeout_ms=50,
            max_crash_retries=0,
            scroll_max_rounds=1,
        )
        config.max_unopened_panel_retries_per_card = 0
        scraper = MapsScraper(
            config,
            ProxyManager(),
            RunStats(),
            profiler=profiler,
        )
        scraper._browser = object()
        scraper._limiter.acquire = lambda *_a, **_k: asyncio.sleep(0)

        yielded = [p async for p in scraper.search(query="Coffee Shop", city="NYC", max_results=1)]
        assert len(yielded) == 0
        assert len(page.goto_calls) >= 1, "Exceptional page.goto must have been attempted after SPA retries failed"
        assert profiler.counter("exceptional_goto_attempted") >= 1
    finally:
        ms._new_stealth_context = orig_new_ctx
        ms._resolve_results_panel = orig_resolve_panel
        ms._resolve_card_interaction_targets = orig_resolve_targets
        ms._interact_with_target = orig_interact
        ms._wait_for_place_settle = orig_wait_settle
        ms._extract_place_data = orig_extract
        ms._return_to_results = orig_return
        ms._human_scroll = orig_scroll


# ==============================================================================
# TEST 8: page.goto timeout classified as navigation_timeout, NOT verified_but_empty
# ==============================================================================
@pytest.mark.asyncio
async def test_08_page_goto_timeout_classified_as_navigation_timeout_not_verified_but_empty():
    """When exceptional page.goto raises PlaywrightTimeoutError, the candidate must be
    classified as 'navigation_timeout' and NOT falsely increment 'verified_but_empty'."""
    feed = _MockElement(attrs={"role": "feed"})
    place_url = "https://www.google.com/maps/place/Timeout+Place/@40.7,-74.0,17z/data=!4m2!3m1!1s0xtimeout:0x1"

    page = _MockPage(
        url="https://www.google.com/maps/search/Coffee+Shop",
        feed=feed,
        headings=[],
        back_buttons={},
    )

    async def timeout_goto(_url: str, **_kwargs):
        raise ms.PlaywrightTimeoutError("Page-goto: Timeout 8000ms exceeded.")

    page.goto = timeout_goto

    class _TimeoutCardAnchor(_MockElement):
        async def scroll_into_view_if_needed(self, **_kwargs):
            pass

    card_anchor = _TimeoutCardAnchor(attrs={"href": place_url, "aria-label": "Timeout Place"})
    feed._card_anchors = [card_anchor]

    async def mock_resolve_targets(_page, _el):
        return [("overlay_anchor", card_anchor)]

    async def mock_interact(_page, _target_el, _target_name, **_kwargs):
        return True

    orig_new_ctx = ms._new_stealth_context
    orig_resolve_panel = ms._resolve_results_panel
    orig_resolve_targets = ms._resolve_card_interaction_targets
    orig_interact = ms._interact_with_target
    orig_wait_settle = ms._wait_for_place_settle
    orig_extract = ms._extract_place_data
    orig_return = ms._return_to_results
    orig_scroll = ms._human_scroll

    class _Ctx:
        async def new_page(self):
            return page
        async def close(self):
            pass

    profiler = PerfProfiler()
    try:
        ms._new_stealth_context = lambda *_a, **_k: asyncio.sleep(0, result=_Ctx())
        ms._resolve_results_panel = lambda *_a, **_k: asyncio.sleep(0, result=("div[role='feed']", feed))
        ms._resolve_card_interaction_targets = mock_resolve_targets
        ms._interact_with_target = mock_interact
        ms._wait_for_place_settle = lambda *_a, **_k: asyncio.sleep(0)
        ms._extract_place_data = lambda *_a, **_k: asyncio.sleep(0, result=None)
        ms._return_to_results = lambda *_a, **_k: asyncio.sleep(0, result=True)
        ms._human_scroll = lambda *_a, **_k: asyncio.sleep(0)

        config = ScraperConfig(
            headless=True,
            place_timeout_ms=50,
            max_crash_retries=0,
            scroll_max_rounds=1,
        )
        config.max_unopened_panel_retries_per_card = 0
        scraper = MapsScraper(
            config,
            ProxyManager(),
            RunStats(),
            profiler=profiler,
        )
        scraper._browser = object()
        scraper._limiter.acquire = lambda *_a, **_k: asyncio.sleep(0)

        yielded = [p async for p in scraper.search(query="Coffee Shop", city="NYC", max_results=1)]
        assert len(yielded) == 0
        assert profiler.counter("exceptional_goto_failed") == 1
        assert profiler.counter("verified_but_empty") == 0, (
            "Must NEVER record 'verified_but_empty' when page.goto times out"
        )
    finally:
        ms._new_stealth_context = orig_new_ctx
        ms._resolve_results_panel = orig_resolve_panel
        ms._resolve_card_interaction_targets = orig_resolve_targets
        ms._interact_with_target = orig_interact
        ms._wait_for_place_settle = orig_wait_settle
        ms._extract_place_data = orig_extract
        ms._return_to_results = orig_return
        ms._human_scroll = orig_scroll


# ==============================================================================
# TEST 9: Normal successful SPA path -> page.goto is never called
# ==============================================================================
@pytest.mark.asyncio
async def test_09_normal_successful_spa_path_never_calls_goto():
    """When a card opens normally via SPA, page.goto must never be called."""
    feed = _MockElement(attrs={"role": "feed"})
    place_url = "https://www.google.com/maps/place/Smooth+Roast/@40.7,-74.0,17z/data=!4m2!3m1!1s0xsmooth:0x1"
    h1_el = _MockElement(text="Smooth Roast")

    page = _MockPage(
        url="https://www.google.com/maps/search/Coffee+Shop",
        feed=feed,
        headings=[],
        back_buttons={},
    )

    class _NormalCardAnchor(_MockElement):
        async def scroll_into_view_if_needed(self, **_kwargs):
            pass

    card_anchor = _NormalCardAnchor(attrs={"href": place_url, "aria-label": "Smooth Roast"})
    feed._card_anchors = [card_anchor]

    async def mock_resolve_targets(_page, _el):
        return [("title", _MockElement(text="Smooth Roast"))]

    async def mock_interact(_page, _target_el, _target_name, **_kwargs):
        # Stage A click immediately succeeds: mounts H1 and updates browser title
        page.url = place_url
        page._title = "Smooth Roast - Google Maps"
        page.headings = [h1_el]
        return True

    orig_new_ctx = ms._new_stealth_context
    orig_resolve_panel = ms._resolve_results_panel
    orig_resolve_targets = ms._resolve_card_interaction_targets
    orig_interact = ms._interact_with_target
    orig_wait_settle = ms._wait_for_place_settle
    orig_extract = ms._extract_place_data
    orig_return = ms._return_to_results
    orig_scroll = ms._human_scroll

    class _Ctx:
        async def new_page(self):
            return page
        async def close(self):
            pass

    profiler = PerfProfiler()
    try:
        ms._new_stealth_context = lambda *_a, **_k: asyncio.sleep(0, result=_Ctx())
        ms._resolve_results_panel = lambda *_a, **_k: asyncio.sleep(0, result=("div[role='feed']", feed))
        ms._resolve_card_interaction_targets = mock_resolve_targets
        ms._interact_with_target = mock_interact
        ms._wait_for_place_settle = lambda *_a, **_k: asyncio.sleep(0)
        ms._extract_place_data = lambda *_a, **_k: asyncio.sleep(
            0,
            result=RawPlace(name="Smooth Roast", address="101 Coffee Lane"),
        )
        ms._return_to_results = lambda *_a, **_k: asyncio.sleep(0, result=True)
        ms._human_scroll = lambda *_a, **_k: asyncio.sleep(0)

        config = ScraperConfig(headless=True, place_timeout_ms=100, max_crash_retries=0, scroll_max_rounds=1)
        scraper = MapsScraper(
            config,
            ProxyManager(),
            RunStats(),
            profiler=profiler,
        )
        scraper._browser = object()
        scraper._limiter.acquire = lambda *_a, **_k: asyncio.sleep(0)

        yielded = [p async for p in scraper.search(query="Coffee Shop", city="NYC", max_results=1)]
        assert len(yielded) == 1
        assert yielded[0].name == "Smooth Roast"
        assert not any("/maps/place/" in u for u in page.goto_calls), "page.goto must NOT be called on normal SPA path"
        assert profiler.counter("stage_a_mount_succeeded") >= 1
    finally:
        ms._new_stealth_context = orig_new_ctx
        ms._resolve_results_panel = orig_resolve_panel
        ms._resolve_card_interaction_targets = orig_resolve_targets
        ms._interact_with_target = orig_interact
        ms._wait_for_place_settle = orig_wait_settle
        ms._extract_place_data = orig_extract
        ms._return_to_results = orig_return
        ms._human_scroll = orig_scroll


# ==============================================================================
# TEST 10: Retry limit bounded, no infinite loop
# ==============================================================================
@pytest.mark.asyncio
async def test_10_retry_limit_bounded_no_infinite_loop():
    """Stage B controlled retry is bounded to at most 1 alternate target attempt,
    and total card attempts are bounded by max_unopened_panel_retries_per_card."""
    feed = _MockElement(attrs={"role": "feed"})
    place_url = "https://www.google.com/maps/place/Dead+End/@40.7,-74.0,17z/data=!4m2!3m1!1s0xdead:0x1"

    page = _MockPage(
        url="https://www.google.com/maps/search/Coffee+Shop",
        feed=feed,
        headings=[],
        back_buttons={},
    )

    class _DeadCardAnchor(_MockElement):
        async def scroll_into_view_if_needed(self, **_kwargs):
            pass

    card_anchor = _DeadCardAnchor(attrs={"href": place_url, "aria-label": "Dead End"})
    feed._card_anchors = [card_anchor]

    interact_count = 0

    async def mock_resolve_targets(_page, _el):
        return [
            ("title", _MockElement(text="Dead End")),
            ("card", _MockElement()),
            ("overlay_anchor", card_anchor),
        ]

    async def mock_interact(_page, _target_el, _target_name, **_kwargs):
        nonlocal interact_count
        interact_count += 1
        return True

    orig_new_ctx = ms._new_stealth_context
    orig_resolve_panel = ms._resolve_results_panel
    orig_resolve_targets = ms._resolve_card_interaction_targets
    orig_interact = ms._interact_with_target
    orig_wait_settle = ms._wait_for_place_settle
    orig_extract = ms._extract_place_data
    orig_return = ms._return_to_results
    orig_scroll = ms._human_scroll

    class _Ctx:
        async def new_page(self):
            return page
        async def close(self):
            pass

    profiler = PerfProfiler()
    try:
        ms._new_stealth_context = lambda *_a, **_k: asyncio.sleep(0, result=_Ctx())
        ms._resolve_results_panel = lambda *_a, **_k: asyncio.sleep(0, result=("div[role='feed']", feed))
        ms._resolve_card_interaction_targets = mock_resolve_targets
        ms._interact_with_target = mock_interact
        ms._wait_for_place_settle = lambda *_a, **_k: asyncio.sleep(0)
        ms._extract_place_data = lambda *_a, **_k: asyncio.sleep(0, result=None)
        ms._return_to_results = lambda *_a, **_k: asyncio.sleep(0, result=True)
        ms._human_scroll = lambda *_a, **_k: asyncio.sleep(0)

        # Allow 0 outer retries (total 1 pass through card)
        config = ScraperConfig(
            headless=True,
            place_timeout_ms=50,
            max_crash_retries=0,
            scroll_max_rounds=1,
        )
        config.max_unopened_panel_retries_per_card = 0
        scraper = MapsScraper(
            config,
            ProxyManager(),
            RunStats(),
            profiler=profiler,
        )
        scraper._browser = object()
        scraper._limiter.acquire = lambda *_a, **_k: asyncio.sleep(0)

        yielded = [p async for p in scraper.search(query="Coffee Shop", city="NYC", max_results=1)]
        assert len(yielded) == 0

        # In 1 pass: Stage A tries target 1, Stage B tries target 2 (at most 1 alternate attempt)
        # Total interactions for this card attempt must be <= 2
        assert interact_count <= 2, f"Total interactions exceeded bound: {interact_count}"
        assert profiler.counter("stage_b_panel_retry_attempted") <= 1
    finally:
        ms._new_stealth_context = orig_new_ctx
        ms._resolve_results_panel = orig_resolve_panel
        ms._resolve_card_interaction_targets = orig_resolve_targets
        ms._interact_with_target = orig_interact
        ms._wait_for_place_settle = orig_wait_settle
        ms._extract_place_data = orig_extract
        ms._return_to_results = orig_return
        ms._human_scroll = orig_scroll
