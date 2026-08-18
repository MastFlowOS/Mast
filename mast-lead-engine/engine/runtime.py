"""
MAST Engine V2 — Engine Runtime
==================================

Source: Engine BluePrint, Phase 1.3 ("Engine is an orchestrator...
coordinating independent subsystems"), Phase 1.4 ("Queue System,
Concurrency & Recovery" — Reservation Model, Retry Philosophy, Dead
Letter), Phase 6.3 implementation prompt ("Engine Runtime is the
active execution layer. It executes pipeline stages. It does NOT own
runtime state. RuntimeContext owns runtime state. Engine Runtime uses
RuntimeContext."). Runtime Integration sequence, item 3 (MergeWorker
[done] -> RuntimeContext [done] -> Engine Runtime [this file] ->
EngineCoordinator integration -> Storage backend -> service.py
cutover).

Responsibility
--------------
Engine Runtime drives exactly one pipeline stage through exactly one
execution cycle at a time:

    Queue.dequeue() -> WorkerAllocator.allocate() -> worker.reserve()
    -> worker.start() -> worker.process() -> worker.complete() ->
    Queue.enqueue() -> WorkerAllocator.release()

or, on failure:

    worker.fail() -> Queue.can_retry() -> Queue.record_attempt() OR
    Queue.dead_letter() -> WorkerAllocator.release()

It composes calls onto RuntimeContext's four services
(engine/runtime_context.py: worker_registry, worker_pool,
worker_allocator, queue_manager) plus whatever BaseWorker instance
WorkerRegistry.get_worker_handle() resolves to. It does not construct
any of those services, does not construct a RuntimeContext /
SessionContext / EngineCoordinator, does not perform provider,
worker, qualification, or storage *logic* itself, and does not invent
retry, dead-letter, queue, or worker-lifecycle behavior beyond calling
the public APIs those already implement.

Why one generic implementation, not six
------------------------------------------
Phase 5's seven worker types split into two shapes, not seven:

    Transformer (Website, Instagram, Contact, Merge, Qualification,
    Storage) — one already-real input object in, one already-computed
    output object out. `process()` calling it is itself the unit of
    work; QueueItem.payload is that input verbatim (see
    workers/merge_worker.py — MergeInput is still just "the payload"
    from whichever caller assembled and enqueued it upstream, not a
    concern of this file's).

    Producer (Discovery only, per workers/discovery_worker.py's own
    "Ownership of on_candidate" section, which names this exact module
    as the caller responsible for building the on_candidate closure)
    — no per-item payload to dequeue; `process()` drives a provider to
    exhaustion and streams results out through a push-style callback
    instead of a single return value.

`StageConfig` below is the "configuration or callbacks" the Phase 6.3
prompt asks for: it lets `execute_stage()` stay one method, used for
every stage, by making the two shape-specific decisions — "where does
this stage's worker input come from" and "what happens to this
stage's worker output" — into fields a caller supplies once per stage,
not a second execution loop.

What this module resolves through RuntimeContext, every call
------------------------------------------------------------
`StageConfig` carries `queue_id` strings, not `Queue` objects, and
`execute_stage()` re-resolves each one via
`RuntimeContext.queue_manager.get_queue()` on every call, rather than
caching a `Queue` reference on the `StageConfig` itself. This mirrors
QueueManager's and WorkerRegistry's own "never merged, never cached
outside their owner" stance (see queue_manager.py, worker_pool.py) —
Engine Runtime holds no state of its own about which Queues or Workers
exist; RuntimeContext is the only source of truth for that, consulted
fresh each cycle.

What Engine Runtime deliberately does NOT do
---------------------------------------------
    - Does not call `Queue.reserve()` / `Queue.release()` (the
      QueueItem-level Reservation/Lease system, Milestones 4.2/4.3).
      The Phase 6.3 success/failure diagrams consume a QueueItem with
      a single `dequeue()` (full FIFO pop) and never mention
      `reserve()`/`release()`/lease semantics; wiring the Reservation
      system into stage execution is not this milestone's diagram and
      is left to whichever future milestone actually needs
      peek-without-consuming semantics.
    - Does not pass `AllocationResult.reservation_id` into
      `BaseWorker.reserve()`'s own `reservation_id` parameter — the
      two are explicitly documented as unrelated
      (workers/worker_allocator.py: "it is never passed to, and has no
      relationship with, BaseWorker.reserve()'s own reservation_id
      parameter"). `worker.reserve()` is called here with no
      `reservation_id`, exactly as its own default allows.
    - Does not re-enqueue a QueueItem after `Queue.record_attempt()`.
      `record_attempt()` is documented as bookkeeping only ("does not
      enqueue, dequeue, sleep, delay, or execute a retry") — a future
      retry-*execution* milestone owns turning that bookkeeping into
      requeued work; inventing that here would be exactly the
      "invent retry behaviour" this milestone is told not to do.
    - Does not enqueue anything for a stage whose `build_downstream`
      returns `None` (the Discovery stage always does — see
      `StageConfig.build_downstream`'s docstring) or whose
      `output_queue_id` is `None` (a terminal stage, e.g. Storage).
    - Does not call `BaseWorker.heartbeat()` or `BaseWorker.shutdown()`
      — neither appears in either diagram; heartbeat cadence is a
      caller/timer concern (Phase 1.4) and shutdown is a pool
      lifecycle concern (Phase 1.3), not part of one execution cycle.

Two edge cases the Phase 6.3 diagrams do not cover, and how this file
resolves them without inventing new subsystem behavior
------------------------------------------------------------------------
1. No worker currently available. Neither diagram says what happens
   if `WorkerAllocator.allocate()` fails after `Queue.dequeue()` has
   already removed the item from its queue. This file avoids the
   dequeue in the first place whenever possible: it calls
   `WorkerAllocator.can_allocate()` (an existing, read-only
   WorkerAllocator query — not a new method) before dequeuing.
   `can_allocate()` -> `allocate()` is still two separate calls
   (nothing here is atomic across them — WorkerAllocator has no
   check-and-reserve primitive), so a residual race is possible: if
   `allocate()` still fails after `can_allocate()` said yes, the
   already-dequeued item is returned to its queue via
   `Queue.enqueue()` — the same public method any producer already
   uses to add work, not a new "put back" operation, and not retry
   bookkeeping (`record_attempt()`/`can_retry()` are not touched; the
   item never reached a worker, so nothing failed).
2. A producer stage (no `input_queue_id`) has no QueueItem to retry or
   dead-letter if `worker.process()` raises. The failure path's
   `Queue.can_retry()` / `Queue.record_attempt()` / `Queue.dead_letter()`
   calls all require a `queue_item_id`; for a producer stage there is
   none, so `execute_stage()` skips straight from `worker.fail()` to
   `WorkerAllocator.release()` for that case, exactly as the general
   flow does for every other stage once there is no QueueItem left to
   act on.

Thread safety
-------------
Introduces no new locking. Every call this file makes is already
protected by the lock internal to the object it is called on (Queue,
WorkerAllocator, WorkerRegistry, WorkerPool/WorkerGroup — see each
module's own "Thread Safety" section). `execute_stage()` does not hold
any lock across more than one such call, so two threads calling
`execute_stage()` for two different stages (or the same stage) never
contend on a lock this file owns, because it owns none.

Status
------
Runtime Integration sequence, item 3. Implements `StageConfig` and
`EngineRuntime.execute_stage()` only. Does NOT modify RuntimeContext,
EngineCoordinator, SessionContext, any Worker, any Queue, or any
Provider. Nothing yet constructs an `EngineRuntime` for a real session
or drives it in a loop — that remains EngineCoordinator integration
(item 4), per the same "not this milestone" boundary
engine/runtime_context.py already draws for its own future wiring.

TODO(future milestones):
    - EngineCoordinator integration (item 4): decide when, during a
      session's STARTING state, a RuntimeContext and an EngineRuntime
      are constructed for a real session, and what drives
      `execute_stage()` in a loop (a thread per stage? a single
      scheduler cycling through StageConfigs? deferred to that
      milestone).
    - Retry execution: turning `Queue.record_attempt()` bookkeeping
      into an actual re-enqueue is explicitly out of scope here (see
      above) and belongs to whichever milestone builds it.
    - Lease-based reservation (`Queue.reserve()`/`expire_leases()`)
      is not used by this file; a future milestone may decide
      execute_stage() should reserve-then-dequeue instead of
      dequeue-outright, if crash-recovery requirements end up needing
      it. Not decided here.
"""

from __future__ import annotations

import time
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Callable, Optional

from engine.runtime_context import RuntimeContext
from engine.state import WorkerState
from queues.dead_letter import DeadLetterReason
from queues.queue_item import QueueItem
from utils.runtime import get_logger

log = get_logger("engine.runtime")


class EngineRuntimeError(RuntimeError):
    """
    Raised for Engine Runtime configuration/precondition failures that
    are not any lower-level component's own error — e.g. a
    RuntimeContext missing one of its four required services, or a
    StageConfig that is internally inconsistent (see StageConfig's own
    validation). Never raised for a worker's own process() failure
    (that is the Failure path, not an error from this class) or for
    any exception a lower-level component (Queue, WorkerAllocator,
    WorkerRegistry, BaseWorker) already raises with its own, more
    specific exception type — those propagate unchanged.
    """


@dataclass(frozen=True, slots=True)
class StageConfig:
    """
    Everything `EngineRuntime.execute_stage()` needs to run one cycle
    of one pipeline stage, generically, for either worker shape
    (transformer or producer — see module docstring).

    Attributes
    ----------
    name:
        Human-readable label for logging only (e.g. "website",
        "discovery"). Never used to look anything up.
    definition_id:
        The WorkerDefinition (workers/worker_definition.py) this
        stage allocates from, via
        `RuntimeContext.worker_allocator.allocate(definition_id)`.
    input_queue_id:
        The QueueDefinition.queue_id this stage dequeues from, via
        `RuntimeContext.queue_manager.get_queue(input_queue_id)`.
        `None` marks a producer stage (Discovery today, per
        workers/discovery_worker.py) — `execute_stage()` will not
        dequeue anything and will call `produce_worker_input` instead
        (required whenever this is `None`; see below).
    output_queue_id:
        The QueueDefinition.queue_id this stage enqueues its result
        into, via `RuntimeContext.queue_manager.get_queue(...)`.
        `None` marks a terminal stage (e.g. Storage) — nothing is
        enqueued after `worker.complete()` regardless of what
        `build_downstream` would have returned.
    output_stage:
        The `stage` label attached to the QueueItem this stage
        enqueues downstream (`Queue.enqueue(..., stage=output_stage,
        ...)`). Free-form, matching QueueDefinition's own free-form
        `stage` field. Ignored if `output_queue_id` is `None`.
    build_worker_input:
        `Callable[[QueueItem], Any]` mapping a dequeued QueueItem to
        the object handed to `worker.process()`. Defaults to
        `lambda item: item.payload` — correct for every transformer
        worker today (Website/Instagram/Contact/Merge/Qualification/
        Storage all take their QueueItem's payload directly; see
        workers/merge_worker.py's own module docstring for why
        MergeInput is still just "the payload" from this file's point
        of view). Never called for a producer stage
        (`input_queue_id is None`).
    produce_worker_input:
        `Callable[[], Any]` building the object handed to
        `worker.process()` for a producer stage, with no QueueItem
        involved. Required whenever `input_queue_id is None`
        (`execute_stage()` raises EngineRuntimeError otherwise).
        For Discovery specifically, the caller that builds this
        StageConfig is the one responsible for closing over a
        `DiscoveryExecution(request=..., on_candidate=lambda
        candidate: <resolved output queue>.enqueue(
        pipeline_id=candidate.pipeline_id, stage=output_stage,
        payload=candidate))` — see workers/discovery_worker.py's
        "Ownership of on_candidate" section, which names this module
        as that caller. Ignored (never called) when `input_queue_id`
        is not `None`.
    build_downstream:
        `Callable[[Any], Optional[Any]]` mapping `worker.process()`'s
        return value to the payload enqueued into `output_queue_id`,
        or `None` to enqueue nothing this cycle. Defaults to
        `lambda output: output` — correct for every transformer worker
        (its return value *is* the downstream payload). For Discovery,
        a caller must supply `lambda _count: None`: DiscoveryWorker's
        `process()` returns an `int` count, not a payload, because the
        real enqueueing already happened once per candidate inside
        `produce_worker_input`'s `on_candidate` closure — mapping the
        count itself into a QueueItem payload here would double-enqueue
        (or wrongly enqueue an int) on top of that streaming, which is
        exactly the "invent queue behaviour" this milestone avoids.
    """

    name: str
    definition_id: str
    input_queue_id: Optional[str] = None
    output_queue_id: Optional[str] = None
    output_stage: Optional[str] = None
    build_worker_input: Callable[[QueueItem], Any] = None  # type: ignore[assignment]
    produce_worker_input: Optional[Callable[[], Any]] = None
    build_downstream: Callable[[Any], Optional[Any]] = None  # type: ignore[assignment]

    def __post_init__(self) -> None:
        if not self.name:
            raise ValueError("StageConfig.name must be a non-empty string")
        if not self.definition_id:
            raise ValueError("StageConfig.definition_id must be a non-empty string")
        if self.input_queue_id is None and self.produce_worker_input is None:
            raise ValueError(
                f"StageConfig {self.name!r}: input_queue_id is None (producer "
                "stage) but produce_worker_input was not supplied"
            )
        # dataclass(frozen=True) forbids assignment in __post_init__ for
        # slotted classes constructed normally; defaults below are
        # applied via object.__setattr__ exactly once, at construction,
        # mirroring the pattern other frozen contracts in this codebase
        # use when a field needs a non-trivial default (e.g.
        # QueueItem.retry_count's constructor-time default in
        # queue.py's enqueue()) — StageConfig itself stays otherwise
        # untouched afterwards.
        if self.build_worker_input is None:
            object.__setattr__(self, "build_worker_input", lambda item: item.payload)
        if self.build_downstream is None:
            object.__setattr__(self, "build_downstream", lambda output: output)


@dataclass(frozen=True, slots=True)
class StageOutcome:
    """
    What happened during one `execute_stage()` call. Purely
    observational — returned for a caller (e.g. a future
    EngineCoordinator-driven loop, or a test) to inspect or log;
    nothing in this file branches on a previously returned
    StageOutcome.

    Attributes
    ----------
    stage_name:
        `StageConfig.name` this outcome is for.
    ran:
        Whether a worker was actually allocated and driven through
        `process()` this cycle. `False` for a no-op cycle: nothing to
        dequeue (transformer stage, empty queue), or no worker
        currently available (see module docstring's edge case 1).
    success:
        `None` if `ran` is `False` (nothing to succeed or fail at).
        Otherwise `True` if `worker.complete()` was reached, `False`
        if `worker.fail()` was reached.
    worker_id:
        The allocated worker's id, or `None` if `ran` is `False`.
    queue_item_id:
        The dequeued QueueItem's id, or `None` for a producer stage or
        a no-op cycle.
    dead_lettered:
        Whether this cycle's failure resulted in
        `Queue.dead_letter()` rather than `Queue.record_attempt()`.
        Always `False` when `success` is not `False`.
    detail:
        Free-form human-readable detail: the allocator's failure
        reason for a no-op cycle, or `str(exc)` for a failed cycle.
        `None` otherwise.
    """

    stage_name: str
    ran: bool
    success: Optional[bool] = None
    worker_id: Optional[str] = None
    queue_item_id: Optional[str] = None
    pipeline_id: Optional[str] = None
    dead_lettered: bool = False
    detail: Optional[str] = None

    # PHASE 2 (per-area latency profiling): purely observational timing,
    # additive to the fields above. `duration_ms` is the wall-clock time
    # spent inside this cycle's `worker.process(worker_input)` call only
    # (allocate/release/queue bookkeeping is excluded, matching what an
    # "$STAGE_ms" figure in an [area-sla] report should mean: time the
    # worker itself was doing work, not scheduler overhead). `None` for a
    # no-op cycle (`ran=False`), exactly like `worker_id` above.
    # `queue_wait_ms` is how long the dequeued `QueueItem` sat in its
    # input queue between `enqueue()` and this cycle's `dequeue()` call —
    # `None` for a producer stage (no `input_queue_id`) or a no-op cycle,
    # same convention as `queue_item_id`. Neither field changes any
    # branching in this file or any caller; both are purely additive.
    duration_ms: Optional[float] = None
    queue_wait_ms: Optional[float] = None


class EngineRuntime:
    """
    Active execution layer for one DiscoverySession's RuntimeContext.
    Owns no state of its own beyond the RuntimeContext/session_id it
    was constructed with — see module docstring for the full list of
    what it deliberately does not do.
    """

    def __init__(self, runtime_context: RuntimeContext, session_id: str) -> None:
        """
        Parameters
        ----------
        runtime_context:
            An already-constructed, already-populated RuntimeContext
            (engine/runtime_context.py) — this class never constructs
            one itself, per the Phase 6.3 "MUST NOT construct
            RuntimeContext" instruction. Every one of its four fields
            must already be set; see `_require_services()` below.
        session_id:
            The owning DiscoverySession's id, passed straight through
            to `BaseWorker.reserve(session_id=...)` every cycle. Engine
            Runtime does not construct or look up a SessionContext /
            DiscoverySession for this id — it is carried purely as an
            opaque string, exactly the way WorkerContext already
            carries it.
        """
        if not session_id:
            raise ValueError("EngineRuntime.session_id must be a non-empty string")
        self._runtime = runtime_context
        self._session_id = session_id

    # -- execution -----------------------------------------------------------

    def execute_stage(self, stage: StageConfig) -> StageOutcome:
        """
        Run exactly one execution cycle of `stage`. See the module
        docstring for the full success/failure flow this implements
        and the two edge cases (no worker available, producer-stage
        failure) it resolves without inventing new subsystem behavior.

        Never raises for a worker's own `process()` failure (handled
        as the Failure path, returned as `StageOutcome(success=False,
        ...)`). Raises `EngineRuntimeError` for a misconfigured
        RuntimeContext. Propagates unchanged any exception raised by
        Queue / WorkerAllocator / WorkerRegistry / BaseWorker for a
        call this method makes outside the `worker.process()` try
        block (e.g. `WorkerRegistryError` if a worker was
        unregistered mid-cycle) — this method does not widen those
        into a generic failure outcome, since doing so would hide an
        actual Engine Runtime / RuntimeContext consistency bug behind
        what looks like an ordinary worker failure.
        """
        allocator, registry, queues = self._require_services()

        input_queue = (
            queues.get_queue(stage.input_queue_id)
            if stage.input_queue_id is not None
            else None
        )
        if stage.input_queue_id is not None and input_queue is None:
            raise EngineRuntimeError(
                f"stage {stage.name!r}: input_queue_id "
                f"{stage.input_queue_id!r} is not registered with this "
                "session's QueueManager"
            )

        item: Optional[QueueItem] = None
        queue_wait_ms: Optional[float] = None
        if input_queue is not None:
            item = input_queue.dequeue()
            if item is None:
                return StageOutcome(stage_name=stage.name, ran=False)
            # PHASE 2 (per-area latency profiling, audit item #16 — queue
            # wait / backpressure): how long this item sat between
            # Queue.enqueue() (created_at) and this dequeue(). Wall-clock
            # (datetime), not perf_counter, because created_at is set by
            # Queue.enqueue() with datetime.now(timezone.utc) and there is
            # no perf_counter equivalent recorded at enqueue time — see
            # queues/queue.py's `_now()`. Never raises: a naive/aware
            # mismatch or clock oddity degrades to `None` rather than
            # failing the whole stage cycle over an observability detail.
            try:
                queue_wait_ms = max(
                    0.0,
                    (datetime.now(timezone.utc) - item.created_at).total_seconds() * 1000.0,
                )
            except Exception:  # noqa: BLE001 - observability must never break execution
                queue_wait_ms = None
            worker_input = stage.build_worker_input(item)
        else:
            worker_input = stage.produce_worker_input()

        # -- allocate ----------------------------------------------------
        #
        # can_allocate() first (module docstring edge case 1): avoids
        # dequeuing a transformer stage's item at all when no worker is
        # currently free. Cannot be made atomic with allocate() itself
        # — WorkerAllocator exposes no combined check-and-reserve call
        # — so a residual race is still handled below.
        if not allocator.can_allocate(stage.definition_id):
            self._return_undequeued(input_queue, item)
            return StageOutcome(
                stage_name=stage.name,
                ran=False,
                detail=f"no idle worker for definition {stage.definition_id!r}",
            )

        allocation = allocator.allocate(stage.definition_id)
        if not allocation.success:
            self._return_undequeued(input_queue, item)
            return StageOutcome(
                stage_name=stage.name, ran=False, detail=allocation.reason
            )

        worker_id = allocation.worker_id
        handle = registry.get_worker_handle(worker_id)
        if handle is None or handle.instance is None:
            # Allocated through the pool but not registered (or not
            # locally attached) in this session's WorkerRegistry — a
            # RuntimeContext consistency problem, not a worker failure.
            # Release the allocation before surfacing it so the pool
            # does not leak a permanently-busy slot.
            allocator.release(worker_id)
            raise EngineRuntimeError(
                f"stage {stage.name!r}: worker {worker_id!r} was allocated "
                "but has no attached instance in this session's "
                "WorkerRegistry"
            )
        worker = handle.instance

        pipeline_id = item.pipeline_id if item is not None else None
        queue_item_id = item.queue_item_id if item is not None else None

        worker.reserve(session_id=self._session_id, pipeline_id=pipeline_id)
        registry.update_state(
            worker_id,
            WorkerState.RESERVED,
            session_id=self._session_id,
            pipeline_id=pipeline_id,
        )

        worker.start()
        registry.update_state(worker_id, WorkerState.WORKING)

        # PHASE 2 (per-area latency profiling, audit items #10-#15 —
        # WebsiteWorker/InstagramWorker/ContactWorker/Merge/Qualification/
        # Storage): time only the `worker.process()` call itself, not the
        # allocate/reserve/release bookkeeping around it, so this measures
        # the same thing an "$STAGE_ms" figure in an [area-sla] report
        # should mean — time the worker was actually doing work.
        _t0 = time.perf_counter()
        try:
            output = worker.process(worker_input)
        except Exception as exc:  # noqa: BLE001 - deliberately broad: any
            # process() failure, of any kind, is this stage's Failure
            # path, not an Engine Runtime error.
            duration_ms = (time.perf_counter() - _t0) * 1000.0
            return self._handle_failure(
                stage=stage,
                exc=exc,
                worker=worker,
                worker_id=worker_id,
                registry=registry,
                allocator=allocator,
                input_queue=input_queue,
                queue_item_id=queue_item_id,
                pipeline_id=pipeline_id,
                duration_ms=duration_ms,
                queue_wait_ms=queue_wait_ms,
            )
        duration_ms = (time.perf_counter() - _t0) * 1000.0

        return self._handle_success(
            stage=stage,
            output=output,
            worker=worker,
            worker_id=worker_id,
            registry=registry,
            allocator=allocator,
            queues=queues,
            pipeline_id=pipeline_id,
            queue_item_id=queue_item_id,
            duration_ms=duration_ms,
            queue_wait_ms=queue_wait_ms,
        )

    # -- success / failure handling ------------------------------------------

    def _handle_success(
        self,
        *,
        stage: StageConfig,
        output: Any,
        worker: Any,
        worker_id: str,
        registry: Any,
        allocator: Any,
        queues: Any,
        pipeline_id: Optional[str],
        queue_item_id: Optional[str],
        duration_ms: Optional[float] = None,
        queue_wait_ms: Optional[float] = None,
    ) -> StageOutcome:
        worker.complete()
        registry.update_state(worker_id, WorkerState.COMPLETED)

        if stage.output_queue_id is not None:
            payload = stage.build_downstream(output)
            if payload is not None:
                output_queue = queues.get_queue(stage.output_queue_id)
                if output_queue is None:
                    self._release(worker, worker_id, registry, allocator)
                    raise EngineRuntimeError(
                        f"stage {stage.name!r}: output_queue_id "
                        f"{stage.output_queue_id!r} is not registered with "
                        "this session's QueueManager"
                    )
                output_queue.enqueue(
                    pipeline_id=pipeline_id,
                    stage=stage.output_stage,
                    payload=payload,
                )

        self._release(worker, worker_id, registry, allocator)
        log.info(
            "stage=%s worker=%s queue_item=%s pipeline_id=%s outcome=success",
            stage.name, worker_id, queue_item_id, pipeline_id,
        )
        return StageOutcome(
            stage_name=stage.name,
            ran=True,
            success=True,
            worker_id=worker_id,
            queue_item_id=queue_item_id,
            pipeline_id=pipeline_id,
            duration_ms=duration_ms,
            queue_wait_ms=queue_wait_ms,
        )

    def _handle_failure(
        self,
        *,
        stage: StageConfig,
        exc: Exception,
        worker: Any,
        worker_id: str,
        registry: Any,
        allocator: Any,
        input_queue: Any,
        queue_item_id: Optional[str],
        pipeline_id: Optional[str] = None,
        duration_ms: Optional[float] = None,
        queue_wait_ms: Optional[float] = None,
    ) -> StageOutcome:
        worker.fail()
        registry.update_state(worker_id, WorkerState.FAILED)

        dead_lettered = False
        if input_queue is not None and queue_item_id is not None:
            # Producer stages (module docstring edge case 2) have no
            # QueueItem here at all — input_queue is None for them, so
            # this block is skipped entirely and only worker.fail() /
            # release() run, exactly as the general flow does once
            # there is no QueueItem left to retry or dead-letter.
            if input_queue.can_retry(queue_item_id):
                input_queue.record_attempt(queue_item_id)
            else:
                reason = (
                    DeadLetterReason.RETRY_EXHAUSTED
                    if input_queue.attempt_count(queue_item_id) > 0
                    else DeadLetterReason.WORKER_FAILURE
                )
                input_queue.dead_letter(queue_item_id, reason=reason, detail=str(exc))
                dead_lettered = True

        self._release(worker, worker_id, registry, allocator)
        log.warning(
            "stage=%s worker=%s queue_item=%s pipeline_id=%s outcome=failed "
            "dead_lettered=%s error=%s",
            stage.name, worker_id, queue_item_id, pipeline_id, dead_lettered, exc,
        )
        return StageOutcome(
            stage_name=stage.name,
            ran=True,
            success=False,
            worker_id=worker_id,
            queue_item_id=queue_item_id,
            pipeline_id=pipeline_id,
            dead_lettered=dead_lettered,
            detail=str(exc),
            duration_ms=duration_ms,
            queue_wait_ms=queue_wait_ms,
        )

    # -- internal --------------------------------------------------------

    def _release(self, worker: Any, worker_id: str, registry: Any, allocator: Any) -> None:
        """
        Shared COMPLETED->IDLE / FAILED->IDLE release sequence for
        both outcome paths: release the BaseWorker itself, report the
        resulting IDLE state (with session_id/pipeline_id explicitly
        cleared) to WorkerRegistry, then release the allocation back
        to WorkerAllocator/WorkerPool. Order matters: the worker is
        freed and reported before the allocator makes it available to
        the next caller, so nothing can observe a worker as "idle in
        the pool" while WorkerRegistry still shows it RESERVED/WORKING.
        """
        worker.release()
        registry.update_state(
            worker_id, WorkerState.IDLE, session_id=None, pipeline_id=None
        )
        allocator.release(worker_id)

    @staticmethod
    def _return_undequeued(input_queue: Any, item: Optional[QueueItem]) -> None:
        """
        Module docstring edge case 1's residual-race handling: if an
        item was dequeued (transformer stage) but no worker could be
        allocated for it after all, hand it back via the same public
        `Queue.enqueue()` every producer already uses. No-op for a
        producer stage (`item is None`) or when nothing was dequeued
        (`can_allocate()` already said no before any dequeue() call).
        """
        if input_queue is not None and item is not None:
            input_queue.enqueue(
                pipeline_id=item.pipeline_id, stage=item.stage, payload=item.payload
            )

    def _require_services(self):
        """
        Confirm this EngineRuntime's RuntimeContext is fully populated
        and return its three services this class actually calls
        (worker_allocator, worker_registry, queue_manager). worker_pool
        is intentionally not returned here: nothing in this class calls
        it directly — WorkerAllocator already wraps it (see
        workers/worker_allocator.py), and reaching around that
        wrapping would duplicate WorkerAllocator, which this milestone
        is explicitly told not to do.

        Raises EngineRuntimeError naming exactly which field(s) are
        missing if any of the three required fields is None. Does not
        construct, replace, or mutate any field on the RuntimeContext
        — only reads it.
        """
        missing = [
            field_name
            for field_name, value in (
                ("worker_allocator", self._runtime.worker_allocator),
                ("worker_registry", self._runtime.worker_registry),
                ("queue_manager", self._runtime.queue_manager),
            )
            if value is None
        ]
        if missing:
            raise EngineRuntimeError(
                "RuntimeContext is missing required service(s) for "
                f"EngineRuntime: {', '.join(missing)}"
            )
        return (
            self._runtime.worker_allocator,
            self._runtime.worker_registry,
            self._runtime.queue_manager,
        )
