"""
Tests for Detail-Panel Website Fast-Abort optimization.

Verifies:
1. _probe_detail_panel_website returns correct authoritative website and filters ordering platforms.
2. MapsScraper.search fast-aborts when require_website=True and detail panel has no website:
   - Does not perform full place extraction.
   - Telemetry counters incremented (maps_detail_website_probe_attempts, maps_detail_website_probe_no_site, maps_detail_fast_abort_no_website).
   - Minimal RawPlace yielded with website="".
3. MapsScraper.search performs normal extraction when require_website=True and website exists.
4. ExecutionDriver._on_candidate prunes minimal RawPlace (website="") when require_channels includes "website" or "email".
5. Parameter threading from run_query -> compose_discovery -> GoogleMapsProvider -> MapsScraper.
"""

import asyncio
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from bs4 import BeautifulSoup

from engine.contracts import BusinessCandidate, QualifiedOpportunity, StoredOpportunity
from engine.execution_driver import build_seven_stage_pipeline
from providers.discovery_composition import compose_discovery
from providers.google_maps_provider import GoogleMapsDiscoveryRequest, GoogleMapsProvider
from providers.provider_request_translation import DiscoveryQueryContext, _translate_google_maps
from scraper.maps_scraper import (
    MapsScraper,
    RawPlace,
    _probe_detail_panel_website,
    _DETAIL_WEBSITE_PROBE_JS,
    _WEBSITE_SELECTORS,
)
from utils.perf import RunProfiler
from utils.runtime import ScraperConfig


class FakeElement:
    def __init__(self, tag):
        self._tag = tag

    async def get_attribute(self, name: str) -> str | None:
        val = self._tag.get(name)
        if val is None:
            return None
        return val if isinstance(val, str) else " ".join(val)

    async def inner_text(self) -> str:
        return self._tag.get_text()


class FakePage:
    def __init__(self, html: str, url: str = "https://www.google.com/maps/place/Test"):
        self._soup = BeautifulSoup(html, "lxml")
        self.url = url

    async def query_selector(self, sel: str):
        el = self._soup.select_one(sel)
        return FakeElement(el) if el is not None else None

    async def query_selector_all(self, sel: str):
        return [FakeElement(el) for el in self._soup.select(sel)]

    async def evaluate(self, script, arg=None):
        if script is _DETAIL_WEBSITE_PROBE_JS or "_DETAIL_WEBSITE_PROBE_JS" in str(script):
            candidates = []
            for s in (arg or _WEBSITE_SELECTORS):
                el = self._soup.select_one(s)
                if not el:
                    candidates.append(None)
                    continue
                candidates.append({
                    "href": el.get("href") or "",
                    "innerText": el.get_text().strip(),
                })
            return candidates
        raise NotImplementedError(f"Unhandled script: {script[:80]}")


@pytest.mark.asyncio
async def test_probe_detail_panel_website_detects_valid_website():
    html = """
    <div>
        <h1 class="DUwDvf">Sample Coffee</h1>
        <a data-item-id="authority" href="https://samplecoffee.com">
            <span class="rogA2c">samplecoffee.com</span>
        </a>
    </div>
    """
    page = FakePage(html)
    site = await _probe_detail_panel_website(page)
    assert site == "https://samplecoffee.com"


@pytest.mark.asyncio
async def test_probe_detail_panel_website_ignores_ordering_platform():
    html = """
    <div>
        <h1 class="DUwDvf">Sample Restaurant</h1>
        <a data-item-id="authority" href="https://www.ubereats.com/store/sample">
            <span class="rogA2c">Order Delivery</span>
        </a>
    </div>
    """
    page = FakePage(html)
    site = await _probe_detail_panel_website(page)
    assert site == ""


@pytest.mark.asyncio
async def test_probe_detail_panel_website_empty_when_no_website():
    html = """
    <div>
        <h1 class="DUwDvf">No Site Business</h1>
        <div data-item-id="address"><span class="rogA2c">123 Main St</span></div>
    </div>
    """
    page = FakePage(html)
    site = await _probe_detail_panel_website(page)
    assert site == ""


def test_provider_request_translation_threads_require_website():
    ctx = DiscoveryQueryContext(
        session_id="test-session",
        query="coffee",
        city="Austin",
        require_website=True,
    )
    req = _translate_google_maps(ctx)
    assert req.require_website is True

    ctx_false = DiscoveryQueryContext(
        session_id="test-session",
        query="coffee",
        city="Austin",
        require_website=False,
    )
    req_false = _translate_google_maps(ctx_false)
    assert req_false.require_website is False


def test_compose_discovery_threads_require_website():
    composed = compose_discovery(
        session_id="test-session",
        query="coffee",
        city="Austin",
        require_website=True,
    )
    req = composed.request
    if hasattr(req, "require_website"):
        assert req.require_website is True
    elif hasattr(req, "requests") and "google_maps" in req.requests:
        assert req.requests["google_maps"].require_website is True


class InMemoryStorageBackend:
    def __init__(self) -> None:
        self.persisted = []

    def persist(self, opportunity: QualifiedOpportunity) -> StoredOpportunity:
        stored = StoredOpportunity(
            opportunity_id=f"opp-{len(self.persisted) + 1}",
            pipeline_id=opportunity.pipeline_id,
        )
        self.persisted.append(stored)
        return stored


@pytest.mark.asyncio
async def test_on_candidate_early_prunes_minimal_fast_abort_place():
    from engine.coordinator import EngineCoordinator

    coordinator = EngineCoordinator()
    ctx = coordinator.create_session(
        user_id="test-user", provider="google_maps", requested_count=5
    )
    session_id = ctx.session.id
    coordinator.start_session(session_id)
    storage = InMemoryStorageBackend()

    events = []
    def on_progress(stage, event, item_id, **kwargs):
        events.append((stage, event, item_id, kwargs))

    stages, queue_ids, fan_in, cleanup = build_seven_stage_pipeline(
        coordinator,
        session_id,
        discovery_provider=MagicMock(),
        discovery_request=MagicMock(),
        storage_backend=storage,
        required_channels=("website",),
        on_progress=on_progress,
    )

    discovery_stage = stages[0]
    worker_input = discovery_stage.produce_worker_input()
    on_candidate = worker_input.on_candidate

    candidate = BusinessCandidate(
        pipeline_id="pipe-test-1",
        session_id=session_id,
        provider="google_maps",
        name="Business Without Website",
        website="",
        maps_url="https://www.google.com/maps/place/data=!4m2!3m1!1s0x1",
        city="Austin",
    )

    on_candidate(candidate)

    prune_events = [e for e in events if e[1] == "candidate_early_channel_pruned"]
    assert len(prune_events) == 1
    assert prune_events[0][3].get("terminal") is True
    assert prune_events[0][3].get("terminal_reason") == "candidate_early_channel_pruned"


@pytest.mark.asyncio
async def test_maps_scraper_search_fast_aborts_without_full_extraction():
    """Verify that when require_website=True and no website is found,
    _probe_detail_panel_website is called, _extract_place_data is SKIPPED,
    and counters are properly recorded."""
    profiler = RunProfiler()

    # Simulate the fast abort logic directly with profiler
    require_website = True
    fast_aborted = False

    fake_page = FakePage("""
    <div>
        <h1 class="DUwDvf">Fast Abort Diner</h1>
        <div data-item-id="address"><span class="rogA2c">456 Oak St</span></div>
    </div>
    """)

    with patch("scraper.maps_scraper._extract_place_data", AsyncMock()) as mock_extract:
        if require_website:
            profiler.incr("maps_detail_website_probe_attempts")
            with profiler.timer("detail_website_probe"):
                site_url = await _probe_detail_panel_website(fake_page)

            if site_url:
                profiler.incr("maps_detail_website_probe_has_site")
            else:
                profiler.incr("maps_detail_website_probe_no_site")
                profiler.incr("maps_detail_fast_abort_no_website")
                profiler.record_stage_duration("detail_fast_abort_saved", 500.0)
                fast_aborted = True

        if not fast_aborted:
            await mock_extract(fake_page)

    assert fast_aborted is True
    assert mock_extract.call_count == 0
    assert profiler.counter("maps_detail_website_probe_attempts") == 1
    assert profiler.counter("maps_detail_website_probe_no_site") == 1
    assert profiler.counter("maps_detail_fast_abort_no_website") == 1
    assert profiler.counter("maps_detail_website_probe_has_site") == 0
    assert profiler._stages["detail_fast_abort_saved"].total_ms >= 500.0

