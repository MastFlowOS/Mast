"""
MAST Engine V2 — Queue Definition
====================================

Source: Engine BluePrint, Phase 1.4 ("Queue System, Concurrency &
Recovery" — "Each queue owns one responsibility"). Milestone 4.1
("Queue Manager"), revised Milestone 4.5 ("Retry Policy") to give
retry_policy its concrete type.

Responsibility
--------------
QueueDefinition is the immutable configuration for one Queue (queues/
queue.py) — e.g. "the Website Queue" or "the Storage Queue". It
carries identity and configuration only, exactly mirroring the role
WorkerDefinition (workers/worker_definition.py) plays for a
WorkerGroup: a frozen description of *what* a queue is, never *what
is currently in it* (that is QueueRecord's job — see queue_record.py)
and never the work items themselves (that is QueueItem's job — see
queue_item.py).

Fields
------
    queue_id         -- stable identifier for this queue, used as the
                         key QueueManager registers it under.
    queue_name        -- human-readable label (e.g. "Website Queue").
    stage             -- the pipeline stage this queue feeds, per
                          Phase 1.4's "Queue Isolation" (Discovery
                          Queue -> Enrichment Queue -> Qualification
                          Queue -> Storage Queue). A free-form string,
                          not engine.state.PipelineStage, because
                          Phase 1.4's per-queue stage names (Website,
                          Instagram, Contact, Qualification, Storage)
                          do not line up one-to-one with
                          PipelineStage's four in-flight values
                          (DISCOVERED/ENRICHING/QUALIFIED/STORED) —
                          inventing that mapping now would be an
                          architectural decision this milestone is not
                          scoped to make. Optional, exactly like
                          QueueItem.stage in engine/contracts.py.
    retry_policy      -- (Milestone 4.5) an optional RetryPolicy
                          (retry_policy.py) describing how many
                          attempts a QueueItem in this queue may
                          accumulate before Queue.can_retry() reports
                          it ineligible, per Phase 1.4's "Retry
                          Philosophy" ("Retries belong to QueueItems...
                          Queue reassigns later"). None means this
                          queue has no retry policy configured at all
                          — Queue.can_retry() treats that as "no
                          retries are permitted" (see queue.py),
                          exactly as a queue with no ttl_seconds ever
                          supplied to reserve() simply never produces
                          a Lease. Prior to this milestone this field
                          was an unshaped opaque placeholder (Any);
                          Milestone 4.5 gives it its first concrete
                          type without changing its optionality or
                          default.
    priority_policy   -- opaque configuration placeholder, same status
                          as retry_policy above. This milestone's Queue
                          is strictly FIFO ("No priorities" in scope);
                          nothing in queue.py reads or enforces this
                          field yet.

Status
------
FOUNDATION ONLY (Milestone 4.1). A plain, frozen data contract with no
behavior beyond the __post_init__ validation below (mirrors
AllocationResult's and WorkerDefinition's own __post_init__
validation pattern). It does not decide what a queue does — queue.py
does that; this module only describes one.

TODO(future milestones):
    - Milestone 4.5 gives retry_policy its concrete RetryPolicy shape
      and Queue.can_retry() / record_attempt() / attempt_count() read
      it for eligibility bookkeeping — but no milestone yet schedules
      *when* a retry runs, executes one, or moves a permanently
      ineligible QueueItem to a Dead Letter Queue (see
      retry_policy.py's Status section for the full list of what
      remains unbuilt).
    - priority_policy remains an unshaped opaque placeholder;
      a future Queue Framework milestone will define its concrete
      shape (and read/enforce it from Queue) the same way this
      milestone did for retry_policy — see queues/README.md.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Optional

from queues.retry_policy import RetryPolicy


@dataclass(frozen=True, slots=True)
class QueueDefinition:
    """
    Immutable configuration for one Queue. Carries no runtime state —
    see QueueRecord (queue_record.py) for pending/processing/
    completed/failed counters, and Queue (queue.py) for the actual
    FIFO storage of QueueItems.

    Attributes
    ----------
    queue_id:
        Stable identifier for this queue (the key QueueManager
        registers it under).
    queue_name:
        Human-readable label.
    stage:
        The pipeline stage this queue feeds. Optional, free-form — see
        the module docstring for why this is not typed against
        engine.state.PipelineStage.
    retry_policy:
        (Milestone 4.5) an optional RetryPolicy read by
        Queue.can_retry() / record_attempt() for eligibility
        bookkeeping. None means no retries are permitted for this
        queue. See the module docstring.
    priority_policy:
        Opaque configuration, stored but not interpreted by this
        milestone's Queue. See the module docstring.
    """

    queue_id: str
    queue_name: str
    stage: Optional[str] = None
    retry_policy: Optional[RetryPolicy] = None
    priority_policy: Optional[Any] = None

    def __post_init__(self) -> None:
        if not self.queue_id:
            raise ValueError("QueueDefinition.queue_id must be a non-empty string")
        if not self.queue_name:
            raise ValueError("QueueDefinition.queue_name must be a non-empty string")
