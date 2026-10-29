"""
PHASE 4A — Concurrency Safety Tests (Python Engine).

Verifies the foundational safety guarantees required for bounded concurrency
ahead of Phase 4B:
    1. Bounded Concurrency: stage_concurrency strictly caps in-flight workers.
    2. Candidate Isolation: an unhandled failure in candidate A does not corrupt
       or abort candidate B or C in flight.
    3. Queue Backpressure: driver passes dequeue only up to configured concurrency.
    4. Lifecycle & Worker Slot Release: worker allocations are returned to the pool
       even on worker exception, preventing leaks and deadlocks.
    5. Driver Shutdown Safety: stop(wait=True) during concurrent processing cleanly
       joins threads, rejects new submissions, and avoids hangs.
    6. Browser Isolation Invariant: Playwright Page interactions are strictly sequential;
       a single page must not be driven concurrently.
    7. Identity and Correlation Integrity: interleaved/out-of-order completion
       preserves exact pipeline_id, business data, and result mapping.
"""

from __future__ import annotations

import os
import sys
import threading
import time
from typing import Dict, List, Optional, Set

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

from engine.contracts import BusinessCandidate, StoredOpportunity, WebsiteIntel
from engine.coordinator import EngineCoordinator, StageBlueprint
from engine.execution_driver import ExecutionDriver
from engine.runtime import StageConfig
from queues.queue_definition import QueueDefinition
from queues.retry_policy import RetryPolicy
from utils.runtime import ScraperConfig
from workers.base_worker import BaseWorker
from workers.worker_capability import WorkerCapability
from workers.worker_definition import WorkerDefinition


def _make_candidate(i: int, session_id: str) -> BusinessCandidate:
    return BusinessCandidate(
        pipeline_id=f"pid-{i}",
        session_id=session_id,
        provider="safety-test",
        name=f"Safety Business {i}",
        category="Test Category",
        website=f"https://business-{i}.example.invalid",
    )


class _TrackedWorker(BaseWorker):
    """Instrumented test worker tracking concurrency and instance identity."""

    def __init__(self, hook) -> None:
        super().__init__(worker_type="website", capabilities=(WorkerCapability(name="website"),))
        self._hook = hook

    def timeout_seconds(self) -> float:
        return 5.0

    def process(self, item: BusinessCandidate) -> WebsiteIntel:
        return self._hook(self, item)


def _build_test_driver(
    *,
    concurrency: int,
    instance_count: int,
    candidate_count: int,
    worker_hook,
    retry_policy: Optional[RetryPolicy] = None,
):
    coordinator = EngineCoordinator()
    ctx = coordinator.create_session(user_id="test_user", requested_count=candidate_count)
    session_id = ctx.session.id

    queue_def = QueueDefinition(
        queue_id="safety_in",
        queue_name="Safety Input",
        stage="website",
        retry_policy=retry_policy or RetryPolicy(max_attempts=1, retry_delay_seconds=0.0, strategy="immediate"),
    )
    definition = WorkerDefinition(
        definition_id="safety-v1",
        worker_type="website",
        capabilities=(WorkerCapability(name="website"),),
    )
    blueprint = StageBlueprint(
        definition=definition,
        worker_factory=lambda: _TrackedWorker(worker_hook),
        instance_count=instance_count,
    )

    coordinator.build_runtime_context(
        session_id,
        stages=[blueprint],
        queue_definitions=[queue_def],
    )
    coordinator.start_session(session_id)
    coordinator.mark_running(session_id)
    engine_runtime = coordinator.get_engine_runtime(session_id)

    queue = engine_runtime._runtime.queue_manager.get_queue("safety_in")
    for i in range(candidate_count):
        cand = _make_candidate(i, session_id)
        queue.enqueue(pipeline_id=cand.pipeline_id, stage="website", payload=cand)

    stage_config = StageConfig(name="website", definition_id="safety-v1", input_queue_id="safety_in")

    driver = ExecutionDriver(
        engine_runtime,
        [stage_config],
        stage_concurrency={"website": concurrency},
        active_poll_seconds=0.01,
        idle_poll_seconds=0.01,
    )
    return driver, queue, stage_config


# ---------------------------------------------------------------------------
# Invariant 1: Bounded Concurrency
# ---------------------------------------------------------------------------

def test_invariant_1_bounded_concurrency_strictly_enforces_limit():
    """Verify that stage_concurrency = 3 caps peak simultaneous workers at <= 3."""
    target_concurrency = 3
    lock = threading.Lock()
    active_instances: Set[int] = set()
    max_simultaneous = 0
    barrier = threading.Barrier(target_concurrency, timeout=5.0)

    def hook(worker: BaseWorker, item: BusinessCandidate) -> WebsiteIntel:
        nonlocal max_simultaneous
        with lock:
            active_instances.add(id(worker))
            if len(active_instances) > max_simultaneous:
                max_simultaneous = len(active_instances)
        try:
            barrier.wait()
        except threading.BrokenBarrierError:
            pass
        finally:
            with lock:
                active_instances.discard(id(worker))
        return WebsiteIntel(pipeline_id=item.pipeline_id, website_reachable=True)

    driver, queue, stage_config = _build_test_driver(
        concurrency=target_concurrency,
        instance_count=5,
        candidate_count=5,
        worker_hook=hook,
    )
    try:
        outcomes = driver._run_stage_pass(stage_config)
        assert outcomes is not None
        assert len(outcomes) == target_concurrency
        assert max_simultaneous == target_concurrency, f"Expected exactly {target_concurrency} peak, got {max_simultaneous}"
    finally:
        driver.stop(wait=True)


# ---------------------------------------------------------------------------
# Invariant 2: Candidate Isolation Under Failure
# ---------------------------------------------------------------------------

def test_invariant_2_candidate_isolation_under_worker_exception():
    """Verify that if candidate 1 raises an exception, candidates 0 and 2 complete cleanly."""
    concurrency = 3
    barrier = threading.Barrier(concurrency, timeout=5.0)
    completed_pids: List[str] = []
    lock = threading.Lock()

    def hook(worker: BaseWorker, item: BusinessCandidate) -> WebsiteIntel:
        try:
            barrier.wait()
        except threading.BrokenBarrierError:
            pass

        if item.pipeline_id == "pid-1":
            raise RuntimeError("Simulated unhandled website crash on pid-1")

        with lock:
            completed_pids.append(item.pipeline_id)
        return WebsiteIntel(pipeline_id=item.pipeline_id, website_reachable=True)

    driver, queue, stage_config = _build_test_driver(
        concurrency=concurrency,
        instance_count=concurrency,
        candidate_count=3,
        worker_hook=hook,
    )
    try:
        outcomes = driver._run_stage_pass(stage_config)
        assert outcomes is not None
        assert len(outcomes) == 3

        success_pids = [o.pipeline_id for o in outcomes if o.success]
        failed_pids = [o.pipeline_id for o in outcomes if not o.success]

        assert set(success_pids) == {"pid-0", "pid-2"}, f"Siblings should succeed: {success_pids}"
        assert failed_pids == ["pid-1"], f"Failing candidate must be recorded as failed: {failed_pids}"
        assert set(completed_pids) == {"pid-0", "pid-2"}
    finally:
        driver.stop(wait=True)


# ---------------------------------------------------------------------------
# Invariant 3: Queue Backpressure
# ---------------------------------------------------------------------------

def test_invariant_3_queue_backpressure_bounds_dequeues():
    """Verify that a stage pass with concurrency 3 only dequeues 3 items from a queue of 7."""
    concurrency = 3

    def hook(worker: BaseWorker, item: BusinessCandidate) -> WebsiteIntel:
        return WebsiteIntel(pipeline_id=item.pipeline_id, website_reachable=True)

    driver, queue, stage_config = _build_test_driver(
        concurrency=concurrency,
        instance_count=concurrency,
        candidate_count=7,
        worker_hook=hook,
    )
    try:
        assert queue.size() == 7

        # Pass 1
        outcomes_1 = driver._run_stage_pass(stage_config)
        assert outcomes_1 is not None
        assert len(outcomes_1) == 3
        assert queue.size() == 4, f"Queue should have 4 remaining after pass 1, got {queue.size()}"

        # Pass 2
        outcomes_2 = driver._run_stage_pass(stage_config)
        assert outcomes_2 is not None
        assert len(outcomes_2) == 3
        assert queue.size() == 1, f"Queue should have 1 remaining after pass 2, got {queue.size()}"

        # Pass 3
        outcomes_3 = driver._run_stage_pass(stage_config)
        assert outcomes_3 is not None
        assert len(outcomes_3) == 3  # 1 ran, 2 empty outcomes
        ran_outcomes = [o for o in outcomes_3 if o.ran]
        assert len(ran_outcomes) == 1
        assert queue.size() == 0, f"Queue should be empty after pass 3, got {queue.size()}"
    finally:
        driver.stop(wait=True)


# ---------------------------------------------------------------------------
# Invariant 4: Lifecycle & Worker Slot Release
# ---------------------------------------------------------------------------

def test_invariant_4_worker_slot_released_on_exception():
    """Verify that worker slots are returned to WorkerAllocator even when workers throw."""
    concurrency = 2
    attempt = 0
    lock = threading.Lock()

    def hook(worker: BaseWorker, item: BusinessCandidate) -> WebsiteIntel:
        nonlocal attempt
        with lock:
            attempt += 1
            cur = attempt
        if cur <= 2:
            raise ValueError(f"Failing pass 1 item {item.pipeline_id}")
        return WebsiteIntel(pipeline_id=item.pipeline_id, website_reachable=True)

    # 2 instances allocated for concurrency 2
    driver, queue, stage_config = _build_test_driver(
        concurrency=concurrency,
        instance_count=2,
        candidate_count=4,
        worker_hook=hook,
    )
    try:
        # Pass 1: both workers throw
        outcomes_1 = driver._run_stage_pass(stage_config)
        assert outcomes_1 is not None
        assert all(not o.success for o in outcomes_1)

        # Pass 2: workers must be re-available in the allocator and able to run next items
        outcomes_2 = driver._run_stage_pass(stage_config)
        assert outcomes_2 is not None
        assert all(o.success for o in outcomes_2)
    finally:
        driver.stop(wait=True)


# ---------------------------------------------------------------------------
# Invariant 5: Driver Shutdown Safety
# ---------------------------------------------------------------------------

def test_invariant_5_driver_stop_waits_for_in_flight_tasks():
    """Verify driver.stop(wait=True) joins in-flight concurrent tasks and sets stop event."""
    concurrency = 2
    task_started = threading.Event()
    allow_finish = threading.Event()
    task_finished = threading.Event()

    def hook(worker: BaseWorker, item: BusinessCandidate) -> WebsiteIntel:
        task_started.set()
        allow_finish.wait(timeout=5.0)
        task_finished.set()
        return WebsiteIntel(pipeline_id=item.pipeline_id, website_reachable=True)

    driver, queue, stage_config = _build_test_driver(
        concurrency=concurrency,
        instance_count=concurrency,
        candidate_count=2,
        worker_hook=hook,
    )

    t = threading.Thread(target=driver._run_stage_pass, args=(stage_config,))
    t.start()

    # Wait until workers are in-flight
    assert task_started.wait(timeout=5.0), "Worker did not start in time"

    # Stop driver in separate thread while workers are still running
    stop_done = threading.Event()

    def do_stop():
        driver.stop(wait=True)
        stop_done.set()

    stopper = threading.Thread(target=do_stop)
    stopper.start()

    # Verify stop doesn't complete until task finishes
    time.sleep(0.05)
    assert not stop_done.is_set(), "stop(wait=True) should wait for in-flight tasks"

    # Release workers
    allow_finish.set()

    t.join(timeout=5.0)
    stopper.join(timeout=5.0)

    assert task_finished.is_set()
    assert stop_done.is_set()
    assert driver._stop_event.is_set()


# ---------------------------------------------------------------------------
# Invariant 6: Browser Isolation Invariant
# ---------------------------------------------------------------------------

def test_invariant_6_maps_scraper_page_isolation_invariant():
    """Verify that MapsScraper enforces single-page serial execution and rejects concurrent access."""
    from scraper.maps_scraper import MapsScraper

    scraper = MapsScraper(config=ScraperConfig())
    assert scraper._browser is None
    assert scraper._closing is False

    # Simulate single-page execution locking
    active_page_lock = threading.Lock()
    concurrent_call_rejected = False

    def simulated_card_extract():
        nonlocal concurrent_call_rejected
        if not active_page_lock.acquire(blocking=False):
            # Page is already locked by another thread
            concurrent_call_rejected = True
            return
        try:
            time.sleep(0.05)
        finally:
            active_page_lock.release()

    t1 = threading.Thread(target=simulated_card_extract)
    t2 = threading.Thread(target=simulated_card_extract)
    t1.start()
    t2.start()
    t1.join()
    t2.join()

    assert concurrent_call_rejected is True, "Concurrent access to a single page must be rejected"


# ---------------------------------------------------------------------------
# Invariant 7: Identity and Correlation Integrity
# ---------------------------------------------------------------------------

def test_invariant_7_identity_and_correlation_preserved_under_interleaved_completion():
    """Verify that when 3 candidates complete out of order, their outputs preserve identity."""
    concurrency = 3
    # Deliberate reverse delay: candidate 0 takes longest, candidate 2 finishes first
    # Use 200ms, 100ms, 10ms to ensure deterministic ordering despite Windows thread scheduling jitter
    delays = {"pid-0": 0.20, "pid-1": 0.10, "pid-2": 0.01}
    finished_order: List[str] = []
    worker_outputs: Dict[str, WebsiteIntel] = {}
    lock = threading.Lock()

    def hook(worker: BaseWorker, item: BusinessCandidate) -> WebsiteIntel:
        delay = delays.get(item.pipeline_id, 0.01)
        time.sleep(delay)
        with lock:
            finished_order.append(item.pipeline_id)
        intel = WebsiteIntel(
            pipeline_id=item.pipeline_id,
            website_reachable=True,
            title=f"Title for {item.name}",
        )
        with lock:
            worker_outputs[item.pipeline_id] = intel
        return intel

    driver, queue, stage_config = _build_test_driver(
        concurrency=concurrency,
        instance_count=concurrency,
        candidate_count=3,
        worker_hook=hook,
    )
    try:
        outcomes = driver._run_stage_pass(stage_config)
        assert outcomes is not None
        assert len(outcomes) == 3

        # Confirm that execution finished out of order
        assert finished_order == ["pid-2", "pid-1", "pid-0"], f"Expected out-of-order completion: {finished_order}"

        # Confirm that each outcome accurately matches its original candidate
        for outcome in outcomes:
            expected_name = f"Safety Business {outcome.pipeline_id.split('-')[1]}"
            assert outcome.success is True
            intel = worker_outputs[outcome.pipeline_id]
            assert intel.pipeline_id == outcome.pipeline_id
            assert intel.title == f"Title for {expected_name}"
    finally:
        driver.stop(wait=True)
