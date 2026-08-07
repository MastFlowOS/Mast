"""
MAST Engine V2 — Workers Package
===================================

Source: Engine BluePrint, Phase 1.3 ("Distributed Worker Architecture")
and Phase 1.5 ("V2 Folder Structure").

Responsibility
----------------------
Per the blueprint, MAST V2 has exactly seven worker types, each with
ONE responsibility, communicating only through queues:

    Discovery Worker      -> BusinessCandidate
    Website Worker        -> WebsiteIntel
    Instagram Worker      -> InstagramIntel
    Contact Worker        -> ContactIntel
    Merge Worker          -> EnrichedBusiness
    Qualification Worker  -> QualifiedOpportunity (qualification half)
    Storage Worker        -> StoredOpportunity

The target V2 layout groups these as subpackages:

    workers/discovery/
    workers/website/
    workers/instagram/
    workers/contact/
    workers/merge/
    workers/qualification/
    workers/storage/

along with the generic worker framework itself:

    workers/base_worker.py
    workers/worker_pool.py
    workers/worker_state.py

None of the seven worker-type subpackages exist yet. This package is
still their eventual home.

Status
------
Milestone 3C added the shared worker lifecycle abstraction:

    workers/base_worker.py      -> BaseWorker, WorkerStateError
    workers/worker_context.py   -> WorkerContext
    workers/worker_capability.py -> WorkerCapability

Milestone 3D added the worker registry — tracking only, no
scheduling, no queue awareness:

    workers/worker_registry.py    -> WorkerRegistry, WorkerRegistryError
    workers/worker_record.py      -> WorkerRecord
    workers/worker_definition.py  -> WorkerDefinition
    workers/worker_handle.py      -> WorkerHandle

An Architecture Review correction to Milestone 3D (not yet reflected
in the blueprint text itself) introduced WorkerHandle as an
indirection layer: WorkerRegistry holds two separate maps, both keyed
by worker_id — one of WorkerRecord (mutable runtime metadata — state,
timestamps, session/pipeline ids) and one of WorkerHandle, which in
turn points at the actual BaseWorker instance (WorkerRegistry no
longer stores BaseWorker objects directly). The same correction made
explicit that the registry never calls a BaseWorker lifecycle method
itself — it only records state a caller reports after driving the
BaseWorker directly. It does not decide which worker gets the next
job; that decision belongs to workers/worker_pool.py, still not yet
created.

Milestone 3E added the worker pool — availability bookkeeping only,
grouped by worker type, no scheduling, no queue awareness:

    workers/worker_pool.py    -> WorkerPool, WorkerPoolError
    workers/worker_group.py   -> WorkerGroup, WorkerGroupError

WorkerPool owns one WorkerGroup per WorkerDefinition; each WorkerGroup
owns the WorkerHandles registered against that one definition, split
into idle and busy sets. Ownership still bottoms out at WorkerHandle,
exactly as it does for WorkerRegistry — WorkerPool and WorkerGroup
alike never hold a BaseWorker directly and never call a BaseWorker
lifecycle method:

    WorkerPool -> WorkerGroup -> WorkerHandle -> BaseWorker

WorkerPool is independent of WorkerRegistry: the two are separate
views over the same WorkerHandles (a flat directory vs. per-type
availability pools), and this milestone does not merge them or make
either call the other. Acquiring a WorkerHandle from a WorkerGroup is
deterministic first-idle (FIFO) selection only — no round robin, no
priority, no weighting; deciding *how many* workers of a type should
exist, or which idle worker is the "best" one to hand out, remains out
of scope.

Milestone 3F added the worker allocator — a thin policy layer that
acquires and releases workers from WorkerPool, nothing more:

    workers/worker_allocator.py   -> WorkerAllocator, WorkerAllocatorError
    workers/allocation_result.py  -> AllocationResult

WorkerAllocator sits one level above WorkerPool, calling only
WorkerPool.acquire()/release()/idle_count()/busy_count(). It adds
exactly one thing WorkerPool does not have — a reservation_id, minted
at allocation time and returned inside an immutable AllocationResult —
and otherwise duplicates none of WorkerPool/WorkerGroup's own
bookkeeping:

    WorkerAllocator -> WorkerPool -> WorkerGroup -> WorkerHandle -> BaseWorker

Selection remains exactly WorkerGroup's existing deterministic
first-idle (FIFO) policy; this milestone adds no round robin, random
choice, priority, weighting, locality/affinity, or health-aware
scheduling on top. WorkerAllocator never calls a BaseWorker lifecycle
method, never touches WorkerRegistry, and knows nothing about queues,
businesses, sessions, or providers — same boundary WorkerPool and
WorkerGroup already hold, one layer further out.

No concrete worker subclass exists yet. BaseWorker cannot be
instantiated on its own — process() and timeout_seconds()
(engine/interfaces.py: WorkerInterface) stay abstract — and no queue or
provider exists yet to decide how many workers should run or hand one
real work. The existing scraper/, enrichment/, storage/, and scoring/
packages are untouched and continue to run exactly as they do today.

TODO(future milestones):
    - A future allocation-policy layer (not yet scoped in Phase
      1.1-1.5) may sit above WorkerAllocator to decide *which*
      definition_id to allocate from for a given job type, or to react
      to WorkerAllocator.can_allocate() returning False by scaling a
      WorkerGroup up (Phase 1.3 "Dynamic Worker Allocation") — no such
      decision is made by WorkerPool, WorkerGroup, or WorkerAllocator
      themselves. (A separate worker_state.py was not created —
      Milestone 3C drives WorkerState transitions directly inside
      BaseWorker; see base_worker.py's _ALLOWED_TRANSITIONS.)
    - Phase 4 (Queue Framework): will call WorkerRegistry.
      update_state() / heartbeat() as part of the real reservation
      flow, once queues exist to drive it. A caller pairing a
      successful AllocationResult with a real queue reservation will
      likely also drive BaseWorker.reserve() and
      WorkerRegistry.update_state() itself; WorkerAllocator remains
      blind to both.
    - Phase 5 (Discovery Provider): workers/discovery/.
    - Phase 6 (Enrichment Package): workers/website/, instagram/,
      contact/, merge/.
    - Phase 7 (Qualification Engine): workers/qualification/.
    - Phase 8 (Storage Layer): workers/storage/.
"""

from __future__ import annotations
