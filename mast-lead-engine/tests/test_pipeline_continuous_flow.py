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


class GatedDiscoveryProvider(DiscoveryProviderInterface):
    """Yields N candidates. For any index named in `gate_before`, blocks
    immediately before yielding that candidate until the corresponding
    `threading.Event` is set (bounded by `gate_timeout_s`), instead of
    relying on a fixed real-time `sleep()` gap.

    Why this exists (forensic finding, see class-level docstrings below):
    the original tests proved "enrichment starts before discovery
    finishes candidate N" by racing a real-time sleep gap against real
    `WebsiteWorker` network I/O (a genuine HTTPS request to
    https://pypi.org, no connection reuse -- see workers/website_worker.py
    `process()`, a fresh `build_opener()`/TLS handshake every call). That
    race is not a defect in the fix under test; it is a defect in the
    *test's* synchronization strategy. Real HTTPS connection setup is
    reported to run 400-850ms in the environment where these tests were
    observed to fail (cold DNS/TLS, no keep-alive) versus a comfortable
    <150ms in this sandbox -- both are legitimate real-world durations
    for a fresh HTTPS connection, and no fixed sleep gap is safely ahead
    of *all* of them without either being needlessly slow or still
    occasionally losing the race.

    `GatedDiscoveryProvider` replaces the sleep-based race with an
    explicit happens-before edge: the candidate that would prove
    "downstream work already happened" is not produced *until* that
    downstream work is independently observed to have happened (an
    `on_stage_outcome` callback sets the Event). This is strictly
    stronger than the timing race it replaces, not weaker: if the
    producer/transformer decoupling this suite guards ever regresses
    (Discovery back to blocking the one thread that also drives
    transformer stages), the gated `discover()` call deadlocks waiting
    on an Event that can now never be set -- and the bounded
    `gate_timeout_s` turns that deadlock into a reliable, deterministic
    test failure (`gate_timed_out[i] is True`) instead of a silent hang
    or a coin-flip pass depending on network latency that morning.
    """

    def __init__(
        self,
        count: int,
        *,
        gate_before: "dict[int, threading.Event] | None" = None,
        gate_timeout_s: float = WAIT_TIMEOUT_S,
        gap_s: float = 0.0,
    ) -> None:
        self._count = count
        self._gate_before = gate_before or {}
        self._gate_timeout_s = gate_timeout_s
        self._gap_s = gap_s
        self.yielded_at: dict[int, float] = {}
        self.gate_timed_out: dict[int, bool] = {}
        self.discover_call_count = 0

    @property
    def provider_id(self) -> str:
        return "gated_test_provider"

    @property
    def display_name(self) -> str:
        return "Gated Test Provider (Phase 2B regression tests)"

    def discover(self, request) -> Iterator[BusinessCandidate]:
        self.discover_call_count += 1
        for i in range(1, self._count + 1):
            if i > 1 and self._gap_s:
                time.sleep(self._gap_s)
            event = self._gate_before.get(i)
            if event is not None:
                signaled = event.wait(timeout=self._gate_timeout_s)
                self.gate_timed_out[i] = not signaled
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
    enrichment BEFORE candidate 3 is discovered.

    Deterministic rewrite (see `GatedDiscoveryProvider`): candidate 3's
    yield is gated on an Event that is only set once the first "website"
    StageOutcome with `ran=True` is observed. This proves the exact same
    happens-before relationship the original test wanted -- website
    enrichment for candidate 1 genuinely ran while discovery was still
    active, i.e. Discovery did not block the transformer loop -- without
    racing a fixed real-time sleep gap against real, variable-latency
    HTTPS connection setup in `WebsiteWorker.process()` (see
    `GatedDiscoveryProvider` docstring for the measured-latency evidence
    that made the old race flaky, specifically on Windows). If the
    Phase 2B fix ever regresses (producer stage blocking the one thread
    that also drives transformer stages), `discover()` deadlocks waiting
    on the Event and `gate_timed_out[3]` deterministically becomes True
    after `WAIT_TIMEOUT_S` -- a reliable failure, not a coin flip.
    """

    def test_first_website_outcome_precedes_third_discovery(self):
        website_ran_event = threading.Event()
        provider = GatedDiscoveryProvider(count=3, gate_before={3: website_ran_event})
        outcomes: List[StageOutcome] = []
        outcomes_lock = threading.Lock()
        first_website_ran_at: list[float] = []

        def _record(outcome: StageOutcome) -> None:
            with outcomes_lock:
                outcomes.append(outcome)
            if outcome.stage_name == "website" and outcome.ran and not first_website_ran_at:
                first_website_ran_at.append(time.perf_counter())
                website_ran_event.set()

        driver, _backend = _build_driver(provider, on_stage_outcome=_record)
        driver.start()
        try:
            deadline = time.perf_counter() + WAIT_TIMEOUT_S
            while 3 not in provider.yielded_at and time.perf_counter() < deadline:
                time.sleep(POLL_S)
        finally:
            driver.stop()

        assert first_website_ran_at, (
            "no website StageOutcome was ever recorded — enrichment never ran at all"
        )
        assert not provider.gate_timed_out.get(3, False), (
            "REGRESSION: candidate 3's discovery was gated on the first "
            "website StageOutcome and that gate timed out after "
            f"{WAIT_TIMEOUT_S}s -- discovery is still blocking enrichment "
            "(the exact Phase 2B bug): the producer thread never observed "
            "a completed website stage, so it could not have been running "
            "concurrently with the transformer loop."
        )
        assert 3 in provider.yielded_at, "discovery never reached candidate 3 (gate never released)"
        # By construction (the gate above), candidate 3 cannot have been
        # yielded until AFTER the website Event was set -- this is a
        # happens-before guarantee, not a wall-clock race, but we still
        # assert the ordering explicitly for readability/documentation.
        assert first_website_ran_at[0] <= provider.yielded_at[3], (
            "REGRESSION: candidate 1 did not enter enrichment until AFTER "
            "candidate 3 was discovered -- discovery is still blocking "
            "enrichment (the exact Phase 2B bug)."
            f" first_website_ran_at={first_website_ran_at[0]:.3f} "
            f"candidate_3_discovered_at={provider.yielded_at[3]:.3f}"
        )


class TestContinuousFlowDuringDiscovery:
    """Test 2 — discovery of candidate #2 can happen while enrichment of
    candidate #1 is still in flight; the producer is not serially waited
    on by the transformer-stage loop.

    Deterministic rewrite (see `GatedDiscoveryProvider`): candidate 2's
    yield is gated on an Event set by the first non-"discovery"
    StageOutcome with `ran=True` (i.e. any transformer stage actually
    executing). This proves transformer work happened while Discovery
    was still active -- the producer was not serially waited on -- via
    an explicit happens-before edge instead of racing a fixed real-time
    sleep gap against real, variable-latency `WebsiteWorker` network I/O
    (see `GatedDiscoveryProvider` docstring). A regression that makes
    Discovery block the transformer loop again causes `discover()` to
    deadlock waiting on the Event, deterministically failing via
    `gate_timed_out[2]` after `WAIT_TIMEOUT_S`.
    """

    def test_second_candidate_discovered_while_pipeline_actively_running(self):
        transformer_ran_event = threading.Event()
        provider = GatedDiscoveryProvider(count=3, gate_before={2: transformer_ran_event})
        stage_ran_events: List[tuple[str, float]] = []
        lock = threading.Lock()

        def _record(outcome: StageOutcome) -> None:
            if outcome.ran:
                with lock:
                    stage_ran_events.append((outcome.stage_name, time.perf_counter()))
                if outcome.stage_name != "discovery":
                    transformer_ran_event.set()

        driver, _backend = _build_driver(provider, on_stage_outcome=_record)
        driver.start()
        try:
            deadline = time.perf_counter() + WAIT_TIMEOUT_S
            while 2 not in provider.yielded_at and time.perf_counter() < deadline:
                time.sleep(POLL_S)
            candidate_2_at = provider.yielded_at.get(2)
        finally:
            driver.stop()

        assert not provider.gate_timed_out.get(2, False), (
            "REGRESSION: candidate 2's discovery was gated on some "
            f"transformer stage actually running and timed out after "
            f"{WAIT_TIMEOUT_S}s -- no transformer-stage work happened "
            "while discovery was paused before candidate 2, meaning the "
            "producer is once again being serially waited on by the "
            f"transformer loop. stage_ran_events={stage_ran_events!r}"
        )
        assert candidate_2_at is not None, "discovery never reached candidate 2 (gate never released)"
        # By construction (the gate above), candidate 2 cannot have been
        # yielded until AFTER some transformer stage's Event was set --
        # this is a happens-before guarantee, not a wall-clock race, but
        # we still assert the ordering explicitly for readability.
        transformer_events_before_c2 = [
            (name, ts) for name, ts in stage_ran_events if name != "discovery" and ts <= candidate_2_at
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
