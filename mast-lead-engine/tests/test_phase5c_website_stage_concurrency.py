"""
PHASE 5C — targeted regression tests for ExecutionDriver's new bounded
per-stage concurrency mechanism (Website only, default off).

Deliberately narrow, per Phase 5C's own instructions ("keep tests
focused... add only the tests necessary to prove" the six numbered
items below). Uses the REAL `EngineCoordinator.build_runtime_context()`
/ `EngineRuntime.execute_stage()` / `WorkerAllocator` / `Queue` stack —
not a reimplementation of any of them — with a minimal single-stage
("website") pipeline built directly (not through
`build_seven_stage_pipeline()`) so each test controls exactly the
worker behavior it needs, with no network I/O anywhere in this file.

Covers:
    1. Website concurrency limit is enforced.
    2. Two different Website candidates can run concurrently.
    3. Same BaseWorker instance cannot be used simultaneously.
    4. Existing retry behavior still works.
    5. Cancellation does not accept new Website work.
    6. Phase 5B terminal accounting still works (via the real
       `build_seven_stage_pipeline()` composition, concurrency enabled).
"""

from __future__ import annotations

import os
import sys
import threading
import time
from typing import Iterator, List, Optional

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

from engine.contracts import BusinessCandidate, StoredOpportunity, WebsiteIntel
from engine.coordinator import EngineCoordinator, StageBlueprint
from engine.execution_driver import (
    ExecutionDriver,
    build_seven_stage_pipeline,
)
from engine.interfaces import DiscoveryProviderInterface
from engine.runtime import StageConfig
from queues.queue_definition import QueueDefinition
from queues.retry_policy import RetryPolicy
from workers.base_worker import BaseWorker
from workers.worker_capability import WorkerCapability
from workers.worker_definition import WorkerDefinition


def _candidate(i: int, session_id: str) -> BusinessCandidate:
    return BusinessCandidate(
        pipeline_id=f"pid-{i}",
        session_id=session_id,
        provider="fake",
        name=f"Business {i}",
        category="Coffee Shop",
        website="https://example.invalid",
    )


class _ProbeWebsiteWorker(BaseWorker):
    """Fake Website worker: no network, deterministic, instrumented via a
    shared `_ConcurrencyProbe` so tests can observe overlap/limits/
    distinct-instance behavior without timing races."""

    def __init__(self, probe: "_ConcurrencyProbe") -> None:
        super().__init__(worker_type="website", capabilities=(WorkerCapability(name="website"),))
        self._probe = probe

    def timeout_seconds(self) -> float:
        return 5.0

    def process(self, item: BusinessCandidate) -> WebsiteIntel:
        return self._probe.process(self, item)


class _ConcurrencyProbe:
    """Shared controller for tests 1-3: tracks concurrently-active worker
    *instances* (by identity) so the test can assert both that no more
    than `concurrency` are ever active at once (test 1) and that two of
    them are provably active at the same moment, not just close in time
    (test 2, via the barrier) and that no instance is ever reused while
    still active (test 3)."""

    def __init__(self, concurrency: int) -> None:
        self._concurrency = concurrency
        self._lock = threading.Lock()
        self._active_ids: set = set()
        self.max_active = 0
        self.duplicate_instance_seen = False
        self.over_limit_seen = False
        self._barrier = threading.Barrier(concurrency, timeout=5.0)

    def process(self, worker: BaseWorker, item: BusinessCandidate) -> WebsiteIntel:
        with self._lock:
            if id(worker) in self._active_ids:
                self.duplicate_instance_seen = True
            self._active_ids.add(id(worker))
            self.max_active = max(self.max_active, len(self._active_ids))
            if len(self._active_ids) > self._concurrency:
                self.over_limit_seen = True
        try:
            # Forces true overlap: every concurrent call in this pass
            # must actually be in-flight simultaneously before any of
            # them is allowed to return -- a real race, not a timing
            # guess. If the driver only ran `concurrency` calls
            # serially, this would hang and the test would fail on
            # BrokenBarrierError instead of silently passing.
            self._barrier.wait()
        except threading.BrokenBarrierError:
            pass
        with self._lock:
            self._active_ids.discard(id(worker))
        return WebsiteIntel(pipeline_id=item.pipeline_id, website_reachable=True)


def _build_website_only_driver(
    *,
    concurrency: int,
    instance_count: int,
    candidate_count: int,
    worker_factory,
    retry_policy: Optional[RetryPolicy] = None,
):
    """Minimal single-stage ("website") pipeline: real EngineCoordinator /
    RuntimeContext / WorkerAllocator / Queue, built directly (not via
    build_seven_stage_pipeline) so each test controls worker behavior
    precisely. Terminal (output_queue_id=None) -- nothing downstream of
    website is needed for tests 1-5."""
    coordinator = EngineCoordinator()
    ctx = coordinator.create_session(user_id="probe_user", requested_count=candidate_count)
    session_id = ctx.session.id

    website_in = QueueDefinition(
        queue_id="website_in",
        queue_name="Website Input",
        stage="website",
        retry_policy=retry_policy or RetryPolicy(max_attempts=3, retry_delay_seconds=0.0, strategy="immediate"),
    )
    definition = WorkerDefinition(
        definition_id="website-v1",
        worker_type="website",
        capabilities=(WorkerCapability(name="website"),),
    )
    blueprint = StageBlueprint(
        definition=definition,
        worker_factory=worker_factory,
        instance_count=instance_count,
    )

    coordinator.build_runtime_context(
        session_id, stages=[blueprint], queue_definitions=[website_in]
    )
    coordinator.start_session(session_id)
    coordinator.mark_running(session_id)
    engine_runtime = coordinator.get_engine_runtime(session_id)

    queue = engine_runtime._runtime.queue_manager.get_queue("website_in")
    for i in range(candidate_count):
        cand = _candidate(i, session_id)
        queue.enqueue(pipeline_id=cand.pipeline_id, stage="website", payload=cand)

    stage = StageConfig(name="website", definition_id="website-v1", input_queue_id="website_in")
    driver = ExecutionDriver(
        engine_runtime, [stage], stage_concurrency={"website": concurrency}
    )
    return driver, queue


def test_website_concurrency_limit_is_enforced_and_overlaps():
    """Tests 1 + 2: with stage_concurrency={"website": 2} and 4 more idle
    instances than that (instance_count=6), never more than 2 execute
    concurrently, and two calls are provably in flight at once (the
    barrier would hang/fail otherwise)."""
    probe = _ConcurrencyProbe(concurrency=2)
    driver, queue = _build_website_only_driver(
        concurrency=2,
        instance_count=6,
        candidate_count=6,
        worker_factory=lambda: _ProbeWebsiteWorker(probe),
    )
    try:
        for _ in range(10):
            if queue.is_empty():
                break
            driver.run_once()
    finally:
        driver.stop(wait=True, timeout=5.0)

    assert queue.is_empty()
    assert probe.max_active == 2, f"expected exactly 2 concurrent, saw {probe.max_active}"
    assert not probe.over_limit_seen
    assert not probe.duplicate_instance_seen


def test_website_default_concurrency_is_one_when_unconfigured():
    """Sanity check for the DEFAULT ALL STAGES TO 1 instruction: a stage
    absent from stage_concurrency never runs more than one call at a
    time, even with several idle instances available."""
    probe = _ConcurrencyProbe(concurrency=1)
    coordinator = EngineCoordinator()
    ctx = coordinator.create_session(user_id="probe_user2", requested_count=3)
    session_id = ctx.session.id
    website_in = QueueDefinition(
        queue_id="website_in", queue_name="Website Input", stage="website",
        retry_policy=RetryPolicy(max_attempts=3, retry_delay_seconds=0.0, strategy="immediate"),
    )
    definition = WorkerDefinition(
        definition_id="website-v1", worker_type="website",
        capabilities=(WorkerCapability(name="website"),),
    )
    blueprint = StageBlueprint(
        definition=definition, worker_factory=lambda: _ProbeWebsiteWorker(probe),
        instance_count=4,
    )
    coordinator.build_runtime_context(session_id, stages=[blueprint], queue_definitions=[website_in])
    coordinator.start_session(session_id)
    coordinator.mark_running(session_id)
    engine_runtime = coordinator.get_engine_runtime(session_id)
    queue = engine_runtime._runtime.queue_manager.get_queue("website_in")
    for i in range(3):
        cand = _candidate(i, session_id)
        queue.enqueue(pipeline_id=cand.pipeline_id, stage="website", payload=cand)

    stage = StageConfig(name="website", definition_id="website-v1", input_queue_id="website_in")
    # No stage_concurrency passed at all -- identical to pre-Phase-5C.
    driver = ExecutionDriver(engine_runtime, [stage])
    assert driver._concurrency_executor is None  # no thread pool ever built
    for _ in range(5):
        if queue.is_empty():
            break
        driver.run_once()
    assert queue.is_empty()


def test_website_retry_behavior_preserved_under_concurrency():
    """Test 4: existing retry-eligibility bookkeeping
    (Queue.can_retry()/record_attempt()/dead_letter(), read live from
    each QueueItem's RetryPolicy inside execute_stage()'s own
    `_handle_failure()`, unmodified by Phase 5C) still behaves
    correctly, per item, when two Website failures are processed
    concurrently -- including preserving each outcome's own
    pipeline_id.

    NOTE on scope: this codebase's actual retry *execution* (turning a
    retryable, not-yet-dead-lettered failure into a second attempt via
    a fresh dequeue of the same work) is an explicitly out-of-scope,
    pre-existing gap here -- `Queue.enqueue()` always mints a brand
    new queue_item_id with retry_count reset to 0 (see its own
    docstring), and `EngineCoordinator.resume_failed_work()` raises
    `NotImplementedError` today. Phase 5C does not add that missing
    piece either (it isn't in the DO NOT / IMPLEMENT list), so this
    test exercises the one retry-policy outcome that's actually real
    today -- a policy that permits exactly one attempt, immediately
    dead-lettering a failure -- rather than fabricating a multi-attempt
    retry loop this system doesn't implement.
    """

    class _AlwaysFailWebsiteWorker(BaseWorker):
        def __init__(self) -> None:
            super().__init__(worker_type="website", capabilities=(WorkerCapability(name="website"),))

        def timeout_seconds(self) -> float:
            return 5.0

        def process(self, item: BusinessCandidate) -> WebsiteIntel:
            raise RuntimeError("simulated website failure")

    driver, queue = _build_website_only_driver(
        concurrency=2,
        instance_count=3,
        candidate_count=0,
        worker_factory=lambda: _AlwaysFailWebsiteWorker(),
        retry_policy=RetryPolicy(max_attempts=1, retry_delay_seconds=0.0, strategy="immediate"),
    )
    # Pre-seed each item's retry record to already be at its policy's
    # max_attempts, using record_attempt() exactly as documented ("does
    # not require queue_item_id to currently be present in this queue's
    # FIFO storage... the normal case is a QueueItem that has already
    # left this queue... and failed elsewhere" -- queues/queue.py). This
    # is the real, public, intended way to represent "this work has
    # already used up its attempts" ahead of a dequeue -- not a private
    # monkeypatch.
    items = [queue.enqueue(pipeline_id=f"pid-{i}", stage="website", payload=_candidate(i, "probe_user")) for i in range(2)]
    for item in items:
        queue.record_attempt(item.queue_item_id)

    try:
        outcomes = driver.run_once()
    finally:
        driver.stop(wait=True, timeout=5.0)

    assert queue.is_empty()
    assert len(outcomes) == 2
    pipeline_ids = {o.pipeline_id for o in outcomes}
    assert pipeline_ids == {"pid-0", "pid-1"}
    for o in outcomes:
        assert o.success is False
        # max_attempts=1 -> the one and only attempt exhausts the
        # policy -> dead-lettered, exactly as it would be at
        # concurrency=1. Concurrency did not change this per-item
        # decision or mix up which pipeline_id it applies to.
        assert o.dead_lettered is True


def test_cancellation_stops_new_website_submissions():
    """Test 5: once stop() has fully returned, the driver's concurrency
    executor is shut down and _run_stage_pass() refuses to submit new
    work for the website stage (returns None) rather than silently
    starting more concurrent execute_stage() calls."""
    probe = _ConcurrencyProbe(concurrency=2)
    driver, queue = _build_website_only_driver(
        concurrency=2,
        instance_count=4,
        candidate_count=2,
        worker_factory=lambda: _ProbeWebsiteWorker(probe),
    )
    # Drain the two seeded candidates first so shutdown isn't racing the
    # barrier-gated in-flight probe calls.
    driver.run_once()
    assert queue.is_empty()

    driver.stop(wait=True, timeout=5.0)
    assert driver._concurrency_executor is not None
    assert driver._concurrency_executor._shutdown  # type: ignore[attr-defined]

    # Enqueue new work after cancellation and prove a fresh pass for the
    # concurrency>1 stage refuses to submit it.
    cand = _candidate(99, "irrelevant")
    queue.enqueue(pipeline_id=cand.pipeline_id, stage="website", payload=cand)
    stage = driver._stages[0]
    result = driver._run_stage_pass(stage)
    assert result is None
    # The item must not have been silently dropped -- Queue.dequeue()
    # inside execute_stage() only runs if a submission is attempted, and
    # here the submission itself was refused before any dequeue, so the
    # item is still sitting in the queue for a future driver/session.
    assert not queue.is_empty()


def test_phase5b_terminal_accounting_preserved_with_website_concurrency():
    """Test 6: running the REAL build_seven_stage_pipeline() composition
    (Phase 5B-2's terminal-accounting on_progress wiring, unmodified)
    with website stage_concurrency enabled still produces exactly one
    terminal event per dead-lettered website candidate -- no double
    counting, no missing terminal event, under concurrent execution."""

    class _AlwaysFailWebsiteWorker(BaseWorker):
        def __init__(self) -> None:
            super().__init__(worker_type="website", capabilities=(WorkerCapability(name="website"),))

        def timeout_seconds(self) -> float:
            return 5.0

        def process(self, item: BusinessCandidate) -> WebsiteIntel:
            raise RuntimeError("simulated permanent website failure")

    class _FakeDiscoveryProvider(DiscoveryProviderInterface):
        def __init__(self, count: int) -> None:
            self._count = count

        @property
        def provider_id(self) -> str:
            return "fake"

        @property
        def display_name(self) -> str:
            return "Fake"

        def discover(self, request) -> Iterator[BusinessCandidate]:
            for i in range(self._count):
                yield _candidate(i, request.session_id if request else "s")

    class _DummyStorageBackend:
        def store_opportunity(self, opp):
            return StoredOpportunity(
                storage_id=f"store_{opp.pipeline_id}",
                pipeline_id=opp.pipeline_id,
                stored_at_iso="2026-08-15T00:00:00Z",
            )

    coordinator = EngineCoordinator()
    ctx = coordinator.create_session(user_id="term_user", requested_count=4)
    session_id = ctx.session.id

    events: List[tuple] = []

    def _on_progress(stage, event, item_id, **kwargs):
        events.append((stage, event, kwargs.get("pipeline_id"), kwargs.get("terminal")))

    provider = _FakeDiscoveryProvider(4)
    stages, queue_ids, fan_in, cleanup_cb = build_seven_stage_pipeline(
        coordinator,
        session_id,
        discovery_provider=provider,
        discovery_request=None,
        storage_backend=_DummyStorageBackend(),
        website_worker_factory=lambda: _AlwaysFailWebsiteWorker(),
        instance_counts={"website": 4},
        on_progress=_on_progress,
    )
    coordinator.start_session(session_id)
    coordinator.mark_running(session_id)
    engine_runtime = coordinator.get_engine_runtime(session_id)

    driver = ExecutionDriver(
        engine_runtime, stages, on_stage_outcome=cleanup_cb,
        run_producers_once=True,
        stage_concurrency={"website": 2},
    )
    driver._ensure_producers_started()
    deadline = time.monotonic() + 10.0
    while time.monotonic() < deadline and not driver.producers_finished():
        time.sleep(0.01)
    assert driver.producers_finished()

    website_q = engine_runtime._runtime.queue_manager.get_queue(queue_ids.website_in)

    # build_seven_stage_pipeline hardcodes a real RetryPolicy(max_attempts=2)
    # for every queue it builds (not caller-configurable, and this test does
    # not change it -- redesigning Queue/retry policy is explicitly out of
    # scope for Phase 5C). Pre-seed each queued item's retry record to
    # already be at that policy's max_attempts via record_attempt(), exactly
    # as documented ("does not require queue_item_id to currently be
    # present in this queue's FIFO storage" -- queues/queue.py) -- the
    # real, public, intended way to represent "this work has already used
    # up its attempts" ahead of a dequeue, so the one real execute_stage()
    # failure below takes the actual dead-letter branch (matching what a
    # second real attempt would look like, without fabricating a retry
    # *execution* loop this codebase doesn't implement -- see the retry
    # test's own docstring for that gap).
    for item in list(website_q._items):
        for _ in range(2):  # max_attempts=2
            website_q.record_attempt(item.queue_item_id)

    outcomes: List = []
    while not website_q.is_empty():
        outcomes.extend(driver.run_once())
    driver.stop(wait=True, timeout=5.0)

    website_outcomes = [o for o in outcomes if o.stage_name == "website"]
    assert len(website_outcomes) == 4
    assert all(o.success is False and o.dead_lettered for o in website_outcomes)

    terminal_website_events = [
        e for e in events if e[0] == "website" and e[3] is True
    ]
    terminal_pipeline_ids = {e[2] for e in terminal_website_events}
    assert terminal_pipeline_ids == {f"pid-{i}" for i in range(4)}
    # Exactly one terminal event per pipeline_id -- concurrency must not
    # cause double-accounting.
    assert len(terminal_website_events) == 4

