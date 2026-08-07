"""
MAST Engine V2 — Worker Pool
==============================

Source: Engine BluePrint, Phase 1.3 ("Worker Architecture", "Worker
Registry", "Dynamic Worker Allocation"). Milestone 3E ("Worker Pool").

Responsibility
--------------
WorkerPool owns a collection of WorkerGroups (workers/worker_group.py)
— one per WorkerDefinition (workers/worker_definition.py) — and
delegates every worker-availability operation to the correct group.
It answers one question, at the level of the whole engine instead of
one worker type:

    Which workers, of which type, are currently available?

WorkerPool never owns a BaseWorker or a WorkerHandle directly. The
ownership chain is:

    WorkerPool
        └── WorkerGroup   (one per WorkerDefinition)
                 └── WorkerHandle
                          └── BaseWorker

exactly mirroring how WorkerRegistry (workers/worker_registry.py)
never owns a BaseWorker directly either, and for the same reason: an
indirection layer already exists (WorkerHandle) and nothing above it
needs to duplicate what it wraps.

What WorkerPool is NOT
------------------------
WorkerPool implements no scheduling, allocation, or execution policy.
It does not decide *how many* workers of a type should exist (that is
a future allocation-policy layer's job, reading idle_count()/
utilization() from this pool to make that decision — see the module
TODO). It does not know what a QueueItem, Provider, Business, Session,
or discovery task is, and it never calls a BaseWorker lifecycle method
— acquiring a WorkerHandle from this pool says nothing about that
worker's own BaseWorker.worker_state; a caller that wants the
underlying worker actually reserved still drives BaseWorker directly
and reports the result to WorkerRegistry, exactly as it would without
this pool existing at all.

Relationship to WorkerRegistry
--------------------------------
WorkerRegistry and WorkerPool are two independent views over the same
WorkerHandles, answering two different questions:

    WorkerRegistry -> "which workers exist, and what is their last
                        reported WorkerState?" (a flat directory)
    WorkerPool     -> "which workers, grouped by type, are idle right
                        now?" (a set of availability pools)

Neither owns the other, and this milestone does not merge them or make
one call the other — a future milestone may choose to keep a
WorkerPool and a WorkerRegistry in sync for the same fleet of workers,
but that synchronization is a caller's responsibility, not something
either object does automatically.

Status
------
FOUNDATION ONLY (Milestone 3E). WorkerPool manages worker-group
registration and delegates availability operations to the correct
WorkerGroup. It does not schedule work, execute work, retry work, or
know about queues, providers, businesses, sessions, or discovery.

TODO(future milestones):
    - A future allocation-policy layer (not yet scoped in Phase
      1.1-1.5) would read idle_count()/busy_count()/utilization()
      across groups to decide how many workers of each type to spin up
      or retire (Phase 1.3 "Dynamic Worker Allocation") — no such
      decision is made here.
    - Phase 4 (Queue Framework): a caller acquiring a WorkerHandle from
      this pool will pair that with a real queue reservation and a
      WorkerRegistry.update_state() call; WorkerPool itself remains
      blind to queues and to the registry.
"""

from __future__ import annotations

import threading
from typing import Dict, List, Optional

from workers.worker_definition import WorkerDefinition
from workers.worker_group import WorkerGroup, WorkerGroupError
from workers.worker_handle import WorkerHandle


class WorkerPoolError(RuntimeError):
    """
    Raised for illegal WorkerPool operations: registering a
    definition_id that is already registered, or referencing a
    definition_id that is not registered (via unregister_group(),
    add_worker(), remove_worker(), acquire(), release(), or
    get_group()).

    This is pool-level bookkeeping validation only. A WorkerGroupError
    raised by the delegated-to WorkerGroup (e.g. removing a busy
    worker) propagates unchanged — WorkerPool does not catch or wrap
    it.
    """


class WorkerPool:
    """
    Owns a collection of WorkerGroups, one per WorkerDefinition, and
    delegates every add/remove/acquire/release/count operation to the
    correct group. Performs no scheduling, no queue interaction, and
    never invokes a BaseWorker lifecycle method — see the module
    docstring for exactly what is (and is not) in scope.

    All public methods are protected by a single `threading.RLock`
    (re-entrant, not an async primitive) guarding the pool's own
    definition_id -> WorkerGroup map. Each WorkerGroup additionally
    guards its own idle/busy sets with its own lock (workers/
    worker_group.py), so two callers acquiring from two different
    groups at once never contend on the same lock.
    """

    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._groups: Dict[str, WorkerGroup] = {}

    # -- group registration --------------------------------------------------

    def register_group(self, definition: WorkerDefinition) -> WorkerGroup:
        """
        Create and register a new, empty WorkerGroup for `definition`,
        keyed by definition.definition_id.

        Raises WorkerPoolError if definition.definition_id is already
        registered.
        """
        with self._lock:
            definition_id = definition.definition_id
            if definition_id in self._groups:
                raise WorkerPoolError(
                    f"group for definition {definition_id!r} is already "
                    "registered"
                )
            group = WorkerGroup(definition)
            self._groups[definition_id] = group
            return group

    def unregister_group(self, definition_id: str) -> None:
        """
        Remove the WorkerGroup registered for definition_id.

        Raises WorkerPoolError if definition_id is not registered, or
        if the group still has any busy workers — exactly like
        WorkerGroup.remove_worker() refusing to remove a single busy
        worker, a group holding busy workers must have them released()
        first, so no in-flight WorkerHandle is silently dropped from
        the pool.
        """
        with self._lock:
            group = self._groups.get(definition_id)
            if group is None:
                raise WorkerPoolError(
                    f"no group is registered for definition {definition_id!r}"
                )
            if group.busy_count() > 0:
                raise WorkerPoolError(
                    f"group for definition {definition_id!r} cannot be "
                    "unregistered: it still has busy workers"
                )
            del self._groups[definition_id]

    def get_group(self, definition_id: str) -> Optional[WorkerGroup]:
        """Return the registered WorkerGroup for definition_id, or None."""
        with self._lock:
            return self._groups.get(definition_id)

    def list_groups(self) -> List[WorkerGroup]:
        """Return every registered WorkerGroup, in no particular order."""
        with self._lock:
            return list(self._groups.values())

    # -- delegated worker operations -----------------------------------------

    def add_worker(self, definition_id: str, handle: WorkerHandle) -> None:
        """
        Add `handle` (idle) to the WorkerGroup registered for
        definition_id.

        Raises WorkerPoolError if definition_id is not registered.
        Propagates WorkerGroupError unchanged if the group itself
        rejects the add (e.g. duplicate worker_id, worker_type
        mismatch).
        """
        group = self._require_group(definition_id)
        group.add_worker(handle)

    def remove_worker(self, definition_id: str, worker_id: str) -> None:
        """
        Remove worker_id from the WorkerGroup registered for
        definition_id.

        Raises WorkerPoolError if definition_id is not registered.
        Propagates WorkerGroupError unchanged if the group itself
        rejects the removal (not a member, or currently busy).
        """
        group = self._require_group(definition_id)
        group.remove_worker(worker_id)

    def acquire(self, definition_id: str) -> Optional[WorkerHandle]:
        """
        Acquire the first idle WorkerHandle from the WorkerGroup
        registered for definition_id, or None if that group has no
        idle worker available.

        Raises WorkerPoolError if definition_id is not registered.
        """
        group = self._require_group(definition_id)
        return group.acquire()

    def release(self, definition_id: str, worker_id: str) -> None:
        """
        Release worker_id back to idle in the WorkerGroup registered
        for definition_id.

        Raises WorkerPoolError if definition_id is not registered.
        Propagates WorkerGroupError unchanged if the group itself
        rejects the release (worker_id not currently busy there).
        """
        group = self._require_group(definition_id)
        group.release(worker_id)

    # -- counts ------------------------------------------------------------

    def idle_count(self, definition_id: Optional[str] = None) -> int:
        """
        Number of idle workers. If definition_id is given, counts only
        that group (raises WorkerPoolError if not registered);
        otherwise sums idle workers across every registered group.
        """
        if definition_id is not None:
            return self._require_group(definition_id).idle_count()
        with self._lock:
            groups = list(self._groups.values())
        return sum(group.idle_count() for group in groups)

    def busy_count(self, definition_id: Optional[str] = None) -> int:
        """
        Number of busy workers. If definition_id is given, counts only
        that group (raises WorkerPoolError if not registered);
        otherwise sums busy workers across every registered group.
        """
        if definition_id is not None:
            return self._require_group(definition_id).busy_count()
        with self._lock:
            groups = list(self._groups.values())
        return sum(group.busy_count() for group in groups)

    def utilization(self, definition_id: Optional[str] = None) -> float:
        """
        Fraction of workers currently busy, in [0.0, 1.0]. If
        definition_id is given, this is that group's own utilization
        (raises WorkerPoolError if not registered); otherwise it is
        computed across every registered group's combined idle+busy
        counts. 0.0 if the relevant worker count is zero.
        """
        if definition_id is not None:
            return self._require_group(definition_id).utilization()
        with self._lock:
            groups = list(self._groups.values())
        total_idle = sum(group.idle_count() for group in groups)
        total_busy = sum(group.busy_count() for group in groups)
        total = total_idle + total_busy
        if total == 0:
            return 0.0
        return total_busy / total

    # -- internal ---------------------------------------------------------

    def _require_group(self, definition_id: str) -> WorkerGroup:
        with self._lock:
            group = self._groups.get(definition_id)
        if group is None:
            raise WorkerPoolError(
                f"no group is registered for definition {definition_id!r}"
            )
        return group
