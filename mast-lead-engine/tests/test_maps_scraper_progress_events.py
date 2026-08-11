"""
MINIMAL FIX (discovery liveness / watchdog blindness — forensic audit §9)
— focused tests for the new `on_progress` heartbeat added to
`MapsScraper.search()` (scraper/maps_scraper.py): `panel_resolved`,
`round_scanned` (with `cards_in_dom`), `crash_detected`, and
`crash_recovered`.

Follows the exact monkeypatch-the-seam pattern already established by
tests/test_maps_scraper_should_stop.py (fake `_new_stealth_context`,
fake page/context objects implementing only what's actually touched)
but extends it far enough to drive a full attempt through panel
resolution and at least one scroll round, since panel_resolved/
round_scanned/crash_recovered all require getting past navigation into
the round loop — which should_stop's tests deliberately never reach
(they only exercise the pre-panel navigation-timeout crash path).

Every internal helper this test doesn't care about verifying
(`_resolve_results_panel`, `_detect_interstitial`, `_diag_dump_panel_dom`,
`_human_scroll`, `_return_to_results`, `_human_click`,
`_wait_for_place_settle`, `_extract_place_data`) is monkeypatched to a
minimal fake — none of scraper/maps_scraper.py's own
selector/scroll/extraction logic is touched or exercised by this file,
consistent with the audit's "Do NOT change the existing extraction
logic, selectors, scrolling strategy, enrichment pipeline" instruction.

Run: pytest tests/test_maps_scraper_progress_events.py -v
"""

from __future__ import annotations

import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

import scraper.maps_scraper as maps_scraper_module
from scraper.maps_scraper import MapsScraper, RawPlace
from utils.runtime import ProxyManager, RunStats, ScraperConfig


# ---------------------------------------------------------------------------
# Minimal fake Playwright surface — only what search() actually touches
# once the internal helpers below are monkeypatched out.
# ---------------------------------------------------------------------------


class _FakeAnchor:
    def __init__(self, href: str) -> None:
        self._href = href

    async def get_attribute(self, name: str) -> str:
        assert name == "href"
        return self._href

    async def scroll_into_view_if_needed(self, timeout: int = 2000) -> None:
        pass


class _FakePanel:
    """The results-feed panel element. `rounds` is a list of anchor-href
    lists, one per scroll round — round N's `query_selector_all` call
    returns `_FakeAnchor` objects for `rounds[N]` (clamped to the last
    entry once rounds run out, so a trailing EOL round still gets an
    empty-ish/stable answer instead of an IndexError)."""

    def __init__(self, rounds: list[list[str]]) -> None:
        self._rounds = rounds
        self.round_index = 0

    async def query_selector_all(self, _selector: str):
        idx = min(self.round_index, len(self._rounds) - 1)
        return [_FakeAnchor(href) for href in self._rounds[idx]]


class _FakePage:
    def __init__(self, panel: _FakePanel, *, goto_exception: Exception | None = None) -> None:
        self._panel = panel
        self._goto_exception = goto_exception
        self.goto_calls = 0
        self.url = "https://www.google.com/maps/search/fake"
        # Flips true once the test wants the EOL sentinel to appear in
        # `document.body.innerText` (checked after each round).
        self.eol_reached = False

    async def goto(self, *_args, **_kwargs) -> None:
        self.goto_calls += 1
        if self._goto_exception is not None:
            raise self._goto_exception

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


def _fake_extracted_place(anchor_index: int) -> RawPlace:
    return RawPlace(name=f"Business {anchor_index}", address=f"{anchor_index} Test St")


@pytest.fixture
def patched_helpers(monkeypatch):
    """Monkeypatches every internal helper `search()` calls other than
    the round-loop/attempt-loop control flow itself and the new
    `_emit_progress` heartbeat this phase adds — see module docstring."""
    monkeypatch.setattr(maps_scraper_module, "_diag_dump_panel_dom", _AsyncNoop())
    monkeypatch.setattr(maps_scraper_module, "_detect_interstitial", _AsyncReturns(None))
    monkeypatch.setattr(maps_scraper_module, "_human_scroll", _AsyncNoop())
    monkeypatch.setattr(maps_scraper_module, "_return_to_results", _AsyncReturns(True))
    monkeypatch.setattr(maps_scraper_module, "_human_click", _AsyncNoop())
    monkeypatch.setattr(maps_scraper_module, "_wait_for_place_settle", _AsyncNoop())

    extract_calls = {"n": 0}

    async def _fake_extract(*_args, **_kwargs) -> RawPlace:
        extract_calls["n"] += 1
        return _fake_extracted_place(extract_calls["n"])

    monkeypatch.setattr(maps_scraper_module, "_extract_place_data", _fake_extract)


class _AsyncNoop:
    async def __call__(self, *_args, **_kwargs):
        return None


class _AsyncReturns:
    def __init__(self, value):
        self._value = value

    async def __call__(self, *_args, **_kwargs):
        return self._value


def _make_scraper(page: _FakePage, monkeypatch, *, max_crash_retries: int = 2) -> MapsScraper:
    async def _fake_new_stealth_context(_browser, proxy=None):
        return _FakeContext(page)

    monkeypatch.setattr(maps_scraper_module, "_new_stealth_context", _fake_new_stealth_context)
    monkeypatch.setattr(
        maps_scraper_module, "_resolve_results_panel", _AsyncReturns(("FAKE_PANEL_SEL", None))
    )

    config = ScraperConfig(headless=True, max_crash_retries=max_crash_retries)
    scraper = MapsScraper(config, ProxyManager(), RunStats())
    scraper._browser = object()
    # Bypass the real 800ms-floor rate limiter — irrelevant to what this
    # file verifies and would only slow the test down.
    scraper._limiter.acquire = _AsyncNoop()  # type: ignore[method-assign]
    return scraper


@pytest.mark.asyncio
async def test_panel_resolved_and_round_scanned_emitted_once_each(monkeypatch, patched_helpers):
    """One attempt, one round with 2 anchor cards, then EOL: expect
    exactly one panel_resolved and exactly one round_scanned (not one per
    anchor — the audit's explicit "Do NOT emit one stdout event per
    anchor" instruction), with cards_in_dom correctly reflected."""
    panel = _FakePanel(rounds=[["https://maps.google.com/maps/place/Business1"]])
    page = _FakePage(panel)
    scraper = _make_scraper(page, monkeypatch)

    events: list[tuple[str, str, str | None]] = []

    def on_progress(stage: str, event: str, item_id: str | None) -> None:
        events.append((stage, event, item_id))

    # After the single anchor is yielded, the inner loop finds nothing
    # else unseen and falls through to the EOL check — flip it here so
    # the round loop ends cleanly on the very next pass.
    async def _extract_and_end(*args, **kwargs):
        page.eol_reached = True
        return _fake_extracted_place(1)

    monkeypatch.setattr(maps_scraper_module, "_extract_place_data", _extract_and_end)

    results = [
        place
        async for place in scraper.search(
            query="coffee", city="New York", max_results=5, on_progress=on_progress,
        )
    ]

    assert len(results) == 1
    panel_resolved_events = [e for e in events if e[1] == "panel_resolved"]
    round_scanned_events = [e for e in events if e[1] == "round_scanned"]
    assert panel_resolved_events == [("discovery", "panel_resolved", "1")]
    assert round_scanned_events == [("discovery", "round_scanned", "1")], (
        "expected exactly ONE round_scanned event for the one round with "
        "cards_in_dom=1 — not one per anchor re-query"
    )
    assert not [e for e in events if e[1] in ("crash_detected", "crash_recovered")]


@pytest.mark.asyncio
async def test_round_scanned_reports_cards_in_dom_and_fires_once_per_round_not_per_anchor(
    monkeypatch, patched_helpers
):
    """Three cards in one round (multiple anchor re-queries inside that
    same round as each anchor is processed) must still produce exactly
    one round_scanned event, carrying cards_in_dom=3."""
    hrefs = [
        "https://maps.google.com/maps/place/BizA",
        "https://maps.google.com/maps/place/BizB",
        "https://maps.google.com/maps/place/BizC",
    ]
    panel = _FakePanel(rounds=[hrefs])
    page = _FakePage(panel)
    scraper = _make_scraper(page, monkeypatch)

    events: list[tuple[str, str, str | None]] = []

    def on_progress(stage: str, event: str, item_id: str | None) -> None:
        events.append((stage, event, item_id))

    extract_calls = {"n": 0}

    async def _fake_extract(*_args, **_kwargs) -> RawPlace:
        extract_calls["n"] += 1
        if extract_calls["n"] >= len(hrefs):
            page.eol_reached = True
        return _fake_extracted_place(extract_calls["n"])

    monkeypatch.setattr(maps_scraper_module, "_extract_place_data", _fake_extract)

    results = [
        place
        async for place in scraper.search(
            query="coffee", city="New York", max_results=5, on_progress=on_progress,
        )
    ]

    assert len(results) == 3
    round_scanned_events = [e for e in events if e[1] == "round_scanned"]
    assert round_scanned_events == [("discovery", "round_scanned", "3")], (
        f"expected exactly one round_scanned(cards_in_dom=3) event, got {round_scanned_events}"
    )


@pytest.mark.asyncio
async def test_crash_detected_then_crash_recovered_on_retry(monkeypatch, patched_helpers):
    """First attempt's page.goto() raises a generic (non-DiscoveryFailure)
    exception — the "Target crashed"-shaped branch — which must emit
    crash_detected. The retry attempt succeeds and resolves a fresh
    panel, which must emit both panel_resolved AND crash_recovered
    (attempt > 1)."""
    panel = _FakePanel(rounds=[[]])  # empty round -> immediate EOL-free fallthrough
    page = _FakePage(panel)
    # eol_reached=True from the start so the (empty) round loop ends the
    # search cleanly right after the recovered attempt's first round.
    page.eol_reached = True

    pages_created: list[_FakePage] = []

    async def _fake_new_stealth_context(_browser, proxy=None):
        # First attempt: a page whose goto() raises (simulating a
        # browser/page/context crash). Every subsequent attempt: the
        # already-working fake `page` from above.
        if not pages_created:
            crashing_page = _FakePage(panel, goto_exception=RuntimeError("Target crashed"))
            pages_created.append(crashing_page)
            return _FakeContext(crashing_page)
        pages_created.append(page)
        return _FakeContext(page)

    monkeypatch.setattr(maps_scraper_module, "_new_stealth_context", _fake_new_stealth_context)
    monkeypatch.setattr(
        maps_scraper_module, "_resolve_results_panel", _AsyncReturns(("FAKE_PANEL_SEL", None))
    )

    config = ScraperConfig(headless=True, max_crash_retries=2)
    scraper = MapsScraper(config, ProxyManager(), RunStats())
    scraper._browser = object()
    scraper._limiter.acquire = _AsyncNoop()  # type: ignore[method-assign]

    events: list[tuple[str, str, str | None]] = []

    def on_progress(stage: str, event: str, item_id: str | None) -> None:
        events.append((stage, event, item_id))

    results = [
        place
        async for place in scraper.search(
            query="coffee", city="New York", max_results=5, on_progress=on_progress,
        )
    ]

    assert results == []  # empty round, no anchors, EOL immediately
    assert len(pages_created) == 2, "expected exactly one crash + one successful retry attempt"

    crash_detected_events = [e for e in events if e[1] == "crash_detected"]
    crash_recovered_events = [e for e in events if e[1] == "crash_recovered"]
    panel_resolved_events = [e for e in events if e[1] == "panel_resolved"]

    assert crash_detected_events == [("discovery", "crash_detected", "1")], (
        f"expected exactly one crash_detected(attempt=1) event, got {crash_detected_events}"
    )
    assert crash_recovered_events == [("discovery", "crash_recovered", "2")], (
        f"expected exactly one crash_recovered(attempt=2) event, got {crash_recovered_events}"
    )
    # panel_resolved must have fired for the successful (2nd) attempt —
    # the crashed 1st attempt never got past goto(), so it never resolved
    # a panel and must not have emitted panel_resolved at all.
    assert panel_resolved_events == [("discovery", "panel_resolved", "2")]


@pytest.mark.asyncio
async def test_on_progress_none_is_backward_compatible(monkeypatch, patched_helpers):
    """`on_progress=None` (the default) must behave exactly like before
    this phase — no observer callback, no exception, no behavior change."""
    panel = _FakePanel(rounds=[[]])
    page = _FakePage(panel)
    page.eol_reached = True
    scraper = _make_scraper(page, monkeypatch)

    results = [
        place
        async for place in scraper.search(query="coffee", city="New York", max_results=5)
    ]
    assert results == []


@pytest.mark.asyncio
async def test_on_progress_observer_exception_is_swallowed(monkeypatch, patched_helpers):
    """An observer that raises must never affect discovery itself —
    mirrors execution_driver.py's own `_emit()` contract."""
    panel = _FakePanel(rounds=[[]])
    page = _FakePage(panel)
    page.eol_reached = True
    scraper = _make_scraper(page, monkeypatch)

    def _raising_on_progress(*_args, **_kwargs):
        raise RuntimeError("observer boom")

    results = [
        place
        async for place in scraper.search(
            query="coffee", city="New York", max_results=5, on_progress=_raising_on_progress,
        )
    ]
    assert results == [], "a raising on_progress observer must not break discovery"
