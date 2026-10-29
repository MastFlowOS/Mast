"""
Phase 3 — Google Maps Fast Path Regression & Safety Suite
==========================================================

Proves that the Phase 3 optimizations in `scraper/maps_scraper.py`:
1. Preserve all required candidate fields and downstream behavior for accepted candidates.
2. Short-circuit expensive detail-page settle, rate-limit wait, website probing, and full
   DOM extraction (`_extract_place_data`) when a candidate is conclusively disqualified or
   deduplicated using information legitimately available at that stage:
   - Pre-click: known place ID, explicit permanently-closed card marker.
   - Post-identity-check (before settle/extraction): panel header exclusion, redirected
     known place ID, already-seen `name|address` duplicate, and verified detail-panel `h1`
     name matching canonical `CHAIN_KEYWORDS` / `CANNABIS_KEYWORDS`.
3. Do NOT skip or fast-abort ambiguous candidates (e.g., `"McDonald Dental Clinic"` which
   does not match `"mcdonald's"`, or `"Green Leaf Co"` whose cannabis status depends on
   the detail panel's `category="Cannabis Dispensary"`).
4. Eliminate redundant `_return_to_results` back-navigation across consecutive cards when
   the split-pane results feed remains mounted with unseen cards, while still executing
   `_return_to_results` at the end of a scroll round (when no unseen cards remain).
5. Preserve safe recovery paths when browser navigation fails, panels remain stale
   (`mismatch`), or the results feed is lost (`RETURN_TO_RESULTS_FAILED`).
6. Preserve candidate deduplication (`known_place_ids`, `seen_hrefs`, `seen_place_keys`)
   and distinguish same-name businesses at different addresses.
7. Reuse the website URL already probed by `_probe_detail_panel_website` when
   `require_website=True` instead of re-querying website DOM selectors inside
   `_extract_place_data`.
"""

from __future__ import annotations

import asyncio
import os
import sys
import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

import scraper.maps_scraper as maps_scraper_module
from exceptions import DiscoveryFailure, DiscoveryFailureReason
from scraper.maps_scraper import (
    MapsScraper,
    RawPlace,
    _extract_place_data,
    _is_conclusively_disqualified_by_name,
    _read_panel_identity_snapshot,
)
from scoring.scorer import is_cannabis, is_chain
from storage.dedup import fingerprints_for, norm_maps_place_id
from utils.perf import RunProfiler as PerfProfiler
from utils.runtime import RunStats, ScraperConfig
from workers.scoring_worker import _is_cannabis as worker_is_cannabis, _is_chain as worker_is_chain


class _FakeElement:
    def __init__(self, *, text: str = "", attrs: dict[str, str] | None = None, on_click=None):
        self._text = text
        self._attrs = dict(attrs or {})
        self._on_click = on_click

    async def inner_text(self) -> str:
        return self._text

    async def get_attribute(self, name: str) -> str | None:
        return self._attrs.get(name)

    async def is_visible(self) -> bool:
        return True

    async def scroll_into_view_if_needed(self, timeout: int = 2000) -> None:
        return None

    async def click(self, **_kwargs) -> None:
        if self._on_click:
            res = self._on_click()
            if asyncio.iscoroutine(res):
                await res

    async def evaluate(self, _script: str):
        if self._on_click:
            res = self._on_click()
            if asyncio.iscoroutine(res):
                await res
        return None


class _FakeFeedPanel:
    def __init__(self, page: "_SplitViewScenarioPage"):
        self._page = page

    async def query_selector_all(self, selector: str):
        if "a[href*='/maps/place/']" in selector:
            return self._page._build_anchors()
        return []

    async def evaluate(self, _script: str):
        return {"scrollHeight": 2000, "clientHeight": 600, "role": "feed"}


class _SplitViewScenarioPage:
    """Deterministic split-pane Google Maps page double with instrumentation counters
    for every browser/DOM operation."""

    def __init__(
        self,
        cards: list[dict],
        *,
        close_detail_on_back: bool = True,
        hide_feed_when_detail_open: bool = False,
        eol_on_first_round: bool = True,
        unrecoverable_feed_after_first_click: bool = False,
    ):
        self.cards = cards
        self.close_detail_on_back = close_detail_on_back
        self.hide_feed_when_detail_open = hide_feed_when_detail_open
        self.eol_on_first_round = eol_on_first_round
        self.unrecoverable_feed_after_first_click = unrecoverable_feed_after_first_click
        self.ever_clicked = False
        self.feed_panel = _FakeFeedPanel(self)
        self.url = "https://www.google.com/maps/search/dentists+in+Chicago"
        self.detail_open = False
        self.current_panel: dict | None = None
        self.click_counts: dict[str, int] = {}
        self.goto_urls: list[str] = []
        self.back_button_clicks = 0
        self.escape_presses = 0
        self.wait_for_function_calls = 0
        self.extract_evaluate_calls = 0
        self.last_extract_selectors: dict | None = None

        class _Keyboard:
            def __init__(self, outer: "_SplitViewScenarioPage"):
                self._outer = outer

            async def press(self, key: str):
                if key == "Escape":
                    self._outer.escape_presses += 1
                    if self._outer.close_detail_on_back:
                        self._outer.detail_open = False
                        self._outer.current_panel = None
                        self._outer.url = "https://www.google.com/maps/search/dentists+in+Chicago"

        self.keyboard = _Keyboard(self)

    def _build_anchors(self) -> list[_FakeElement]:
        anchors: list[_FakeElement] = []
        for card in self.cards:
            href = card["href"]
            aria = card.get("aria", "")
            text = card.get("text", aria)

            def _make_click(c=card):
                def _on_click():
                    h = c["href"]
                    idx = self.click_counts.get(h, 0)
                    self.click_counts[h] = idx + 1
                    outcomes = c["outcomes"]
                    outcome = outcomes[min(idx, len(outcomes) - 1)]
                    self.detail_open = True
                    self.ever_clicked = True
                    self.current_panel = dict(outcome)
                    self.url = outcome.get("url", h)

                return _on_click

            anchors.append(
                _FakeElement(
                    text=text,
                    attrs={"href": href, "aria-label": aria},
                    on_click=_make_click(),
                )
            )
        return anchors

    async def goto(self, url: str, **_kwargs):
        self.goto_urls.append(url)
        self.detail_open = False
        self.current_panel = None
        self.url = url

    async def title(self) -> str:
        return "Google Maps"

    async def wait_for_selector(self, selector: str, **_kwargs):
        if selector == "div[role='feed']":
            if (self.hide_feed_when_detail_open and self.detail_open) or (
                self.unrecoverable_feed_after_first_click and self.ever_clicked
            ):
                return None
            return self.feed_panel
        if self.detail_open and self.current_panel:
            return _FakeElement(text=self.current_panel.get("name", ""))
        return None

    async def query_selector(self, selector: str):
        if selector == "div[role='feed']":
            if (self.hide_feed_when_detail_open and self.detail_open) or (
                self.unrecoverable_feed_after_first_click and self.ever_clicked
            ):
                return None
            return self.feed_panel
        if not self.detail_open or not self.current_panel:
            return None
        if selector in ("h1.DUwDvf", "h1.fontHeadlineLarge", "div[role='main'] h1"):
            return _FakeElement(text=self.current_panel.get("name", ""))
        if selector in (
            "button[data-item-id='address'] .fontBodyMedium",
            "[data-item-id='address'] .fontBodyMedium",
            "button[data-item-id*='address']",
        ):
            addr = self.current_panel.get("address", "")
            return _FakeElement(text=addr) if addr else None
        if selector in (
            "a[data-item-id='authority']",
            "a[data-item-id*='authority']",
            "a[aria-label*='Website']",
            "a[aria-label*='website']",
        ):
            site = self.current_panel.get("website", "")
            return _FakeElement(text=site, attrs={"href": site}) if site else None
        if (
            "Back to results" in selector
            or "back to results" in selector
            or "pane.backButton" in selector
            or " close" in selector
            or "Close" in selector
            or "Fechar" in selector
            or "Cerrar" in selector
        ):
            def _close():
                self.back_button_clicks += 1
                if self.close_detail_on_back:
                    self.detail_open = False
                    self.current_panel = None
                    self.url = "https://www.google.com/maps/search/dentists+in+Chicago"

            return _FakeElement(attrs={"aria-label": "Back to results"}, on_click=_close)
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
        self.wait_for_function_calls += 1
        return None

    async def evaluate(self, script: str, arg=None):
        if "document.body?.innerText" in script:
            return "You've reached the end of the list" if self.eol_on_first_round else ""
        if isinstance(arg, dict) and "name" in arg and "address" in arg:
            self.extract_evaluate_calls += 1
            self.last_extract_selectors = dict(arg)
            panel = self.current_panel or {}
            phone = panel.get("phone", "+1 312-555-0100")
            website = panel.get("website", "https://example.com")
            website_selectors = arg.get("website") or []
            return {
                "name": panel.get("name", ""),
                "category": panel.get("category", "Dentist"),
                "address": panel.get("address", ""),
                "ratingRaw": panel.get("ratingRaw", "4.8"),
                "reviewRaw": panel.get("reviewRaw", "42 reviews"),
                "reviewFallbackAria": [],
                "phoneCandidates": (
                    [{"aria": f"Phone: {phone}", "href": f"tel:{phone}", "text": phone}]
                    if phone
                    else []
                ),
                "websiteCandidates": (
                    [{"href": website, "text": website}]
                    if (website and len(website_selectors) > 0)
                    else []
                ),
                "html": panel.get("html", '<html><body><div aria-label="Claimed">Verified</div></body></html>'),
                "photosTabText": panel.get("photosTabText", "Photos"),
                "hoursSummary": panel.get("hoursSummary", "Open 9AM-5PM"),
            }
        return None

    async def go_back(self, **_kwargs):
        if self.close_detail_on_back:
            self.detail_open = False
            self.current_panel = None
            self.url = "https://www.google.com/maps/search/dentists+in+Chicago"

    async def close(self):
        return None


class _FakeContext:
    def __init__(self, page: _SplitViewScenarioPage):
        self._page = page

    async def new_page(self) -> _SplitViewScenarioPage:
        return self._page

    async def close(self):
        return None


def _wire_page(monkeypatch, page: _SplitViewScenarioPage):
    async def _fake_new_stealth_context(_browser, proxy=None):
        return _FakeContext(page)

    async def _noop(*_a, **_kw):
        return None

    monkeypatch.setattr(maps_scraper_module, "_new_stealth_context", _fake_new_stealth_context)
    monkeypatch.setattr(maps_scraper_module, "_detect_interstitial", _noop)
    monkeypatch.setattr(maps_scraper_module, "_human_scroll", _noop)


# ──────────────────────────────────────────────────────────────────────────────
# 1 & 4. Multi-card split-pane navigation & full field preservation
# ──────────────────────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_consecutive_cards_skip_redundant_back_navigation_and_preserve_all_fields(monkeypatch):
    """Across 4 consecutive accepted business cards in a split-view feed:
    - All 4 candidates are yielded with identical required fields (name, category, address,
      city, country, phone, website, rating, reviews, maps_link, has_photos, is_google_verified,
      hours_summary).
    - Redundant `_return_to_results` calls are skipped for the first 3 cards because the
      split-pane feed remains mounted with unseen cards (`return_to_results_skipped == 3`).
    - `_return_to_results` executes only after the 4th (final) card in the round before
      scrolling/EOL (`return_to_results_executed == 1`), eliminating 75% of back-navigations.
    """
    cards = [
        {
            "href": f"https://www.google.com/maps/place/Clinic+{i}/data=!4m2!3m1!1s0x880fd2:0x11111{i}",
            "aria": f"Clinic {i} · {i}00 Main St",
            "outcomes": [
                {
                    "name": f"Clinic {i}",
                    "category": "Dental Clinic",
                    "address": f"{i}00 Main St, Chicago, IL",
                    "phone": f"+1 312-555-010{i}",
                    "website": f"https://clinic{i}.example.com",
                    "ratingRaw": "4.9",
                    "reviewRaw": f"{10 * i} reviews",
                    "url": f"https://www.google.com/maps/place/Clinic+{i}/data=!4m2!3m1!1s0x880fd2:0x11111{i}",
                }
            ],
        }
        for i in range(1, 5)
    ]

    page = _SplitViewScenarioPage(cards=cards)
    _wire_page(monkeypatch, page)

    config = ScraperConfig(
        scroll_max_rounds=2,
        max_crash_retries=0,
        place_timeout_ms=150,
        place_settle_ms=20,
        scroll_settle_timeout_ms=50,
        maps_rpm=6000,
    )
    profiler = PerfProfiler()
    scraper = MapsScraper(config, stats=RunStats(), profiler=profiler)
    scraper._browser = object()
    scraper._limiter.acquire = lambda *_a, **_kw: asyncio.sleep(0)

    yielded: list[RawPlace] = []
    async for place in scraper.search("dentists", "Chicago", country="US", max_results=10):
        yielded.append(place)

    assert [p.name for p in yielded] == ["Clinic 1", "Clinic 2", "Clinic 3", "Clinic 4"]
    for i, place in enumerate(yielded, start=1):
        assert place.category == "Dental Clinic"
        assert place.address == f"{i}00 Main St, Chicago, IL"
        assert place.city == "Chicago"
        assert place.country == "US"
        assert place.phone == f"+1 312-555-010{i}"
        assert place.website == f"https://clinic{i}.example.com"
        assert place.rating == 4.9
        assert place.reviews == 10 * i
        assert f"0x880fd2:0x11111{i}" in place.maps_link
        assert place.has_photos is True
        assert place.is_google_verified is True
        assert place.hours_summary == "Open 9AM-5PM"

    snap = profiler.summary()
    assert snap["counters"].get("return_to_results_skipped", 0) == 3
    assert snap["counters"].get("return_to_results_executed", 0) == 1
    # Because panel_snap already had raw_address on all 4 cards, wait_for_function in
    # _wait_for_place_settle was skipped on all 4 cards as well:
    assert page.wait_for_function_calls == 0


# ──────────────────────────────────────────────────────────────────────────────
# 2 & 3. Conclusively disqualified vs ambiguous candidates
# ──────────────────────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_conclusively_disqualified_candidates_fast_abort_while_ambiguous_candidates_preserve_full_extraction(monkeypatch):
    """Verifies that:
    - Card 1 ('Starbucks Reserve', chain keyword 'starbucks') fast-aborts before settle,
      website probe, and `_extract_place_data` (`maps_detail_fast_abort_disqualified == 1`),
      while still yielding a RawPlace with verified name/address/maps_link so downstream
      `_on_candidate` / `service.py` can record `candidate_keyword_pruned`.
    - Card 2 ('Starlight Dental Clinic', which starts with 'Star' like 'Starbucks' but
      is NOT in CHAIN_KEYWORDS) is NOT falsely skipped — it runs full extraction and yields
      all detail fields.
    - Card 3 ('Green Leaf Co', whose name is NOT in CANNABIS_KEYWORDS, but whose detail-page
      category is 'Cannabis Dispensary') is NOT skipped by name — it runs full extraction so
      `category='Cannabis Dispensary'` is captured for downstream cannabis disqualification.
    """
    href_chain = "https://www.google.com/maps/place/Starbucks+Reserve/data=!4m2!3m1!1s0x880fd2:0xaaa111"
    href_ambig_dental = "https://www.google.com/maps/place/Starlight+Dental+Clinic/data=!4m2!3m1!1s0x880fd2:0xbbb222"
    href_ambig_cannabis = "https://www.google.com/maps/place/Green+Leaf+Co/data=!4m2!3m1!1s0x880fd2:0xccc333"

    cards = [
        {
            "href": href_chain,
            "aria": "Starbucks Reserve · 100 State St",
            "outcomes": [
                {
                    "name": "Starbucks Reserve",
                    "category": "Coffee shop",
                    "address": "100 State St, Chicago, IL",
                    "website": "https://starbucks.com",
                    "url": href_chain,
                }
            ],
        },
        {
            "href": href_ambig_dental,
            "aria": "Starlight Dental Clinic · 200 State St",
            "outcomes": [
                {
                    "name": "Starlight Dental Clinic",
                    "category": "Dentist",
                    "address": "200 State St, Chicago, IL",
                    "phone": "+1 312-555-0200",
                    "website": "https://starlightdental.example.com",
                    "url": href_ambig_dental,
                }
            ],
        },
        {
            "href": href_ambig_cannabis,
            "aria": "Green Leaf Co · 300 State St",
            "outcomes": [
                {
                    "name": "Green Leaf Co",
                    "category": "Cannabis Dispensary",
                    "address": "300 State St, Chicago, IL",
                    "phone": "+1 312-555-0300",
                    "website": "https://greenleaf.example.com",
                    "url": href_ambig_cannabis,
                }
            ],
        },
    ]

    page = _SplitViewScenarioPage(cards=cards)
    _wire_page(monkeypatch, page)

    config = ScraperConfig(
        scroll_max_rounds=2,
        max_crash_retries=0,
        place_timeout_ms=150,
        place_settle_ms=20,
        scroll_settle_timeout_ms=50,
        maps_rpm=6000,
    )
    profiler = PerfProfiler()
    scraper = MapsScraper(config, stats=RunStats(), profiler=profiler)
    scraper._browser = object()
    scraper._limiter.acquire = lambda *_a, **_kw: asyncio.sleep(0)

    yielded: list[RawPlace] = []
    async for place in scraper.search("dentists", "Chicago", max_results=10, require_website=True):
        yielded.append(place)

    assert [p.name for p in yielded] == [
        "Starbucks Reserve",
        "Starlight Dental Clinic",
        "Green Leaf Co",
    ]

    # 1. Starbucks Reserve fast-aborted full DOM extraction and website probe
    starbucks = yielded[0]
    assert starbucks.address == "100 State St, Chicago, IL"
    assert starbucks.website == ""
    assert is_chain(starbucks.name) is True
    assert worker_is_chain(starbucks.name) is True

    # 2. Starlight Dental Clinic was NOT treated as a chain and retained full extraction
    starlight_dental = yielded[1]
    assert _is_conclusively_disqualified_by_name(starlight_dental.name) is False
    assert is_chain(starlight_dental.name) is False
    assert starlight_dental.website == "https://starlightdental.example.com"
    assert starlight_dental.phone == "+1 312-555-0200"
    assert starlight_dental.category == "Dentist"

    # 3. Green Leaf Co was NOT fast-aborted by name; full extraction captured category='Cannabis Dispensary'
    green_leaf = yielded[2]
    assert _is_conclusively_disqualified_by_name(green_leaf.name) is False
    assert green_leaf.category == "Cannabis Dispensary"
    assert worker_is_cannabis(green_leaf.name, green_leaf.category) is True
    assert is_cannabis(green_leaf.to_dict()) is True

    # Only 2 full _PLACE_EXTRACT_JS evaluations ran (for Cards 2 and 3; Card 1 was skipped)
    assert page.extract_evaluate_calls == 2
    snap = profiler.summary()
    assert snap["counters"].get("maps_detail_fast_abort_disqualified", 0) == 1
    assert snap["counters"].get("maps_website_probe_reused", 0) == 2


# ──────────────────────────────────────────────────────────────────────────────
# 5. Browser navigation failures & missing feed recovery
# ──────────────────────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_missing_feed_when_detail_open_falls_back_to_return_to_results(monkeypatch):
    """When the layout hides the feed while a detail pane is open (`hide_feed_when_detail_open=True`),
    `_can_continue_from_split_results_feed` returns False and `_return_to_results` is executed
    after every card so the feed is restored before clicking the next card."""
    cards = [
        {
            "href": "https://www.google.com/maps/place/Alpha+Clinic/data=!4m2!3m1!1s0x880fd2:0x100001",
            "aria": "Alpha Clinic · 10 Main St",
            "outcomes": [
                {
                    "name": "Alpha Clinic",
                    "address": "10 Main St, Chicago, IL",
                    "url": "https://www.google.com/maps/place/Alpha+Clinic/data=!4m2!3m1!1s0x880fd2:0x100001",
                }
            ],
        },
        {
            "href": "https://www.google.com/maps/place/Beta+Clinic/data=!4m2!3m1!1s0x880fd2:0x100002",
            "aria": "Beta Clinic · 20 Main St",
            "outcomes": [
                {
                    "name": "Beta Clinic",
                    "address": "20 Main St, Chicago, IL",
                    "url": "https://www.google.com/maps/place/Beta+Clinic/data=!4m2!3m1!1s0x880fd2:0x100002",
                }
            ],
        },
    ]

    page = _SplitViewScenarioPage(
        cards=cards,
        close_detail_on_back=True,
        hide_feed_when_detail_open=True,
    )
    _wire_page(monkeypatch, page)

    config = ScraperConfig(
        scroll_max_rounds=2,
        max_crash_retries=0,
        place_timeout_ms=150,
        place_settle_ms=20,
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

    assert [p.name for p in yielded] == ["Alpha Clinic", "Beta Clinic"]
    snap = profiler.summary()
    assert snap["counters"].get("return_to_results_skipped", 0) == 0
    assert snap["counters"].get("return_to_results_executed", 0) == 2


@pytest.mark.asyncio
async def test_unrecoverable_lost_feed_raises_bounded_return_to_results_failed(monkeypatch):
    """When the feed disappears when the detail pane opens AND back-navigation cannot close
    the detail pane, the scraper performs bounded search-navigation recovery and raises
    `DiscoveryFailure(RETURN_TO_RESULTS_FAILED)` after bounded consecutive failures."""
    cards = [
        {
            "href": f"https://www.google.com/maps/place/Clinic+{i}/data=!4m2!3m1!1s0x880fd2:0x20000{i}",
            "aria": f"Clinic {i} · {i}0 Main St",
            "outcomes": [
                {
                    "name": f"Clinic {i}",
                    "address": f"{i}0 Main St, Chicago, IL",
                    "url": f"https://www.google.com/maps/place/Clinic+{i}/data=!4m2!3m1!1s0x880fd2:0x20000{i}",
                }
            ],
        }
        for i in range(1, 5)
    ]

    page = _SplitViewScenarioPage(
        cards=cards,
        close_detail_on_back=False,
        hide_feed_when_detail_open=True,
        eol_on_first_round=False,
        unrecoverable_feed_after_first_click=True,
    )
    _wire_page(monkeypatch, page)

    config = ScraperConfig(
        scroll_max_rounds=3,
        max_crash_retries=0,
        place_timeout_ms=80,
        place_settle_ms=10,
        scroll_settle_timeout_ms=50,
        return_to_results_timeout_ms=80,
        maps_rpm=6000,
    )
    profiler = PerfProfiler()
    scraper = MapsScraper(config, stats=RunStats(), profiler=profiler)
    scraper._browser = object()
    scraper._limiter.acquire = lambda *_a, **_kw: asyncio.sleep(0)

    with pytest.raises(DiscoveryFailure) as exc_info:
        async for _place in scraper.search("dentists", "Chicago", max_results=10):
            pass

    assert exc_info.value.reason == DiscoveryFailureReason.RETURN_TO_RESULTS_FAILED


# ──────────────────────────────────────────────────────────────────────────────
# 6. Deduplication & early post-click skip before `_extract_place_data`
# ──────────────────────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_post_click_known_place_and_duplicate_identity_short_circuit_before_extraction(monkeypatch):
    """Verifies that:
    - Card 1 ('Lakeview Dental', 100 Lake St) is extracted and yielded (`extract_evaluate_calls == 1`).
    - Card 2 has a slug-only href without a CID before click, but redirects on click to a URL
      containing a `known_place_ids` CID -> short-circuits immediately after panel identity
      verification (`maps_detail_early_known_place_skipped == 1`), without calling `_extract_place_data`.
    - Card 3 has a distinct href/CID but opens a panel with the exact same `name|address` as
      Card 1 -> short-circuits immediately after panel identity verification
      (`maps_detail_early_duplicate_skipped == 1`), without calling `_extract_place_data`.
    - Card 4 has the same name ('Lakeview Dental') but a DIFFERENT address ('900 South Ave')
      -> NOT treated as a duplicate; runs full extraction and is yielded (`extract_evaluate_calls == 2`).
    """
    known_cid = "0x880fd2:0xdeadbeef"
    href_1 = "https://www.google.com/maps/place/Lakeview+Dental/data=!4m2!3m1!1s0x880fd2:0x111111"
    href_redirect_known = "https://www.google.com/maps/place/Mystery+Listing"
    href_dup_identity = "https://www.google.com/maps/place/Lakeview+Dental/data=!4m2!3m1!1s0x880fd2:0x222222"
    href_branch_2 = "https://www.google.com/maps/place/Lakeview+Dental/data=!4m2!3m1!1s0x880fd2:0x333333"

    cards = [
        {
            "href": href_1,
            "aria": "Lakeview Dental · 100 Lake St",
            "outcomes": [
                {
                    "name": "Lakeview Dental",
                    "address": "100 Lake St, Chicago, IL",
                    "url": href_1,
                }
            ],
        },
        {
            "href": href_redirect_known,
            "aria": "Mystery Listing · 500 West St",
            "outcomes": [
                {
                    "name": "Mystery Listing",
                    "address": "500 West St, Chicago, IL",
                    "url": f"https://www.google.com/maps/place/Mystery+Listing/data=!4m2!3m1!1s{known_cid}",
                }
            ],
        },
        {
            "href": href_dup_identity,
            "aria": "Lakeview Dental · 100 Lake St",
            "outcomes": [
                {
                    "name": "Lakeview Dental",
                    "address": "100 Lake St, Chicago, IL",
                    "url": href_dup_identity,
                }
            ],
        },
        {
            "href": href_branch_2,
            "aria": "Lakeview Dental · 900 South Ave",
            "outcomes": [
                {
                    "name": "Lakeview Dental",
                    "address": "900 South Ave, Chicago, IL",
                    "url": href_branch_2,
                }
            ],
        },
    ]

    page = _SplitViewScenarioPage(cards=cards)
    _wire_page(monkeypatch, page)

    config = ScraperConfig(
        scroll_max_rounds=2,
        max_crash_retries=0,
        place_timeout_ms=150,
        place_settle_ms=20,
        scroll_settle_timeout_ms=50,
        maps_rpm=6000,
    )
    profiler = PerfProfiler()
    scraper = MapsScraper(config, stats=RunStats(), profiler=profiler)
    scraper._browser = object()
    scraper._limiter.acquire = lambda *_a, **_kw: asyncio.sleep(0)

    yielded: list[RawPlace] = []
    async for place in scraper.search(
        "dentists",
        "Chicago",
        max_results=10,
        known_place_ids={known_cid},
    ):
        yielded.append(place)

    assert len(yielded) == 2
    assert [(p.name, p.address) for p in yielded] == [
        ("Lakeview Dental", "100 Lake St, Chicago, IL"),
        ("Lakeview Dental", "900 South Ave, Chicago, IL"),
    ]
    assert norm_maps_place_id(yielded[0].maps_link) == "0x880fd2:0x111111"
    assert norm_maps_place_id(yielded[1].maps_link) == "0x880fd2:0x333333"
    assert "place:0x880fd2:0x111111" in fingerprints_for(yielded[0].to_dict())
    assert "place:0x880fd2:0x333333" in fingerprints_for(yielded[1].to_dict())

    # Cards 2 and 3 were skipped BEFORE _extract_place_data: only 2 extract evaluations ran!
    assert page.extract_evaluate_calls == 2
    snap = profiler.summary()
    assert snap["counters"].get("maps_detail_early_known_place_skipped", 0) == 1
    assert snap["counters"].get("maps_detail_early_duplicate_skipped", 0) == 1


# ──────────────────────────────────────────────────────────────────────────────
# 7. Website probe reuse & single-pass heading read
# ──────────────────────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_extract_place_data_reuses_probed_website_without_requerying_website_selectors():
    """When `probed_website` is passed to `_extract_place_data`, `_PLACE_EXTRACT_JS` receives
    an empty `website` selector list (avoiding 6 redundant DOM selector queries) and the
    returned `RawPlace` reuses `probed_website` directly."""
    card = {
        "href": "https://www.google.com/maps/place/Reuse+Cafe/data=!4m2!3m1!1s0x880fd2:0x999999",
        "aria": "Reuse Cafe",
        "outcomes": [
            {
                "name": "Reuse Cafe",
                "category": "Cafe",
                "address": "777 Reuse Blvd, Chicago, IL",
                "website": "https://dom-fallback.example.com",
            }
        ],
    }
    page = _SplitViewScenarioPage(cards=[card])
    page.detail_open = True
    page.current_panel = card["outcomes"][0]
    page.url = card["href"]

    profiler = PerfProfiler()
    place = await _extract_place_data(
        page,
        config=ScraperConfig(),
        profiler=profiler,
        probed_website="https://probed-already.example.com",
    )

    assert place is not None
    assert place.name == "Reuse Cafe"
    assert place.website == "https://probed-already.example.com"
    assert page.last_extract_selectors is not None
    assert page.last_extract_selectors["website"] == []
    assert profiler.summary()["counters"].get("maps_website_probe_reused", 0) == 1


@pytest.mark.asyncio
async def test_read_panel_identity_snapshot_queries_heading_once_when_open():
    """`_read_panel_identity_snapshot` reads the heading selector in a single pass rather
    than querying it twice (once in `_is_detail_pane_open` and once for `raw_name`)."""
    heading_queries = 0

    class _CountingPage:
        url = "https://www.google.com/maps/place/Single+Pass/data=!4m2!3m1!1s0x880fd2:0x555555"

        async def query_selector(self, selector: str):
            nonlocal heading_queries
            if selector == "h1.DUwDvf":
                heading_queries += 1
                return _FakeElement(text="Single Pass Bakery")
            if selector in ("button[data-item-id='address']", "[data-item-id='address'] .fontBodyMedium"):
                return _FakeElement(text="42 Baker St, Chicago, IL")
            return None

    snap = await _read_panel_identity_snapshot(_CountingPage(), feed_el=object())
    assert snap["open"] is True
    assert snap["raw_name"] == "Single Pass Bakery"
    assert snap["raw_address"] == "42 Baker St, Chicago, IL"
    assert snap["place_id"] == "0x880fd2:0x555555"
    assert heading_queries == 1
