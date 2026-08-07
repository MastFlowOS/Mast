"""
MAST Engine V2 — Queue Manager
=================================

Source: Engine BluePrint, Phase 1.4 ("Queue System, Concurrency &
Recovery"), Phase 1.5 ("V2 Folder Structure" — queue/manager.py).
Milestone 4.1 ("Queue Manager").

Responsibility
--------------
QueueManager owns a collection of Queues (queues/queue.py) — one per
QueueDefinition (queues/queue_definition.py) — and delegates every
queue operation to the correct one. It answers one question, at the
level of the whole engine instead of one queue:

    Which queue is which, and where do I find it?

QueueManager owns work only in the sense that it owns the Queues that
own QueueItems — it never touches a QueueItem directly, and it never
peeks inside a Queue's FIFO storage. The ownership chain is:

    QueueManager
        └── Queue   (one per QueueDefinition)
                 └── QueueItem

This is a deliberate mirror of the worker-side hierarchy already
established in workers/worker_pool.py and workers/worker_group.py:

    WorkerPool  -> WorkerGroup -> WorkerHandle -> BaseWorker
    QueueManager -> Queue      -> QueueItem

WorkerPool owns WorkerGroups and delegates add/remove/acquire/release
to the correct one; QueueManager owns Queues and delegates
create/delete/get/list to the correct one. Same shape, same reason: an
indirection layer (Queue / WorkerGroup) already exists and nothing
above it needs to duplicate what it wraps.

What QueueManager is NOT
---------------------------
QueueManager implements no scheduling, allocation, or execution
policy. It does not decide *what* goes in a queue, does not execute a
QueueItem's payload, and does not retry a failed item — those remain
Queue's (or a future milestone's) job, not this one's.

QueueManager does not know Workers, WorkerPool, WorkerGroup,
WorkerHandle, or WorkerAllocator. It does not import anything from
workers/, does not know Providers, and does not know Sessions. This is
intentional and load-bearing: Phase 1.4's "Core Philosophy" is
"Queues own work. Workers consume work. Workers never own work." — for
that separation to be real, the object that owns queues cannot also
know about the workers that will eventually consume from them. A
future milestone (the eventual WorkerAllocator-and-Queue pairing noted
in workers/worker_allocator.py's own TODO) is what will introduce that
connection, from the *worker* side reading a queue, not from
QueueManager reaching into workers/.

Status
------
FOUNDATION ONLY (Milestone 4.1). QueueManager manages queue
registration and delegates FIFO operations to the correct Queue. It
does not schedule work, execute work, retry work, or know about
workers, providers, businesses, or sessions.

TODO(future milestones):
    - Phase 4.2+ (Queue Framework): reservation.py, heartbeat.py, and
      retry_policy.py will add reservation + ACK semantics, liveness
      tracking, and bounded retries on top of individual Queues —
      none of that logic will live in QueueManager itself, exactly as
      none of WorkerPool's future allocation-policy layer lives in
      WorkerPool itself (see its own module TODO).
    - A caller (eventually a RuntimeContext or EngineCoordinator, per
      Phase 1.3's ownership hierarchy) will hold both a QueueManager
      and a WorkerAllocator and be the one to connect them — e.g.
      "reserve a worker, then dequeue from that worker's queue" — a
      decision this milestone does not make and this module does not
      import anything to support.
"""

from __future__ import annotations

import threading
from typing import Dict, List, Optional

from queues.queue import Queue
from queues.queue_definition import QueueDefinition


class QueueManagerError(RuntimeError):
    """
    Raised for illegal QueueManager operations: registering a
    queue_id that is already registered, referencing a queue_id that
    is not registered (via delete_queue()), or deleting a queue that
    still has pending QueueItems.

    This is manager-level bookkeeping validation only — it says
    nothing about what a Queue itself does with its FIFO storage
    (Queue never raises this; see queue.py).
    """


class QueueManager:
    """
    Owns a collection of Queues, one per QueueDefinition, and
    delegates create/delete/get/list operations to the correct one.
    Performs no scheduling, no execution, and never references
    Workers, WorkerPool, WorkerGroup, WorkerHandle, WorkerAllocator,
    Providers, or Sessions — see the module docstring for exactly what
    is (and is not) in scope.

    All public methods are protected by a single `threading.RLock`
    (re-entrant, not an async primitive) guarding only this manager's
    own queue_id -> Queue map. Each Queue additionally guards its own
    FIFO storage and QueueRecord with its own lock (queue.py), so two
    callers operating on two different queues at once never contend on
    the same lock. QueueManager never holds its own lock while calling
    into a Queue — every delegated method below releases the manager
    lock (via _require_queue()) before it touches the Queue instance
    it looked up.
    """

    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._queues: Dict[str, Queue] = {}

    # -- queue registration ----------------------------------------------

    def create_queue(self, definition: QueueDefinition) -> Queue:
        """
        Create and register a new, empty Queue for `definition`, keyed
        by definition.queue_id.

        Raises QueueManagerError if definition.queue_id is already
        registered.
        """
        with self._lock:
            queue_id = definition.queue_id
            if queue_id in self._queues:
                raise QueueManagerError(
                    f"queue {queue_id!r} is already registered"
                )
            queue = Queue(definition)
            self._queues[queue_id] = queue
            return queue

    def delete_queue(self, queue_id: str) -> None:
        """
        Remove the Queue registered for queue_id.

        Raises QueueManagerError if queue_id is not registered, or if
        the queue still has pending QueueItems — exactly like
        WorkerPool.unregister_group() refusing to remove a group with
        busy workers, this prevents a queue's items from being
        silently dropped (Phase 1.4 AD-022: "every QueueItem reaches
        exactly one terminal state... nothing silently disappears").
        A caller must dequeue() (or otherwise drain) a queue fully
        before it can be deleted.
        """
        with self._lock:
            queue = self._queues.get(queue_id)
            if queue is None:
                raise QueueManagerError(
                    f"no queue is registered for {queue_id!r}"
                )
        # size() is checked outside the manager lock (see class
        # docstring: never hold the manager lock while operating on a
        # Queue) — the Queue's own lock protects the read.
        if not queue.is_empty():
            raise QueueManagerError(
                f"queue {queue_id!r} cannot be deleted: it still has "
                f"{queue.size()} pending item(s)"
            )
        with self._lock:
            # Re-check membership: another caller may have deleted it
            # between the lookup above and this point.
            if queue_id not in self._queues:
                raise QueueManagerError(
                    f"no queue is registered for {queue_id!r}"
                )
            del self._queues[queue_id]

    def get_queue(self, queue_id: str) -> Optional[Queue]:
        """Return the registered Queue for queue_id, or None."""
        with self._lock:
            return self._queues.get(queue_id)

    def list_queues(self) -> List[Queue]:
        """Return every registered Queue, in no particular order."""
        with self._lock:
            return list(self._queues.values())

    # -- internal ---------------------------------------------------------

    def _require_queue(self, queue_id: str) -> Queue:
        with self._lock:
            queue = self._queues.get(queue_id)
        if queue is None:
            raise QueueManagerError(
                f"no queue is registered for {queue_id!r}"
            )
        return queue
