"""
PHASE 12A — zero-risk Maps click reduction: focused tests for
`_extract_card_signals()` and the ONE new click-gating behavior it feeds
in `MapsScraper.search()` (scraper/maps_scraper.py) — skipping a place
click only when the results-feed card itself explicitly, unambiguously
reports the business as permanently closed.

Scope, deliberately narrow, mirroring test_maps_scraper_progress_events.py's
established pattern: every internal helper this file doesn't care about
verifying (`_resolve_results_panel`, `_detect_interstitial`,
`_diag_dump_panel_dom`, `_human_scroll`, `_return_to_results`,
`_wait_for_place_settle`, `_extract_place_data`) is monkeypatched to a
minimal fake. `_extract_card_signals` and `_human_click` are the two
functions under test / instrumented here — NOT monkeypatched away (with
one exception: `_human_click` is replaced by a small controllable fake so
tests can force a click failure without touching real Playwright mouse/
box APIs, matching the existing suite's own convention for this call).

Explicitly verifies the audit's "VERY IMPORTANT" constraint: rating,
review_count, name, and category are captured by `_extract_card_signals`
but must NEVER gate whether a click happens — only an explicit closed
marker may.

Run: pytest tests/test_maps_scraper_card_closed_skip.py -v
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


# ---------------------------------------------------------------------------
# Minimal fake Playwright surface
# ---------------------------------------------------------------------------


class _FakeAnchor:
    """A single results-feed card anchor. `aria_label`/`visible_text` are
    exactly the two sources `_extract_card_signals` reads — nothing else
    on this fake is touched by that function."""

    def __init__(
        self,
        href: str,
        *,
        aria_label: str = "",
        visible_text: str = "",
        raise_on_attr: bool = False,
        raise_on_text: bool = False,
    ) -> None:
        self._href = href
        self._aria_label = aria_label
        self._visible_text = visible_text
        self._raise_on_attr = raise_on_attr
        self._raise_on_text = raise_on_text

    async def get_attribute(self, name: str) -> str | None:
        if name == "href":
            return self._href
        if name == "aria-label":
            if self._raise_on_attr:
                raise RuntimeError("simulated DOM query failure (aria-label)")
            return self._aria_label
        return None

    async def inner_text(self) -> str:
        if self._raise_on_text:
            raise RuntimeError("simulated DOM query failure (inner_text)")
        return self._visible_text

    async def scroll_into_view_if_needed(self, timeout: int = 2000) -> None:
        pass


class _FakePanel:
    """Same shape as test_maps_scraper_progress_events.py's _FakePanel,
    except `rounds` holds pre-built `_FakeAnchor` objects directly (not
    bare hrefs), so each anchor can carry its own aria-label/visible text."""

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
    """Controllable stand-in for `_human_click`. Records every anchor it
    was called with; raises for any href listed in `fail_for_hrefs`
    (simulating the existing "anchor detached/stale before click" path),
    succeeds (no-op) otherwise."""

    def __init__(self, fail_for_hrefs: set[str] | None = None) -> None:
        self.fail_for_hrefs = fail_for_hrefs or set()
        self.calls: list[str] = []

    async def __call__(self, _page, anchor) -> None:
        href = anchor._href
        self.calls.append(href)
        if href in self.fail_for_hrefs:
            raise RuntimeError("simulated stale/detached anchor")


def _fake_extracted_place(anchor_index: int) -> RawPlace:
    return RawPlace(name=f"Business {anchor_index}", address=f"{anchor_index} Test St")


@pytest.fixture
def patched_helpers(monkeypatch):
    monkeypatch.setattr(maps_scraper_module, "_diag_dump_panel_dom", _AsyncNoop())
    monkeypatch.setattr(maps_scraper_module, "_detect_interstitial", _AsyncReturns(None))
    monkeypatch.setattr(maps_scraper_module, "_human_scroll", _AsyncNoop())
    monkeypatch.setattr(maps_scraper_module, "_return_to_results", _AsyncReturns(True))
    monkeypatch.setattr(maps_scraper_module, "_wait_for_place_settle", _AsyncNoop())


def _make_scraper(page: _FakePage, monkeypatch, *, human_click=None) -> MapsScraper:
    async def _fake_new_stealth_context(_browser, proxy=None):
        return _FakeContext(page)

    monkeypatch.setattr(maps_scraper_module, "_new_stealth_context", _fake_new_stealth_context)
    monkeypatch.setattr(
        maps_scraper_module, "_resolve_results_panel", _AsyncReturns(("FAKE_PANEL_SEL", None))
    )
    monkeypatch.setattr(maps_scraper_module, "_human_click", human_click or _FakeHumanClick())

    config = ScraperConfig(headless=True, max_crash_retries=0)
    profiler = RunProfiler()
    scraper = MapsScraper(config, ProxyManager(), RunStats(), profiler=profiler)
    scraper._browser = object()
    scraper._limiter.acquire = _AsyncNoop()  # type: ignore[method-assign]
    return scraper


def _end_after(page: _FakePage, extract_calls: dict, total: int):
    async def _fake_extract(*_args, **_kwargs) -> RawPlace:
        extract_calls["n"] += 1
        if extract_calls["n"] >= total:
            page.eol_reached = True
        return _fake_extracted_place(extract_calls["n"])
    return _fake_extract


# ---------------------------------------------------------------------------
# 1. explicit closed card → no click
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_explicit_closed_card_skips_click(monkeypatch, patched_helpers):
    anchor = _FakeAnchor(
        "https://maps.google.com/maps/place/OldDiner",
        aria_label="Old Diner · Permanently closed · 4.2 stars · 10 reviews",
    )
    page = _FakePage(_FakePanel(rounds=[[anchor]]))
    page.eol_reached = True  # nothing else to do after this one anchor
    human_click = _FakeHumanClick()
    scraper = _make_scraper(page, monkeypatch, human_click=human_click)

    results = [p async for p in scraper.search(query="diner", city="Metro", max_results=5)]

    assert results == [], "a card-level closed skip must never yield a place"
    assert human_click.calls == [], "_human_click must never be called for an explicitly closed card"
    assert scraper._profiler.counter("maps_candidates_card_closed_skipped") == 1
    assert scraper._profiler.counter("maps_candidates_clicked") == 0


# ---------------------------------------------------------------------------
# 2. ordinary card → click unchanged
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_ordinary_card_is_clicked_and_yielded(monkeypatch, patched_helpers):
    anchor = _FakeAnchor(
        "https://maps.google.com/maps/place/GreatBakery",
        aria_label="Great Bakery · 4.8 stars · 120 reviews · Bakery",
    )
    page = _FakePage(_FakePanel(rounds=[[anchor]]))
    human_click = _FakeHumanClick()
    scraper = _make_scraper(page, monkeypatch, human_click=human_click)

    extract_calls = {"n": 0}
    monkeypatch.setattr(
        maps_scraper_module, "_extract_place_data", _end_after(page, extract_calls, 1)
    )

    results = [p async for p in scraper.search(query="bakery", city="Metro", max_results=5)]

    assert len(results) == 1
    assert human_click.calls == [anchor._href]
    assert scraper._profiler.counter("maps_candidates_clicked") == 1
    assert scraper._profiler.counter("maps_candidates_card_closed_skipped") == 0


# ---------------------------------------------------------------------------
# 3–6. every "VERY IMPORTANT" non-closed signal must still result in a click
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "label, aria_label",
    [
        ("rating_low", "Cheap Diner · 1.2 stars · 5 reviews"),
        ("review_count_zero", "New Shop · 4.5 stars · 0 reviews"),
        ("rating_missing", "Unknown Place · Restaurant · 5th Ave"),
        ("no_closed_marker_at_all", ""),
    ],
)
async def test_non_closed_signals_never_skip_the_click(monkeypatch, patched_helpers, label, aria_label):
    anchor = _FakeAnchor(
        f"https://maps.google.com/maps/place/{label}",
        aria_label=aria_label,
        visible_text=aria_label,
    )
    page = _FakePage(_FakePanel(rounds=[[anchor]]))
    human_click = _FakeHumanClick()
    scraper = _make_scraper(page, monkeypatch, human_click=human_click)

    extract_calls = {"n": 0}
    monkeypatch.setattr(
        maps_scraper_module, "_extract_place_data", _end_after(page, extract_calls, 1)
    )

    results = [p async for p in scraper.search(query="q", city="Metro", max_results=5)]

    assert human_click.calls == [anchor._href], (
        f"[{label}] a non-closed card signal must never prevent the click"
    )
    assert scraper._profiler.counter("maps_candidates_card_closed_skipped") == 0
    assert len(results) == 1


# ---------------------------------------------------------------------------
# 7. card-level extraction failure → still clicked
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_card_signal_extraction_failure_falls_back_to_click(monkeypatch, patched_helpers):
    anchor = _FakeAnchor(
        "https://maps.google.com/maps/place/FlakyCard",
        raise_on_attr=True,
        raise_on_text=True,
    )
    page = _FakePage(_FakePanel(rounds=[[anchor]]))
    human_click = _FakeHumanClick()
    scraper = _make_scraper(page, monkeypatch, human_click=human_click)

    extract_calls = {"n": 0}
    monkeypatch.setattr(
        maps_scraper_module, "_extract_place_data", _end_after(page, extract_calls, 1)
    )

    results = [p async for p in scraper.search(query="q", city="Metro", max_results=5)]

    assert human_click.calls == [anchor._href], (
        "a card-signal extraction failure must fail open (click as before), not skip"
    )
    assert scraper._profiler.counter("maps_candidates_card_closed_skipped") == 0
    assert len(results) == 1


# ---------------------------------------------------------------------------
# 8. closed skip does not affect qualification semantics for any accepted lead
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_closed_skip_does_not_alter_the_surviving_candidates_path(monkeypatch, patched_helpers):
    closed_anchor = _FakeAnchor(
        "https://maps.google.com/maps/place/ClosedOne",
        aria_label="Closed One · Permanently closed",
    )
    open_anchor = _FakeAnchor(
        "https://maps.google.com/maps/place/OpenOne",
        aria_label="Open One · 4.6 stars · 88 reviews",
    )
    page = _FakePage(_FakePanel(rounds=[[closed_anchor, open_anchor]]))
    human_click = _FakeHumanClick()
    scraper = _make_scraper(page, monkeypatch, human_click=human_click)

    extract_calls = {"n": 0}
    monkeypatch.setattr(
        maps_scraper_module, "_extract_place_data", _end_after(page, extract_calls, 1)
    )

    results = [p async for p in scraper.search(query="q", city="Metro", max_results=5)]

    # Exactly the surviving (open) candidate is yielded, with exactly the
    # same shape _extract_place_data would have produced pre-Phase-12A —
    # the closed skip changed nothing about how the open one is handled.
    assert len(results) == 1
    assert results[0].name == "Business 1"
    assert results[0].address == "1 Test St"
    assert human_click.calls == [open_anchor._href], "only the open candidate should ever be clicked"
    assert scraper._profiler.counter("maps_candidates_card_closed_skipped") == 1
    assert scraper._profiler.counter("maps_candidates_clicked") == 1


# ---------------------------------------------------------------------------
# 9. click counter increments only after successful click
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_click_counter_increments_only_after_successful_click(monkeypatch, patched_helpers):
    stale_anchor = _FakeAnchor("https://maps.google.com/maps/place/Stale")
    good_anchor = _FakeAnchor("https://maps.google.com/maps/place/Good")
    page = _FakePage(_FakePanel(rounds=[[stale_anchor, good_anchor]]))
    human_click = _FakeHumanClick(fail_for_hrefs={stale_anchor._href})
    scraper = _make_scraper(page, monkeypatch, human_click=human_click)

    extract_calls = {"n": 0}
    monkeypatch.setattr(
        maps_scraper_module, "_extract_place_data", _end_after(page, extract_calls, 1)
    )

    results = [p async for p in scraper.search(query="q", city="Metro", max_results=5)]

    # Both anchors get a click attempt (neither is closed), but only the
    # second one succeeds — the first raises inside _human_click and is
    # caught by search()'s existing "anchor detached/stale" handler.
    assert set(human_click.calls) == {stale_anchor._href, good_anchor._href}
    assert scraper._profiler.counter("maps_candidates_clicked") == 1, (
        "the counter must not increment for the failed click attempt"
    )
    assert len(results) == 1


# ---------------------------------------------------------------------------
# 10. closed-skip counter increments exactly once
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_closed_skip_counter_increments_exactly_once_across_rounds(monkeypatch, patched_helpers):
    closed_anchor = _FakeAnchor(
        "https://maps.google.com/maps/place/ClosedTwice",
        aria_label="Closed Twice · Permanently closed",
    )
    # The same closed anchor is "still visible" across two scroll rounds
    # (nothing new appears in round 2) — seen_hrefs must prevent a second
    # counter increment on the re-scan.
    page = _FakePage(_FakePanel(rounds=[[closed_anchor], [closed_anchor]]))
    human_click = _FakeHumanClick()
    scraper = _make_scraper(page, monkeypatch, human_click=human_click)

    round_count = {"n": 0}
    real_scroll = _AsyncNoop()

    async def _scroll_then_eol(*_args, **_kwargs):
        round_count["n"] += 1
        if round_count["n"] >= 2:
            page.eol_reached = True
        return await real_scroll()

    monkeypatch.setattr(maps_scraper_module, "_human_scroll", _scroll_then_eol)

    results = [p async for p in scraper.search(query="q", city="Metro", max_results=5)]

    assert results == []
    assert human_click.calls == []
    assert scraper._profiler.counter("maps_candidates_card_closed_skipped") == 1
