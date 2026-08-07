"""
MAST Engine V2 — Base Worker
===============================

Source: Engine BluePrint, Phase 1.1 ("Worker" definition, Principle 6),
Phase 1.3 ("Distributed Worker Architecture" — Worker Types, Worker
Lifecycle, Timeout Rules, Failure Recovery), and Phase 1.4
("Heartbeat").

Responsibility
--------------
BaseWorker is the common abstraction every one of the seven Phase 1.3
worker types (Discovery, Website, Instagram, Contact, Merge,
Qualification, Storage) will eventually inherit from. It owns exactly
one thing: a worker's own lifecycle state, and the bookkeeping that
goes with it (identity, capabilities, timestamps, job counters, and
the current WorkerContext).

It does NOT own:
    - job execution — WorkerInterface.process() (engine/interfaces.py)
      stays abstract here; BaseWorker does not implement it, so
      BaseWorker cannot be instantiated on its own.
    - queues, reservations, or heartbeat timeouts — those belong to
      Phase 4 (queue/manager.py, reservation.py, heartbeat.py), none
      of which exist yet. BaseWorker.heartbeat() only records that a
      heartbeat happened; it does not send one anywhere, and nothing
      here detects a missed one.
    - worker allocation or pooling — Phase 3's workers/worker_pool.py
      (not yet created) will decide how many BaseWorker instances of
      each type exist and hand out reservations. BaseWorker only
      reacts to reserve()/release() calls; it never allocates itself.

Worker Lifecycle
-----------------
Phase 1.3 "Worker Lifecycle" describes five processing states:

    IDLE -> RESERVED -> WORKING -> COMPLETED -> IDLE
    WORKING -> FAILED -> IDLE

engine/state.py:WorkerState (Milestone 3C) adds two bookkeeping states
in front of that cycle so a freshly constructed worker has an explicit
path to its first IDLE:

    CREATED -> INITIALIZING -> IDLE

Full lifecycle as enforced by _ALLOWED_TRANSITIONS below::

    CREATED -> INITIALIZING -> IDLE -> RESERVED -> WORKING -> COMPLETED -> IDLE
                                                        \\-> FAILED ----> IDLE

Each BaseWorker method performs exactly the arrow(s) its name
describes (initialize() performs two — CREATED->INITIALIZING->IDLE —
since no separate method was requested to sit between them). No method
does anything else: no I/O, no queue calls, no business logic.

Status
------
FOUNDATION + LIFECYCLE (Milestone 3C). BaseWorker is a real, working
state machine: constructed through a concrete subclass that supplies
process()/timeout_seconds(), its lifecycle methods genuinely transition
worker_state and raise WorkerStateError on an illegal call order. What
it is NOT yet is *used* — nothing in the currently running V1 engine
constructs a BaseWorker, and no concrete subclass (WebsiteWorker, etc.)
exists yet to give it real work.

TODO(future milestones):
    - Phase 3 (later part): workers/worker_pool.py will construct
      BaseWorker subclasses and call reserve()/release() on them.
    - Phase 4 (Queue Framework): reserve()'s reservation_id and the
      cadence of heartbeat() calls will be driven by a real queue
      instead of being passed in / called directly by a caller.
    - Phase 6+: concrete worker subclasses (workers/website/, etc.)
      will implement process() and timeout_seconds() — the first code
      anywhere to actually do enrichment/qualification/storage work.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Dict, FrozenSet, Optional, Sequence, Tuple
from uuid import uuid4

from engine.interfaces import InputT, OutputT, WorkerInterface
from engine.state import WorkerState
from workers.worker_capability import WorkerCapability
from workers.worker_context import WorkerContext


class WorkerStateError(RuntimeError):
    """
    Raised when a BaseWorker lifecycle method is called out of order
    (e.g. start() before reserve(), or heartbeat() while IDLE).

    This is architecture-level validation only — enforcing Phase 1.3's
    "Worker Lifecycle" transition diagram. It is not a business-logic
    error and has nothing to do with a job succeeding or failing.
    """


class BaseWorker(WorkerInterface[InputT, OutputT]):
    """
    Common lifecycle/state abstraction for every Phase 1.3 worker type.

    Concrete subclasses (not part of this milestone) must still
    implement WorkerInterface.process() and
    WorkerInterface.timeout_seconds(); BaseWorker deliberately leaves
    both abstract so it can never be mistaken for a worker that does
    real work — see engine/interfaces.py for how the two relate.
    """

    #: Legal worker_state transitions. Keys are the current state;
    #: values are the states a single lifecycle method call may move
    #: to from there. See the module docstring for the full diagram.
    _ALLOWED_TRANSITIONS: Dict[WorkerState, FrozenSet[WorkerState]] = {
        WorkerState.CREATED: frozenset({WorkerState.INITIALIZING}),
        WorkerState.INITIALIZING: frozenset({WorkerState.IDLE}),
        WorkerState.IDLE: frozenset({WorkerState.RESERVED}),
        WorkerState.RESERVED: frozenset({WorkerState.WORKING}),
        WorkerState.WORKING: frozenset(
            {WorkerState.COMPLETED, WorkerState.FAILED}
        ),
        WorkerState.COMPLETED: frozenset({WorkerState.IDLE}),
        WorkerState.FAILED: frozenset({WorkerState.IDLE}),
    }

    def __init__(
        self,
        worker_type: str,
        capabilities: Optional[Sequence[WorkerCapability]] = None,
        worker_id: Optional[str] = None,
    ) -> None:
        if not worker_type:
            raise ValueError("BaseWorker.worker_type must be a non-empty string")

        self.worker_id: str = worker_id or f"{worker_type}-{uuid4().hex[:12]}"
        self.worker_type: str = worker_type
        self.worker_state: WorkerState = WorkerState.CREATED
        self.capabilities: Tuple[WorkerCapability, ...] = tuple(capabilities or ())

        self._context: Optional[WorkerContext] = None

        self.created_at: datetime = self._now()
        self.started_at: Optional[datetime] = None
        self.last_heartbeat: Optional[datetime] = None

        self.processed_jobs: int = 0
        self.failed_jobs: int = 0

        self._shutdown: bool = False

    # -- read-only convenience views ---------------------------------
    #
    # current_pipeline / current_session are derived from the single
    # WorkerContext this worker holds, rather than tracked as separate
    # mutable fields, so the two can never drift out of sync.

    @property
    def context(self) -> Optional[WorkerContext]:
        """The active WorkerContext, or None if not reserved."""
        return self._context

    @property
    def current_pipeline(self) -> Optional[str]:
        """The pipeline_id of the active WorkerContext, if any."""
        ctx = self._context
        return ctx.pipeline_id if ctx is not None else None

    @property
    def current_session(self) -> Optional[str]:
        """The session_id of the active WorkerContext, if any."""
        ctx = self._context
        return ctx.session_id if ctx is not None else None

    @property
    def is_shutdown(self) -> bool:
        """Whether shutdown() has been called on this worker."""
        return self._shutdown

    # -- lifecycle -----------------------------------------------------

    def initialize(self) -> None:
        """
        CREATED -> INITIALIZING -> IDLE.

        Makes a freshly constructed worker ready to be reserved. No
        separate method exists for the INITIALIZING step, so this
        performs both arrows in one call. Sets started_at — the worker
        instance's own start time, distinct from
        WorkerContext.started_at, which marks when a single job began.
        """
        self._transition(WorkerState.INITIALIZING)
        self._transition(WorkerState.IDLE)
        self.started_at = self._now()

    def reserve(
        self,
        *,
        session_id: str,
        pipeline_id: Optional[str] = None,
        reservation_id: Optional[str] = None,
    ) -> WorkerContext:
        """
        IDLE -> RESERVED.

        Records a new WorkerContext for this assignment. pipeline_id
        is optional: a Discovery Worker (Phase 1.3) is reserved for a
        discovery task, not an existing pipeline item, so it has none
        yet. reservation_id is optional until a real queue (Phase 4)
        issues one.
        """
        self._transition(WorkerState.RESERVED)
        self._context = WorkerContext(
            worker_id=self.worker_id,
            session_id=session_id,
            pipeline_id=pipeline_id,
            reservation_id=reservation_id,
            assigned_at=self._now(),
            started_at=None,
        )
        return self._context

    def start(self) -> None:
        """
        RESERVED -> WORKING.

        Requires an active WorkerContext (set by reserve()). Records
        the moment work began by replacing the context with a new one
        that has started_at set — per Phase 1.2 Rule #1, the existing
        context is never mutated in place.
        """
        ctx = self._context
        if ctx is None:
            raise WorkerStateError(
                f"worker {self.worker_id} cannot start(): no active "
                "WorkerContext (reserve() was never called)"
            )
        self._transition(WorkerState.WORKING)
        self._context = WorkerContext(
            worker_id=ctx.worker_id,
            session_id=ctx.session_id,
            pipeline_id=ctx.pipeline_id,
            reservation_id=ctx.reservation_id,
            assigned_at=ctx.assigned_at,
            started_at=self._now(),
        )

    def heartbeat(self) -> None:
        """
        Records a heartbeat while WORKING (Phase 1.4 "Every worker
        sends heartbeat every 2 seconds"). Not itself a worker_state
        transition — worker_state stays WORKING. This method only
        records that a heartbeat happened; sending it anywhere and
        detecting a missed one is Phase 4 (queue/heartbeat.py).
        """
        if self.worker_state is not WorkerState.WORKING:
            raise WorkerStateError(
                f"worker {self.worker_id} cannot heartbeat(): state is "
                f"{self.worker_state.value}, expected WORKING"
            )
        self.last_heartbeat = self._now()

    def complete(self) -> None:
        """
        WORKING -> COMPLETED.

        Records a successful job. Does not clear the WorkerContext —
        release() does that, once the caller is done inspecting the
        completed assignment.
        """
        self._transition(WorkerState.COMPLETED)
        self.processed_jobs += 1

    def fail(self) -> None:
        """
        WORKING -> FAILED.

        Records a failed job (Phase 1.3 "Timeout Rules" / "Failure
        Recovery"). Does not clear the WorkerContext — release() does.
        """
        self._transition(WorkerState.FAILED)
        self.failed_jobs += 1

    def release(self) -> None:
        """
        COMPLETED -> IDLE, or FAILED -> IDLE.

        Discards the WorkerContext and the last heartbeat, returning
        the worker to a stateless, reservable IDLE — Phase 1.3
        "Workers are stateless. All progress lives in queues."
        """
        self._transition(WorkerState.IDLE)
        self._context = None
        self.last_heartbeat = None

    def shutdown(self) -> None:
        """
        Retires this worker instance. Only legal while IDLE with no
        active WorkerContext — Phase 1.4 "User Cancels" describes a
        clean shutdown as one where in-flight work finishes first, so
        a worker holding a reservation is never shut down mid-job.

        This does not introduce a new worker_state: a shut-down worker
        stays formally IDLE, but is_shutdown becomes True and every
        other lifecycle method rejects further calls.
        """
        if self._shutdown:
            return
        if (
            self.worker_state is not WorkerState.IDLE
            or self._context is not None
        ):
            detail = (
                " with an active reservation"
                if self._context is not None
                else ""
            )
            raise WorkerStateError(
                f"worker {self.worker_id} cannot shutdown(): state is "
                f"{self.worker_state.value}{detail}"
            )
        self._shutdown = True

    # -- internal -------------------------------------------------------

    def _transition(self, new_state: WorkerState) -> None:
        """Apply new_state if legal from worker_state; else raise."""
        if self._shutdown:
            raise WorkerStateError(f"worker {self.worker_id} has been shut down")
        allowed = self._ALLOWED_TRANSITIONS.get(self.worker_state, frozenset())
        if new_state not in allowed:
            raise WorkerStateError(
                f"worker {self.worker_id} cannot transition "
                f"{self.worker_state.value} -> {new_state.value}"
            )
        self.worker_state = new_state

    @staticmethod
    def _now() -> datetime:
        return datetime.now(timezone.utc)
