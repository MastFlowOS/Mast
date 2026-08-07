"""
MAST Engine V2 — State Definitions
===================================

Source: Engine BluePrint, Phase 1.1 ("Design Principles"), Phase 1.3
("Worker Lifecycle"), and Phase 1.4 ("Queue States").

Responsibility
--------------
This module is the single home for every finite-state enum used by the
V2 engine: pipeline stage, worker lifecycle, queue item lifecycle, and
discovery session status. It defines states only — no transition
logic, no validation, no side effects. Deciding *when* something moves
from one state to another belongs to future milestones (the
coordinator, the worker pool, and the queue manager respectively), not
to this module.

Status
------
FOUNDATION ONLY (Milestone 1/2). Nothing in the current running engine
imports these enums yet.

Milestone 2 review: each enum below was checked against its blueprint
section. All four already fully cover their source text (PipelineStage
== Phase 1.1 Principle 4 + Principle 8 exactly; WorkerState == Phase
1.3 "Worker Lifecycle" exactly, five states + the FAILED branch;
QueueItemState == Phase 1.4 "Queue States" exactly, six states; and
SessionStatus covers every Phase 1.3 "Session Completion" reason,
plus PAUSED for Phase 1.4 backpressure). No values were missing, so
none were added and none were removed.

Milestone 3C note: WorkerState gained two bookkeeping states — see its
class docstring below. PipelineStage, QueueItemState, and SessionStatus
are unchanged by this milestone.

TODO(future milestones):
    - Phase 2 (this milestone) only defines the enums.
    - Phase 3 (Worker Framework): workers/worker_state.py will drive
      WorkerState transitions.
    - Phase 4 (Queue Framework): queue/manager.py, reservation.py, and
      heartbeat.py will drive QueueItemState transitions (including
      reservation expiry and dead-lettering).
    - Phase 5+ (Discovery Provider onward): PipelineStage will be set
      by the coordinator/session as a business moves forward through
      the five engine layers (Providers -> Discovery -> Enrichment ->
      Qualification -> Storage).
"""

from __future__ import annotations

from enum import Enum


class PipelineStage(str, Enum):
    """
    Principle 4 (Phase 1.1): businesses flow forward only, never
    backwards. No stage may mutate a previous stage.

        DISCOVERED -> ENRICHING -> QUALIFIED -> STORED

    Principle 8 (Phase 1.1): every pipeline ends with exactly one final
    state — DELIVERED, REJECTED, or FAILED. Nothing may disappear.

    TODO: enforced by the coordinator once it exists (Phase 2+); no
    enforcement logic lives here.
    """

    DISCOVERED = "DISCOVERED"
    ENRICHING = "ENRICHING"
    QUALIFIED = "QUALIFIED"
    STORED = "STORED"

    # Final states (Principle 8) — a pipeline must end in exactly one.
    DELIVERED = "DELIVERED"
    REJECTED = "REJECTED"
    FAILED = "FAILED"


class WorkerState(str, Enum):
    """
    Phase 1.3 "Worker Lifecycle": every worker has exactly five
    *processing* states, reproduced below unchanged from the
    blueprint. Workers are stateless — all progress lives in queues,
    not in the worker itself.

        IDLE -> RESERVED -> WORKING -> COMPLETED -> IDLE
        WORKING -> FAILED -> IDLE

    Milestone 3C added CREATED and INITIALIZING in front of that
    cycle so BaseWorker (workers/base_worker.py) has an explicit
    pre-IDLE lifecycle to enforce — mirroring how Milestone 3A/3B gave
    SessionStatus an explicit pre-RUNNING lifecycle (CREATED ->
    STARTING -> RUNNING):

        CREATED -> INITIALIZING -> IDLE

    A freshly constructed worker starts in CREATED. Calling
    BaseWorker.initialize() moves it through INITIALIZING and lands it
    in IDLE — the first state of the unchanged five-state cycle above.
    Nothing from the original Phase 1.3 cycle was removed, renamed, or
    reordered; CREATED and INITIALIZING are pure bookkeeping states
    that exist only before a worker's first IDLE.

    TODO(Phase 3 — Worker Framework): the five Phase 1.3 states above
    are driven by BaseWorker.reserve() / start() / complete() / fail()
    / release() (workers/base_worker.py, Milestone 3C). Transition
    legality is enforced by BaseWorker's own _ALLOWED_TRANSITIONS
    table, not by this enum — no separate workers/worker_state.py was
    created for this. workers/worker_pool.py still has no concrete
    implementation.
    """

    CREATED = "CREATED"
    INITIALIZING = "INITIALIZING"
    IDLE = "IDLE"
    RESERVED = "RESERVED"
    WORKING = "WORKING"
    COMPLETED = "COMPLETED"
    FAILED = "FAILED"


class QueueItemState(str, Enum):
    """
    Phase 1.4 "Queue States": every QueueItem has exactly one state.

        WAITING -> RESERVED -> PROCESSING -> COMPLETED
        PROCESSING -> FAILED -> WAITING
        PROCESSING -> REJECTED

    TODO(Phase 4 — Queue Framework): driven by queue/manager.py,
    reservation.py (reservation + ACK), and retry_policy.py.
    """

    WAITING = "WAITING"
    RESERVED = "RESERVED"
    PROCESSING = "PROCESSING"
    COMPLETED = "COMPLETED"
    FAILED = "FAILED"
    REJECTED = "REJECTED"


class SessionStatus(str, Enum):
    """
    Coarse status for a DiscoverySession (see engine/session.py).
    Phase 1.3 "Session Completion": a session ends when the requested
    count is delivered, all providers are exhausted, the user cancels,
    or a fatal session error occurs.

    Milestone 3A added CREATED and STARTING so
    EngineCoordinator/SessionStateMachine (engine/coordinator.py) have
    an explicit pre-RUNNING lifecycle to enforce:

        CREATED -> STARTING -> RUNNING -> COMPLETED
        RUNNING -> CANCELLED
        RUNNING -> FAILED

    Milestone 3B made STARTING a real, independently-reachable state:
    EngineCoordinator.start_session() stops at STARTING and a separate
    EngineCoordinator.mark_running() call is required to reach RUNNING.
    This exists so that future "starting" work (worker allocation,
    queue creation, checkpoint loading, provider initialization) has
    an actual state to occupy, instead of being jumped over inside one
    opaque call.

    PENDING, PAUSED, and EXHAUSTED are left in place, unused by that
    transition table for now, as forward-compatible placeholders for
    future phases (Phase 1.4 backpressure / PAUSED, and provider
    exhaustion / EXHAUSTED) — removing them would be an unrelated
    change this milestone isn't scoped to make.

    TODO(Phase 2+): the coordinator (now: EngineCoordinator +
    SessionStateMachine, Milestone 3A) is the only writer of this
    status. Transition legality is enforced by
    SessionStateMachine._ALLOWED_TRANSITIONS, not by this enum.
    """

    CREATED = "CREATED"
    STARTING = "STARTING"
    PENDING = "PENDING"
    RUNNING = "RUNNING"
    PAUSED = "PAUSED"  # e.g. backpressure (Phase 1.4)
    COMPLETED = "COMPLETED"
    EXHAUSTED = "EXHAUSTED"  # fewer opportunities available than requested
    CANCELLED = "CANCELLED"
    FAILED = "FAILED"
