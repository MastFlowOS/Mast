"""
MAST Engine V2 — Worker Context
=================================

Source: Engine BluePrint, Phase 1.3 ("Worker Lifecycle", "Dynamic
Worker Allocation") and Phase 1.4 ("Reservation System", "Queue
Ownership").

Responsibility
--------------
WorkerContext is the runtime assignment record for exactly one
worker: which session currently has it reserved, which pipeline item
(if any) it is working, which queue reservation that corresponds to,
and when that assignment happened. It carries no business data — no
BusinessCandidate, no intel, no scores, nothing produced or consumed
by process(). Per Phase 1.4 ("Queue Ownership"), a business belongs to
a QueueItem, never to a worker; WorkerContext only records the fact of
the assignment, not the work item itself.

A worker with no active reservation has no WorkerContext
(BaseWorker.context is None). BaseWorker.reserve() creates one;
BaseWorker.release() discards it — matching Phase 1.3 "Workers are
stateless. All progress lives in queues."

pipeline_id and reservation_id are Optional because a Discovery Worker
(Phase 1.3, worker type 1) is reserved for a discovery task, not an
existing pipeline item — it is the one worker type whose job is to
*create* the pipeline ID (as part of the BusinessCandidate it
produces), not consume one that already exists.

Status
------
FOUNDATION ONLY (Milestone 3C). Constructed and replaced (never
mutated) by workers/base_worker.py's lifecycle methods. Nothing in the
currently running V1 engine constructs or reads this object.

TODO(future milestones):
    - Phase 4 (Queue Framework): reservation_id will be populated from
      a real queue/reservation.py reservation instead of being
      caller-supplied.
    - Phase 6+: concrete workers will read current_pipeline /
      current_session (via BaseWorker) for logging and metrics rather
      than reading this object directly.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Optional


@dataclass(frozen=True)
class WorkerContext:
    """
    Immutable runtime assignment record for one worker.

    Per Phase 1.2 Rule #1 ("Objects are immutable. Workers don't
    modify objects—they produce new ones."), a WorkerContext is never
    mutated in place. BaseWorker.start(), for example, replaces it
    with a new WorkerContext rather than setting started_at on the
    existing one.

    Attributes
    ----------
    worker_id:
        The worker this context belongs to. A WorkerContext is never
        shared between workers.
    session_id:
        The DiscoverySession (Phase 1.1) this assignment belongs to.
    pipeline_id:
        The pipeline item (Phase 1.1 Principle 3) this worker is
        reserved for. None for a Discovery Worker reservation, which
        has no pipeline_id yet — see module docstring.
    reservation_id:
        The queue reservation (Phase 1.4 "Reservation System") this
        assignment corresponds to. None until a real queue exists
        (Phase 4) to issue one.
    assigned_at:
        When BaseWorker.reserve() created this context.
    started_at:
        When BaseWorker.start() began work under this context. None
        while the worker is still only RESERVED, not yet WORKING.
    """

    worker_id: str
    session_id: Optional[str] = None
    pipeline_id: Optional[str] = None
    reservation_id: Optional[str] = None
    assigned_at: Optional[datetime] = None
    started_at: Optional[datetime] = None
