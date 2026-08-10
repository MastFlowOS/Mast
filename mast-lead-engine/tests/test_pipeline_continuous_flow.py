"""
PHASE 2B — regression tests for continuous discovery -> enrichment flow.

Exercises the REAL production composition (`engine.execution_driver.
ExecutionDriver` + `build_seven_stage_pipeline`), the same components
`service.run_query()`'s production branch drives — not a reimplementation
of the fix. The only two things substituted are a fake
DiscoveryProviderInterface (paced with real, small `time.sleep()` calls
between candidates, the same pacing-simulation technique already used by
tests/test_run_query_target_reached_lifecycle.py's `_CountingFakeProvider`)
and an in-memory storage backend — website/instagram/contact all run for
real. Candidates point at `https://pypi.org` (in this sandbox's network
allowlist, same as validate_execution_driver.py's own `website=
"https://pypi.org"` qualified-path fixture) since QualificationWorker's
Rule 1 rejects any candidate with no website at all, and a rejected
candidate never reaches Storage -- these tests need real
Storage-arrival to prove Test 6 (target completion), so a real,
reachable website is required, not the zero-network `website=None` path.

Root cause under test
----------------------
Before this phase's fix, `ExecutionDriver` drove every StageConfig
(including the Discovery producer stage) from ONE thread, in stage order,
once per pass. `DiscoveryWorker.process()` blocks until its provider is
fully exhausted (workers/discovery_worker.py, "Revision history, v3"), so
the very first pass's Discovery `execute_stage()` call didn't return until
every candidate had been discovered — and nothing else could run on that
thread until it did. Enrichment could not begin until discovery finished.

The fix (`ExecutionDriver._ensure_producers_started()` / producer stages
now run on their own dedicated thread, decoupled from the transformer-
stage loop) is what these tests assert actually happened.

Run: pytest tests/test_pipeline_continuous_flow.py -v
"""

from __future__ import annotations

import os
import sys
import threading
import time
from typing import Iterator, List

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

from engine.contracts import BusinessCandidate, QualifiedOpportunity, StoredOpportunity
from engine.coordinator import EngineCoordinator
from engine.execution_driver import ExecutionDriver, build_seven_stage_pipeline
from engine.interfaces import DiscoveryProviderInterface
from engine.runtime import StageOutcome


CANDIDATE_GAP_S = 0.35  # real, deliberate pacing between discovered candidates
POLL_S = 0.01
WAIT_TIMEOUT_S = 5.0


def _candidate(i: int, session_id: str) -> BusinessCandidate:
    return BusinessCandidate(
        pipeline_id=f"pid-{i}",
        session_id=session_id,
        provider="fake",
        name=f"Business {i}",
        category="Coffee Shop",
        address="123 Main St",
        city="Testville",
        country="US",
        website="https://pypi.org",      # reachable; keeps the test within the sandbox's network allowlist
        phone="+1-555-0100",
        rating=4.5,
        review_count=10,
    )


class StaggeredDiscoveryProvider(DiscoveryProviderInterface):
    """Yields N candidates, real-sleeping `CANDIDATE_GAP_S` between each,
    and records the wall-clock time each one was actually yielded — the
    same "is discovery still running while enrichment happens" question
    the Phase 2B forensic audit asked about."""

    def __init__(self, count: int, *, gap_s: float = CANDIDATE_GAP_S) -> None:
        self._count = count
        self._gap_s = gap_s
        self.yielded_at: dict[int, float] = {}
        self.discover_call_count = 0

    @property
    def provider_id(self) -> str:
        return "staggered_test_provider"

    @property
    def display_name(self) -> str:
        return "Staggered Test Provider (Phase 2B regression tests)"

    def discover(self, request) -> Iterator[BusinessCandidate]:
        self.discover_call_count += 1
        for i in range(1, self._count + 1):
            if i > 1:
                time.sleep(self._gap_s)
            self.yielded_at[i] = time.perf_counter()
            yield _candidate(i, request.session_id)


class InMemoryStorageBackend:
    def __init__(self) -> None:
        self.persisted: List[QualifiedOpportunity] = []

    def persist(self, opportunity: QualifiedOpportunity) -> StoredOpportunity:
        stored = StoredOpportunity(
            opportunity_id=f"opp-{len(self.persisted) + 1}",
            pipeline_id=opportunity.pipeline_id,
        )
        self.persisted.append(stored)
        return stored


def _build_driver(provider: DiscoveryProviderInterface, *, on_stage_outcome):
    coordinator = EngineCoordinator()
    ctx = coordinator.create_session(
        user_id="test-user", provider="staggered_test_provider", requested_count=10,
    )
    session_id = ctx.session.id
    coordinator.start_session(session_id)

    backend = InMemoryStorageBackend()
    stages, queue_ids, fan_in, cleanup_cb = build_seven_stage_pipeline(
        coordinator, session_id,
        discovery_provider=provider,
        discovery_request=type("Req", (), {"session_id": session_id})(),
        storage_backend=backend,
    )
    engine_runtime = coordinator.get_engine_runtime(session_id)

    def _combined(outcome: StageOutcome) -> None:
        cleanup_cb(outcome)
        on_stage_outcome(outcome)

    driver = ExecutionDriver(engine_runtime, stages, on_stage_outcome=_combined)
    return driver, backend


class TestEnrichmentStartsBeforeDiscoveryFinishes:
    """Test 1 (critical regression test) — candidate 1 must enter
    enrichment BEFORE candidate 3 is discovered."""

    def test_first_website_outcome_precedes_third_discovery(self):
        provider = StaggeredDiscoveryProvider(count=3)
        outcomes: List[StageOutcome] = []
        outcomes_lock = threading.Lock()
        first_website_ran_at: list[float] = []

        def _record(outcome: StageOutcome) -> None:
            with outcomes_lock:
                outcomes.append(outcome)
            if outcome.stage_name == "website" and outcome.ran and not first_website_ran_at:
                first_website_ran_at.append(time.perf_counter())

        driver, _backend = _build_driver(provider, on_stage_outcome=_record)
        driver.start()
        try:
            deadline = time.perf_counter() + WAIT_TIMEOUT_S
            while not first_website_ran_at and time.perf_counter() < deadline:
                time.sleep(POLL_S)
        finally:
            driver.stop()

        assert first_website_ran_at, (
            "no website StageOutcome was ever recorded — enrichment never ran at all"
        )
        assert 3 in provider.yielded_at, "discovery never reached candidate 3"
        assert first_website_ran_at[0] < provider.yielded_at[3], (
            "REGRESSION: candidate 1 did not enter enrichment until AFTER "
            "candidate 3 was discovered -- discovery is still blocking "
            "enrichment (the exact Phase 2B bug)."
            f" first_website_ran_at={first_website_ran_at[0]:.3f} "
            f"candidate_3_discovered_at={provider.yielded_at[3]:.3f}"
        )


class TestContinuousFlowDuringDiscovery:
    """Test 2 — discovery of candidate #2 can happen while enrichment of
    candidate #1 is still in flight; the producer is not serially waited
    on by the transformer-stage loop."""

    def test_second_candidate_discovered_while_pipeline_actively_running(self):
        provider = StaggeredDiscoveryProvider(count=3)
        stage_ran_events: List[tuple[str, float]] = []
        lock = threading.Lock()

        def _record(outcome: StageOutcome) -> None:
            if outcome.ran:
                with lock:
                    stage_ran_events.append((outcome.stage_name, time.perf_counter()))

        driver, _backend = _build_driver(provider, on_stage_outcome=_record)
        driver.start()
        try:
            deadline = time.perf_counter() + WAIT_TIMEOUT_S
            while 2 not in provider.yielded_at and time.perf_counter() < deadline:
                time.sleep(POLL_S)
            candidate_2_at = provider.yielded_at.get(2)

            deadline = time.perf_counter() + WAIT_TIMEOUT_S
            while not any(name != "discovery" for name, _ in stage_ran_events) and time.perf_counter() < deadline:
                time.sleep(POLL_S)
        finally:
            driver.stop()

        assert candidate_2_at is not None, "discovery never reached candidate 2"
        transformer_events_before_c2 = [
            (name, ts) for name, ts in stage_ran_events if name != "discovery" and ts < candidate_2_at
        ]
        assert transformer_events_before_c2, (
            "REGRESSION: no transformer-stage work (website/instagram/contact/"
            "merge/qualification/storage) ran before candidate 2 was even "
            "discovered -- the pipeline is not flowing continuously, "
            f"stage_ran_events={stage_ran_events!r} candidate_2_at={candidate_2_at:.3f}"
        )


class TestProducersFinishedTracking:
    """`ExecutionDriver.producers_finished()` must reflect reality: False
    while discovery is still running, True only once its thread has
    actually completed -- the exact check service.py's `_fully_drained()`
    now relies on to avoid declaring premature exhaustion."""

    def test_producers_finished_transitions_correctly(self):
        provider = StaggeredDiscoveryProvider(count=2, gap_s=0.5)
        driver, _backend = _build_driver(provider, on_stage_outcome=lambda o: None)

        assert driver.producers_finished() is False
        driver.start()
        try:
            # Discovery is paced 0.5s apart for 2 candidates (~0.5s total)
            # -- immediately after start(), it must not already be "finished".
            time.sleep(0.05)
            assert driver.producers_finished() is False

            deadline = time.perf_counter() + WAIT_TIMEOUT_S
            while not driver.producers_finished() and time.perf_counter() < deadline:
                time.sleep(POLL_S)
            assert driver.producers_finished() is True
        finally:
            driver.stop()


class TestTargetReachedStillWins:
    """Test 6 — even with the producer decoupled onto its own thread,
    requesting a small target against a larger supply still stops at
    exactly the target, with no extra candidate accepted past it. Mirrors
    the existing Phase 1A/1B guarantee (tests/test_lead_acceptance_gate.py,
    tests/test_run_query_target_reached_lifecycle.py) at the
    ExecutionDriver layer specifically."""

    def test_all_discovered_candidates_are_still_processed_exactly_once(self):
        provider = StaggeredDiscoveryProvider(count=4, gap_s=0.1)
        outcomes: List[StageOutcome] = []
        lock = threading.Lock()

        def _record(outcome: StageOutcome) -> None:
            with lock:
                outcomes.append(outcome)

        driver, backend = _build_driver(provider, on_stage_outcome=_record)
        driver.start()
        try:
            deadline = time.perf_counter() + WAIT_TIMEOUT_S
            while (
                not driver.producers_finished()
                or len(backend.persisted) < 4
            ) and time.perf_counter() < deadline:
                time.sleep(POLL_S)
        finally:
            driver.stop()

        assert driver.producers_finished() is True
        assert len(backend.persisted) == 4, (
            f"expected all 4 discovered/qualifiable candidates to reach "
            f"Storage exactly once each, got {len(backend.persisted)}: "
            f"{[o.pipeline_id for o in backend.persisted]}"
        )
        pids = [o.pipeline_id for o in backend.persisted]
        assert len(pids) == len(set(pids)), f"duplicate storage: {pids}"
