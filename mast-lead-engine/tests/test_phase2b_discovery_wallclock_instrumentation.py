"""
Phase 2B — Discovery wall-clock instrumentation.

Targeted regression coverage for the pieces this phase adds, proving
the new discovery timers/counters are actually populated when Google
Maps / provider work runs — the exact gap the Phase 2B task describes
(`[area-sla]` reading 0 for maps_ms/navigation_ms/panel_ms/scroll_ms/
place_click_ms/rate_limit_ms/extraction_ms even while discovery_worker
consumes 200-315s of real production wall-clock time).

  1. `GoogleMapsProvider(profiler=...)` (providers/google_maps_provider.py)
     — the ROOT CAUSE FIX: profiler is now actually threaded into
     `MapsScraper`, so a stage timer fired inside MapsScraper.search()
     lands in the SAME profiler instance the caller is holding, not a
     silently-discarded NullProfiler.

  2. `TimedDiscoveryProvider` / `wrap_with_timing()`
     (providers/provider_timing.py) — composition-root wall-clock
     wrapper. Proves it measures real elapsed time (not a fabricated
     value), excludes downstream consumer time between pulls, and
     survives StopIteration/exceptions without losing the in-flight
     sample.

  3. `OverpassProvider(profiler=...)` (providers/overpass_provider.py)
     — `overpass_requests`/`overpass_retries` counters, driven by the
     new `on_attempt` hook on `_http_post_urllib`.

  4. `ExecutionDriver(..., on_stage_wallclock=...)`
     (engine/execution_driver.py) — the generic per-stage wall-clock
     hook `service.py` uses to populate `discovery_total_ms` and the
     previously-never-set `discovery_worker_end` mark.

  5. `RunProfiler.area_sla_line()` (utils/perf.py) — the new fields
     actually appear in the formatted report and are sourced from the
     right stages/counters.

These are deliberately narrow, source-tracing-driven tests, matching
tests/test_phase2_area_sla_instrumentation.py's own stated scope: "the
new fields/hooks work as designed", not new pipeline business-logic
coverage. Per the Phase 2B task, this phase is instrumentation +
tests only — no worker-count/dedup/qualification/candidate-budget/
rotation/provider-selection/Maps-navigation behavior changes.
"""

from __future__ import annotations

import time

import pytest

from engine.contracts import BusinessCandidate
from engine.execution_driver import ExecutionDriver, StageConfig
from engine.interfaces import DiscoveryProviderInterface
from engine.runtime import EngineRuntime, StageOutcome
from providers.google_maps_provider import GoogleMapsDiscoveryRequest, GoogleMapsProvider
from providers.overpass_provider import OverpassProvider
from providers.provider_timing import TimedDiscoveryProvider, wrap_with_timing
from utils.perf import NullProfiler, RunProfiler


def _candidate(name: str) -> BusinessCandidate:
    return BusinessCandidate(
        pipeline_id="p1", session_id="s1", provider="dummy",
        provider_business_id=name, name=name,
    )


class _SlowDiscoveryProvider(DiscoveryProviderInterface):
    """
    Yields a fixed number of candidates, sleeping a known, real amount
    of wall-clock time before each one — so a test can assert the
    measured total is at least that real sleep time (never a
    fabricated/zero value), without depending on exact timing.
    """

    def __init__(self, count: int = 3, sleep_s: float = 0.03) -> None:
        self._count = count
        self._sleep_s = sleep_s

    @property
    def provider_id(self) -> str:
        return "slow_dummy"

    @property
    def display_name(self) -> str:
        return "Slow Dummy"

    def discover(self, request):
        for i in range(self._count):
            time.sleep(self._sleep_s)
            yield _candidate(f"place-{i}")


class TestTimedDiscoveryProvider:
    """providers/provider_timing.py"""

    def test_measures_real_wallclock_not_zero(self):
        profiler = RunProfiler()
        wrapped = TimedDiscoveryProvider(
            _SlowDiscoveryProvider(count=3, sleep_s=0.03),
            profiler=profiler, total_stage="google_maps_provider_total",
        )
        candidates = list(wrapped.discover(request=None))
        assert len(candidates) == 3
        # 3 real sleeps of ~30ms each -> total should be well over
        # 60ms; a fabricated/zero value would read 0.0.
        assert profiler._stages["google_maps_provider_total"].total_ms > 60.0

    def test_excludes_downstream_consumer_time_between_pulls(self):
        """
        Time spent by the CALLER between pulls (e.g. on_candidate)
        must never be billed to the provider's own total — see
        providers/provider_timing.py's own docstring, "Time strictly
        excludes...".
        """
        profiler = RunProfiler()
        wrapped = TimedDiscoveryProvider(
            _SlowDiscoveryProvider(count=2, sleep_s=0.01),
            profiler=profiler, total_stage="google_maps_provider_total",
        )
        for _ in wrapped.discover(request=None):
            time.sleep(0.2)  # deliberately large consumer-side delay
        # Provider itself only ever slept ~20ms total; if consumer time
        # leaked in, this would read >= 400ms.
        assert profiler._stages["google_maps_provider_total"].total_ms < 200.0

    def test_delegates_provider_id_and_display_name(self):
        inner = _SlowDiscoveryProvider()
        wrapped = TimedDiscoveryProvider(inner, profiler=RunProfiler(), total_stage="x")
        assert wrapped.provider_id == inner.provider_id
        assert wrapped.display_name == inner.display_name

    def test_wrap_with_timing_is_noop_without_profiler(self):
        inner = _SlowDiscoveryProvider()
        assert wrap_with_timing(inner, profiler=None, total_stage="x") is inner
        assert wrap_with_timing(inner, profiler=RunProfiler(), total_stage=None) is inner
        assert wrap_with_timing(inner, profiler=RunProfiler(), total_stage="") is inner

    def test_wrap_with_timing_wraps_when_both_given(self):
        inner = _SlowDiscoveryProvider()
        wrapped = wrap_with_timing(inner, profiler=RunProfiler(), total_stage="x")
        assert isinstance(wrapped, TimedDiscoveryProvider)

    def test_records_in_flight_sample_on_exception(self):
        """
        An exception raised mid-generator must not swallow the
        already-elapsed time for that pull — see the class docstring's
        "Any exception raised while pulling..." paragraph.
        """
        profiler = RunProfiler()

        def _boom(request):
            time.sleep(0.02)
            raise RuntimeError("provider blew up")
            yield  # pragma: no cover - makes this a generator function

        class _BoomProvider(DiscoveryProviderInterface):
            @property
            def provider_id(self) -> str:
                return "boom"

            @property
            def display_name(self) -> str:
                return "Boom"

            def discover(self, request):
                return _boom(request)

        wrapped = TimedDiscoveryProvider(
            _BoomProvider(), profiler=profiler, total_stage="google_maps_provider_total",
        )
        with pytest.raises(RuntimeError):
            list(wrapped.discover(request=None))
        assert profiler._stages["google_maps_provider_total"].total_ms > 0.0


class TestGoogleMapsProviderProfilerWiring:
    """
    providers/google_maps_provider.py — the ROOT CAUSE fix. Proves the
    profiler passed to GoogleMapsProvider(...) is the SAME instance
    MapsScraper ends up recording stage timers into (rather than a
    NullProfiler MapsScraper silently defaults to, which is what
    happened on the production path this phase's task describes).
    """

    def test_profiler_defaults_to_nullprofiler_when_omitted(self):
        provider = GoogleMapsProvider()
        assert isinstance(provider._profiler, NullProfiler)

    def test_profiler_is_stored_when_supplied(self):
        profiler = RunProfiler()
        provider = GoogleMapsProvider(profiler=profiler)
        assert provider._profiler is profiler

    def test_maps_scraper_receives_the_same_profiler_instance(self, monkeypatch):
        """
        Root-cause regression test: before this phase,
        `GoogleMapsProvider._discover_async()` unconditionally called
        `MapsScraper(config, proxy_manager, stats)` with NO profiler
        argument, so this test would have failed (captured=None)
        against the pre-fix code.
        """
        import providers.google_maps_provider as gmp_module

        captured = {}

        class _CapturingFakeMapsScraper:
            def __init__(self, config, proxy_manager, stats, *, profiler=None):
                captured["profiler"] = profiler

            async def __aenter__(self):
                return self

            async def __aexit__(self, *a):
                return None

            async def search(self, **kwargs):
                if False:
                    yield None  # pragma: no cover - empty async generator

        monkeypatch.setattr(gmp_module, "MapsScraper", _CapturingFakeMapsScraper)

        profiler = RunProfiler()
        provider = GoogleMapsProvider(profiler=profiler)
        request = GoogleMapsDiscoveryRequest(session_id="s1", query="coffee", city="Testville")
        list(provider.discover(request))

        assert captured["profiler"] is profiler

    def test_falls_back_when_wrapped_mapsscraper_predates_profiler_kwarg(self, monkeypatch):
        """
        Backward-compatibility: a monkeypatched MapsScraper that
        doesn't accept `profiler=` (matching
        tests/test_google_maps_provider_should_stop.py's
        `_FakeMapsScraper`) must still work, unchanged from before this
        phase.
        """
        import providers.google_maps_provider as gmp_module

        class _LegacyFakeMapsScraper:
            def __init__(self, config, proxy_manager, stats):
                pass

            async def __aenter__(self):
                return self

            async def __aexit__(self, *a):
                return None

            async def search(self, **kwargs):
                if False:
                    yield None  # pragma: no cover

        monkeypatch.setattr(gmp_module, "MapsScraper", _LegacyFakeMapsScraper)

        provider = GoogleMapsProvider(profiler=RunProfiler())
        request = GoogleMapsDiscoveryRequest(session_id="s1", query="coffee", city="Testville")
        # Must not raise TypeError.
        assert list(provider.discover(request)) == []


class TestOverpassProviderRequestCounters:
    """
    providers/overpass_provider.py — overpass_requests / overpass_retries,
    driven by the new `on_attempt` hook on `_http_post_urllib`.
    """

    def test_single_successful_call_counts_one_request_zero_retries(self):
        profiler = RunProfiler()

        def _fake_http_post(url, data, headers, timeout=None, should_stop=None, on_attempt=None):
            if on_attempt is not None:
                on_attempt()
            return {"elements": []}

        provider = OverpassProvider(http_post=_fake_http_post, profiler=profiler)
        from providers.overpass_provider import OverpassDiscoveryRequest

        request = OverpassDiscoveryRequest(
            session_id="s1", tags={"shop": "coffee"}, around=(1000.0, 40.7, -73.9),
        )
        list(provider.discover(request))
        assert profiler.counter("overpass_requests") == 1
        assert profiler.counter("overpass_retries") == 0

    def test_retried_call_counts_multiple_requests(self):
        profiler = RunProfiler()
        attempts = {"n": 0}

        def _fake_http_post(url, data, headers, timeout=None, should_stop=None, on_attempt=None):
            attempts["n"] += 1
            if on_attempt is not None:
                on_attempt()
                on_attempt()
                on_attempt()
            return {"elements": []}

        provider = OverpassProvider(http_post=_fake_http_post, profiler=profiler)
        from providers.overpass_provider import OverpassDiscoveryRequest

        request = OverpassDiscoveryRequest(
            session_id="s1", tags={"shop": "coffee"}, around=(1000.0, 40.7, -73.9),
        )
        list(provider.discover(request))
        assert profiler.counter("overpass_requests") == 3
        assert profiler.counter("overpass_retries") == 2

    def test_legacy_http_post_without_on_attempt_still_works(self):
        """Backward compatibility: an injected http_post predating
        `on_attempt` still counts exactly one honest request rather
        than raising or silently reporting 0."""
        profiler = RunProfiler()

        def _legacy_http_post(url, data, headers):
            return {"elements": []}

        provider = OverpassProvider(http_post=_legacy_http_post, profiler=profiler)
        from providers.overpass_provider import OverpassDiscoveryRequest

        request = OverpassDiscoveryRequest(
            session_id="s1", tags={"shop": "coffee"}, around=(1000.0, 40.7, -73.9),
        )
        list(provider.discover(request))
        assert profiler.counter("overpass_requests") == 1


class TestExecutionDriverStageWallclock:
    """engine/execution_driver.py — on_stage_wallclock."""

    def test_on_stage_wallclock_called_with_real_elapsed_time(self):
        calls = []

        stage = StageConfig(
            name="discovery",
            definition_id="discovery-v1",
            input_queue_id=None,
            output_queue_id=None,
            produce_worker_input=lambda: object(),
            build_downstream=lambda _count: None,
        )

        class _FakeRuntime:
            def execute_stage(self, stage):
                time.sleep(0.02)
                return StageOutcome(
                    stage_name=stage.name, ran=True, success=True,
                    queue_item_id=None, duration_ms=None, queue_wait_ms=None,
                )

        driver = ExecutionDriver(
            _FakeRuntime(), [stage],
            on_stage_wallclock=lambda name, ms: calls.append((name, ms)),
        )
        driver._execute_one(stage)

        assert len(calls) == 1
        name, elapsed_ms = calls[0]
        assert name == "discovery"
        assert elapsed_ms >= 20.0  # real sleep, not fabricated/zero

    def test_on_stage_wallclock_none_is_a_noop(self):
        class _FakeRuntime:
            def execute_stage(self, stage):
                return StageOutcome(
                    stage_name=stage.name, ran=False, success=True,
                    queue_item_id=None, duration_ms=None, queue_wait_ms=None,
                )

        stage = StageConfig(
            name="discovery", definition_id="discovery-v1",
            input_queue_id=None, output_queue_id=None,
            produce_worker_input=lambda: object(),
            build_downstream=lambda _count: None,
        )
        driver = ExecutionDriver(_FakeRuntime(), [stage])  # no on_stage_wallclock
        # Must not raise.
        driver._execute_one(stage)


class TestAreaSlaLineNewFields:
    """utils/perf.py — the new [area-sla] fields."""

    def test_new_fields_present_and_sourced_correctly(self):
        profiler = RunProfiler()
        profiler.record_stage_duration("discovery_total_ms", 240900.0)
        profiler.record_stage_duration("google_maps_provider_total", 238000.0)
        profiler.record_stage_duration("overpass_provider_total", 1500.0)
        profiler.record_stage_duration("retry_wait", 300.0)
        profiler.incr("maps_rounds", by=42)
        profiler.incr("maps_candidates_seen", by=310)
        profiler.incr("maps_candidates_yielded", by=180)
        profiler.incr("overpass_requests", by=4)
        profiler.incr("overpass_retries", by=1)

        line = profiler.area_sla_line(
            area="Bronx", runtime_ms=240900.0,
            first_candidate_ms=None, first_enrichment_ms=None,
            first_qualified_ms=None, first_delivered_ms=None,
        )
        fields = dict(row.split("=", 1) for row in line.splitlines() if "=" in row)

        assert fields["discovery_total_ms"] == "240900.0"
        assert fields["google_maps_total_ms"] == "238000.0"
        assert fields["overpass_total_ms"] == "1500.0"
        assert fields["retry_wait_ms"] == "300.0"
        assert fields["maps_rounds"] == "42"
        assert fields["maps_candidates_seen"] == "310"
        assert fields["maps_candidates_yielded"] == "180"
        assert fields["overpass_requests"] == "4"
        assert fields["overpass_retries"] == "1"

    def test_new_fields_default_to_zero_when_nothing_ran(self):
        profiler = RunProfiler()
        line = profiler.area_sla_line(
            area="Manhattan", runtime_ms=1.0,
            first_candidate_ms=None, first_enrichment_ms=None,
            first_qualified_ms=None, first_delivered_ms=None,
        )
        fields = dict(row.split("=", 1) for row in line.splitlines() if "=" in row)
        for key in (
            "discovery_total_ms", "google_maps_total_ms", "overpass_total_ms",
            "retry_wait_ms", "maps_rounds", "maps_candidates_seen",
            "maps_candidates_yielded", "overpass_requests", "overpass_retries",
        ):
            assert fields[key] in ("0", "0.0"), f"{key}={fields[key]!r}"

    def test_nullprofiler_area_sla_line_still_a_noop(self):
        # NullProfiler.area_sla_line() must remain a harmless "" —
        # unaffected by any of the new field names above.
        assert NullProfiler().area_sla_line(
            area="x", runtime_ms=0.0, first_candidate_ms=None,
            first_enrichment_ms=None, first_qualified_ms=None,
            first_delivered_ms=None,
        ) == ""
