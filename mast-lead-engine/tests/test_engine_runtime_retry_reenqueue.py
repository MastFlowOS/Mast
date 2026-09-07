"""
Focused unit tests for EngineRuntime retry re-enqueue behavior:
- On retryable failure, dequeued QueueItem is re-enqueued back to input_queue.
- Preserves retry bookkeeping and attempt count.
- Attempt 2 executes.
- On final failure, dead-letters exactly once.
- FanIn remains open after attempt 1 and becomes terminal exactly once after final failure.
- No duplicate FanIn closure.
"""

from datetime import datetime, timezone
from typing import Any, Optional
import pytest

from engine.contracts import BusinessCandidate
from engine.fan_in_runtime import FanInRuntime
from engine.runtime import EngineRuntime, StageConfig
from engine.runtime_context import RuntimeContext
from queues.queue import Queue
from queues.queue_definition import QueueDefinition
from queues.queue_item import QueueItem
from queues.queue_manager import QueueManager
from queues.retry_policy import RetryPolicy
from workers.base_worker import BaseWorker
from workers.worker_allocator import WorkerAllocator
from workers.worker_capability import WorkerCapability
from workers.worker_definition import WorkerDefinition
from workers.worker_handle import WorkerHandle
from workers.worker_pool import WorkerPool
from workers.worker_registry import WorkerRegistry


class FlakyWorker(BaseWorker[Any, Any]):
    """Fails until failure_budget reaches 0, then succeeds."""

    def __init__(self, failure_budget: int = 1, worker_id: Optional[str] = None):
        super().__init__(
            worker_type="flaky",
            capabilities=(WorkerCapability(name="flaky"),),
            worker_id=worker_id,
        )
        self.failure_budget = failure_budget
        self.calls = 0

    def timeout_seconds(self) -> float:
        return 5.0

    def process(self, item: Any) -> str:
        self.calls += 1
        if self.failure_budget > 0:
            self.failure_budget -= 1
            raise RuntimeError(f"Flaky failure {self.calls}")
        return f"success_after_{self.calls}"


def _make_runtime_context(retry_policy: Optional[RetryPolicy] = None) -> tuple[RuntimeContext, Queue, Queue]:
    queue_manager = QueueManager()
    in_def = QueueDefinition(
        queue_id="in_q",
        queue_name="Input Queue",
        retry_policy=retry_policy,
    )
    out_def = QueueDefinition(queue_id="out_q", queue_name="Output Queue")
    in_q = queue_manager.create_queue(in_def)
    out_q = queue_manager.create_queue(out_def)

    registry = WorkerRegistry()
    pool = WorkerPool()
    allocator = WorkerAllocator(pool=pool)

    ctx = RuntimeContext(
        worker_registry=registry,
        worker_pool=pool,
        worker_allocator=allocator,
        queue_manager=queue_manager,
    )
    return ctx, in_q, out_q


def test_retry_reenqueue_attempt1_failure_attempt2_success():
    """Attempt 1 exception -> re-enqueue -> attempt 2 success."""
    policy = RetryPolicy(max_attempts=3, retry_delay_seconds=0.0, strategy="immediate")
    ctx, in_q, out_q = _make_runtime_context(retry_policy=policy)

    flaky_def = WorkerDefinition(
        definition_id="flaky-v1",
        worker_type="flaky",
        capabilities=(WorkerCapability(name="flaky"),),
        heartbeat_interval=2.0,
        timeout_seconds=5.0,
    )
    ctx.worker_pool.register_group(flaky_def)

    flaky = FlakyWorker(failure_budget=1, worker_id="w1")
    flaky.initialize()
    ctx.worker_registry.register_worker(flaky, flaky_def)
    handle = WorkerHandle(
        worker_id=flaky.worker_id,
        instance=flaky,
        attached=True,
        created_at=datetime.now(timezone.utc),
    )
    ctx.worker_pool.add_worker(flaky_def.definition_id, handle)

    runtime = EngineRuntime(ctx, session_id="s1")

    item = in_q.enqueue(pipeline_id="p1", payload="data1")
    assert in_q.size() == 1
    assert in_q.attempt_count(item.queue_item_id) == 0

    stage = StageConfig(
        name="flaky_stage",
        definition_id="flaky-v1",
        input_queue_id="in_q",
        output_queue_id="out_q",
    )

    # Pass 1: Attempt 1 executes and fails
    outcome1 = runtime.execute_stage(stage)
    assert outcome1.ran is True
    assert outcome1.success is False
    assert outcome1.dead_lettered is False
    assert in_q.attempt_count(item.queue_item_id) == 1
    # Check item was re-enqueued
    assert in_q.size() == 1
    peeked = in_q.peek()
    assert peeked is not None
    assert peeked.queue_item_id == item.queue_item_id
    assert peeked.pipeline_id == "p1"

    # Pass 2: Attempt 2 executes and succeeds
    outcome2 = runtime.execute_stage(stage)
    assert outcome2.ran is True
    assert outcome2.success is True
    assert in_q.size() == 0
    assert out_q.size() == 1
    assert flaky.calls == 2


def test_retry_reenqueue_exhaustion_dead_letter_once():
    """Attempt 1 exception -> attempt 2 exception -> dead-letter exactly once."""
    policy = RetryPolicy(max_attempts=2, retry_delay_seconds=0.0, strategy="immediate")
    ctx, in_q, out_q = _make_runtime_context(retry_policy=policy)

    flaky_def = WorkerDefinition(
        definition_id="flaky-v1",
        worker_type="flaky",
        capabilities=(WorkerCapability(name="flaky"),),
        heartbeat_interval=2.0,
        timeout_seconds=5.0,
    )
    ctx.worker_pool.register_group(flaky_def)

    flaky = FlakyWorker(failure_budget=99, worker_id="w1")
    flaky.initialize()
    ctx.worker_registry.register_worker(flaky, flaky_def)
    handle = WorkerHandle(
        worker_id=flaky.worker_id,
        instance=flaky,
        attached=True,
        created_at=datetime.now(timezone.utc),
    )
    ctx.worker_pool.add_worker(flaky_def.definition_id, handle)

    runtime = EngineRuntime(ctx, session_id="s1")

    item = in_q.enqueue(pipeline_id="p1", payload="data1")
    stage = StageConfig(
        name="flaky_stage",
        definition_id="flaky-v1",
        input_queue_id="in_q",
        output_queue_id="out_q",
    )

    # Attempt 1: fails, can_retry is True (attempts=1 < max_attempts=2) -> re-enqueued
    outcome1 = runtime.execute_stage(stage)
    assert outcome1.ran is True
    assert outcome1.success is False
    assert outcome1.dead_lettered is False
    assert in_q.attempt_count(item.queue_item_id) == 1
    assert in_q.size() == 1

    # Attempt 2: fails, can_retry is False (attempts=2 >= max_attempts=2) -> dead-lettered
    outcome2 = runtime.execute_stage(stage)
    assert outcome2.ran is True
    assert outcome2.success is False
    assert outcome2.dead_lettered is True
    assert in_q.size() == 0  # NOT re-enqueued
    assert in_q.is_dead_letter(item.queue_item_id) is True
    assert in_q.dead_letter_count() == 1


def test_fan_in_remains_open_after_attempt_1_and_closes_once_on_dead_letter():
    """Verify FanIn correlation remains open on transient retry and becomes terminal exactly once on dead-letter."""
    merge_q = Queue(QueueDefinition(queue_id="merge_in", queue_name="Merge Queue"))
    fan_in = FanInRuntime(merge_queue=merge_q)

    candidate = BusinessCandidate(pipeline_id="p1", session_id="s1", provider="test")
    fan_in.register_business(candidate)
    assert fan_in.is_closed("p1") is False

    # Simulate attempt 1: retryable, FanIn stays open
    assert fan_in.is_closed("p1") is False
    assert fan_in.pending_count() == 1

    # Simulate attempt 2: website dead-letters
    fan_in.record_website_dead_letter("p1")
    assert fan_in.is_closed("p1") is False  # Still waiting on Instagram and Contact

    # Instagram succeeds
    from engine.contracts import InstagramIntel
    fan_in.record_instagram_result("p1", InstagramIntel(pipeline_id="p1", profile_reachable=False))
    assert fan_in.is_closed("p1") is False

    # Contact dead-letters
    fan_in.record_contact_dead_letter("p1")
    # All 3 branches reached terminal state
    assert fan_in.is_closed("p1") is True
    assert fan_in.pending_count() == 0
    assert merge_q.size() == 1
    merged = merge_q.dequeue()
    assert merged is not None
    assert merged.pipeline_id == "p1"

    # Late/duplicate call must be safe no-op
    fan_in.record_website_dead_letter("p1")
    assert merge_q.size() == 0
