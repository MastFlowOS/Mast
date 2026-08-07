"""
MAST Engine V2 — Discovery Session
====================================

Source: Engine BluePrint, Phase 1.1 ("Definitions" -> Discovery
Session), Phase 1.2 ("DiscoverySession"), and Phase 1.3 ("Discovery
Session").

Responsibility
--------------
Every click on "Discover Opportunities" creates exactly one
DiscoverySession. Per the blueprint, nothing exists outside a
Discovery Session — it owns:

    - the requested amount, niche, country, category
    - every worker
    - every queue
    - every opportunity
    - progress / performance stats

This module defines the *shape* of that ownership only. It does not
start workers, does not read or write queues, and does not talk to
Supabase. Actually creating and running a session is the
responsibility of the EngineCoordinator (see engine/coordinator.py),
which does not exist as working logic yet either.

Immutability (Phase 1.2 Golden Rule)
-------------------------------------
Like every other contract in engine/contracts.py, DiscoverySession is
a frozen, slotted dataclass: nothing mutates a session's counters or
status in place. Per the Golden Rule ("Workers don't modify
objects—they produce new ones"), a session transition (e.g. RUNNING ->
COMPLETED, or delivered_count incrementing) is represented by
producing a brand new DiscoverySession, not by assigning to an
existing one. Which component is responsible for constructing that
next snapshot (the EngineCoordinator? a dedicated SessionManager?) is
a Phase 3+ decision and is intentionally not made here.

Status
------
Milestone 3B (revised). DiscoverySession stays exactly what Milestone 2
made it — a frozen, slotted dataclass holding immutable session
*metadata* (identifiers, configuration, status, counters, timestamps).
It no longer represents "everything a session owns" from the
Responsibility section above; that broader ownership now belongs to
the mutable `SessionContext` defined below, which wraps a
`DiscoverySession` rather than being one. EngineCoordinator's registry
is `session_id -> SessionContext`, not `session_id -> DiscoverySession`
(see engine/coordinator.py).

This revision establishes one further split, on top of the original
3B pass: `SessionContext` does not itself hold individual runtime
handles (queues, workers, provider state, cache, timers, metrics,
...) as separate fields. Instead it holds exactly one runtime slot,
`runtime: Optional[RuntimeContext]`, so the ownership hierarchy is:

    EngineCoordinator
            |
            v
    SessionContext
            |
            +-- session: DiscoverySession   (immutable, always present)
            +-- runtime: RuntimeContext      (mutable, populated by a future
                                               EngineCoordinator integration
                                               milestone — see below)

`RuntimeContext` (engine/runtime_context.py) is now a real,
implemented class as of the Runtime Integration sequence's item 2 —
see its own module docstring for the full "architecture clarification"
that settled its four fields (`worker_registry`, `worker_pool`,
`worker_allocator`, `queue_manager`), each independent and each
Optional. This keeps the *set* of runtime subsystems a session may
eventually own (workers, queues, and — later — provider state /
cache / timers / metrics once their shapes are decided) as an
implementation detail of `RuntimeContext`, rather than a set of fields
that `SessionContext` — and every piece of code that constructs a
`SessionContext` — has to know about individually. Nothing in this
milestone constructs a `RuntimeContext` for a real session or assigns
one to a real `SessionContext.runtime` — that remains a future
EngineCoordinator integration milestone's job (Runtime Integration
sequence, item 4), not this one's.

`SessionContext` also now carries its own bookkeeping, independent of
`DiscoverySession`'s timestamps: `created_at` (when the context itself
was registered), `last_updated` (when the context — its `session`, or
once it exists, its `runtime` — last changed), and `version` (an
integer bump on every such change, for optimistic-concurrency /
audit purposes). These describe the *context's* lifecycle, which is
not the same thing as the *session's* lifecycle
(`DiscoverySession.created_at/started_at/finished_at` already cover
that).

TODO(future milestones):
    - Runtime Integration sequence, item 3 (Engine Runtime): the
      execution loop that actually reaches through a populated
      `RuntimeContext` to allocate a worker and drive a queue. Does
      not itself construct or populate a `RuntimeContext`.
    - Runtime Integration sequence, item 4 (EngineCoordinator
      integration): the first milestone that will actually construct
      a `RuntimeContext` (with its `worker_registry` / `worker_pool` /
      `worker_allocator` / `queue_manager` fields) for a real session
      and assign it to that session's `SessionContext.runtime` —
      most likely during the STARTING state (see engine/coordinator.py).
      Not implemented by this milestone.
    - Phase 5+ : `RuntimeContext` will gain fields for discovery
      provider runtime state, cache, timers, and metrics once those
      subsystems' shapes are decided (see engine/runtime_context.py's
      own TODO — `ProviderRuntime`/`StatisticsRuntime`/
      `PerformanceRuntime`/`CacheRuntime`/`CheckpointRuntime` remain
      unbuilt). `SessionContext` itself should not need to change
      again for any of this — only `RuntimeContext` grows.
    - The coordinator will continue producing new DiscoverySession
      snapshots (per the Golden Rule) and swapping them into the
      owning SessionContext as a session's status changes, bumping
      `last_updated`/`version` when it does.
    - Success metrics (Phase 1.1 section 6): requested / delivered /
      rejected / failed / timeouts / average stage durations / first
      opportunity time will be computed and attached to
      `performance_stats` once the pipeline that produces them exists.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Optional

from engine.runtime_context import RuntimeContext
from engine.state import SessionStatus


@dataclass(frozen=True, slots=True)
class DiscoverySession:
    """
    Immutable metadata for a single discovery run: identifiers,
    configuration, status, counters, and timestamps only. As of
    Milestone 3B this class does NOT own queues, workers, or arbitrary
    runtime state — see `SessionContext` below, which wraps a
    DiscoverySession and owns everything else the Phase 1.1/1.2
    "nothing exists outside a Discovery Session" description implies.

    Created by: the Engine (EngineCoordinator), one per "Discover
    Opportunities" click, wrapped in a SessionContext.
    Read by: everyone (workers, queues, and the frontend all read a
    session's requested/delivered counts and status).
    Terminal or intermediate: intermediate while status is CREATED /
    STARTING / PENDING / RUNNING / PAUSED; terminal once status is
    COMPLETED / EXHAUSTED / CANCELLED / FAILED (Phase 1.3 "Session
    Completion").

    TODO: queue_stats / worker_stats / performance_stats are currently
    untyped (dict placeholders) pending the Queue Framework (Phase 4)
    and Worker Framework (Phase 3), which will define their real
    shapes (see engine/contracts.py module docstring, ambiguity #2).
    These remain here (not on SessionContext) because they are meant
    to be an immutable *summary* snapshot, not the live mutable
    handles themselves.
    """

    # Identifiers
    id: str
    user_id: str

    # Configuration
    provider: Optional[str] = None
    niche: Optional[str] = None
    country: Optional[str] = None
    city: Optional[str] = None
    category: Optional[str] = None
    requested_count: int = 0
    contact_requirements: tuple[str, ...] = ()

    # Data
    status: SessionStatus = SessionStatus.PENDING
    delivered_count: int = 0

    # Metrics
    queue_stats: Optional[dict[str, Any]] = None
    worker_stats: Optional[dict[str, Any]] = None
    performance_stats: Optional[dict[str, Any]] = None

    # Metadata
    created_at: Optional[str] = None
    started_at: Optional[str] = None
    finished_at: Optional[str] = None

    def start(self) -> None:
        """
        Session transitions are owned by EngineCoordinator /
        SessionStateMachine (engine/coordinator.py), not by
        DiscoverySession itself — and, per Milestone 3B, "starting" is
        no longer one hop anyway. Call, in order:

            EngineCoordinator.create_session(...)   # -> CREATED
            EngineCoordinator.start_session(id)      # -> STARTING
            EngineCoordinator.mark_running(id)       # -> RUNNING

        each of which returns the SessionContext holding the new
        DiscoverySession snapshot. Per the Golden Rule,
        DiscoverySession is frozen and cannot mutate itself in place,
        so this instance method is kept only as a documented
        placeholder so nothing that already references
        `DiscoverySession.start` breaks; it intentionally still does
        not implement session startup itself.
        """
        raise NotImplementedError(
            "DiscoverySession.start is intentionally not implemented — "
            "session transitions are owned by EngineCoordinator / "
            "SessionStateMachine (engine/coordinator.py), not by "
            "DiscoverySession itself. See create_session / "
            "start_session / mark_running."
        )

    def is_finished(self) -> bool:
        """
        True once status is one of the terminal states reached via
        SessionStateMachine (Phase 1.3 "Session Completion"):
        COMPLETED, CANCELLED, or FAILED. EXHAUSTED is listed in
        SessionStatus as a future terminal reason (Phase 1.3) but is
        not yet reachable via any SessionStateMachine transition as of
        Milestone 3A, so it is included here for forward-compatibility
        without claiming the coordinator can produce it yet.
        """
        return self.status in (
            SessionStatus.COMPLETED,
            SessionStatus.EXHAUSTED,
            SessionStatus.CANCELLED,
            SessionStatus.FAILED,
        )


@dataclass(slots=True)
class SessionContext:
    """
    Mutable per-session container (Milestone 3B, revised). This is
    what EngineCoordinator's registry actually stores — `session_id ->
    SessionContext`, not `session_id -> DiscoverySession`. Its job is
    only to establish the ownership hierarchy:

        EngineCoordinator -> SessionContext -> {session, runtime}

    `SessionContext` itself owns exactly two things: the immutable
    `DiscoverySession` snapshot, and a single `runtime` slot for
    everything else a session will eventually own (workers, queues,
    and — later — provider state / cache / timers / metrics).
    `SessionContext` does not enumerate those individually — that
    would mean this class changing shape every time a new runtime
    subsystem lands. Instead they all live inside `RuntimeContext`
    (engine/runtime_context.py), now a real, implemented class as of
    the Runtime Integration sequence's item 2 — see its own module
    docstring for the four fields it groups
    (`worker_registry`/`worker_pool`/`worker_allocator`/
    `queue_manager`) and the architecture clarification that settled
    them. `runtime` remains `Optional[RuntimeContext]`: nothing in
    this or the prior milestone constructs one for a real session or
    assigns it here — see TODO below for which future milestone does.

    Deliberately NOT frozen, unlike every contract in
    engine/contracts.py and unlike DiscoverySession itself: once
    `runtime` exists it will hold live, mutable handles, not immutable
    data. `SessionContext.session`, however, is still swapped wholesale
    (never mutated in place) on every status transition, per the Phase
    1.2 Golden Rule — SessionStateMachine produces a new
    DiscoverySession and EngineCoordinator assigns it to `ctx.session`;
    nothing ever does `ctx.session.status = ...`.

    Fields:
        session       Immutable DiscoverySession metadata (see above).
                       The only field with real behavior today.
        runtime       Optional `RuntimeContext` (engine/runtime_context.py)
                       instance holding this session's WorkerRegistry,
                       WorkerPool, WorkerAllocator, and QueueManager
                       (each independently Optional there too), plus —
                       once their shapes are decided — provider state /
                       cache / timers / metrics. `RuntimeContext` is
                       implemented (Runtime Integration sequence, item
                       2); constructing one for a real session and
                       assigning it here remains a future
                       EngineCoordinator integration milestone's job
                       (item 4) — not done by this or the prior
                       milestone.
        created_at     When this SessionContext was registered with
                       the coordinator. Distinct from
                       `DiscoverySession.created_at`, which describes
                       the session's own lifecycle, not the context's.
        last_updated   When this SessionContext was last changed
                       (`session` swapped, or — once it exists —
                       `runtime` mutated). Coordinator bookkeeping
                       only; not read or written by
                       SessionStateMachine.
        version        Monotonically increasing counter, bumped on
                       every SessionContext change. Reserved for
                       optimistic-concurrency / audit use by future
                       milestones; not yet enforced anywhere.
    """

    session: DiscoverySession
    runtime: Optional[RuntimeContext] = None
    created_at: Optional[str] = None
    last_updated: Optional[str] = None
    version: int = 1
