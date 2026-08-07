"""
MAST Engine V2 — Runtime Context
===================================

Source: Engine BluePrint, Phase 1.3 ("RuntimeContext groups every
runtime subsystem. It exists to prevent SessionContext from becoming a
God Object."), AD-010 ("RuntimeContext owns runtime systems"). Phase
6.2 of the Runtime Integration sequence (MergeWorker -> RuntimeContext
-> Engine Runtime -> EngineCoordinator integration -> Storage backend
-> service.py cutover).

Architecture clarification (resolves the Runtime Integration review's
open ownership question)
--------------------------------------------------------------------
A prior architecture review found every existing reference to
`RuntimeContext` across this codebase and the blueprint, and surfaced
a real disagreement: `engine/interfaces.py`, `workers/discovery_worker.py`,
`workers/worker_allocator.py`, and the blueprint's own Phase 1.3
diagram all name `WorkerRegistry` as the worker-side member
`RuntimeContext` groups; `engine/session.py`'s own TODOs instead named
`WorkerPool` ("worker pool handles (workers/worker_pool.py)"); and no
file anywhere named `WorkerAllocator`, despite it being the one
component that actually grants/releases a reservation.

This is resolved, by explicit instruction, as follows — recorded here
so every future milestone references the same model instead of
re-litigating it:

    RuntimeContext owns, as four independent, sibling fields:
        - WorkerRegistry   (workers/worker_registry.py)
        - WorkerPool        (workers/worker_pool.py)
        - WorkerAllocator   (workers/worker_allocator.py)
        - QueueManager      (queues/queue_manager.py)

None of the four is nested inside another from RuntimeContext's point
of view. WorkerAllocator happens to wrap one WorkerPool internally
(see workers/worker_allocator.py — that relationship is unchanged and
is entirely that module's own concern), and WorkerRegistry/WorkerPool
happen to be two independent views over the same WorkerHandles (see
workers/worker_pool.py's own module docstring) — but RuntimeContext
does not encode, depend on, or care about either of those facts. It is
purely an ownership boundary: four already-constructed runtime
services that belong to one session, held as four flat attributes,
nothing more.

`ProviderRuntime`, `StatisticsRuntime`, `PerformanceRuntime`,
`CacheRuntime`, and `CheckpointRuntime` — the remaining five members
the blueprint's Phase 1.3 diagram lists — are deliberately NOT
introduced by this milestone. Every file that mentions them agrees
their shape is "not yet specified anywhere in the blueprint" (see
engine/session.py). Adding placeholder fields for them now, with no
defined shape, would be inventing architecture this milestone has no
basis for. They remain exactly the future blueprint subsystems they
already were; this class simply does not grow a field for any of them
yet.

Responsibility
--------------
RuntimeContext groups the runtime services belonging to one
DiscoverySession (Phase 1.3: "It exists to prevent SessionContext from
becoming a God Object"). It is a plain, mutable container — an
ownership boundary, not a behavior. Concretely, and exhaustively, it:

    - holds a reference to a WorkerRegistry, a WorkerPool, a
      WorkerAllocator, and a QueueManager, each Optional and
      independently settable
    - does nothing else

It explicitly does NOT:

    - orchestrate anything (no method here decides *when* a worker is
      allocated, a queue is drained, or a session moves forward —
      that remains EngineCoordinator's eventual job, once the Engine
      Runtime execution loop exists to give it something real to
      orchestrate; see the Runtime Integration sequence's own
      ordering, item 4, not this one)
    - execute a worker (no call to any WorkerRegistry/WorkerPool/
      WorkerAllocator method that would reserve, allocate, or run one)
    - execute a queue (no call to any QueueManager/Queue method that
      would enqueue, dequeue, or reserve a QueueItem)
    - allocate work itself (allocation remains WorkerAllocator's own
      job, exactly as it already is independent of this class)
    - construct its own members (a caller constructs a WorkerRegistry/
      WorkerPool/WorkerAllocator/QueueManager and assigns each to this
      container; RuntimeContext does not decide worker-type
      definitions, queue definitions, or pool sizing — none of that is
      this class's concern)
    - merge, wrap, or otherwise couple its four members to one another
      beyond holding all four as siblings

Relationship to SessionContext
----------------------------------
`SessionContext.runtime` (engine/session.py) is `Optional[RuntimeContext]`
— this milestone gives that forward reference a real class for the
first time. Nothing in this milestone constructs a RuntimeContext for
an actual session, and nothing assigns one to a real SessionContext's
`runtime` field — that wiring (deciding *when*, during STARTING, a
session's four runtime services get constructed and attached) belongs
to EngineCoordinator integration, per the agreed Runtime Integration
sequence's item 4, not to this milestone. This file only makes the
type real and gives it the four fields the architecture clarification
above settles on.

Status
------
Runtime Integration sequence, item 2 (MergeWorker [done] ->
RuntimeContext [this file] -> Engine Runtime -> EngineCoordinator
integration -> Storage backend -> service.py cutover). This module:

    - does NOT construct a WorkerRegistry, WorkerPool, WorkerAllocator,
      or QueueManager anywhere (no such construction call exists in
      this file)
    - does NOT modify WorkerRegistry, WorkerPool, WorkerAllocator,
      QueueManager, or any Worker/Queue/Provider/Session class
    - does NOT modify engine/coordinator.py — EngineCoordinator's
      allocate_workers()/monitor_queues()/resume_failed_work()
      placeholders are unchanged and still raise NotImplementedError
    - is imported by engine/session.py (SessionContext.runtime's type
      annotation is now a real import instead of a forward-reference
      string) — see that module's own updated note

TODO(future milestones):
    - Engine Runtime (Runtime Integration sequence, item 3): the
      execution loop that actually calls WorkerAllocator.allocate(),
      QueueManager.get_queue(...).dequeue()/enqueue(), etc. Nothing in
      this file anticipates its shape beyond exposing the four
      services it will need to reach.
    - EngineCoordinator integration (item 4): decides when, during a
      session's STARTING state, a RuntimeContext is constructed
      (with its four members) and attached to that session's
      SessionContext.runtime. Not decided or implemented here.
    - ProviderRuntime / StatisticsRuntime / PerformanceRuntime /
      CacheRuntime / CheckpointRuntime: remain future blueprint
      subsystems with no defined shape anywhere yet. A future
      milestone that gives one of them a concrete shape would add a
      new Optional field here, mirroring exactly how this milestone
      added four — not anything this file does now.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Optional

from queues.queue_manager import QueueManager
from workers.worker_allocator import WorkerAllocator
from workers.worker_pool import WorkerPool
from workers.worker_registry import WorkerRegistry


@dataclass(slots=True)
class RuntimeContext:
    """
    Per-session ownership boundary for four independent runtime
    services. See the module docstring's "Architecture clarification"
    section for why these four, and why they are siblings rather than
    a parent/child hierarchy.

    Deliberately NOT frozen, mirroring SessionContext
    (engine/session.py): once populated, each field holds a live,
    mutable runtime object (a WorkerRegistry instance keeps mutating
    its own records as workers register/heartbeat; a Queue inside
    QueueManager keeps mutating its own FIFO storage as items move
    through it) — RuntimeContext itself does not protect any of that
    mutation with its own lock, and does not need to: each of the four
    services already guards its own internal state with its own lock
    (see worker_registry.py, worker_pool.py, worker_allocator.py,
    queue_manager.py). RuntimeContext only holds the four references;
    it is never itself a point of synchronization.

    Every field defaults to None so a RuntimeContext can be
    constructed and populated incrementally (e.g. by a future
    EngineCoordinator integration milestone that builds the worker
    side during STARTING before the queue side, or vice versa) without
    this class enforcing an order or requiring all four at once. This
    mirrors SessionContext.runtime's own optionality — "not yet
    populated" is a normal, expected state for this class, not an
    error.

    Attributes
    ----------
    worker_registry:
        This session's WorkerRegistry (workers/worker_registry.py) —
        the flat directory of every worker's last-reported state.
        Independent of worker_pool below; see that class's own module
        docstring for why the two are separate views over the same
        WorkerHandles, never merged.
    worker_pool:
        This session's WorkerPool (workers/worker_pool.py) — per-type
        idle/busy availability pools.
    worker_allocator:
        This session's WorkerAllocator (workers/worker_allocator.py)
        — the thin reservation-granting policy layer in front of
        worker_pool above. Carried here as its own sibling field, not
        derived from worker_pool, since a caller reaching
        RuntimeContext should not need to know that WorkerAllocator
        happens to wrap a WorkerPool internally.
    queue_manager:
        This session's QueueManager (queues/queue_manager.py) — owns
        this session's per-stage Queues.
    """

    worker_registry: Optional[WorkerRegistry] = None
    worker_pool: Optional[WorkerPool] = None
    worker_allocator: Optional[WorkerAllocator] = None
    queue_manager: Optional[QueueManager] = None
