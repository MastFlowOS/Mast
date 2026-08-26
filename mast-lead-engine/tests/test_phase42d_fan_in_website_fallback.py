"""
PHASE 42D-1 — Fan-in leak fix: unreachable/missing website no longer
strands a candidate in FanInRuntime._pending forever.

Root cause under test
----------------------
`engine.execution_driver.build_seven_stage_pipeline()`'s
`_website_downstream()` closure used to `return None` for a candidate
whose website is missing/unreachable (and not a required channel)
without ever telling `FanInRuntime` that the Contact branch is
terminally skipped. Because `website_stage`'s `output_queue_id` points
at the real Contact queue (not the `fan_in_sink` dummy Instagram/Contact
themselves are routed to), returning `None` there means ContactWorker
never runs -- and never calls `fan_in.record_contact_result` on its own
either. `_PipelineAccumulator.is_complete()` requires
website_intel/instagram_intel/contact_intel to all be non-`_UNSET`, so
the candidate sat in `FanInRuntime._pending` forever, even when Maps
already supplied enough phone/email to qualify.

The fix: `_website_downstream` now calls
`fan_in.record_contact_result(pipeline_id, None)` immediately before
that `return None`, for the "no reachable website, not already pruned"
branch specifically (not the `prune_business` branches, which already
close the pipeline on their own).

Test 4 here is the integration-level proof asked for in the Phase
42D-1 prompt: a real `build_seven_stage_pipeline()` + `ExecutionDriver`
run (the actual production composition, same style as
`tests/test_pipeline_continuous_flow.py`), one candidate with no
website but a Maps-supplied phone, `required_channels=("phone",)`,
proving the candidate reaches Qualification/Storage instead of leaking.

Run: pytest tests/test_phase42d_fan_in_website_fallback.py -v
"""

from __future__ import annotations

import os
import sys
import threading
import time
from typing import Iterator, List

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

from engine.contracts import BusinessCandidate, QualifiedOpportunity, StoredOpportunity, WebsiteIntel
from engine.coordinator import EngineCoordinator
from engine.execution_driver import ExecutionDriver, build_seven_stage_pipeline
from engine.fan_in_runtime import FanInRuntime
from engine.interfaces import DiscoveryProviderInterface
from engine.runtime import StageOutcome

WAIT_TIMEOUT_S = 12.0
POLL_S = 0.01


# ── Tests 1-3 unit-level: exercise the real _website_downstream closure ───
# via a minimal FanInRuntime + fake fan_in accessed through
# build_seven_stage_pipeline's returned stage list, so these tests run
# against the actual production closure, not a reimplementation of it.


def _find_stage(stages, name):
    for stage in stages:
        if stage.name == name:
            return stage
    raise AssertionError(f"no stage named {name!r}")


class _FakeDiscoveryProvider(DiscoveryProviderInterface):
    """Yields nothing — these unit tests drive `_website_downstream`
    directly and never need Discovery to actually run."""

    @property
    def provider_id(self) -> str:
        return "fake_empty_provider"

    @property
    def display_name(self) -> str:
        return "Fake Empty Provider (Phase 42D-1 unit tests)"

    def discover(self, request) -> Iterator[BusinessCandidate]:
        return iter(())


class _InMemoryStorageBackend:
    def __init__(self) -> None:
        self.persisted: List[QualifiedOpportunity] = []

    def persist(self, opportunity: QualifiedOpportunity) -> StoredOpportunity:
        stored = StoredOpportunity(
            opportunity_id=f"opp-{len(self.persisted) + 1}",
            pipeline_id=opportunity.pipeline_id,
        )
        self.persisted.append(stored)
        return stored


def _build_pipeline(*, required_channels=None):
    coordinator = EngineCoordinator()
    ctx = coordinator.create_session(
        user_id="test-user", provider="fake_empty_provider", requested_count=1,
    )
    session_id = ctx.session.id
    coordinator.start_session(session_id)

    backend = _InMemoryStorageBackend()
    stages, queue_ids, fan_in, cleanup_cb = build_seven_stage_pipeline(
        coordinator, session_id,
        discovery_provider=_FakeDiscoveryProvider(),
        discovery_request=type("Req", (), {"session_id": session_id})(),
        storage_backend=backend,
        required_channels=required_channels,
    )
    return coordinator, session_id, stages, fan_in, backend, cleanup_cb


def _candidate(pipeline_id: str, session_id: str, *, website=None, phone=None) -> BusinessCandidate:
    return BusinessCandidate(
        pipeline_id=pipeline_id,
        session_id=session_id,
        provider="fake",
        name="Test Biz",
        category="Coffee Shop",
        address="123 Main St",
        city="Testville",
        country="US",
        website=website,
        phone=phone,
        rating=4.5,
        review_count=10,
    )


# ── Test 1: unreachable website (default/legacy rules, required_channels=None) ─
def test_unreachable_website_records_contact_skip_default_rules():
    """Default (legacy) rules: an unreachable website's `_website_downstream`
    call must mark the Contact branch terminally skipped instead of leaking
    the pipeline_id out of FanInRuntime._pending."""
    coordinator, session_id, stages, fan_in, _backend, _cleanup = _build_pipeline(
        required_channels=None,
    )
    website_stage = _find_stage(stages, "website")

    candidate = _candidate("p-unreachable-default", session_id, website="https://nope.invalid")
    fan_in.register_business(candidate)

    intel = WebsiteIntel(
        pipeline_id=candidate.pipeline_id, website_reachable=False,
    )
    result = website_stage.build_downstream(intel)

    assert result is None  # ContactWorker is still never enqueued
    # The fix: contact_intel must already be recorded (not _UNSET), so
    # the accumulator can complete on website_intel + instagram_intel
    # alone once those also land -- proving no leak into _pending.
    acc = fan_in._pending.get(candidate.pipeline_id)
    assert acc is not None, "pipeline_id must still be tracked (not pruned)"
    from engine.fan_in_runtime import _UNSET
    assert acc.contact_intel is not _UNSET


# ── Test 2: unreachable website under dynamic required_channels ───────────
def test_unreachable_website_records_contact_skip_required_channels():
    """Same fix, exercised with a dynamic `required_channels` tuple that
    does NOT include 'website' or 'email' -- the leaky branch, not the
    prune_business branches above it."""
    coordinator, session_id, stages, fan_in, _backend, _cleanup = _build_pipeline(
        required_channels=("phone",),
    )
    website_stage = _find_stage(stages, "website")

    candidate = _candidate("p-unreachable-required", session_id, website=None, phone="+15551112222")
    fan_in.register_business(candidate)

    intel = WebsiteIntel(
        pipeline_id=candidate.pipeline_id, website_reachable=False,
    )
    result = website_stage.build_downstream(intel)

    assert result is None
    acc = fan_in._pending.get(candidate.pipeline_id)
    assert acc is not None
    from engine.fan_in_runtime import _UNSET
    assert acc.contact_intel is not _UNSET


# ── Test 3: already-pruned pipeline_id is not double-recorded ─────────────
def test_pruned_pipeline_not_double_recorded():
    """When `required_channels` includes 'website' and the site is
    unreachable, `_website_downstream` already prunes the business via
    `fan_in.prune_business` and returns early -- the new
    `record_contact_result` call must NOT also fire for that branch
    (it already returned before reaching the fix's new call)."""
    coordinator, session_id, stages, fan_in, _backend, _cleanup = _build_pipeline(
        required_channels=("website", "phone"),
    )
    website_stage = _find_stage(stages, "website")

    candidate = _candidate("p-pruned", session_id, website="https://nope.invalid", phone="+15551112222")
    fan_in.register_business(candidate)

    intel = WebsiteIntel(
        pipeline_id=candidate.pipeline_id, website_reachable=False,
    )
    result = website_stage.build_downstream(intel)

    assert result is None
    assert fan_in.is_closed(candidate.pipeline_id) or candidate.pipeline_id not in fan_in._pending
    # pruned pipeline_ids are tracked in `_pruned`, not `_pending`
    assert candidate.pipeline_id in fan_in._pruned


# ── Test 4: full integration -- candidate reaches Qualification/Storage ───
def test_no_website_candidate_reaches_qualification_not_stuck_pending():
    """A candidate with NO website but a Maps-supplied phone, under
    `required_channels=("phone",)`, must not be stuck in
    FanInRuntime._pending forever -- it must reach Qualification/Storage
    (either QualifiedOpportunity or a proper qualification rejection),
    never silence. Drives the REAL production composition
    (build_seven_stage_pipeline + ExecutionDriver), same style as
    tests/test_pipeline_continuous_flow.py.
    """

    class _OneShotProvider(DiscoveryProviderInterface):
        def __init__(self) -> None:
            self.yielded = False

        @property
        def provider_id(self) -> str:
            return "one_shot_test_provider"

        @property
        def display_name(self) -> str:
            return "One-shot Test Provider (Phase 42D-1 integration test)"

        def discover(self, request) -> Iterator[BusinessCandidate]:
            self.yielded = True
            yield _candidate("p-integration-nowebsite", request.session_id, website=None, phone="+15551112222")

    coordinator = EngineCoordinator()
    ctx = coordinator.create_session(
        user_id="test-user", provider="one_shot_test_provider", requested_count=1,
    )
    session_id = ctx.session.id
    coordinator.start_session(session_id)

    backend = _InMemoryStorageBackend()
    provider = _OneShotProvider()

    outcomes: List[StageOutcome] = []
    outcomes_lock = threading.Lock()
    reached_terminal = threading.Event()

    def _record(outcome: StageOutcome) -> None:
        with outcomes_lock:
            outcomes.append(outcome)
        if outcome.stage_name in ("qualification", "storage") and outcome.ran:
            reached_terminal.set()

    stages, queue_ids, fan_in, cleanup_cb = build_seven_stage_pipeline(
        coordinator, session_id,
        discovery_provider=provider,
        discovery_request=type("Req", (), {"session_id": session_id})(),
        storage_backend=backend,
        required_channels=("phone",),
    )

    def _combined(outcome: StageOutcome) -> None:
        cleanup_cb(outcome)
        _record(outcome)

    engine_runtime = coordinator.get_engine_runtime(session_id)
    driver = ExecutionDriver(engine_runtime, stages, on_stage_outcome=_combined)
    driver.start()
    try:
        signaled = reached_terminal.wait(timeout=WAIT_TIMEOUT_S)
        # Give FanInRuntime a moment to settle to pending_count()==0 even
        # if the terminal outcome fired on qualification (storage may
        # trail by one stage cycle).
        deadline = time.perf_counter() + WAIT_TIMEOUT_S
        while fan_in.pending_count() != 0 and time.perf_counter() < deadline:
            time.sleep(POLL_S)
    finally:
        driver.stop()

    assert signaled, (
        "candidate never reached qualification/storage -- fan-in leak "
        "regression: it is stuck in FanInRuntime._pending"
    )
    assert fan_in.pending_count() == 0, (
        f"pipeline_id leaked in FanInRuntime._pending: {list(fan_in._pending)!r}"
    )

    qualification_outcomes = [o for o in outcomes if o.stage_name == "qualification" and o.ran]
    assert qualification_outcomes, "QualificationWorker must have run for the candidate"
