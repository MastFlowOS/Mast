"""
Bound the Google Maps detail-extraction `page.evaluate()` (discovery audit,
Phase 1 fix).

Production evidence: three `maps_place_extraction` calls hung for ~213s,
~156s and ~108s because Playwright's `page.evaluate()` has no timeout of its
own, until the Node inactivity watchdog (90s of no protocol progress) killed
the whole Python subprocess. `_extract_place_data()` now bounds that single
call with `ScraperConfig.place_extract_timeout_ms` and raises
`PlaceExtractionTimeout`, which `MapsScraper.search()` routes through its
existing crash-recovery path (fresh context/page, bounded by
`max_crash_retries`) instead of continuing against the hung page.

Every test uses a mocked page whose `evaluate()` hangs on demand; no browser
or network is involved and all timeouts are a few tens of milliseconds.

Run: pytest tests/test_maps_scraper_extraction_timeout.py -v
"""

from __future__ import annotations

import asyncio
import os
import sys
import time

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

import scraper.maps_scraper as maps_scraper_module
from exceptions import DiscoveryFailure
from scraper.maps_scraper import (
    MapsScraper,
    PlaceExtractionTimeout,
    _close_bounded,
    _extract_place_data,
)
from utils.perf import RunProfiler
from utils.runtime import ProxyManager, RunStats, ScraperConfig

TEST_TIMEOUT_MS = 50  # bound used by every test below


# ---------------------------------------------------------------------------
# Mock page / context
# ---------------------------------------------------------------------------


class _HangingEvaluatePage:
    """Minimal page for `_extract_place_data()` alone."""

    def __init__(self, *, hang: bool, data: dict | None = None) -> None:
        self.hang = hang
        self.data = data if data is not None else {"name": "Test Biz", "address": "1 Test St"}
        self.url = "https://www.google.com/maps/place/fake"
        self.evaluate_started = asyncio.Event()
        self.evaluate_cancelled = False

    async def evaluate(self, _script, _arg=None):
        self.evaluate_started.set()
        if self.hang:
            try:
                await asyncio.Event().wait()  # never resolves
            except asyncio.CancelledError:
                self.evaluate_cancelled = True
                raise
        return self.data


class _Anchor:
    def __init__(self, href: str) -> None:
        self._href = href

    async def get_attribute(self, name: str):
        return self._href if name == "href" else None

    async def inner_text(self) -> str:
        return ""

    async def scroll_into_view_if_needed(self, timeout: int = 2000) -> None:
        pass


class _Panel:
    def __init__(self, anchors: list[_Anchor]) -> None:
        self._anchors = anchors

    async def query_selector_all(self, _selector: str):
        return self._anchors


class _SearchPage:
    """Full-loop page: the detail-panel extraction `evaluate()` hangs for any
    href in `hang_hrefs`; everything else extracts normally. `close()` can
    also be made to hang."""

    def __init__(self, anchors: list[_Anchor], *, hang_hrefs: set[str], hang_close: bool = False,
                 on_hang=None) -> None:
        self._panel = _Panel(anchors)
        self.hang_hrefs = hang_hrefs
        self.hang_close = hang_close
        self.on_hang = on_hang
        self.current_href = ""
        self.url = "https://www.google.com/maps/search/fake"
        self.closed = False
        self.close_cancelled = False
        self.evaluate_cancelled = False
        self.hang_started = asyncio.Event()

    async def goto(self, *_a, **_k) -> None:
        pass

    async def title(self) -> str:
        return "Fake Maps Results"

    async def evaluate(self, script, _arg=None):
        if script is maps_scraper_module._PLACE_EXTRACT_JS:
            if self.current_href in self.hang_hrefs:
                if self.on_hang:
                    self.on_hang()
                self.hang_started.set()
                try:
                    await asyncio.Event().wait()
                except asyncio.CancelledError:
                    self.evaluate_cancelled = True
                    raise
            tail = self.current_href.rsplit("/", 1)[-1]
            return {"name": f"Biz {tail}", "address": f"{tail} Test St"}
        if "innerText" in script and "length" not in script:
            return "You've reached the end of the list"  # end the search after one pass
        return 0

    async def eval_on_selector_all(self, _selector: str, _script: str) -> int:
        return len(self._panel._anchors)

    async def query_selector(self, _selector: str):
        return self._panel

    async def wait_for_selector(self, _selector: str, timeout: int = 0) -> None:
        return None

    async def close(self) -> None:
        if self.hang_close:
            try:
                await asyncio.Event().wait()
            except asyncio.CancelledError:
                self.close_cancelled = True
                raise
        self.closed = True


class _Context:
    def __init__(self, page: _SearchPage) -> None:
        self._page = page

    async def new_page(self) -> _SearchPage:
        return self._page

    async def close(self) -> None:
        pass


class _Noop:
    async def __call__(self, *_a, **_k):
        return None


class _Returns:
    def __init__(self, value) -> None:
        self._value = value

    async def __call__(self, *_a, **_k):
        return self._value


async def _fake_click(page, anchor) -> None:
    page.current_href = anchor._href


def _href(name: str) -> str:
    return f"https://maps.google.com/maps/place/{name}"


def _build_scraper(monkeypatch, pages: list[_SearchPage], *, max_crash_retries: int) -> tuple[MapsScraper, list[_SearchPage]]:
    """`pages` are handed out one per attempt (the last one is reused)."""
    handed_out: list[_SearchPage] = []

    async def _fake_new_stealth_context(_browser, proxy=None):
        page = pages[min(len(handed_out), len(pages) - 1)]
        handed_out.append(page)
        return _Context(page)

    monkeypatch.setattr(maps_scraper_module, "_new_stealth_context", _fake_new_stealth_context)
    monkeypatch.setattr(maps_scraper_module, "_resolve_results_panel", _Returns(("FAKE_PANEL_SEL", None)))
    monkeypatch.setattr(maps_scraper_module, "_diag_dump_panel_dom", _Noop())
    monkeypatch.setattr(maps_scraper_module, "_detect_interstitial", _Returns(None))
    monkeypatch.setattr(maps_scraper_module, "_human_scroll", _Noop())
    monkeypatch.setattr(maps_scraper_module, "_return_to_results", _Returns(True))
    monkeypatch.setattr(maps_scraper_module, "_wait_for_place_settle", _Noop())
    monkeypatch.setattr(maps_scraper_module, "_human_click", _fake_click)

    config = ScraperConfig(
        headless=True,
        max_crash_retries=max_crash_retries,
        place_extract_timeout_ms=TEST_TIMEOUT_MS,
    )
    scraper = MapsScraper(config, ProxyManager(), RunStats(), profiler=RunProfiler())
    scraper._browser = object()
    scraper._limiter.acquire = _Noop()  # type: ignore[method-assign]
    return scraper, handed_out


async def _collect(scraper: MapsScraper, **kwargs) -> list:
    return [p async for p in scraper.search(query="diner", city="Metro", max_results=10, **kwargs)]


def _no_stray_tasks() -> bool:
    current = asyncio.current_task()
    return not [t for t in asyncio.all_tasks() if t is not current and not t.done()]


# ---------------------------------------------------------------------------
# 1. `_extract_place_data()` itself
# ---------------------------------------------------------------------------


def test_default_extraction_timeout_is_30s():
    if "PLACE_EXTRACT_TIMEOUT_MS" in os.environ:
        pytest.skip("overridden via environment")
    assert ScraperConfig().place_extract_timeout_ms == 30_000


@pytest.mark.asyncio
async def test_successful_extraction_still_works():
    page = _HangingEvaluatePage(hang=False)
    config = ScraperConfig(place_extract_timeout_ms=TEST_TIMEOUT_MS)

    place = await _extract_place_data(page, config=config, city="Metro")

    assert place is not None and place.name == "Test Biz"
    assert place.address == "1 Test St"


@pytest.mark.asyncio
async def test_hanging_evaluate_times_out_within_bound_and_is_cancelled():
    page = _HangingEvaluatePage(hang=True)
    config = ScraperConfig(place_extract_timeout_ms=TEST_TIMEOUT_MS)

    started = time.monotonic()
    with pytest.raises(PlaceExtractionTimeout) as info:
        await _extract_place_data(page, config=config)
    elapsed = time.monotonic() - started

    assert elapsed < 2.0, "must give up at the configured bound, not wait for the page"
    assert info.value.timeout_ms == TEST_TIMEOUT_MS
    assert page.evaluate_cancelled, "the hung evaluate() must be cancelled, not abandoned"
    assert _no_stray_tasks()


@pytest.mark.asyncio
async def test_timeout_message_carries_no_business_data():
    page = _HangingEvaluatePage(hang=True, data={"name": "Secret Bakery", "phone": "+1 555 0100"})
    config = ScraperConfig(place_extract_timeout_ms=TEST_TIMEOUT_MS)

    with pytest.raises(PlaceExtractionTimeout) as info:
        await _extract_place_data(page, config=config)

    text = str(info.value)
    assert "Secret Bakery" not in text and "555" not in text
    assert "place_extract" in text and str(TEST_TIMEOUT_MS) in text


# ---------------------------------------------------------------------------
# 2. `_close_bounded()`
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_close_bounded_gives_up_on_a_hung_close(monkeypatch):
    monkeypatch.setattr(maps_scraper_module, "_CLOSE_TIMEOUT_S", 0.05)
    page = _SearchPage([], hang_hrefs=set(), hang_close=True)

    started = time.monotonic()
    await _close_bounded(page.close, "page")  # must return, not raise or hang

    assert time.monotonic() - started < 2.0
    assert page.close_cancelled and _no_stray_tasks()


@pytest.mark.asyncio
async def test_close_bounded_swallows_ordinary_close_errors():
    async def _boom():
        raise RuntimeError("Target closed")

    await _close_bounded(_boom, "page")  # no exception


# ---------------------------------------------------------------------------
# 3. `MapsScraper.search()` recovery
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_timeout_recovers_with_fresh_page_and_preserves_earlier_results(monkeypatch):
    """A hangs-free, B hangs, C is fine. A (yielded before the hang) is kept,
    the page is rebuilt, the stuck card B is skipped on recovery, C is
    yielded, and the area finishes normally."""
    anchors = [_Anchor(_href("A")), _Anchor(_href("B")), _Anchor(_href("C"))]
    first = _SearchPage(anchors, hang_hrefs={_href("B")})
    second = _SearchPage(anchors, hang_hrefs={_href("B")})  # B would hang again if retried
    scraper, handed_out = _build_scraper(monkeypatch, [first, second], max_crash_retries=2)

    results = await asyncio.wait_for(_collect(scraper), timeout=10)

    assert [p.name for p in results] == ["Biz A", "Biz C"]
    assert len(handed_out) == 2, "exactly one recovery attempt (fresh context/page)"
    assert first.closed and second.closed, "both pages must be closed"
    assert first.evaluate_cancelled and not second.evaluate_cancelled, "B must not be retried"
    assert scraper._profiler.counter("place_extraction_timeouts") == 1
    assert _no_stray_tasks()


@pytest.mark.asyncio
async def test_timeout_on_last_attempt_raises_typed_failure_and_keeps_yielded(monkeypatch):
    """With no crash retries left the existing rule applies: a typed
    DiscoveryFailure (never an unhandled PlaceExtractionTimeout), and leads
    yielded earlier were already handed to the caller."""
    anchors = [_Anchor(_href("A")), _Anchor(_href("B"))]
    page = _SearchPage(anchors, hang_hrefs={_href("B")}, hang_close=True)
    monkeypatch.setattr(maps_scraper_module, "_CLOSE_TIMEOUT_S", 0.05)
    scraper, handed_out = _build_scraper(monkeypatch, [page], max_crash_retries=0)

    yielded: list = []
    started = time.monotonic()
    with pytest.raises(DiscoveryFailure):
        async for place in scraper.search(query="diner", city="Metro", max_results=10):
            yielded.append(place)

    assert time.monotonic() - started < 5.0, "an unresponsive page (even on close) must not hang the area"
    assert [p.name for p in yielded] == ["Biz A"]
    assert len(handed_out) == 1
    assert page.close_cancelled, "the hung page.close() must have been abandoned"
    assert _no_stray_tasks()


@pytest.mark.asyncio
async def test_timeout_during_cooperative_stop_ends_cleanly_without_retry(monkeypatch):
    stop = {"flag": False}
    page = _SearchPage(
        [_Anchor(_href("A"))],
        hang_hrefs={_href("A")},
        on_hang=lambda: stop.__setitem__("flag", True),  # shutdown requested while hung
    )
    scraper, handed_out = _build_scraper(monkeypatch, [page], max_crash_retries=2)

    results = await asyncio.wait_for(
        _collect(scraper, should_stop=lambda: stop["flag"]), timeout=10
    )

    assert results == []
    assert len(handed_out) == 1, "no recovery attempt once a cooperative stop was requested"
    assert page.closed


@pytest.mark.asyncio
async def test_caller_cancellation_interrupts_a_hung_extraction(monkeypatch):
    """Cancellation is not converted into a timeout/crash-retry: the task is
    cancelled, the hung evaluate() is cancelled with it, resources are closed."""
    page = _SearchPage([_Anchor(_href("A"))], hang_hrefs={_href("A")})
    # a bound far larger than the test, so only the cancel can end it
    scraper, handed_out = _build_scraper(monkeypatch, [page], max_crash_retries=2)
    scraper.config.place_extract_timeout_ms = 60_000

    task = asyncio.ensure_future(_collect(scraper))
    await asyncio.wait_for(page.hang_started.wait(), timeout=5)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task

    assert page.evaluate_cancelled
    assert page.closed and len(handed_out) == 1
    assert _no_stray_tasks()
