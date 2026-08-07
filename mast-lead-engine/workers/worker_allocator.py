"""
MAST Engine V2 — Worker Allocator
====================================

Source: Engine BluePrint, Phase 1.3 ("Worker Architecture", "Dynamic
Worker Allocation" — "First free worker takes next job"). Milestone 3F
("Worker Allocator").

Responsibility
--------------
WorkerAllocator is a thin policy layer in front of WorkerPool
(workers/worker_pool.py). It answers exactly one question, in one
verb:

    "Find an available worker and reserve it."

and its inverse:

    "Give this worker back."

Nothing else. It owns no worker, no WorkerGroup, no WorkerHandle — it
is a caller of WorkerPool, exactly the way WorkerPool is a caller of
WorkerGroup, which is in turn a caller of WorkerHandle:

    WorkerAllocator -> WorkerPool -> WorkerGroup -> WorkerHandle -> BaseWorker

WorkerAllocator adds exactly one thing WorkerPool does not already
have: a reservation_id, minted at allocation time, plus a small
worker_id -> (definition_id, reservation_id) map so release() can be
called with only a worker_id. It does not otherwise duplicate any
bookkeeping WorkerPool/WorkerGroup already do (idle/busy sets, FIFO
order, per-group counts) — allocate()/release()/available_workers()/
busy_workers() all delegate straight through to the WorkerPool passed
in at construction.

Worker Selection Policy
------------------------
allocate() delegates to WorkerPool.acquire(definition_id), which
delegates to WorkerGroup.acquire() — deterministic first-idle (FIFO)
selection, exactly as already implemented there. This milestone adds
no new selection logic on top: no round robin, no random choice, no
priority, no weighted balancing, no locality/affinity, no health-aware
scheduling. Those remain out of scope for a possible future
allocation-policy layer above this one.

What WorkerAllocator is NOT
-----------------------------
Like WorkerPool and WorkerGroup before it, WorkerAllocator never calls
a BaseWorker lifecycle method (initialize(), reserve(), start(),
complete(), fail(), release(), shutdown()). Acquiring a worker through
this allocator says nothing about that worker's own
BaseWorker.worker_state, and nothing here updates WorkerRegistry's
WorkerRecord for it — a caller that wants those updated still drives
BaseWorker directly and reports the result to WorkerRegistry, exactly
as it would without this allocator existing.

AllocationResult.reservation_id is this allocator's own bookkeeping
token only — it is never passed to, and has no relationship with,
BaseWorker.reserve()'s own reservation_id parameter, which today is
only ever supplied by a caller that already has one from Phase 4's
not-yet-built queue framework.

WorkerAllocator does not know — and imports nothing related to —
QueueItem, BusinessCandidate, EnrichedBusiness, QualifiedOpportunity,
DiscoverySession, SessionContext, or any Provider. It does not execute
a worker's process(), does not retry, does not monitor heartbeats, and
does not perform scheduling. It only acquires and releases.

Status
------
FOUNDATION ONLY (Milestone 3F). WorkerAllocator wraps one WorkerPool
instance, delegating acquisition/release to it and layering a
reservation_id on top. It does not construct workers, WorkerGroups,
WorkerDefinitions, or the WorkerPool itself — all of those are
supplied by a caller (e.g. an eventual RuntimeContext, per Phase 1.3's
ownership hierarchy: EngineCoordinator -> SessionContext ->
RuntimeContext -> WorkerRegistry / QueueManager / ...).

TODO(future milestones):
    - A future allocation-policy layer may sit above WorkerAllocator to
      decide *which* definition_id to allocate from for a given job
      type, or to react to can_allocate() returning False by scaling a
      WorkerGroup up (Phase 1.3 "Dynamic Worker Allocation") — no such
      decision is made here.
    - Phase 4 (Queue Framework): a caller pairing a successful
      AllocationResult with a real queue reservation will likely also
      call BaseWorker.reserve() (via WorkerHandle.instance) and
      WorkerRegistry.update_state() itself; WorkerAllocator remains
      blind to both.
"""

from __future__ import annotations

import threading
from datetime import datetime, timezone
from typing import Dict, Optional, Tuple
from uuid import uuid4

from workers.allocation_result import AllocationResult
from workers.worker_pool import WorkerPool, WorkerPoolError


class WorkerAllocatorError(RuntimeError):
    """
    Raised for illegal WorkerAllocator operations: releasing a
    worker_id that was not allocated through this allocator (never
    allocated, or already released).

    This is allocator-level bookkeeping validation only — it says
    nothing about WorkerPool/WorkerGroup legality (WorkerPoolError,
    WorkerGroupError, both of which may still propagate unchanged from
    release()) or BaseWorker lifecycle legality (WorkerStateError,
    which WorkerAllocator can never raise since it never calls a
    lifecycle method).
    """


class WorkerAllocator:
    """
    Thin policy layer that acquires and releases workers from one
    WorkerPool. See the module docstring for exactly what is (and is
    not) in scope.

    All public methods are protected by a single `threading.RLock`
    (re-entrant, not an async primitive), guarding only this
    allocator's own worker_id -> (definition_id, reservation_id) map.
    The underlying WorkerPool/WorkerGroup guard their own idle/busy
    sets with their own locks (see worker_pool.py, worker_group.py),
    so correctness does not depend on lock ordering between the two —
    this allocator's lock is held only around its own map plus the one
    pool call that must stay consistent with it.
    """

    def __init__(self, pool: WorkerPool) -> None:
        self._lock = threading.RLock()
        self._pool = pool
        # worker_id -> (definition_id, reservation_id), for every
        # worker currently allocated (and not yet released) through
        # this allocator. definition_id is kept so release() can be
        # called with just a worker_id, without the caller having to
        # remember which group it came from.
        self._allocations: Dict[str, Tuple[str, str]] = {}

    # -- allocation --------------------------------------------------------

    def allocate(self, definition_id: str) -> AllocationResult:
        """
        Acquire the first idle worker for definition_id from the
        underlying WorkerPool (deterministic first-idle / FIFO
        selection — see the module docstring) and return an
        AllocationResult describing the outcome.

        On success, mints a new reservation_id (this allocator's own
        bookkeeping token) and records worker_id -> (definition_id,
        reservation_id) so release() can later be called with just the
        worker_id.

        Never raises for "no worker available" or "unknown
        definition_id" — both come back as a failed AllocationResult
        (success=False, reason set) so a caller can check
        result.success without a try/except. Any other exception from
        the pool propagates unchanged.
        """
        with self._lock:
            try:
                handle = self._pool.acquire(definition_id)
            except WorkerPoolError as exc:
                return self._failure(str(exc))

            if handle is None:
                return self._failure(
                    f"no idle worker available for definition "
                    f"{definition_id!r}"
                )

            worker_type = (
                handle.instance.worker_type
                if handle.instance is not None
                else None
            )
            reservation_id = uuid4().hex
            self._allocations[handle.worker_id] = (definition_id, reservation_id)
            return AllocationResult(
                worker_id=handle.worker_id,
                worker_type=worker_type,
                reservation_id=reservation_id,
                allocated_at=self._now(),
                success=True,
                reason=None,
            )

    def release(self, worker_id: str) -> None:
        """
        Return worker_id to idle in the underlying WorkerPool and
        forget this allocator's own record of the allocation.

        Raises WorkerAllocatorError if worker_id is not currently
        allocated through this allocator. Propagates
        WorkerPoolError/WorkerGroupError unchanged if the pool itself
        rejects the release (e.g. the worker was removed from its
        group by another caller in the meantime).
        """
        with self._lock:
            allocation = self._allocations.get(worker_id)
            if allocation is None:
                raise WorkerAllocatorError(
                    f"worker {worker_id!r} is not currently allocated by "
                    "this allocator"
                )
            definition_id, _reservation_id = allocation
            self._pool.release(definition_id, worker_id)
            del self._allocations[worker_id]

    # -- queries -------------------------------------------------------------

    def can_allocate(self, definition_id: str) -> bool:
        """
        Whether allocate(definition_id) would currently succeed —
        i.e. whether the underlying WorkerPool reports at least one
        idle worker for that definition. Returns False (rather than
        raising) if definition_id is not registered with the pool.
        """
        with self._lock:
            try:
                return self._pool.idle_count(definition_id) > 0
            except WorkerPoolError:
                return False

    def available_workers(self, definition_id: Optional[str] = None) -> int:
        """
        Number of idle workers. If definition_id is given, counts only
        that definition's group; otherwise sums across every group
        registered with the underlying WorkerPool. Delegates directly
        to WorkerPool.idle_count() — see its docstring for exact
        semantics, including that it raises WorkerPoolError for an
        unregistered definition_id.
        """
        return self._pool.idle_count(definition_id)

    def busy_workers(self, definition_id: Optional[str] = None) -> int:
        """
        Number of busy workers. If definition_id is given, counts only
        that definition's group; otherwise sums across every group
        registered with the underlying WorkerPool. Delegates directly
        to WorkerPool.busy_count() — see its docstring for exact
        semantics, including that it raises WorkerPoolError for an
        unregistered definition_id.
        """
        return self._pool.busy_count(definition_id)

    # -- internal ---------------------------------------------------------

    def _failure(self, reason: str) -> AllocationResult:
        return AllocationResult(
            worker_id=None,
            worker_type=None,
            reservation_id=None,
            allocated_at=self._now(),
            success=False,
            reason=reason,
        )

    @staticmethod
    def _now() -> datetime:
        return datetime.now(timezone.utc)
