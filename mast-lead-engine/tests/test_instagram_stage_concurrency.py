"""
Instagram stage concurrency — targeted regression test.

Scope: DEFAULT_STAGE_CONCURRENCY now includes "instagram": 2 (same
treatment already given to Website in Phase 5C and Contact in Phase
5E). This file adds only the minimum test needed to prove that the
existing, generic bounded-concurrency mechanism in
engine/execution_driver.py (`_stage_concurrency_for()`, the bounded
`_concurrency_executor`, and WorkerAllocator/Queue's own locking)
behaves for Instagram exactly as it already does for Website/Contact:

    1. Instagram concurrency limit (2) is enforced and never exceeded.
    2. Two different Instagram candidates provably run concurrently
       (via a barrier, not a timing guess).
    3. No single BaseWorker instance is ever used by two concurrent
       calls at once (no duplicate worker allocation).

No network I/O anywhere in this file — mirrors
tests/test_phase5c_website_stage_concurrency.py's own structure and
its `_ConcurrencyProbe` pattern, adapted to the "instagram" stage.
"""

from __future__ import annotations

import os
import sys
import threading

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

from engine.contracts import BusinessCandidate, InstagramIntel
from engine.coordinator import EngineCoordinator, StageBlueprint
from engine.execution_driver import DEFAULT_STAGE_CONCURRENCY, ExecutionDriver
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
        instagram_url="https://instagram.com/example.invalid",
    )


class _ConcurrencyProbe:
    """Same shape as _ConcurrencyProbe in
    tests/test_phase5c_website_stage_concurrency.py: tracks
    concurrently-active worker *instances* (by identity) so the test
    can assert no more than `concurrency` are ever active at once, that
    two are provably active at the same moment (barrier), and that no
    instance is ever reused while still active."""

    def __init__(self, concurrency: int) -> None:
        self._concurrency = concurrency
        self._lock = threading.Lock()
        self._active_ids: set = set()
        self.max_active = 0
        self.duplicate_instance_seen = False
        self.over_limit_seen = False
        self._barrier = threading.Barrier(concurrency, timeout=5.0)

    def process(self, worker: BaseWorker, item: BusinessCandidate) -> InstagramIntel:
        with self._lock:
            if id(worker) in self._active_ids:
                self.duplicate_instance_seen = True
            self._active_ids.add(id(worker))
            self.max_active = max(self.max_active, len(self._active_ids))
            if len(self._active_ids) > self._concurrency:
                self.over_limit_seen = True
        try:
            self._barrier.wait()
        except threading.BrokenBarrierError:
            pass
        with self._lock:
            self._active_ids.discard(id(worker))
        return InstagramIntel(pipeline_id=item.pipeline_id, profile_reachable=True)


class _ProbeInstagramWorker(BaseWorker):
    """Fake Instagram worker: no network, instrumented via a shared
    _ConcurrencyProbe, exactly like _ProbeWebsiteWorker."""

    def __init__(self, probe: _ConcurrencyProbe) -> None:
        super().__init__(worker_type="instagram", capabilities=(WorkerCapability(name="instagram"),))
        self._probe = probe

    def timeout_seconds(self) -> float:
        return 5.0

    def process(self, item: BusinessCandidate) -> InstagramIntel:
        return self._probe.process(self, item)


def test_default_stage_concurrency_now_includes_instagram():
    """DEFAULT_STAGE_CONCURRENCY carries the new "instagram": 2 entry,
    while leaving website/contact untouched -- the exact, minimal diff
    described in the audit."""
    assert DEFAULT_STAGE_CONCURRENCY == {"website": 2, "contact": 2, "instagram": 2}


def test_instagram_concurrency_limit_is_enforced_and_overlaps_without_duplicate_allocation():
    """With stage_concurrency={"instagram": 2} and 4 more idle instances
    than that (instance_count=6), never more than 2 execute
    concurrently, two calls are provably in flight at once (the barrier
    would hang/fail otherwise), and no BaseWorker instance is ever
    allocated to two concurrent calls at once."""
    concurrency = 2
    instance_count = 6
    candidate_count = 6

    probe = _ConcurrencyProbe(concurrency=concurrency)

    coordinator = EngineCoordinator()
    ctx = coordinator.create_session(user_id="probe_user", requested_count=candidate_count)
    session_id = ctx.session.id

    instagram_in = QueueDefinition(
        queue_id="instagram_in",
        queue_name="Instagram Input",
        stage="instagram",
        retry_policy=RetryPolicy(max_attempts=3, retry_delay_seconds=0.0, strategy="immediate"),
    )
    definition = WorkerDefinition(
        definition_id="instagram-v1",
        worker_type="instagram",
        capabilities=(WorkerCapability(name="instagram"),),
    )
    blueprint = StageBlueprint(
        definition=definition,
        worker_factory=lambda: _ProbeInstagramWorker(probe),
        instance_count=instance_count,
    )

    coordinator.build_runtime_context(
        session_id, stages=[blueprint], queue_definitions=[instagram_in]
    )
    coordinator.start_session(session_id)
    coordinator.mark_running(session_id)
    engine_runtime = coordinator.get_engine_runtime(session_id)

    queue = engine_runtime._runtime.queue_manager.get_queue("instagram_in")
    for i in range(candidate_count):
        cand = _candidate(i, session_id)
        queue.enqueue(pipeline_id=cand.pipeline_id, stage="instagram", payload=cand)

    stage = StageConfig(name="instagram", definition_id="instagram-v1", input_queue_id="instagram_in")
    driver = ExecutionDriver(
        engine_runtime, [stage], stage_concurrency={"instagram": concurrency}
    )
    try:
        for _ in range(10):
            if queue.is_empty():
                break
            driver.run_once()
    finally:
        driver.stop(wait=True, timeout=5.0)

    assert queue.is_empty()
    assert probe.max_active == concurrency, f"expected exactly {concurrency} concurrent, saw {probe.max_active}"
    assert not probe.over_limit_seen
    assert not probe.duplicate_instance_seen
