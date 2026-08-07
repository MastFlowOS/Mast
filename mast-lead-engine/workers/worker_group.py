"""
MAST Engine V2 — Worker Group
================================

Source: Engine BluePrint, Phase 1.3 ("Worker Architecture", "Worker
Registry" — "WorkerDefinitions are shared. 100 WorkerInstances may
reference one WorkerDefinition."). Milestone 3E ("Worker Pool").

Responsibility
--------------
WorkerGroup manages every WorkerHandle registered against ONE
WorkerDefinition — e.g. "every Website Worker currently known to the
pool". It answers exactly two questions for that single worker type:

    - which of its workers are idle (available)?
    - which are busy (already handed out)?

and lets a caller move a WorkerHandle between those two sets
(acquire()/release()) or add/remove one from the group entirely
(add_worker()/remove_worker()).

WorkerGroup does not decide *when* to acquire a worker, does not know
what the worker will be used for, and does not know about sessions,
pipelines, queues, or businesses — it only tracks WorkerHandles
(workers/worker_handle.py), the same indirection layer WorkerRegistry
(workers/worker_registry.py) already stores. WorkerGroup never
constructs a BaseWorker and never calls a BaseWorker lifecycle method
(initialize(), reserve(), start(), ...) — exactly like WorkerRegistry,
it is a directory, not a controller. Acquiring a WorkerHandle from a
WorkerGroup says nothing about that worker's BaseWorker.worker_state;
keeping the two in sync (e.g. also calling BaseWorker.reserve() and
WorkerRegistry.update_state()) is a caller's job, not WorkerGroup's.

Selection policy
-----------------
acquire() returns the first idle WorkerHandle in FIFO order (the order
handles were added, less any already re-added after a release()) and
marks it busy. This is deterministic first-idle selection only — no
round robin, no priority, no weighting, no health-aware scheduling.
Those remain out of scope for this milestone (and likely belong to a
future allocation-policy layer above WorkerPool, not to WorkerGroup
itself).

Status
------
FOUNDATION ONLY (Milestone 3E). WorkerGroup manages availability
bookkeeping for one worker type. It does not schedule work, does not
execute work, does not retry work, and does not know about queues,
providers, businesses, sessions, or discovery — see workers/
worker_pool.py's module docstring for the pool-level equivalent of
this same boundary.

TODO(future milestones):
    - A future allocation-policy layer may read idle_count() /
      utilization() across many WorkerGroups (via WorkerPool) to
      decide how many workers of each type to keep running (Phase 1.3
      "Dynamic Worker Allocation") — no such decision is made here.
    - Phase 4 (Queue Framework): a caller acquiring a WorkerHandle here
      will pair that with a real queue reservation; WorkerGroup itself
      remains blind to queues.
"""

from __future__ import annotations

import threading
from typing import Dict, List, Optional

from workers.worker_definition import WorkerDefinition
from workers.worker_handle import WorkerHandle


class WorkerGroupError(RuntimeError):
    """
    Raised for illegal WorkerGroup operations: adding a worker_id that
    is already in this group, removing/acquiring/releasing a worker_id
    that isn't in this group, or removing a worker_id that is
    currently busy.

    This is availability bookkeeping validation only — it says
    nothing about BaseWorker lifecycle legality (that's
    BaseWorker.WorkerStateError, raised by base_worker.py; WorkerGroup
    never calls a lifecycle method that could raise it).
    """


class WorkerGroup:
    """
    Tracks WorkerHandles for every worker registered against one
    WorkerDefinition, split into an idle set and a busy set. Performs
    no scheduling, no queue interaction, and never invokes a
    BaseWorker lifecycle method — see the module docstring for exactly
    what is (and is not) in scope.

    All public methods are protected by a single `threading.RLock`
    (re-entrant, not an async primitive) so a group's idle/busy sets
    can be read and mutated safely from multiple threads at once.
    """

    def __init__(self, definition: WorkerDefinition) -> None:
        self._lock = threading.RLock()
        self._definition = definition
        # Both maps are keyed by worker_id. A given worker_id lives in
        # exactly one of the two maps at a time, never both — add_worker()
        # puts it in _idle; acquire() moves it to _busy; release() moves
        # it back. dict insertion order gives acquire() its deterministic
        # first-idle (FIFO) selection for free.
        self._idle: Dict[str, WorkerHandle] = {}
        self._busy: Dict[str, WorkerHandle] = {}

    @property
    def definition(self) -> WorkerDefinition:
        """The WorkerDefinition this group manages workers for."""
        return self._definition

    # -- membership ------------------------------------------------------

    def add_worker(self, handle: WorkerHandle) -> None:
        """
        Add a new WorkerHandle to this group, idle by default.

        Raises WorkerGroupError if handle.worker_id is already present
        in this group (idle or busy), or if the handle's attached
        instance's worker_type does not match this group's
        WorkerDefinition.worker_type (a basic consistency check, not a
        lifecycle check — mirrors WorkerRegistry.register_worker()'s
        own type check).
        """
        with self._lock:
            worker_id = handle.worker_id
            if worker_id in self._idle or worker_id in self._busy:
                raise WorkerGroupError(
                    f"worker {worker_id!r} is already in group "
                    f"{self._definition.definition_id!r}"
                )
            if (
                handle.instance is not None
                and handle.instance.worker_type != self._definition.worker_type
            ):
                raise WorkerGroupError(
                    f"worker {worker_id!r} has worker_type "
                    f"{handle.instance.worker_type!r}, which does not "
                    f"match group {self._definition.definition_id!r}'s "
                    f"worker_type {self._definition.worker_type!r}"
                )
            self._idle[worker_id] = handle

    def remove_worker(self, worker_id: str) -> None:
        """
        Remove worker_id from this group entirely.

        Raises WorkerGroupError if worker_id is not in this group, or
        if worker_id is currently busy — a busy WorkerHandle is held by
        whoever acquired it, so it must be released() back to idle
        before it can be removed.
        """
        with self._lock:
            if worker_id in self._busy:
                raise WorkerGroupError(
                    f"worker {worker_id!r} cannot be removed from group "
                    f"{self._definition.definition_id!r}: currently busy"
                )
            if worker_id not in self._idle:
                raise WorkerGroupError(
                    f"worker {worker_id!r} is not in group "
                    f"{self._definition.definition_id!r}"
                )
            del self._idle[worker_id]

    # -- acquisition -------------------------------------------------------

    def acquire(self) -> Optional[WorkerHandle]:
        """
        Return the first idle WorkerHandle (FIFO by add order) and
        mark it busy, or None if no idle worker is available.

        Deterministic first-idle selection only — see the module
        docstring. Does not call any BaseWorker lifecycle method; a
        caller that wants the underlying worker actually reserved
        still calls handle.instance.reserve() itself.
        """
        with self._lock:
            if not self._idle:
                return None
            worker_id, handle = next(iter(self._idle.items()))
            del self._idle[worker_id]
            self._busy[worker_id] = handle
            return handle

    def release(self, worker_id: str) -> None:
        """
        Return worker_id to the idle set. Nothing else — does not call
        any BaseWorker lifecycle method; a caller that already called
        handle.instance.release() separately still calls this to make
        the WorkerHandle available for a future acquire().

        Raises WorkerGroupError if worker_id is not currently busy in
        this group.
        """
        with self._lock:
            handle = self._busy.get(worker_id)
            if handle is None:
                raise WorkerGroupError(
                    f"worker {worker_id!r} is not a busy member of group "
                    f"{self._definition.definition_id!r}"
                )
            del self._busy[worker_id]
            self._idle[worker_id] = handle

    # -- counts ------------------------------------------------------------

    def idle_count(self) -> int:
        """Number of idle (available) workers in this group."""
        with self._lock:
            return len(self._idle)

    def busy_count(self) -> int:
        """Number of busy (already acquired) workers in this group."""
        with self._lock:
            return len(self._busy)

    def utilization(self) -> float:
        """
        Fraction of this group's workers currently busy, in [0.0, 1.0].
        0.0 if the group has no workers at all.
        """
        with self._lock:
            total = len(self._idle) + len(self._busy)
            if total == 0:
                return 0.0
            return len(self._busy) / total
