"""
MAST Engine V2 — Engine Coordinator
======================================

Source: Engine BluePrint, Phase 1.3 ("Engine Philosophy" / "Engine
Overview").

Responsibility
--------------
"The Engine is NOT a worker. The Engine is NOT a queue. The Engine is
NOT a scraper. The Engine is simply an orchestrator."

This module implements exactly one slice of that orchestration: the
lifecycle of Discovery Sessions. It does NOT:

    - perform discovery
    - create workers
    - create queues
    - monitor queue/worker health
    - enrich businesses
    - store opportunities

Those remain future-milestone placeholders below (allocate_workers,
monitor_queues, resume_failed_work) — they still raise
NotImplementedError, because implementing them now would be exactly
the "Engine acts as a worker/queue" violation Phase 1.3 warns against.

Two classes
-----------
    SessionStateMachine — owns the DiscoverySession status transition
        table (Milestone 3A "One Architecture Improvement"). Given a
        session and a target status, it either returns a new
        DiscoverySession snapshot (per the Phase 1.2 Golden Rule —
        frozen dataclass, never mutated in place) or raises
        IllegalSessionTransitionError. This is deliberately its own
        class, not a set of private methods on EngineCoordinator, so
        that future statuses (PAUSED, RESUMING, EXHAUSTED,
        WAITING_FOR_PROVIDER, WAITING_FOR_WORKERS, ...) only ever
        require extending this one table — not touching
        EngineCoordinator's registry/logging responsibilities. Without
        this split, EngineCoordinator would slowly accumulate
        transition logic alongside registry logic and become another
        service.py.

    EngineCoordinator — owns the in-memory session registry
        (session_id -> SessionContext, Milestone 3B — see
        engine/session.py for why the registry holds SessionContext
        rather than DiscoverySession directly) and the public
        lifecycle surface (create/start/mark_running/finish/cancel/
        fail/get/list). Every status change is delegated to
        SessionStateMachine; this class never encodes "which
        transitions are legal" itself.

Session Lifecycle (Milestone 3B)
---------------------------------
    CREATED -> STARTING -> RUNNING -> COMPLETED
    RUNNING -> CANCELLED
    RUNNING -> FAILED

Milestone 3B change: `start_session` no longer silently chains
CREATED -> STARTING -> RUNNING in one call. STARTING is now a real,
independently observable state reached by `start_session()` alone;
moving on to RUNNING requires an explicit, separate `mark_running()`
call. The three-call shape is deliberate:

    create_session()  -> CREATED
    start_session()   -> STARTING
    mark_running()    -> RUNNING

This exists so that future work belonging to "starting" (allocating
workers, creating queues, loading checkpoints, provider
initialization — none of which are implemented here; see
allocate_workers/monitor_queues/resume_failed_work below) has a real
state to run inside of, between `start_session()` and
`mark_running()`, instead of that window being jumped over inside a
single opaque method.

Any transition not in SessionStateMachine._ALLOWED_TRANSITIONS raises
IllegalSessionTransitionError.

Thread Safety
-------------
The session registry is a plain dict guarded by a single
threading.RLock (`EngineCoordinator._lock`). Every registry read and
every registry write — including the read-transition-write sequence
inside `_transition` — happens while holding that lock, so concurrent
callers cannot observe or produce a torn/interleaved update. RLock
(not Lock) is used so that any coordinator method can safely call
another coordinator method that also acquires the lock, without
deadlocking against itself, without depending on every future method
staying single-hop. No third-party dependency is used — only
`threading` from the standard library.

Status
------
Milestone 3B session lifecycle (create/start/mark_running/finish/
cancel/fail/get/list) is unchanged. Milestone 6.4 ("EngineCoordinator
Integration", Runtime Integration sequence item 4) adds the
composition-root surface: build_runtime_context() constructs a
session's WorkerRegistry/WorkerPool/WorkerAllocator/QueueManager
(engine/runtime_context.py's four services), registers whatever
StageBlueprints/QueueDefinitions it is handed, attaches the result to
SessionContext.runtime, and constructs that session's EngineRuntime
(engine/runtime.py); start_discovery() is the high-level entry point
chaining start_session() -> build_runtime_context() -> mark_running().
Deciding the actual seven-stage pipeline shape (which StageBlueprints
to pass, how Merge's fan-in and the Storage backend are eventually
supplied) is explicitly left to the caller / a future milestone -- see
build_runtime_context()'s own docstring for the two concrete,
currently-open architecture gaps (no fan-in primitive; no
_StoragePersistenceProtocol implementation) that block a *complete*
blueprint today, without either gap being invented around here.
allocate_workers / monitor_queues / resume_failed_work remain
unimplemented placeholders -- this milestone does not touch them.

TODO(future milestones):
    - Phase 3 (Worker Framework): the Worker Manager responsibility
      (allocate/monitor workers) will be backed by
      workers/worker_pool.py, and will populate
      SessionContext.runtime (engine/session.py) — via the future
      RuntimeContext type, not a dedicated `workers` field on
      SessionContext itself (see Milestone 3B revision in
      engine/session.py) — most likely triggered during the STARTING
      state introduced by this milestone.
    - Phase 4 (Queue Framework): the Queue Manager responsibility
      (monitor queues, health) will be backed by queue/manager.py, and
      will likewise populate SessionContext.runtime — during STARTING.
    - Phase 5+ : service.py will eventually be switched to route
      discovery through this coordinator instead of its current inline
      orchestration (Phase 1.5 Migration Rule #1 — never replace
      something that hasn't already been rebuilt). service.py only
      instantiates a singleton; it does not route anything through it
      yet.
    - Additional SessionStatus values (PAUSED, RESUMING, EXHAUSTED,
      WAITING_FOR_PROVIDER, WAITING_FOR_WORKERS) will be added to
      SessionStateMachine._ALLOWED_TRANSITIONS as those phases land.
"""

from __future__ import annotations

import dataclasses
import threading
import uuid
from datetime import datetime, timezone
from typing import Any, Callable, Dict, List, Optional, Sequence, Tuple

from engine.fan_in_runtime import FanInRuntime
from engine.runtime import EngineRuntime
from engine.runtime_context import RuntimeContext
from engine.session import DiscoverySession, SessionContext
from engine.state import SessionStatus
from queues.queue_definition import QueueDefinition
from queues.queue_manager import QueueManager
from utils.runtime import get_logger
from workers.base_worker import BaseWorker
from workers.worker_allocator import WorkerAllocator
from workers.worker_definition import WorkerDefinition
from workers.worker_handle import WorkerHandle
from workers.worker_pool import WorkerPool
from workers.worker_registry import WorkerRegistry

log = get_logger("engine.coordinator")


def _utc_now_iso() -> str:
    """Timestamp helper for created_at/started_at/finished_at fields."""
    return datetime.now(timezone.utc).isoformat()


class IllegalSessionTransitionError(Exception):
    """
    Raised when a requested DiscoverySession status transition is not
    present in SessionStateMachine._ALLOWED_TRANSITIONS for the
    session's current status.
    """


class SessionNotFoundError(Exception):
    """
    Raised when EngineCoordinator is asked to operate on a session_id
    that is not (or no longer) present in its in-memory registry.
    """


class RuntimeAlreadyBuiltError(Exception):
    """
    Raised by build_runtime_context() if the target SessionContext
    already has a non-None `runtime` — RuntimeContext construction is
    a one-time event per session, mirroring SessionStateMachine's own
    "no transition backwards" stance. A caller that wants to rebuild a
    session's runtime graph must go through a not-yet-implemented
    resume/rebuild path (see resume_failed_work below), not call
    build_runtime_context() twice.
    """


class FanInRuntimeAlreadyBuiltError(Exception):
    """
    Raised by build_fan_in_runtime() if the target session already has
    a FanInRuntime registered — construction is a one-time event per
    session, mirroring RuntimeAlreadyBuiltError's identical stance for
    EngineRuntime/RuntimeContext above.
    """


@dataclasses.dataclass(frozen=True)
class StageBlueprint:
    """
    Everything build_runtime_context() needs to register one worker
    *type* (one WorkerDefinition, one WorkerGroup, N BaseWorker
    instances) with a session's WorkerRegistry/WorkerPool. This is
    plain composition data — it names a definition and a factory, it
    does not decide what the factory builds or how stages connect to
    one another. Deciding *that* (which provider a DiscoveryWorker
    gets, how Website/Instagram/Contact fan out and back into Merge,
    which persistence backend a StorageWorker gets) is a pipeline-shape
    decision this class deliberately carries no opinion about — see
    build_runtime_context()'s own docstring for why EngineCoordinator
    does not make that decision itself in this milestone.

    Attributes
    ----------
    definition:
        The WorkerDefinition this stage's workers are registered
        against (workers/worker_definition.py).
    worker_factory:
        A zero-argument callable returning one freshly constructed,
        not-yet-initialized BaseWorker of this definition's
        worker_type. Called once per `instance_count`. Supplying
        already-configured factories (e.g. `lambda: DiscoveryWorker(
        provider=GoogleMapsProvider(...))`) is how a caller injects
        provider/backend dependencies — EngineCoordinator never
        constructs a Provider, a persistence backend, or any other
        business-logic object itself; it only calls the factory it
        was handed.
    instance_count:
        How many BaseWorker instances of this definition to construct
        and register. Defaults to 1.
    """

    definition: WorkerDefinition
    worker_factory: Callable[[], BaseWorker]
    instance_count: int = 1

    def __post_init__(self) -> None:
        if self.instance_count < 1:
            raise ValueError("StageBlueprint.instance_count must be >= 1")


class SessionStateMachine:
    """
    Owns DiscoverySession status transition rules and snapshot
    construction. See module docstring for why this is split out from
    EngineCoordinator.

    Stateless: holds no session data of its own. Every call takes the
    current DiscoverySession and a target status and returns a brand
    new DiscoverySession (Phase 1.2 Golden Rule — never mutates the
    one it was given). It knows nothing about SessionContext or the
    registry; EngineCoordinator is the one that takes the returned
    snapshot and assigns it to a SessionContext.session.
    """

    _ALLOWED_TRANSITIONS: Dict[SessionStatus, tuple] = {
        SessionStatus.CREATED: (SessionStatus.STARTING,),
        SessionStatus.STARTING: (SessionStatus.RUNNING,),
        SessionStatus.RUNNING: (
            SessionStatus.COMPLETED,
            SessionStatus.CANCELLED,
            SessionStatus.FAILED,
        ),
        SessionStatus.COMPLETED: (),
        SessionStatus.CANCELLED: (),
        SessionStatus.FAILED: (),
    }

    def transition(self, session: DiscoverySession, target: SessionStatus) -> DiscoverySession:
        """
        Produce the next DiscoverySession snapshot for `target`, or
        raise IllegalSessionTransitionError if `target` is not legal
        from `session.status`.
        """
        allowed = self._ALLOWED_TRANSITIONS.get(session.status, ())
        if target not in allowed:
            allowed_names = [s.value for s in allowed] or ["<none — terminal state>"]
            raise IllegalSessionTransitionError(
                f"Illegal DiscoverySession transition for session_id="
                f"{session.id!r}: {session.status.value} -> {target.value}. "
                f"Allowed from {session.status.value}: {allowed_names}."
            )

        changes: Dict[str, Any] = {"status": target}
        if target is SessionStatus.RUNNING and session.started_at is None:
            changes["started_at"] = _utc_now_iso()
        if target in (SessionStatus.COMPLETED, SessionStatus.CANCELLED, SessionStatus.FAILED):
            changes["finished_at"] = _utc_now_iso()

        return dataclasses.replace(session, **changes)


class EngineCoordinator:
    """
    Orchestrator. Scope: Discovery Session lifecycle only — create,
    register, retrieve, start, mark running, finish, cancel, and track
    status of sessions. Delegates every status change to
    SessionStateMachine.

    The registry maps session_id -> SessionContext (Milestone 3B), not
    session_id -> DiscoverySession. SessionContext.session is the
    immutable DiscoverySession snapshot that SessionStateMachine
    produces; SessionContext.runtime (a forward-referenced
    RuntimeContext placeholder — see engine/session.py) is untouched
    by this class — defining and populating it is future-milestone
    work (see module docstring), not something EngineCoordinator does
    itself. This class does maintain SessionContext's own bookkeeping
    (created_at/last_updated/version) as sessions are created and
    transitioned; that's context metadata, not a runtime subsystem.

    Still does NOT (see module docstring): perform discovery, create
    workers, create queues, monitor queues/health, enrich businesses,
    or store opportunities.
    """

    #: Statuses that make a session no longer "active" for
    #: list_active_sessions().
    _TERMINAL_STATUSES = (
        SessionStatus.COMPLETED,
        SessionStatus.CANCELLED,
        SessionStatus.FAILED,
    )

    def __init__(self, state_machine: Optional[SessionStateMachine] = None) -> None:
        self._sessions: Dict[str, SessionContext] = {}
        self._lock = threading.RLock()
        self._state_machine = state_machine or SessionStateMachine()
        # session_id -> EngineRuntime. Kept here rather than on
        # SessionContext because EngineRuntime is not one of
        # RuntimeContext's four owned services (engine/runtime_context.py)
        # and SessionContext's own docstring limits it to exactly
        # `session` + `runtime` — EngineRuntime is the *active execution
        # layer over* a session's RuntimeContext, not a runtime service a
        # session owns, so it is tracked as coordinator-level bookkeeping,
        # the same way `_sessions` itself is.
        self._runtimes: Dict[str, EngineRuntime] = {}
        # session_id -> FanInRuntime. Kept here for the identical
        # reason self._runtimes is: FanInRuntime (engine/fan_in_runtime.py)
        # is not one of RuntimeContext's four owned services, so it is
        # coordinator-level bookkeeping, a sibling to self._runtimes,
        # never a RuntimeContext field. See fan_in_runtime.py's own
        # module docstring, architecture-review point 3.
        self._fan_in_runtimes: Dict[str, FanInRuntime] = {}
        # session_id -> list of prioritized-opportunity records
        # (opportunity, qualification, score, priority — all Engine 2.0
        # domain-layer objects; see engine/adapters.py). Coordinator-level
        # bookkeeping for the identical reason self._fan_in_runtimes is:
        # this is the accumulator the batch intelligence chain's
        # session-scoped Ranking step (Part 3) needs at session-completion
        # time, and there is no other existing place in the runtime that
        # collects a whole session's cohort together. The coordinator only
        # stores what execution_driver.py's pipeline composition hands it
        # via record_prioritized_opportunity() below — it does not compute
        # Prioritization itself, matching this module's own "the Engine
        # does not enrich businesses / store opportunities" boundary.
        self._batch_cohorts: Dict[str, List[Any]] = {}
        # session_id -> the batch intelligence chain's final output
        # (ranked opportunities / missions / workflow states), populated
        # by execution_driver.run_batch_intelligence() once a session
        # completes. Read-only bookkeeping for on-demand callers.
        self._batch_results: Dict[str, Dict[str, Any]] = {}

    # -- creation / registration -----------------------------------

    def create_session(
        self,
        *,
        user_id: str,
        provider: Optional[str] = None,
        niche: Optional[str] = None,
        country: Optional[str] = None,
        city: Optional[str] = None,
        category: Optional[str] = None,
        requested_count: int = 0,
        contact_requirements: tuple = (),
    ) -> SessionContext:
        """
        Create a new DiscoverySession (status CREATED), wrap it in a
        fresh SessionContext, register it, and return the context.
        Uses uuid.uuid4() for the session id — the blueprint does not
        specify an id format, so no format is invented beyond the
        standard library default.
        """
        session_id = str(uuid.uuid4())
        session = DiscoverySession(
            id=session_id,
            user_id=user_id,
            provider=provider,
            niche=niche,
            country=country,
            city=city,
            category=category,
            requested_count=requested_count,
            contact_requirements=tuple(contact_requirements),
            status=SessionStatus.CREATED,
            created_at=_utc_now_iso(),
        )
        now = _utc_now_iso()
        ctx = SessionContext(session=session, created_at=now, last_updated=now)
        with self._lock:
            self._sessions[session_id] = ctx
        log.info("Session created id=%s user_id=%s", session_id, user_id)
        return ctx

    # -- lifecycle transitions ---------------------------------------

    def start_session(self, session_id: str) -> SessionContext:
        """
        CREATED -> STARTING only. This is where future milestones will
        hook worker allocation, queue creation, checkpoint loading, and
        provider initialization (see module docstring) — none of that
        is implemented here; this call only marks the transition.
        """
        ctx = self._transition(session_id, SessionStatus.STARTING)
        log.info("Session starting id=%s", session_id)
        return ctx

    def mark_running(self, session_id: str) -> SessionContext:
        """
        STARTING -> RUNNING. Called once whatever work happens during
        STARTING (not implemented by this milestone) has finished.
        """
        ctx = self._transition(session_id, SessionStatus.RUNNING)
        log.info("Session running id=%s", session_id)
        return ctx

    # -- composition root ------------------------------------------------

    def build_runtime_context(
        self,
        session_id: str,
        *,
        stages: Sequence[StageBlueprint] = (),
        queue_definitions: Sequence[QueueDefinition] = (),
    ) -> RuntimeContext:
        """
        Assemble and attach this session's RuntimeContext: construct a
        WorkerRegistry, WorkerPool, WorkerAllocator, and QueueManager
        (engine/runtime_context.py's four sibling services), create
        every Queue in `queue_definitions`, register every worker
        group/instance described by `stages`, and attach the result to
        `ctx.runtime`. Also constructs this session's EngineRuntime
        (engine/runtime.py) over the freshly attached RuntimeContext
        and stores it for `get_engine_runtime()`.

        What this method does NOT do, and why
        --------------------------------------
        It does not decide which stages exist, in what order they run,
        how a stage's output queue feeds another stage's input queue,
        or how multiple upstream outputs (e.g. Website + Instagram +
        Contact intel, all needed by Merge) are correlated back into
        one payload before being enqueued. Every one of those is a
        pipeline-shape / business-logic decision -- exactly "implement
        pipeline algorithms" and "perform provider logic", both
        explicitly out of scope for this composition root -- so this
        method accepts `stages` and `queue_definitions` as
        already-decided data from its caller rather than hooking a
        real business pipeline together itself. Concretely, as of this
        milestone, two real gaps in the surrounding architecture (not
        invented or worked around here) mean no caller can yet supply
        a *complete* seven-stage blueprint:

          1. [Closed, Phase 6.5] A fan-in primitive now exists —
             engine/fan_in_runtime.py's FanInRuntime, built via
             build_fan_in_runtime() below — for correlating
             independent per-business outputs (Website, Instagram,
             Contact) back into one MergeInput by pipeline_id, per
             AD-042. StageConfig (engine/runtime.py) remains strictly
             one-queue-in/one-queue-out and is unmodified; the join
             lives entirely in FanInRuntime, a sibling subsystem, not
             a change to StageConfig's own shape.
          2. No concrete implementation of
             workers.storage_worker._StoragePersistenceProtocol exists
             anywhere in this codebase (confirmed by inspection).
             StorageWorker's own module docstring calls this "a real
             gap, flagged rather than silently worked around" and
             explicitly defers a real persistence abstraction to a
             future milestone; the Runtime Integration sequence's own
             ordering places "Storage backend" immediately *after*
             "EngineCoordinator integration" (this milestone),
             confirming the gap is expected to still be open here, not
             a surprise.

        A caller today can therefore supply StageBlueprints for
        Discovery, Website, Instagram, Contact, and Qualification (each
        genuinely one-in/one-out or a pure producer) but not yet a
        working Merge or Storage stage without one of those two gaps
        being closed by a dedicated future milestone. This method does
        not special-case, hide, or silently skip that limitation -- it
        simply builds exactly the WorkerDefinition/Queue graph it is
        handed, whatever subset that is.

        Raises
        ------
        SessionNotFoundError
            via `get_session` -- session_id is not registered.
        RuntimeAlreadyBuiltError
            if `ctx.runtime` is already set.
        Whatever WorkerPoolError / WorkerRegistryError / WorkerGroupError
        / QueueManagerError a duplicate definition_id / queue_id / worker_id
        raises -- propagated unchanged, not caught or wrapped here.
        """
        with self._lock:
            ctx = self._require_context(session_id)
            if ctx.runtime is not None:
                raise RuntimeAlreadyBuiltError(
                    f"session {session_id!r} already has a RuntimeContext; "
                    "build_runtime_context() may only be called once per "
                    "session."
                )

            registry = WorkerRegistry()
            pool = WorkerPool()
            allocator = WorkerAllocator(pool)
            queue_manager = QueueManager()

            for queue_definition in queue_definitions:
                queue_manager.create_queue(queue_definition)

            for stage in stages:
                pool.register_group(stage.definition)
                for _ in range(stage.instance_count):
                    worker = stage.worker_factory()
                    worker.initialize()
                    registry.register_worker(worker, stage.definition)
                    handle = WorkerHandle(
                        worker_id=worker.worker_id,
                        instance=worker,
                        attached=True,
                        created_at=datetime.now(timezone.utc),
                    )
                    pool.add_worker(stage.definition.definition_id, handle)

            runtime_context = RuntimeContext(
                worker_registry=registry,
                worker_pool=pool,
                worker_allocator=allocator,
                queue_manager=queue_manager,
            )
            ctx.runtime = runtime_context
            ctx.last_updated = _utc_now_iso()
            ctx.version += 1

            self._runtimes[session_id] = EngineRuntime(runtime_context, session_id)

            log.info(
                "RuntimeContext built id=%s stages=%d queues=%d",
                session_id, len(stages), len(queue_definitions),
            )
            return runtime_context

    def get_engine_runtime(self, session_id: str) -> EngineRuntime:
        """
        Return the EngineRuntime built for session_id by
        build_runtime_context(). Raises RuntimeError if
        build_runtime_context() has not been called yet for a
        registered session, distinct from SessionNotFoundError
        ("session not registered at all").
        """
        with self._lock:
            self._require_context(session_id)  # session must exist
            runtime = self._runtimes.get(session_id)
            if runtime is None:
                raise RuntimeError(
                    f"session {session_id!r} has no EngineRuntime yet; "
                    "call build_runtime_context() first."
                )
            return runtime

    def build_fan_in_runtime(
        self, session_id: str, *, merge_queue_id: str, merge_output_stage: str = "merge"
    ) -> FanInRuntime:
        """
        Construct and register this session's FanInRuntime
        (engine/fan_in_runtime.py), which enforces AD-042's Merge
        Completion Policy by correlating Website/Instagram/Contact
        results by pipeline_id and emitting exactly one MergeInput per
        pipeline_id into the Queue identified by `merge_queue_id`.

        Must be called after build_runtime_context() for this
        session_id — it resolves `merge_queue_id` via this session's
        already-built RuntimeContext.queue_manager, the same way
        EngineRuntime resolves queues, rather than constructing a
        Queue itself.

        Mirrors build_runtime_context()/get_engine_runtime()'s own
        shape exactly (see engine/fan_in_runtime.py's module
        docstring, architecture-review point 4) — purely additive; no
        existing method's behavior changes.

        Raises
        ------
        SessionNotFoundError
            via `get_session` -- session_id is not registered.
        RuntimeError
            if build_runtime_context() has not been called yet for
            this session_id (no RuntimeContext / QueueManager to
            resolve `merge_queue_id` against).
        FanInRuntimeAlreadyBuiltError
            if this session already has a FanInRuntime registered.
        FanInRuntimeError
            if `merge_queue_id` is not registered with this session's
            QueueManager.
        """
        with self._lock:
            ctx = self._require_context(session_id)
            if session_id in self._fan_in_runtimes:
                raise FanInRuntimeAlreadyBuiltError(
                    f"session {session_id!r} already has a FanInRuntime; "
                    "build_fan_in_runtime() may only be called once per "
                    "session."
                )
            if ctx.runtime is None:
                raise RuntimeError(
                    f"session {session_id!r} has no RuntimeContext yet; "
                    "call build_runtime_context() first."
                )
            merge_queue = ctx.runtime.queue_manager.get_queue(merge_queue_id)
            if merge_queue is None:
                raise FanInRuntimeError(
                    f"merge_queue_id {merge_queue_id!r} is not registered "
                    f"with session {session_id!r}'s QueueManager"
                )

            fan_in_runtime = FanInRuntime(
                merge_queue=merge_queue, merge_output_stage=merge_output_stage
            )
            self._fan_in_runtimes[session_id] = fan_in_runtime

            log.info(
                "FanInRuntime built id=%s merge_queue_id=%s",
                session_id, merge_queue_id,
            )
            return fan_in_runtime

    def get_fan_in_runtime(self, session_id: str) -> FanInRuntime:
        """
        Return the FanInRuntime built for session_id by
        build_fan_in_runtime(). Raises RuntimeError if
        build_fan_in_runtime() has not been called yet for a
        registered session, distinct from SessionNotFoundError
        ("session not registered at all") — mirrors
        get_engine_runtime()'s identical shape.
        """
        with self._lock:
            self._require_context(session_id)  # session must exist
            fan_in_runtime = self._fan_in_runtimes.get(session_id)
            if fan_in_runtime is None:
                raise RuntimeError(
                    f"session {session_id!r} has no FanInRuntime yet; "
                    "call build_fan_in_runtime() first."
                )
            return fan_in_runtime

    def record_prioritized_opportunity(self, session_id: str, record: Any) -> None:
        """
        Append one prioritized-opportunity record (produced by
        execution_driver.py's `_qualification_downstream`, the same
        composition point that already computes Scoring as a plain
        function call — see that function's own "Scoring" note) to
        this session's batch cohort. Pure bookkeeping, mirroring
        `_fan_in_runtimes`'s registration pattern; performs no
        evaluation of its own.
        """
        with self._lock:
            self._require_context(session_id)  # session must exist
            self._batch_cohorts.setdefault(session_id, []).append(record)

    def pop_batch_cohort(self, session_id: str) -> List[Any]:
        """
        Return and clear this session's accumulated batch cohort. Called
        exactly once per session, at session-completion time, by
        execution_driver.run_batch_intelligence() — draining rather than
        just reading so a session's cohort cannot be double-counted if
        ranking were ever invoked twice for the same session_id.
        """
        with self._lock:
            self._require_context(session_id)  # session must exist
            return self._batch_cohorts.pop(session_id, [])

    def set_batch_result(self, session_id: str, result: Dict[str, Any]) -> None:
        """
        Store the batch intelligence chain's final output (ranked
        opportunities / missions / workflow states) for later on-demand
        retrieval via get_batch_result(). Pure bookkeeping — the result
        itself is computed entirely by execution_driver.run_batch_intelligence(),
        never by the coordinator.
        """
        with self._lock:
            self._require_context(session_id)  # session must exist
            self._batch_results[session_id] = result

    def get_batch_result(self, session_id: str) -> Optional[Dict[str, Any]]:
        """
        Return the batch intelligence chain's stored output for
        session_id, or None if run_batch_intelligence() has not
        populated one yet (e.g. the session has not completed, or had
        an empty/fully-ineligible cohort).
        """
        with self._lock:
            self._require_context(session_id)  # session must exist
            return self._batch_results.get(session_id)

    def start_discovery(
        self,
        session_id: str,
        *,
        stages: Sequence[StageBlueprint] = (),
        queue_definitions: Sequence[QueueDefinition] = (),
    ) -> EngineRuntime:
        """
        High-level entry point composing the pieces above into the
        full STARTING sequence for one session: transition
        CREATED -> STARTING, assemble and attach this session's
        RuntimeContext (registering every worker/queue supplied),
        transition STARTING -> RUNNING, and return the resulting
        EngineRuntime.

        This is orchestration of *calls already defined elsewhere*
        (start_session / build_runtime_context / mark_running) -- it
        contains no transition-legality logic of its own (that stays
        SessionStateMachine's job) and no pipeline-shape logic of its
        own (that stays whatever assembled `stages` /
        `queue_definitions`, per build_runtime_context()'s own
        docstring). It does not execute a single stage cycle itself --
        driving `EngineRuntime.execute_stage()` in a loop remains
        unimplemented, exactly like allocate_workers/monitor_queues/
        resume_failed_work below.
        """
        self.start_session(session_id)
        self.build_runtime_context(
            session_id, stages=stages, queue_definitions=queue_definitions
        )
        self.mark_running(session_id)
        return self.get_engine_runtime(session_id)

    def finish_session(self, session_id: str) -> SessionContext:
        """RUNNING -> COMPLETED."""
        ctx = self._transition(session_id, SessionStatus.COMPLETED)
        log.info("Session completed id=%s", session_id)
        return ctx

    def cancel_session(self, session_id: str) -> SessionContext:
        """RUNNING -> CANCELLED."""
        ctx = self._transition(session_id, SessionStatus.CANCELLED)
        log.info("Session cancelled id=%s", session_id)
        return ctx

    def fail_session(self, session_id: str) -> SessionContext:
        """RUNNING -> FAILED."""
        ctx = self._transition(session_id, SessionStatus.FAILED)
        log.info("Session failed id=%s", session_id)
        return ctx

    def _transition(self, session_id: str, target: SessionStatus) -> SessionContext:
        with self._lock:
            ctx = self._require_context(session_id)
            ctx.session = self._state_machine.transition(ctx.session, target)
            ctx.last_updated = _utc_now_iso()
            ctx.version += 1
            return ctx

    def _require_context(self, session_id: str) -> SessionContext:
        """Caller must already hold self._lock."""
        ctx = self._sessions.get(session_id)
        if ctx is None:
            raise SessionNotFoundError(
                f"No SessionContext registered with id={session_id!r}."
            )
        return ctx

    # -- retrieval -----------------------------------------------------

    def get_session(self, session_id: str) -> SessionContext:
        with self._lock:
            return self._require_context(session_id)

    def list_active_sessions(self) -> List[SessionContext]:
        """Every registered SessionContext whose status is not terminal."""
        with self._lock:
            return [
                ctx for ctx in self._sessions.values()
                if ctx.session.status not in self._TERMINAL_STATUSES
            ]

    # -- future-milestone placeholders (unchanged in scope) ------------
    #
    # These remain intentionally unimplemented. Implementing them would
    # mean the Engine allocating workers or watching queues itself,
    # which Phase 1.3 explicitly forbids ("The Engine is NOT a worker.
    # The Engine is NOT a queue.").

    def allocate_workers(self, session: DiscoverySession) -> None:
        """
        TODO(Phase 3+): allocate discovery/enrichment/qualification/
        storage workers for a session (the "10 / 10 / 10 model" from
        Phase 1.3), populating the owning SessionContext.runtime (via
        the future RuntimeContext type — see engine/session.py). Not
        implemented — out of this milestone's scope.
        """
        raise NotImplementedError(
            "EngineCoordinator.allocate_workers is not implemented; "
            "implemented by a future migration phase."
        )

    def monitor_queues(self, session: DiscoverySession) -> None:
        """
        TODO(Phase 4+): monitor per-stage queue health (queue length,
        oldest item age, processing rate, worker utilization, failure
        rate) as described in Phase 1.3 "Health Monitoring". Not
        implemented — out of this milestone's scope.
        """
        raise NotImplementedError(
            "EngineCoordinator.monitor_queues is not implemented; "
            "implemented by a future migration phase."
        )

    def resume_failed_work(self, session: DiscoverySession) -> None:
        """
        TODO(Phase 4+): resume work after a worker crash or server
        restart, per Phase 1.4 "Session Resume" / "Worker Crash" (any
        PROCESSING item becomes WAITING again; no opportunity lost).
        Not implemented — out of this milestone's scope.
        """
        raise NotImplementedError(
            "EngineCoordinator.resume_failed_work is not implemented; "
            "implemented by a future migration phase."
        )
