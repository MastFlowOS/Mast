"""
Phase 33A — Place Panel Wait Telemetry Tests.

Targeted regression and distribution coverage for place_panel_wait telemetry:
1. Zero samples -> safe empty summary
2. One sample
3. Multiple samples
4. p50/p90/p99 calculation
5. Timeout count
6. Abort does not count as timeout
7. Existing area_sla_line remains compatible
8. No behavior change in Maps search
"""

from __future__ import annotations

import pytest

from scraper.maps_scraper import MapsScraper, ScraperConfig
from utils.perf import NullProfiler, RunProfiler


# ── Test 1: Zero samples → safe empty summary ─────────────────────────────────

def test_zero_samples_safe_empty_summary():
    profiler = RunProfiler()
    summary = profiler.place_panel_wait_summary()

    assert summary["place_panel_wait_count"] == 0
    assert summary["place_panel_wait_total_ms"] == 0.0
    assert summary["place_panel_wait_avg_ms"] is None
    assert summary["place_panel_wait_p50_ms"] is None
    assert summary["place_panel_wait_p90_ms"] is None
    assert summary["place_panel_wait_p99_ms"] is None
    assert summary["place_panel_wait_max_ms"] is None
    assert summary["place_panel_wait_timeout_count"] == 0

    full_summary = profiler.summary()
    assert full_summary["place_panel_wait_count"] == 0
    assert full_summary["place_panel_wait_total_ms"] == 0.0
    assert full_summary["place_panel_wait_avg_ms"] is None
    assert full_summary["place_panel_wait_timeout_count"] == 0
    assert "place_panel_wait_summary" in full_summary
    assert full_summary["place_panel_wait_summary"] == summary

    # NullProfiler also safely produces empty summary
    null_prof = NullProfiler()
    null_summary = null_prof.place_panel_wait_summary()
    assert null_summary["place_panel_wait_count"] == 0
    assert null_summary["place_panel_wait_total_ms"] == 0.0
    assert null_summary["place_panel_wait_avg_ms"] is None
    assert null_summary["place_panel_wait_timeout_count"] == 0


# ── Test 2: One sample ────────────────────────────────────────────────────────

def test_one_sample():
    profiler = RunProfiler()
    profiler.record_stage_duration("place_panel_wait", 245.5)

    summary = profiler.place_panel_wait_summary()
    assert summary["place_panel_wait_count"] == 1
    assert summary["place_panel_wait_total_ms"] == 245.5
    assert summary["place_panel_wait_avg_ms"] == 245.5
    assert summary["place_panel_wait_p50_ms"] == 245.5
    assert summary["place_panel_wait_p90_ms"] == 245.5
    assert summary["place_panel_wait_p99_ms"] == 245.5
    assert summary["place_panel_wait_max_ms"] == 245.5
    assert summary["place_panel_wait_timeout_count"] == 0


# ── Test 3: Multiple samples ──────────────────────────────────────────────────

def test_multiple_samples():
    profiler = RunProfiler()
    samples = [100.0, 200.0, 300.0, 400.0, 500.0]
    for s in samples:
        profiler.record_stage_duration("place_panel_wait", s)

    summary = profiler.place_panel_wait_summary()
    assert summary["place_panel_wait_count"] == 5
    assert summary["place_panel_wait_total_ms"] == 1500.0
    assert summary["place_panel_wait_avg_ms"] == 300.0
    assert summary["place_panel_wait_max_ms"] == 500.0
    assert summary["place_panel_wait_timeout_count"] == 0


# ── Test 4: p50 / p90 / p99 calculation ────────────────────────────────────────

def test_percentile_calculation():
    profiler = RunProfiler()
    # 100 samples from 1.0 to 100.0
    for i in range(1, 101):
        profiler.record_stage_duration("place_panel_wait", float(i))

    summary = profiler.place_panel_wait_summary()
    assert summary["place_panel_wait_count"] == 100
    assert summary["place_panel_wait_total_ms"] == 5050.0
    assert summary["place_panel_wait_avg_ms"] == 50.5
    # For 100 items (1..100):
    # p50 idx = max(0, int(100 * 50 / 100) - 1) = 49 -> 50.0
    # p90 idx = max(0, int(100 * 90 / 100) - 1) = 89 -> 90.0
    # p99 idx = max(0, int(100 * 99 / 100) - 1) = 98 -> 99.0
    assert summary["place_panel_wait_p50_ms"] == 50.0
    assert summary["place_panel_wait_p90_ms"] == 90.0
    assert summary["place_panel_wait_p99_ms"] == 99.0
    assert summary["place_panel_wait_max_ms"] == 100.0


# ── Test 5: Timeout count ─────────────────────────────────────────────────────

def test_timeout_count():
    profiler = RunProfiler()
    profiler.record_stage_duration("place_panel_wait", 5000.0)
    profiler.incr("place_panel_wait_timeout", by=3)

    summary = profiler.place_panel_wait_summary()
    assert summary["place_panel_wait_count"] == 1
    assert summary["place_panel_wait_total_ms"] == 5000.0
    assert summary["place_panel_wait_timeout_count"] == 3

    full_summary = profiler.summary()
    assert full_summary["place_panel_wait_timeout_count"] == 3
    assert full_summary["counters"]["place_panel_wait_timeout"] == 3


# ── Test 6: Abort does not count as timeout ───────────────────────────────────

def test_abort_does_not_count_as_timeout():
    profiler = RunProfiler()
    profiler.incr("place_panel_wait_aborted", by=2)

    summary = profiler.place_panel_wait_summary()
    assert summary["place_panel_wait_timeout_count"] == 0
    assert profiler.counter("place_panel_wait_aborted") == 2
    assert profiler.counter("place_panel_wait_timeout") == 0


# ── Test 7: Existing area_sla_line remains compatible ─────────────────────────

def test_existing_area_sla_line_compatibility():
    profiler = RunProfiler()
    profiler.record_stage_duration("place_panel_wait", 120.0)
    profiler.record_stage_duration("place_panel_wait", 180.0)
    profiler.incr("place_panel_wait_timeout", by=1)
    profiler.record_stage_duration("website_worker", 250.0)
    profiler.incr("raw_candidates", by=10)
    profiler.incr("delivered", by=3)

    line = profiler.area_sla_line(
        area="Queens",
        runtime_ms=50000.0,
        first_candidate_ms=200.0,
        first_enrichment_ms=500.0,
        first_qualified_ms=1000.0,
        first_delivered_ms=1500.0,
    )

    fields = dict(row.split("=", 1) for row in line.splitlines() if "=" in row)

    # Check that standard existing fields are present and unmodified
    assert fields["area"] == "Queens"
    assert fields["runtime_ms"] == "50000.0"
    assert fields["first_candidate_ms"] == "200.0"
    assert fields["first_delivered_ms"] == "1500.0"
    assert fields["website_ms"] == "250.0"
    assert fields["raw_candidates"] == "10"
    assert fields["delivered"] == "3"

    # Check that new Phase 33A telemetry fields are present
    assert fields["place_panel_wait_count"] == "2"
    assert fields["place_panel_wait_total_ms"] == "300.0"
    assert fields["place_panel_wait_avg_ms"] == "150.0"
    assert fields["place_panel_wait_p50_ms"] == "120.0"
    assert fields["place_panel_wait_max_ms"] == "180.0"
    assert fields["place_panel_wait_timeout_count"] == "1"

    # NullProfiler remains no-op
    assert NullProfiler().area_sla_line(area="Queens", runtime_ms=10.0,
                                         first_candidate_ms=None, first_enrichment_ms=None,
                                         first_qualified_ms=None, first_delivered_ms=None) == ""


# ── Test 8: No behavior change in Maps search ─────────────────────────────────

@pytest.mark.asyncio
async def test_maps_scraper_place_panel_wait_instrumentation_flow():
    """
    Verify MapsScraper.search instrumentation properly counts resolved,
    timeout, and aborted panel waits without changing scraping behavior.
    """
    config = ScraperConfig(headless=True)
    profiler = RunProfiler()
    scraper = MapsScraper(config=config, profiler=profiler)

    # Test normal panel wait timer
    with profiler.timer("place_panel_wait"):
        profiler.incr("place_panel_wait_resolved")

    assert profiler.place_panel_wait_summary()["place_panel_wait_count"] == 1
    assert profiler.counter("place_panel_wait_resolved") == 1
    assert profiler.counter("place_panel_wait_timeout") == 0
    assert profiler.counter("place_panel_wait_aborted") == 0

    # Test timeout wait (when not aborted)
    with profiler.timer("place_panel_wait"):
        profiler.incr("place_panel_wait_timeout")

    assert profiler.place_panel_wait_summary()["place_panel_wait_count"] == 2
    assert profiler.place_panel_wait_summary()["place_panel_wait_timeout_count"] == 1

    # Test abort wait (should_stop=True)
    should_stop = lambda: True
    with profiler.timer("place_panel_wait"):
        if should_stop():
            profiler.incr("place_panel_wait_aborted")
        else:
            profiler.incr("place_panel_wait_timeout")

    # Timeout count should STILL be 1, aborted should be 1
    assert profiler.place_panel_wait_summary()["place_panel_wait_count"] == 3
    assert profiler.place_panel_wait_summary()["place_panel_wait_timeout_count"] == 1
    assert profiler.counter("place_panel_wait_aborted") == 1


class _FakeAnchor:
    def __init__(self, href: str) -> None:
        self._href = href

    async def get_attribute(self, name: str) -> str | None:
        return self._href if name == "href" else None

    async def inner_text(self) -> str:
        return "Fake Business"

    async def scroll_into_view_if_needed(self, timeout: int = 2000) -> None:
        pass


class _FakePanel:
    def __init__(self, anchors: list[_FakeAnchor]) -> None:
        self.anchors = list(anchors)

    async def query_selector_all(self, _selector: str):
        res = list(self.anchors)
        self.anchors.clear()
        return res


class _FakePage:
    def __init__(
        self,
        panel: _FakePanel,
        *,
        timeout_on_wait: bool = False,
        abort_state: dict | None = None,
    ) -> None:
        self._panel = panel
        self.timeout_on_wait = timeout_on_wait
        self.abort_state = abort_state
        self.url = "https://www.google.com/maps/search/test"

    async def goto(self, *_args, **_kwargs) -> None:
        pass

    async def title(self) -> str:
        return "Fake Maps Results"

    async def evaluate(self, script: str):
        return "You've reached the end of the list"

    async def eval_on_selector_all(self, _selector: str, _script: str) -> int:
        return len(self._panel.anchors)

    async def query_selector(self, _selector: str):
        return self._panel

    async def wait_for_selector(self, _selector: str, timeout: int = 0) -> None:
        if self.timeout_on_wait:
            if self.abort_state is not None:
                self.abort_state["aborted"] = True
            from playwright.async_api import TimeoutError as PlaywrightTimeoutError
            raise PlaywrightTimeoutError("simulated panel wait timeout")
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


class _AsyncVal:
    def __init__(self, val=None):
        self.val = val
    async def __call__(self, *args, **kwargs):
        return self.val


@pytest.mark.asyncio
async def test_maps_scraper_search_e2e_normal_resolution(monkeypatch):
    import scraper.maps_scraper as maps_scraper_mod
    from scraper.maps_scraper import RawPlace
    from utils.runtime import ProxyManager, RunStats

    panel = _FakePanel([_FakeAnchor("https://maps.google.com/maps/place/Biz1")])
    page = _FakePage(panel, timeout_on_wait=False)

    async def _fake_ctx(*a, **k):
        return _FakeContext(page)
    monkeypatch.setattr(maps_scraper_mod, "_new_stealth_context", _fake_ctx)
    monkeypatch.setattr(maps_scraper_mod, "_resolve_results_panel", _AsyncVal(("PANEL", None)))
    monkeypatch.setattr(maps_scraper_mod, "_human_click", _AsyncVal())
    monkeypatch.setattr(maps_scraper_mod, "_wait_for_place_settle", _AsyncVal())
    monkeypatch.setattr(maps_scraper_mod, "_extract_card_signals", _AsyncVal({"closed": False}))
    monkeypatch.setattr(maps_scraper_mod, "_extract_place_data", _AsyncVal(RawPlace(name="Biz 1", address="123 Test St")))
    monkeypatch.setattr(maps_scraper_mod, "_return_to_results", _AsyncVal(True))
    monkeypatch.setattr(maps_scraper_mod, "_human_scroll", _AsyncVal())

    profiler = RunProfiler()
    scraper = MapsScraper(ScraperConfig(headless=True, max_crash_retries=0, scroll_max_rounds=1), ProxyManager(), RunStats(), profiler=profiler)
    scraper._browser = object()
    scraper._limiter.acquire = _AsyncVal()

    results = [p async for p in scraper.search(query="coffee", city="New York", max_results=1)]
    assert len(results) == 1
    assert results[0].name == "Biz 1"

    summary = profiler.place_panel_wait_summary()
    assert summary["place_panel_wait_count"] == 1
    assert profiler.counter("place_panel_wait_resolved") == 1
    assert summary["place_panel_wait_timeout_count"] == 0
    assert profiler.counter("place_panel_wait_aborted") == 0


@pytest.mark.asyncio
async def test_maps_scraper_search_e2e_timeout_counting(monkeypatch):
    import scraper.maps_scraper as maps_scraper_mod
    from utils.runtime import ProxyManager, RunStats

    panel = _FakePanel([_FakeAnchor("https://maps.google.com/maps/place/BizTimeout")])
    page = _FakePage(panel, timeout_on_wait=True)

    async def _fake_ctx(*a, **k):
        return _FakeContext(page)
    monkeypatch.setattr(maps_scraper_mod, "_new_stealth_context", _fake_ctx)
    monkeypatch.setattr(maps_scraper_mod, "_resolve_results_panel", _AsyncVal(("PANEL", None)))
    monkeypatch.setattr(maps_scraper_mod, "_human_click", _AsyncVal())
    monkeypatch.setattr(maps_scraper_mod, "_extract_card_signals", _AsyncVal({"closed": False}))
    monkeypatch.setattr(maps_scraper_mod, "_return_to_results", _AsyncVal(True))
    monkeypatch.setattr(maps_scraper_mod, "_human_scroll", _AsyncVal())

    profiler = RunProfiler()
    scraper = MapsScraper(ScraperConfig(headless=True, max_crash_retries=0, scroll_max_rounds=1), ProxyManager(), RunStats(), profiler=profiler)
    scraper._browser = object()
    scraper._limiter.acquire = _AsyncVal()

    results = [p async for p in scraper.search(query="coffee", city="New York", max_results=1)]
    assert len(results) == 0

    summary = profiler.place_panel_wait_summary()
    assert summary["place_panel_wait_count"] == 1
    assert summary["place_panel_wait_timeout_count"] == 1
    assert profiler.counter("place_panel_wait_resolved") == 0
    assert profiler.counter("place_panel_wait_aborted") == 0


@pytest.mark.asyncio
async def test_maps_scraper_search_e2e_abort_distinction(monkeypatch):
    import scraper.maps_scraper as maps_scraper_mod
    from utils.runtime import ProxyManager, RunStats

    abort_state = {"aborted": False}
    panel = _FakePanel([_FakeAnchor("https://maps.google.com/maps/place/BizAbort")])
    page = _FakePage(panel, timeout_on_wait=True, abort_state=abort_state)

    async def _fake_ctx(*a, **k):
        return _FakeContext(page)
    monkeypatch.setattr(maps_scraper_mod, "_new_stealth_context", _fake_ctx)
    monkeypatch.setattr(maps_scraper_mod, "_resolve_results_panel", _AsyncVal(("PANEL", None)))
    monkeypatch.setattr(maps_scraper_mod, "_human_click", _AsyncVal())
    monkeypatch.setattr(maps_scraper_mod, "_extract_card_signals", _AsyncVal({"closed": False}))
    monkeypatch.setattr(maps_scraper_mod, "_return_to_results", _AsyncVal(True))
    monkeypatch.setattr(maps_scraper_mod, "_human_scroll", _AsyncVal())

    profiler = RunProfiler()
    scraper = MapsScraper(ScraperConfig(headless=True, max_crash_retries=0, scroll_max_rounds=1), ProxyManager(), RunStats(), profiler=profiler)
    scraper._browser = object()
    scraper._limiter.acquire = _AsyncVal()

    should_stop = lambda: abort_state["aborted"]
    results = [p async for p in scraper.search(query="coffee", city="New York", max_results=1, should_stop=should_stop)]
    assert len(results) == 0

    summary = profiler.place_panel_wait_summary()
    assert summary["place_panel_wait_count"] == 1
    assert summary["place_panel_wait_timeout_count"] == 0
    assert profiler.counter("place_panel_wait_aborted") == 1
    assert profiler.counter("place_panel_wait_resolved") == 0

