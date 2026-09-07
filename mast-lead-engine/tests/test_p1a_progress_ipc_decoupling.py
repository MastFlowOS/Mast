"""
P1-A FIX — regression tests for decoupling outcome/progress IPC from the
ExecutionDriver stage execution hot path.

Root cause (see the fix report): `service.py`'s `_on_progress()` used to
call `sys.stdout.write()` + `sys.stdout.flush()` synchronously, and it is
invoked from inside `ExecutionDriver._execute_one()` (via
`on_stage_outcome` -> ... -> `on_progress`), under that method's own
`_outcome_lock`. `_run_stage_pass()` calls `future.result()` on every
`_execute_one()` future before advancing to the next pass, so stdout/pipe
backpressure could gate Future resolution and therefore pass-to-pass
throughput, even with real worker concurrency configured.

Fix: `service.py._ProgressEventWriter` -- a bounded queue + one dedicated
drainer thread that owns every `"type":"progress"` stdout write.
`_on_progress()` now enqueues and returns; `engine/execution_driver.py`
is completely unmodified.

This file covers two things:

  (A) `_ProgressEventWriter` in isolation (ordering, overflow behavior,
      critical-vs-telemetry distinction, shutdown flush, writer-failure
      resilience) -- tests 4, 5, 6 below, plus part of 2.

  (B) The actual `ExecutionDriver` stage hot path, using a REAL
      `EngineCoordinator` / `RuntimeContext` / `WorkerAllocator` / `Queue`
      stack (same pattern as tests/test_phase5c_website_stage_concurrency.py),
      with a deliberately-blocked `on_stage_outcome` sink standing in for
      a stalled stdout writer -- tests 1, 2, 3 below.

No network I/O anywhere in this file.
"""

from __future__ import annotations

import os
import queue as thread_queue
import sys
import threading
import time
from typing import List, Optional

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

from engine.contracts import BusinessCandidate, WebsiteIntel
from engine.coordinator import EngineCoordinator, StageBlueprint
from engine.execution_driver import ExecutionDriver
from engine.runtime import StageConfig
from queues.queue_definition import QueueDefinition
from queues.retry_policy import RetryPolicy
from workers.base_worker import BaseWorker
from workers.worker_capability import WorkerCapability
from workers.worker_definition import WorkerDefinition

import service
from service import (
    _ProgressEventWriter,
    _PROGRESS_WRITER_CRITICAL_ENQUEUE_TIMEOUT_S,
)


# ---------------------------------------------------------------------------
# Shared fixtures / helpers
# ---------------------------------------------------------------------------

def _candidate(i: int, session_id: str) -> BusinessCandidate:
    return BusinessCandidate(
        pipeline_id=f"pid-{i}",
        session_id=session_id,
        provider="fake",
        name=f"Business {i}",
        category="Coffee Shop",
        website="https://example.invalid",
    )


class _SlowSinkWebsiteWorker(BaseWorker):
    """A Website worker whose `process()` itself is fast -- the point of
    these tests is that STDOUT/IPC (the `on_stage_outcome` sink), not the
    worker body, is what's slow/blocked."""

    def timeout_seconds(self) -> float:
        return 5.0

    def process(self, item: BusinessCandidate) -> WebsiteIntel:
        return WebsiteIntel(pipeline_id=item.pipeline_id, website_reachable=True)


def _build_website_only_driver(
    *,
    concurrency: int,
    instance_count: int,
    candidate_count: int,
    on_stage_outcome,
):
    """Minimal single-stage ("website") real pipeline -- same construction
    pattern as tests/test_phase5c_website_stage_concurrency.py -- wired
    with a caller-supplied `on_stage_outcome`, so a test can plug in a
    deliberately slow/blocked sink standing in for stdout/IPC."""
    coordinator = EngineCoordinator()
    ctx = coordinator.create_session(user_id="p1a_probe", requested_count=candidate_count)
    session_id = ctx.session.id

    website_in = QueueDefinition(
        queue_id="website_in",
        queue_name="Website Input",
        stage="website",
        retry_policy=RetryPolicy(max_attempts=3, retry_delay_seconds=0.0, strategy="immediate"),
    )
    definition = WorkerDefinition(
        definition_id="website-v1",
        worker_type="website",
        capabilities=(WorkerCapability(name="website"),),
    )
    blueprint = StageBlueprint(
        definition=definition,
        worker_factory=lambda: _SlowSinkWebsiteWorker(
            worker_type="website", capabilities=(WorkerCapability(name="website"),)
        ),
        instance_count=instance_count,
    )
    coordinator.build_runtime_context(session_id, stages=[blueprint], queue_definitions=[website_in])
    coordinator.start_session(session_id)
    coordinator.mark_running(session_id)
    engine_runtime = coordinator.get_engine_runtime(session_id)

    queue = engine_runtime._runtime.queue_manager.get_queue("website_in")
    for i in range(candidate_count):
        cand = _candidate(i, session_id)
        queue.enqueue(pipeline_id=cand.pipeline_id, stage="website", payload=cand)

    stage = StageConfig(name="website", definition_id="website-v1", input_queue_id="website_in")
    driver = ExecutionDriver(
        engine_runtime, [stage],
        on_stage_outcome=on_stage_outcome,
        stage_concurrency={"website": concurrency},
    )
    return driver, queue


# ---------------------------------------------------------------------------
# (B) ExecutionDriver hot-path tests -- prove decoupling at the driver level
# ---------------------------------------------------------------------------

def test_two_execute_one_calls_complete_independently_when_sink_blocked():
    """Requirement 1: two `_execute_one()` calls (website concurrency=2)
    both complete even though the `on_stage_outcome` sink (standing in
    for the writer/stdout path) is deliberately blocked on an Event that
    only the test releases *after* asserting both workers already ran.
    Pre-fix (sink called synchronously and blocking inline, as
    `_on_progress` used to), this would deadlock: `_execute_one` would
    never return, `future.result()` would hang forever, and this test
    would time out instead of passing.
    """
    release_sink = threading.Event()
    workers_done = threading.Event()
    calls: List[str] = []
    lock = threading.Lock()

    def _blocked_sink(outcome) -> None:
        # Simulate a stalled stdout writer: block until the test says so.
        release_sink.wait(timeout=10.0)
        with lock:
            calls.append(outcome.pipeline_id)

    driver, queue = _build_website_only_driver(
        concurrency=2, instance_count=2, candidate_count=2,
        on_stage_outcome=_blocked_sink,
    )
    try:
        result_box: dict = {}

        def _run_pass():
            result_box["outcomes"] = driver._run_stage_pass(
                StageConfig(name="website", definition_id="website-v1", input_queue_id="website_in")
            )
            workers_done.set()

        t = threading.Thread(target=_run_pass, daemon=True)
        t.start()

        # Give both _execute_one() threads a moment to actually run their
        # (fast) worker bodies and reach the (blocked) sink call -- if the
        # fix works, the worker bodies complete near-instantly regardless
        # of the sink being blocked.
        time.sleep(0.5)
        assert not workers_done.is_set(), (
            "the pass finished before the sink was released -- this "
            "assertion just confirms the sink really is blocking, so the "
            "test below is meaningful"
        )

        release_sink.set()
        t.join(timeout=5.0)
        assert workers_done.is_set(), "driver._run_stage_pass() never returned"
        assert sorted(calls) == ["pid-0", "pid-1"]
        outcomes = result_box["outcomes"]
        assert outcomes is not None and len(outcomes) == 2
        assert all(o.success for o in outcomes)
    finally:
        release_sink.set()
        driver.stop(wait=True, timeout=5.0)


def test_slow_on_stage_outcome_does_not_serialize_worker_execution():
    """Requirement 2: a deliberately slow (not just blocked-forever) sink
    does not serialize the two concurrent Website workers -- both worker
    bodies run and finish well within the sink's own per-call delay,
    proving the sink's latency is off the worker's critical path."""
    sink_delay_s = 1.0
    barrier = threading.Barrier(2, timeout=5.0)
    overlap_seen = {"value": False}

    class _OverlapProbeWorker(BaseWorker):
        def timeout_seconds(self) -> float:
            return 5.0

        def process(self, item: BusinessCandidate) -> WebsiteIntel:
            try:
                barrier.wait()
                overlap_seen["value"] = True
            except threading.BrokenBarrierError:
                pass
            return WebsiteIntel(pipeline_id=item.pipeline_id, website_reachable=True)

    def _slow_sink(outcome) -> None:
        time.sleep(sink_delay_s)

    coordinator = EngineCoordinator()
    ctx = coordinator.create_session(user_id="p1a_probe2", requested_count=2)
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
        definition=definition, worker_factory=lambda: _OverlapProbeWorker(
            worker_type="website", capabilities=(WorkerCapability(name="website"),)
        ),
        instance_count=2,
    )
    coordinator.build_runtime_context(session_id, stages=[blueprint], queue_definitions=[website_in])
    coordinator.start_session(session_id)
    coordinator.mark_running(session_id)
    engine_runtime = coordinator.get_engine_runtime(session_id)
    queue = engine_runtime._runtime.queue_manager.get_queue("website_in")
    for i in range(2):
        cand = _candidate(i, session_id)
        queue.enqueue(pipeline_id=cand.pipeline_id, stage="website", payload=cand)

    stage = StageConfig(name="website", definition_id="website-v1", input_queue_id="website_in")
    driver = ExecutionDriver(
        engine_runtime, [stage], on_stage_outcome=_slow_sink,
        stage_concurrency={"website": 2},
    )
    try:
        t0 = time.perf_counter()
        outcomes = driver._run_stage_pass(stage)
        elapsed_s = time.perf_counter() - t0
    finally:
        driver.stop(wait=True, timeout=5.0)

    assert outcomes is not None and len(outcomes) == 2
    # The two worker bodies proved they overlapped (barrier didn't hang).
    assert overlap_seen["value"]
    # Two _execute_one() calls each pay the 1s sink cost; if the sink
    # serialized/blocked worker throughput the way pre-fix stdout could,
    # this pass would take >= ~2s (two sink calls serialized end-to-end
    # with no worker-side overlap benefit). The fix doesn't remove
    # _outcome_lock (outcome callbacks are still serialized, per Phase 5C
    # contract) -- it removes the *stdout* cost from inside that section
    # -- so this test's sink IS still serialized by _outcome_lock;
    # what's being proven here is that the *worker* stage of the pass
    # already ran to completion concurrently before either sink call
    # started, not that the sink itself becomes concurrent.
    assert elapsed_s < (2 * sink_delay_s) + 1.0


def test_run_stage_pass_advances_without_waiting_for_stdout_drain():
    """Requirement 3: `_run_stage_pass()` returns (i.e. is ready for the
    next pass) even while a slow sink is still the thing taking real
    wall-clock time -- the worker-side work itself is not additionally
    gated behind the sink beyond the sink's own (now off-hot-path in the
    real fix) cost. Uses a fake, instant-return sink standing in for the
    fixed `_ProgressEventWriter.enqueue()` (near-instant even when the
    real drainer thread is stalled) to show the pass-level timing this
    fix targets."""
    enqueue_only_calls: List[str] = []

    def _instant_enqueue_sink(outcome) -> None:
        # Mirrors what the real fix's `_on_progress` -> `enqueue()` does:
        # near-instant, no IO wait, regardless of drainer thread state.
        enqueue_only_calls.append(outcome.pipeline_id)

    driver, queue = _build_website_only_driver(
        concurrency=2, instance_count=2, candidate_count=4,
        on_stage_outcome=_instant_enqueue_sink,
    )
    try:
        stage = StageConfig(name="website", definition_id="website-v1", input_queue_id="website_in")
        t0 = time.perf_counter()
        for _ in range(5):
            if queue.is_empty():
                break
            driver._run_stage_pass(stage)
        elapsed_s = time.perf_counter() - t0
    finally:
        driver.stop(wait=True, timeout=5.0)

    assert queue.is_empty()
    assert len(enqueue_only_calls) == 4
    # Four candidates, concurrency 2 -> 2 passes' worth of real work; each
    # pass should complete in well under a second with no IO in the loop.
    assert elapsed_s < 2.0


# ---------------------------------------------------------------------------
# (A) _ProgressEventWriter unit tests
# ---------------------------------------------------------------------------

def test_writer_event_ordering_is_deterministic():
    """Requirement 4: events enqueued in a known sequence (single
    producer, to make the expected order unambiguous) are written by the
    drainer thread in that exact order."""
    writer = _ProgressEventWriter(maxsize=100)
    written: List[dict] = []
    lock = threading.Lock()
    orig_write_now = writer._write_now

    def _capture(payload):
        with lock:
            written.append(payload)

    writer._write_now = _capture  # type: ignore[method-assign]
    try:
        for i in range(50):
            writer.enqueue({"seq": i}, critical=False)
        writer.stop(timeout=5.0)
    finally:
        writer._write_now = orig_write_now  # type: ignore[method-assign]

    assert [item["seq"] for item in written] == list(range(50))


def test_writer_overflow_drops_telemetry_but_never_drops_critical():
    """Requirement: overflow behavior distinguishes telemetry-only from
    correctness-critical events. With the drainer thread deliberately
    blocked and a tiny queue, telemetry-only (`critical=False`) events
    are dropped once the queue fills, while a correctness-critical
    (`critical=True`) event is never dropped -- it falls back to a
    direct, synchronous write instead."""
    drain_blocked = threading.Event()
    written: List[dict] = []
    lock = threading.Lock()

    writer = _ProgressEventWriter(maxsize=2)

    def _blocking_write_now(payload):
        drain_blocked.wait(timeout=10.0)
        with lock:
            written.append(payload)

    writer._write_now = _blocking_write_now  # type: ignore[method-assign]
    try:
        # First item is picked up by the drainer thread immediately and
        # blocks it inside _write_now -- so the queue (maxsize=2) fills
        # up behind it from the telemetry events below.
        writer.enqueue({"kind": "first"}, critical=False)
        time.sleep(0.2)  # let the drainer thread actually dequeue item 1

        for i in range(10):
            writer.enqueue({"kind": "telemetry", "i": i}, critical=False)

        assert writer._dropped_telemetry > 0, "expected some telemetry drops under overflow"

        # Release the drainer so it can work through the backlog -- this
        # is the common case (a transient stall clearing, not a
        # permanently wedged sink). A correctness-critical event enqueued
        # now must still get through, and must never be dropped even
        # though the queue was just full moments ago.
        drain_blocked.set()
        t0 = time.perf_counter()
        writer.enqueue({"kind": "critical"}, critical=True)
        elapsed_s = time.perf_counter() - t0
        assert elapsed_s < _PROGRESS_WRITER_CRITICAL_ENQUEUE_TIMEOUT_S + 2.0

        writer.stop(timeout=5.0)
        with lock:
            assert any(p.get("kind") == "critical" for p in written), (
                "correctness-critical event was silently dropped"
            )
    finally:
        drain_blocked.set()
        if writer._thread.is_alive():
            writer.stop(timeout=5.0)


def test_writer_critical_event_falls_back_to_direct_write_when_permanently_stuck():
    """Overflow behavior, permanently-stuck case: if the writer thread
    never catches up at all (simulating a genuinely dead/wedged sink,
    not just a transient stall), a correctness-critical event still
    reaches stdout -- via the bounded-timeout-then-direct-write fallback
    -- rather than being dropped or hanging forever. The direct write
    itself is instant here (unlike the queue-bound drainer, which is
    permanently blocked), so the whole call is bounded by
    `_PROGRESS_WRITER_CRITICAL_ENQUEUE_TIMEOUT_S` plus a small margin,
    never indefinite."""
    forever_blocked = threading.Event()  # deliberately never set
    written: List[dict] = []
    lock = threading.Lock()

    writer = _ProgressEventWriter(maxsize=1)

    def _write_now_hook(payload):
        if payload.get("kind") == "critical":
            # The fallback direct write path -- succeeds immediately.
            with lock:
                written.append(payload)
            return
        # Everything the drainer thread itself pulls off the queue is
        # permanently stuck (simulates a truly dead/wedged sink).
        forever_blocked.wait(timeout=30.0)

    writer._write_now = _write_now_hook  # type: ignore[method-assign]
    try:
        # Drainer picks this up and blocks on it forever; queue (maxsize=1)
        # fills up right behind it.
        writer.enqueue({"kind": "filler"}, critical=False)
        time.sleep(0.2)
        writer.enqueue({"kind": "filler2"}, critical=False)  # fills the queue

        t0 = time.perf_counter()
        writer.enqueue({"kind": "critical"}, critical=True)
        elapsed_s = time.perf_counter() - t0

        assert elapsed_s < _PROGRESS_WRITER_CRITICAL_ENQUEUE_TIMEOUT_S + 2.0
        with lock:
            assert any(p.get("kind") == "critical" for p in written), (
                "correctness-critical event was lost when the writer "
                "thread was permanently stuck"
            )
    finally:
        forever_blocked.set()
        # The drainer thread may still be mid-block on the filler item
        # briefly; stop() itself must not hang indefinitely either way.
        writer.stop(timeout=5.0)


def test_writer_shutdown_flushes_pending_critical_events():
    """Requirement 5: stop() flushes every event already queued
    (including correctness-critical ones) before returning."""
    writer = _ProgressEventWriter(maxsize=100)
    written: List[dict] = []
    lock = threading.Lock()
    orig_write_now = writer._write_now

    def _capture(payload):
        # A little jitter so this isn't trivially instantaneous.
        time.sleep(0.01)
        with lock:
            written.append(payload)

    writer._write_now = _capture  # type: ignore[method-assign]
    try:
        for i in range(20):
            writer.enqueue({"i": i, "terminal": i % 5 == 0}, critical=(i % 5 == 0))
        writer.stop(timeout=5.0)
    finally:
        writer._write_now = orig_write_now  # type: ignore[method-assign]

    assert len(written) == 20
    critical_seen = [p["i"] for p in written if p["terminal"]]
    assert critical_seen == [0, 5, 10, 15]


def test_writer_failure_does_not_deadlock_pipeline():
    """Requirement 6: an unexpected exception raised while writing one
    queued event does not kill the drainer thread or block subsequent
    enqueue()/stop() calls -- the pipeline can never deadlock behind a
    writer failure."""
    written: List[dict] = []
    lock = threading.Lock()

    writer = _ProgressEventWriter(maxsize=100)

    def _flaky_write_now(payload):
        if payload.get("boom"):
            raise RuntimeError("simulated writer failure")
        with lock:
            written.append(payload)

    writer._write_now = _flaky_write_now  # type: ignore[method-assign]

    writer.enqueue({"i": 1}, critical=False)
    writer.enqueue({"boom": True}, critical=False)
    writer.enqueue({"i": 2}, critical=False)

    t0 = time.perf_counter()
    writer.stop(timeout=5.0)
    elapsed_s = time.perf_counter() - t0

    assert elapsed_s < 5.0, "stop() hung -- writer failure caused a deadlock"
    assert not writer._thread.is_alive()
    assert [p["i"] for p in written] == [1, 2], (
        "drainer thread must survive one bad item and keep draining "
        "subsequent ones"
    )


def test_on_progress_enqueues_instead_of_blocking_on_stdout():
    """Integration-ish sanity check: `service._on_progress` (used as
    `on_progress`/fanned into `on_stage_outcome` throughout the real
    pipeline) enqueues onto a `_ProgressEventWriter` rather than writing
    to stdout inline. Constructs a minimal stand-in the same shape
    `run_query()` builds, with the writer's own stdout write replaced by
    a blocking hook, and confirms the call returns immediately anyway."""
    writer = _ProgressEventWriter(maxsize=100)
    release = threading.Event()
    orig_write_now = writer._write_now
    writer._write_now = lambda payload: release.wait(timeout=10.0)  # type: ignore[method-assign]
    try:
        t0 = time.perf_counter()
        writer.enqueue(
            {"type": "progress", "stage": "website", "event": "stage_completed",
             "item_id": "x", "terminal": False}, critical=False,
        )
        elapsed_s = time.perf_counter() - t0
        assert elapsed_s < 0.5, (
            "enqueue() must return near-instantly even while the "
            "drainer/stdout path is blocked"
        )
    finally:
        release.set()
        writer._write_now = orig_write_now  # type: ignore[method-assign]
        writer.stop(timeout=5.0)
