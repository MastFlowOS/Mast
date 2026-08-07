"""
MAST Engine V2 — Worker Registry
===================================

Source: Engine BluePrint, Phase 1.3 ("Distributed Worker Architecture"
— Worker Types, Worker Lifecycle, Dynamic Worker Allocation) and Phase
1.4 ("Heartbeat"). Milestone 3D ("Worker Registry"), as amended by an
Architecture Review correction (see "Architecture Review correction"
below) not yet reflected in the attached blueprint text itself, and
further extended by Milestone 4.4 ("Worker Heartbeats" — see
"Heartbeat tracking (Milestone 4.4)" below).

Responsibility
--------------
WorkerRegistry tracks which workers exist. For each registered
worker_id it keeps exactly two things, in two separate maps:

    worker_id -> WorkerRecord   (metadata: state, timestamps, ids)
    worker_id -> WorkerHandle   (indirection to the live instance)

and nothing else. It does not decide which worker should take the next
job, does not reserve anything, does not know what a queue is, and
does not read or write any business object (BusinessCandidate,
EnrichedBusiness, QueueItem, ...). Those are Phase 3's
workers/worker_pool.py (not yet created) and Phase 4's queue framework
(also not yet created) — this module is deliberately blind to both.

Architecture Review correction
-------------------------------
The registry originally stored BaseWorker objects directly:

    WorkerRegistry
        ├── WorkerRecord
        └── BaseWorker

This was corrected to store a WorkerHandle (workers/worker_handle.py)
instead, which itself points at the BaseWorker:

    WorkerRegistry
        ├── WorkerRecord
        └── WorkerHandle
                 │
                 ▼
            BaseWorker

get_worker() (returning a BaseWorker directly) was renamed to
get_worker_handle() (returning a WorkerHandle) to match. See
worker_handle.py's module docstring for why this indirection exists
and what it does/doesn't enable yet.

The correction also made explicit — though it was already true of the
code, just not stated this plainly — that the registry is completely
passive: it never calls a BaseWorker lifecycle method (initialize(),
reserve(), start(), complete(), fail(), release(), shutdown()) itself.
Every method below either only reads a worker's already-current state
(register_worker()) or only writes to WorkerRecord/stores a
WorkerHandle (everything else). A caller drives the real BaseWorker's
lifecycle directly and separately reports the resulting state to this
registry via update_state()/heartbeat() — the registry is a directory,
not a controller.

Why two maps instead of one
----------------------------
WorkerRecord (workers/worker_record.py) is plain metadata — safe to
list, filter, and hand back to a caller without exposing the worker
itself. WorkerHandle (workers/worker_handle.py) is an indirection to
the actual object with lifecycle methods (reserve(), start(),
complete(), ...) that mutate real state. Keeping them in separate maps
means listing/filtering workers (list_workers(), list_idle_workers(),
list_busy_workers()) never hands out a live BaseWorker by accident,
and nothing here is tempted to stash a BaseWorker (or a WorkerHandle)
inside a WorkerRecord for convenience — see worker_record.py's module
docstring for why that boundary matters.

What "idle" and "busy" mean here
----------------------------------
list_idle_workers() returns records whose worker_state is IDLE — the
only state from which BaseWorker.reserve() is legal (see
base_worker.py's _ALLOWED_TRANSITIONS), i.e. genuinely available for a
future worker_pool.py to hand work to.

list_busy_workers() returns records whose worker_state is RESERVED or
WORKING — a worker actively holding an assignment. CREATED,
INITIALIZING, COMPLETED, and FAILED are deliberately in neither list:
they are transitional/bookkeeping states (a worker sitting in
COMPLETED or FAILED is on its way back to IDLE via BaseWorker.release(),
not available for new work and not "busy" doing any); list_workers()
still returns them so nothing is hidden.

Heartbeat tracking (Milestone 4.4)
-------------------------------------
This registry owns exactly one HeartbeatIndex (workers/heartbeat.py)
— a private worker_id -> HeartbeatRecord map, mirroring the
Queue/ReservationIndex/LeaseIndex split already established in the
queue subsystem:

    WorkerRegistry
        ├── WorkerRecord
        └── HeartbeatIndex
                 └── worker_id -> HeartbeatRecord
                          └── (produced from a Heartbeat each call)

heartbeat(), last_heartbeat(), and is_alive() are this milestone's
entire public surface for liveness. All three do exactly what their
name says and nothing more:

    heartbeat(worker_id)       -- record one liveness signal
    last_heartbeat(worker_id)  -- when that worker last did
    is_alive(worker_id)        -- is that recent enough to count?

None of the three expire a Lease, retry a QueueItem, release a
Reservation, allocate a worker, execute a worker, or know what a
queue, provider, or session is — this module still imports nothing
from queues/, and workers/heartbeat.py imports nothing from queues/
either (see its own module docstring). The registry remains a
directory that records timestamps; it schedules nothing and monitors
nothing on its own — there is no background thread or async loop
anywhere in this milestone. See workers/heartbeat.py's module
docstring for the full liveness policy (including where the
heartbeat_timeout default lives) and thread-safety reasoning.

Status
------
FOUNDATION ONLY (Milestone 3D, extended 4.4). This registry only
tracks. It does not construct BaseWorker instances (a caller does that
and passes the already-constructed instance to register_worker()),
never calls any BaseWorker lifecycle method itself (see "Architecture
Review correction" above), and does not itself validate that a
worker_state transition reported via update_state() was legal — that
enforcement already lives in BaseWorker._ALLOWED_TRANSITIONS
(base_worker.py); duplicating it here would make this module a second
source of truth for lifecycle legality, which it deliberately is not.
Milestone 4.4 adds liveness tracking (heartbeat()/last_heartbeat()/
is_alive()) on the same terms: recording and answering only, no
policy decisions made on top.

TODO(future milestones):
    - Phase 3 (remaining): workers/worker_pool.py will read
      list_idle_workers() to decide allocation (Phase 1.3 "Dynamic
      Worker Allocation" — "First free worker takes next job") and
      call get_worker_handle() to reach the BaseWorker it picks. No
      such decision is made here, and this registry still never calls
      a lifecycle method on that BaseWorker on the pool's behalf — the
      pool would call it directly, exactly as this milestone's own
      validation does.
    - Phase 4 (Queue Framework): the reservation flow will call
      update_state() as a worker moves RESERVED -> WORKING ->
      COMPLETED/FAILED -> IDLE.
    - Recovery milestone: a future layer will combine this registry's
      is_alive() with Queue.expire_leases()-style lease expiry to
      decide what action to take on a stale reservation. Neither
      subsystem anticipates that shape yet — see workers/heartbeat.py's
      own TODO.
"""

from __future__ import annotations

import threading
from datetime import datetime, timezone
from typing import Dict, List, Optional

from engine.state import WorkerState
from workers.base_worker import BaseWorker
from workers.heartbeat import HeartbeatIndex
from workers.worker_definition import WorkerDefinition
from workers.worker_handle import WorkerHandle
from workers.worker_record import WorkerRecord

# Sentinel distinguishing "caller did not pass this argument" from
# "caller explicitly passed None to clear the field", used by
# update_state()'s session_id/pipeline_id keyword arguments below.
_UNSET = object()


class WorkerRegistryError(RuntimeError):
    """
    Raised for illegal registry operations: registering a worker_id
    that is already registered, or looking up / mutating a worker_id
    that isn't registered.

    This is registry-level bookkeeping validation only — it says
    nothing about whether a worker_state transition itself was legal
    (that's BaseWorker.WorkerStateError, raised by base_worker.py, and
    this registry never raises it, since it never calls a lifecycle
    method that could).
    """


class WorkerRegistry:
    """
    Tracks WorkerRecords (metadata) and WorkerHandles (indirection to
    live BaseWorker instances) for every registered worker, in two
    separate maps keyed by worker_id. Performs no scheduling,
    reservation, or queue interaction, and never invokes a BaseWorker
    lifecycle method — see the module docstring for exactly what is
    (and is not) in scope. It is a directory of workers, not a
    controller of them.

    All public methods are protected by a single `threading.RLock`
    (re-entrant, not an async primitive per this milestone's
    requirements) so registry state can be read and mutated safely
    from multiple worker threads at once. See the "Thread Safety"
    section of the Milestone 3D deliverable notes for the reasoning.
    """

    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._records: Dict[str, WorkerRecord] = {}
        self._handles: Dict[str, WorkerHandle] = {}
        # Private worker_id -> HeartbeatRecord index (Milestone 4.4).
        # Guarded by this same self._lock — HeartbeatIndex holds no
        # lock of its own; see workers/heartbeat.py's "Thread Safety"
        # section for why.
        self._heartbeats = HeartbeatIndex()

    # -- registration ----------------------------------------------------

    def register_worker(
        self, worker: BaseWorker, definition: WorkerDefinition
    ) -> WorkerRecord:
        """
        Register an already-constructed BaseWorker against a
        WorkerDefinition, creating its WorkerRecord and wrapping the
        worker in a new, attached WorkerHandle.

        Only ever reads worker.worker_id / worker.worker_type /
        worker.worker_state — never calls a lifecycle method on
        worker. Whatever state the worker happens to already be in is
        recorded as-is.

        Raises WorkerRegistryError if worker.worker_id is already
        registered, or if definition.worker_type does not match
        worker.worker_type (a basic consistency check, not a
        lifecycle check).
        """
        with self._lock:
            worker_id = worker.worker_id
            if worker_id in self._records:
                raise WorkerRegistryError(
                    f"worker {worker_id!r} is already registered"
                )
            if definition.worker_type != worker.worker_type:
                raise WorkerRegistryError(
                    f"worker {worker_id!r} has worker_type "
                    f"{worker.worker_type!r}, which does not match "
                    f"definition {definition.definition_id!r}'s "
                    f"worker_type {definition.worker_type!r}"
                )

            now = self._now()
            record = WorkerRecord(
                worker_id=worker_id,
                definition_id=definition.definition_id,
                worker_state=worker.worker_state,
                registered_at=now,
            )
            handle = WorkerHandle(
                worker_id=worker_id,
                instance=worker,
                attached=True,
                created_at=now,
            )
            self._records[worker_id] = record
            self._handles[worker_id] = handle
            return record

    def unregister_worker(self, worker_id: str) -> None:
        """
        Remove worker_id's WorkerRecord and WorkerHandle alike.

        Raises WorkerRegistryError if worker_id is not registered.
        Does not call BaseWorker.shutdown() or any other lifecycle
        method on the underlying instance first — deciding whether a
        worker is safe to remove is a caller/worker_pool.py concern,
        not this registry's; if that decision requires calling
        shutdown(), the caller does so itself, outside the registry,
        before or after this call.
        """
        with self._lock:
            if worker_id not in self._records:
                raise WorkerRegistryError(
                    f"worker {worker_id!r} is not registered"
                )
            del self._records[worker_id]
            del self._handles[worker_id]
            # Drop any HeartbeatRecord too, so an unregistered
            # worker_id doesn't leave stale liveness metadata behind
            # (Milestone 4.4). A no-op if it never heartbeat.
            self._heartbeats.discard(worker_id)

    # -- lookups -----------------------------------------------------------

    def get_worker_handle(self, worker_id: str) -> Optional[WorkerHandle]:
        """
        Return the registered WorkerHandle for worker_id, or None.

        Returns the indirection layer, not a BaseWorker directly — a
        caller that needs the live instance reads handle.instance
        itself (and checks handle.attached) rather than the registry
        handing one out unwrapped.
        """
        with self._lock:
            return self._handles.get(worker_id)

    def get_record(self, worker_id: str) -> Optional[WorkerRecord]:
        """Return the registered WorkerRecord for worker_id, or None."""
        with self._lock:
            return self._records.get(worker_id)

    def list_workers(self) -> List[WorkerRecord]:
        """
        Return every registered WorkerRecord, in no particular order.

        A shallow snapshot list — mutating the returned list does not
        affect the registry, but WorkerRecord itself is mutable, so
        callers should still go through heartbeat() / update_state()
        rather than mutating a returned record's fields directly,
        which would bypass this registry's lock.
        """
        with self._lock:
            return list(self._records.values())

    def list_idle_workers(self) -> List[WorkerRecord]:
        """
        Return every WorkerRecord whose worker_state is IDLE — the
        only state BaseWorker.reserve() may legally be called from.
        See the module docstring for why COMPLETED/FAILED are not
        included here.
        """
        with self._lock:
            return [
                record
                for record in self._records.values()
                if record.worker_state is WorkerState.IDLE
            ]

    def list_busy_workers(self) -> List[WorkerRecord]:
        """
        Return every WorkerRecord whose worker_state is RESERVED or
        WORKING — a worker actively holding an assignment. See the
        module docstring for why CREATED/INITIALIZING/COMPLETED/FAILED
        are not included here.
        """
        with self._lock:
            return [
                record
                for record in self._records.values()
                if record.worker_state
                in (WorkerState.RESERVED, WorkerState.WORKING)
            ]

    # -- record mutation -----------------------------------------------------

    def heartbeat(self, worker_id: str) -> None:
        """
        Record that worker_id sent a heartbeat: this both records a
        new Heartbeat in the HeartbeatIndex (updating that worker's
        HeartbeatRecord — last_heartbeat_at and heartbeat_count;
        Milestone 4.4) and updates WorkerRecord.last_heartbeat as the
        same convenience copy it has always been. Does not touch
        worker_state, current_session_id, or current_pipeline_id, and
        does not itself call BaseWorker.heartbeat() on the underlying
        instance — recording the fact here and driving the
        BaseWorker's own heartbeat() are two separate calls a caller
        makes; this registry does not sequence them or call either.

        This is a pure liveness signal. It does not expire a lease,
        retry a QueueItem, release a reservation, allocate a worker,
        or execute a worker — see workers/heartbeat.py's module
        docstring for the full list of what heartbeats deliberately do
        not do. Detecting a *missed* heartbeat (and reacting to it,
        e.g. by releasing a stale reservation) remains out of scope
        for this milestone — see the module TODO.

        Raises WorkerRegistryError if worker_id is not registered.
        """
        with self._lock:
            record = self._records.get(worker_id)
            if record is None:
                raise WorkerRegistryError(
                    f"worker {worker_id!r} is not registered"
                )
            heartbeat = self._heartbeats.record(worker_id)
            record.last_heartbeat = heartbeat.created_at

    def last_heartbeat(self, worker_id: str) -> Optional[datetime]:
        """
        Return when worker_id last heartbeat (per the HeartbeatIndex —
        Milestone 4.4), or None if worker_id has never heartbeat or is
        not registered at all. Never raises: an unknown worker_id is
        handled the same as one that simply hasn't heartbeat yet,
        since neither has a HeartbeatRecord to report.
        """
        with self._lock:
            return self._heartbeats.last_heartbeat_at(worker_id)

    def is_alive(
        self, worker_id: str, timeout_seconds: Optional[float] = None
    ) -> bool:
        """
        Whether worker_id is currently considered alive: it has a
        HeartbeatRecord, and the time since its last heartbeat is at
        most timeout_seconds (defaulting to
        heartbeat.DEFAULT_HEARTBEAT_TIMEOUT_SECONDS when not
        supplied — see workers/heartbeat.py for where that default
        lives and why it is not hardcoded here).

        Returns False — never raises — for a worker_id that is not
        registered or has never heartbeat. This method only answers
        the liveness question; it takes no action of any kind (no
        lease expiry, no reservation release, no retry) based on the
        answer — see workers/heartbeat.py's module docstring.
        """
        with self._lock:
            return self._heartbeats.is_alive(worker_id, timeout_seconds)

    def update_state(
        self,
        worker_id: str,
        worker_state: WorkerState,
        *,
        session_id: Optional[str] = _UNSET,  # type: ignore[assignment]
        pipeline_id: Optional[str] = _UNSET,  # type: ignore[assignment]
    ) -> None:
        """
        Update worker_id's WorkerRecord to reflect a worker_state a
        caller has already applied to the real BaseWorker (e.g. via
        BaseWorker.reserve()/start()/complete()/fail()/release(),
        called by the caller directly — never by this registry). This
        method only keeps the registry's own record in sync; it does
        not call any lifecycle method and does not validate that the
        transition was legal — that already happened (or should have)
        on the BaseWorker instance itself.

        session_id and pipeline_id are left unchanged unless
        explicitly passed (including explicitly passed as None, which
        clears the field) — so a caller updating WORKING after an
        earlier RESERVED does not need to repeat ids it already set.

        Raises WorkerRegistryError if worker_id is not registered.
        """
        with self._lock:
            record = self._records.get(worker_id)
            if record is None:
                raise WorkerRegistryError(
                    f"worker {worker_id!r} is not registered"
                )
            record.worker_state = worker_state
            if session_id is not _UNSET:
                record.current_session_id = session_id
            if pipeline_id is not _UNSET:
                record.current_pipeline_id = pipeline_id

    # -- internal ---------------------------------------------------------

    @staticmethod
    def _now() -> datetime:
        return datetime.now(timezone.utc)
