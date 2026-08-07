"""
MAST Engine V2 — Queue Record
================================

Source: Engine BluePrint, Phase 1.4 ("Queue System, Concurrency &
Recovery"). Milestone 4.1 ("Queue Manager").

Responsibility
--------------
QueueRecord is the mutable runtime metadata for one Queue (queues/
queue.py) — counters only, never the QueueItems themselves and never
the payload they carry. It exists so a caller (or, later, a
monitoring/allocation-policy layer — see the worker-side TODOs in
workers/worker_pool.py and workers/worker_group.py for the precedent)
can read "how big is this queue, and how is work moving through it?"
without walking the queue's actual FIFO storage.

This mirrors the split WorkerGroup/WorkerPool already establish on the
worker side: a definition (queue_definition.py) is configuration;
a record (this module) is live counters; neither one is the
collection of items/handles itself.

Fields
------
    queue_id           -- which queue this record describes (matches
                           the owning Queue's QueueDefinition.queue_id).
    created_at          -- when the owning Queue was created.
    pending_count       -- items currently waiting in the queue (FIFO
                           storage, not yet dequeued). Driven by
                           Queue.enqueue()/dequeue() this milestone.
    processing_count    -- items currently reserved/being worked on.
                           Always 0 this milestone — see Status below.
    completed_count     -- items that finished successfully. Always 0
                           this milestone — see Status below.
    failed_count        -- items that failed permanently. Driven by
                           Queue.dead_letter() as of Milestone 4.6 —
                           see Status below.

Consumers
---------
(Milestone 4.7) QueueMetrics (queue_metrics.py) reads pending_count,
completed_count, and failed_count from this record — via
Queue.metrics() / Queue.processed_count() (queue.py) — to populate a
point-in-time snapshot. QueueMetrics never mutates this record, never
caches its own copy of these counters, and does not become a second
source of truth for them: this QueueRecord remains exactly as
authoritative after Milestone 4.7 as it was before it. See
queue_metrics.py's "Explicitly not a second source of truth" section.

Status
------
FOUNDATION + DEAD LETTER COUNTING (Milestone 4.6). This milestone's
Queue (queue.py) implements enqueue()/dequeue()/peek()/size()/
is_empty() (Milestone 4.1), reservation claim/release and lease
expiration (Milestones 4.2-4.3), retry-eligibility bookkeeping
(Milestone 4.5), and now permanent-failure bookkeeping (Milestone
4.6). Queue keeps pending_count in sync with its own FIFO storage on
every enqueue()/dequeue() call, and now keeps failed_count in sync
with its own dead-letter index on every successful dead_letter()
call. processing_count and completed_count remain declared here (per
this milestone's explicit field list) but nothing in the current
codebase increments them yet, because the concepts they represent
(reservation-driven processing state and successful-completion ACK)
do not exist yet — only the permanent-failure half of this record's
TODO has been built.

TODO(future milestones):
    - Phase 4.2+ (Queue Framework: reservation.py, heartbeat.py):
      reserving a QueueItem will move it from pending_count to
      processing_count; a successful ACK will move it to
      completed_count. None of that transition logic lives here —
      QueueRecord is counters only, exactly like WorkerRecord
      (workers/worker_registry.py) is a flat directory entry and not a
      state machine. (failed_count's transition, driven by
      Queue.dead_letter() — see dead_letter.py and queue.py's "Dead
      Letter Bookkeeping" section — is no longer a TODO as of
      Milestone 4.6.)
    - The "later, a monitoring/allocation-policy layer" this module's
      Responsibility section anticipated is, as of Milestone 4.7,
      partially built: QueueMetrics (queue_metrics.py) is a read-only
      consumer of pending_count/completed_count/failed_count via
      Queue.metrics(). It is not a policy or allocation layer itself
      — it only snapshots numbers; deciding anything from them
      remains unbuilt.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime


@dataclass(slots=True)
class QueueRecord:
    """
    Mutable runtime counters for one Queue. No QueueItems, no
    payloads — see the module docstring for exactly what is (and is
    not) tracked here, and by whom.

    Deliberately NOT frozen (unlike QueueDefinition and QueueItem):
    Queue owns one QueueRecord per queue and mutates its counters
    in place, under its own lock, on every enqueue()/dequeue() call,
    and (as of Milestone 4.6) increments failed_count on every
    successful dead_letter() call — see queue.py.
    """

    queue_id: str
    created_at: datetime
    pending_count: int = 0
    processing_count: int = 0
    completed_count: int = 0
    failed_count: int = 0
