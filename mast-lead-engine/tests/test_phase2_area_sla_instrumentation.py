"""
Phase 2 — per-area latency profiling instrumentation.

Targeted regression coverage for the two additive pieces this phase
introduces:

  1. `StageOutcome.duration_ms` / `StageOutcome.queue_wait_ms`
     (engine/runtime.py) — populated by `EngineRuntime.execute_stage()`
     for every stage cycle, success or failure, without changing any
     existing field or branching behavior.

  2. `build_seven_stage_pipeline(..., on_stage_timing=...)`
     (engine/execution_driver.py) — a new optional observer, fanned out
     from the same single `_combined_on_stage_outcome` every existing
     `on_stage_outcome` consumer already goes through, that receives the
     raw `StageOutcome` (so a caller can read `duration_ms`).

  3. `RunProfiler.record_stage_duration()` / `.incr()` / `.counter()` /
     `.area_sla_line()` (utils/perf.py) — the accumulation + report-
     formatting side service.py's `_on_stage_timing`/`_on_progress`
     closures feed into.

These are deliberately narrow, source-tracing-driven tests: this phase's
task is instrumentation only, not a behavior change, so the goal is
"the new fields/hooks work as designed", not new coverage of pipeline
business logic (already covered by test_issue2_pipeline_drain_and_latency.py
and friends).
"""

from __future__ import annotations

import time

from engine.contracts import BusinessCandidate
from engine.coordinator import EngineCoordinator
from engine.execution_driver import build_seven_stage_pipeline
from engine.interfaces import DiscoveryProviderInterface
from engine.runtime import StageOutcome
from utils.perf import RunProfiler
from workers.merge_worker import MergeInput


class _DummyDiscoveryProvider(DiscoveryProviderInterface):
    @property
    def provider_id(self) -> str:
        return "dummy"

    @property
    def display_name(self) -> str:
        return "Dummy"

    def discover(self, request):
        return iter([])


class _DummyStorageBackend:
    def persist(self, opportunity):
        return opportunity


def _setup_pipeline(*, on_stage_timing=None):
    coordinator = EngineCoordinator()
    ctx = coordinator.create_session(
        user_id="test-user", provider="dummy", requested_count=10,
    )
    session_id = ctx.session.id
    coordinator.start_session(session_id)

    stages, queue_ids, fan_in, on_stage_outcome = build_seven_stage_pipeline(
        coordinator,
        session_id,
        discovery_provider=_DummyDiscoveryProvider(),
        discovery_request=type("Req", (), {"session_id": session_id})(),
        storage_backend=_DummyStorageBackend(),
        on_stage_timing=on_stage_timing,
    )
    coordinator.mark_running(session_id)
    engine_runtime = coordinator.get_engine_runtime(session_id)
    stage_map = {s.name: s for s in stages}
    queue_manager = coordinator.get_session(session_id).runtime.queue_manager
    return engine_runtime, stage_map, queue_ids, queue_manager


def test_stage_outcome_carries_duration_and_queue_wait_for_a_real_cycle():
    """A real execute_stage() cycle (Merge, a fast pure-composition
    worker — see workers/merge_worker.py) returns a StageOutcome with
    both new fields populated and non-negative, and `queue_wait_ms`
    reflects genuine time spent queued (not zero) once we sleep before
    dequeuing."""
    engine_runtime, stage_map, queue_ids, queue_manager = _setup_pipeline()

    candidate = BusinessCandidate(
        pipeline_id="c1", session_id="s", provider="maps",
        name="C1", city="MX", category="Food",
    )
    merge_queue = queue_manager.get_queue(queue_ids.merge_in)
    merge_queue.enqueue(
        pipeline_id="c1", stage="merge",
        payload=MergeInput(business=candidate, website_intel=None,
                            instagram_intel=None, contact_intel=None),
    )

    time.sleep(0.05)  # ensure a measurable queue_wait_ms

    outcome = engine_runtime.execute_stage(stage_map["merge"])

    assert outcome.ran is True
    assert outcome.success is True
    assert outcome.duration_ms is not None
    assert outcome.duration_ms >= 0.0
    assert outcome.queue_wait_ms is not None
    assert outcome.queue_wait_ms >= 40.0  # slept 50ms; allow scheduler slack


def test_stage_outcome_fields_are_none_for_a_producer_or_noop_cycle():
    """Discovery (a producer stage, input_queue_id=None) and an
    empty-queue transformer cycle both still return `ran=False` with no
    duration/queue_wait — the pre-existing no-op-cycle contract is
    unchanged by this phase's additive fields."""
    engine_runtime, stage_map, queue_ids, queue_manager = _setup_pipeline()

    outcome = engine_runtime.execute_stage(stage_map["website"])
    assert outcome.ran is False
    assert outcome.duration_ms is None
    assert outcome.queue_wait_ms is None


def test_on_stage_timing_is_fanned_out_alongside_existing_observers():
    """`on_stage_timing`, when supplied, receives every StageOutcome the
    pre-existing `on_progress`/cleanup observers already receive —
    fanned out from the same composed `on_stage_outcome` callback
    `build_seven_stage_pipeline()` returns, not a replacement for it.
    Matches the existing test file's own pattern
    (test_issue2_pipeline_drain_and_latency.py) of feeding a
    hand-built `StageOutcome` straight into that composed callback,
    since that is exactly what `ExecutionDriver.run_once()` does after
    a real `execute_stage()` call."""
    received: list[StageOutcome] = []
    coordinator = EngineCoordinator()
    ctx = coordinator.create_session(
        user_id="test-user", provider="dummy", requested_count=10,
    )
    session_id = ctx.session.id
    coordinator.start_session(session_id)
    _stages, _queue_ids, fan_in, on_stage_outcome = build_seven_stage_pipeline(
        coordinator,
        session_id,
        discovery_provider=_DummyDiscoveryProvider(),
        discovery_request=type("Req", (), {"session_id": session_id})(),
        storage_backend=_DummyStorageBackend(),
        on_stage_timing=received.append,
    )

    candidate = BusinessCandidate(
        pipeline_id="c1", session_id="s", provider="maps",
        name="C1", city="MX", category="Food",
    )
    fan_in.register_business(candidate)

    outcome = StageOutcome(
        stage_name="website", ran=True, success=True,
        pipeline_id="c1", queue_item_id="q-c1-web",
        duration_ms=42.0, queue_wait_ms=7.0,
    )
    on_stage_outcome(outcome)

    assert len(received) == 1
    assert received[0].duration_ms == 42.0
    assert received[0].queue_wait_ms == 7.0
    assert received[0].stage_name == "website"


def test_on_stage_timing_exception_never_propagates():
    """An observer that raises must never break pipeline execution —
    matches `_emit`'s existing no-throw contract (both are fanned out
    from the same composed `on_stage_outcome` callback)."""
    def _boom(_outcome):
        raise RuntimeError("observer exploded")

    coordinator = EngineCoordinator()
    ctx = coordinator.create_session(
        user_id="test-user", provider="dummy", requested_count=10,
    )
    session_id = ctx.session.id
    coordinator.start_session(session_id)
    _stages, _queue_ids, fan_in, on_stage_outcome = build_seven_stage_pipeline(
        coordinator,
        session_id,
        discovery_provider=_DummyDiscoveryProvider(),
        discovery_request=type("Req", (), {"session_id": session_id})(),
        storage_backend=_DummyStorageBackend(),
        on_stage_timing=_boom,
    )
    candidate = BusinessCandidate(
        pipeline_id="c1", session_id="s", provider="maps",
        name="C1", city="MX", category="Food",
    )
    fan_in.register_business(candidate)

    outcome = StageOutcome(
        stage_name="website", ran=True, success=True,
        pipeline_id="c1", queue_item_id="q-c1-web",
        duration_ms=1.0, queue_wait_ms=1.0,
    )
    # Must not raise, even though the on_stage_timing observer always does.
    on_stage_outcome(outcome)


def test_run_profiler_area_sla_line_reflects_recorded_stage_durations_and_counters():
    profiler = RunProfiler()
    profiler.record_stage_duration("website_worker", 150.0)
    profiler.record_stage_duration("website_worker", 50.0)
    profiler.record_stage_duration("contact_worker", None)  # no-op cycle: ignored
    profiler.incr("raw_candidates", by=5)
    profiler.incr("qualified")
    profiler.incr("delivered")

    line = profiler.area_sla_line(
        area="Brooklyn",
        runtime_ms=97000.0,
        first_candidate_ms=500.0,
        first_enrichment_ms=1200.0,
        first_qualified_ms=3000.0,
        first_delivered_ms=4000.0,
    )

    assert "area=Brooklyn" in line
    assert "website_ms=200.0" in line
    assert "contact_ms=0" in line
    assert "raw_candidates=5" in line
    assert "qualified=1" in line
    assert "delivered=1" in line
