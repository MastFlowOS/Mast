"""
MAST Engine V2 — Queue Item
==============================

Source: Engine BluePrint, Phase 1.4 ("Queue System, Concurrency &
Recovery" — "Queues own work"). Milestone 4.1 ("Queue Manager").

Responsibility
--------------
QueueItem is the immutable unit of work a Queue (queues/queue.py)
stores. It carries just enough to identify the work and where it came
from — nothing about who processes it or what engine concept it
belongs to.

    queue_item_id     -- identifies this item within its queue. Minted
                          by Queue.enqueue() (uuid4 hex), never
                          supplied by a caller — mirrors how
                          WorkerAllocator mints reservation_id
                          (workers/worker_allocator.py) rather than
                          accepting one.
    pipeline_id        -- Phase 1.4 "Pipeline Ownership": the constant
                          identity of the Business this item belongs
                          to, unchanged as it moves through every
                          future queue (Discovery -> Enrichment ->
                          Qualification -> Storage).
    stage              -- which pipeline stage this item represents
                          (free-form string — see QueueDefinition's
                          docstring in queue_definition.py for why).
    payload            -- the actual data being carried. Untyped
                          (Any) at this layer on purpose: Phase 1.4
                          describes QueueItem as "the universal wrapper
                          every queue stores" regardless of whether the
                          payload is a BusinessCandidate, an
                          EnrichedBusiness, or a QualifiedOpportunity
                          (engine/contracts.py) — this module does not
                          pick one.
    created_at          -- when Queue.enqueue() created this item.
    retry_count         -- carried, immutable data only this
                          milestone. Phase 1.4 ("Retry Philosophy":
                          "Retries belong to QueueItems... QueueItem
                          retry count increases") makes clear this
                          field's *eventual* meaning, but this
                          milestone's Queue does not implement retry
                          logic ("No retries" is explicitly in scope
                          as an exclusion) — nothing here increments
                          it. It is present now, always 0, only so a
                          future retry milestone has a field to
                          populate on a *new* QueueItem it constructs,
                          without changing this contract's shape.

No Worker, no Session, no Business logic, and no Provider reference —
this module does not import anything from workers/ or engine/, on
purpose (see queues/README.md for why QueueManager as a whole stays
independent of worker infrastructure).

Status
------
FOUNDATION ONLY (Milestone 4.1). A plain, frozen data contract with no
behavior beyond the __post_init__ validation below (mirrors
AllocationResult's and QueueDefinition's own __post_init__ validation
pattern). QueueItems never move backwards and are never mutated after
creation — a future retry/reservation milestone constructs a *new*
QueueItem (e.g. with an incremented retry_count) rather than mutating
this one in place, exactly like every object in engine/contracts.py
following Phase 1.2's Golden Rule.

Relationship to engine.contracts.QueueItem
--------------------------------------------
engine/contracts.py already defines its own, differently-shaped
QueueItem (with session_id, state, attempt, last_updated, worker_id,
and timeout_at — the full reservation/heartbeat contract anticipated
for Phase 4's eventual reservation model). This module's QueueItem is
a deliberately smaller contract, scoped to exactly the six fields this
milestone's spec calls for (queue_item_id, pipeline_id, stage,
payload, created_at, retry_count) and to exactly what this milestone's
strictly-FIFO Queue needs to store. Reconciling the two — e.g. having
a future reservation-aware Queue construct/consume
engine.contracts.QueueItem instead of (or wrapping) this one — is a
Phase 4.2+ decision, not made here. This file does not modify
engine/contracts.py, per this milestone's scope.

Reservation relationship (Milestone 4.2)
------------------------------------------
A QueueItem is conceptually either **Unreserved** (no Worker
currently owns it) or **Reserved** (exactly one Worker owns it via a
Reservation, reservation.py) — never both, per Phase 1.4's
"Reservation Model". This milestone deliberately does NOT add a
`reservation` field to this dataclass to represent that. Doing so
would mean either mutating a QueueItem in place (forbidden — see the
module docstring above and Phase 1.2's Golden Rule) or constructing a
brand-new QueueItem on every reserve()/release() call just to flip
one reference, which would mint a new queue_item_id-bearing identity
for work that has not actually changed.

Instead, "is this QueueItem reserved, and by whom" is tracked
externally, by the owning Queue, in a private queue_item_id ->
Reservation index (see queue.py's module docstring). This QueueItem
stays exactly as immutable and exactly as small as Milestone 4.1 left
it; Queue.is_reserved() / Queue.reservation() are how a caller answers
the Reserved/Unreserved question for a given queue_item_id, not a
field read directly off this object.

Retry ownership (Milestone 4.5)
----------------------------------
Phase 1.4's "Retry Philosophy" ("QueueItem retry count increases")
anticipated a live counter living on this object. Milestone 4.5
("Retry Policy") deliberately does NOT implement that here, for
exactly the same reason Milestone 4.2 kept reservations off this
object (see "Reservation relationship" above): mutating a frozen
QueueItem in place is forbidden, and constructing a brand-new
QueueItem on every failed attempt just to bump one counter would mint
a new queue_item_id-bearing identity for work that has not actually
changed.

Instead, "how many times has this QueueItem been attempted, and is it
still eligible for another" is tracked externally, by the owning
Queue, in a private queue_item_id -> RetryRecord index (see
retry_record.py and queue.py's module docstring) — the same shape as
the existing queue_item_id -> Reservation index. Queue.can_retry() /
Queue.record_attempt() / Queue.attempt_count() (queue.py) are how a
caller answers retry questions for a given queue_item_id; this
QueueItem carries nothing new to support it, referencing that
external bookkeeping only implicitly, by the queue_item_id it already
had.

The `retry_count` field below remains exactly as Milestone 4.1 left
it: present, always 0, and never written by this milestone's Queue.
It is not the live retry counter — RetryRecord.attempts is. The two
are deliberately not unified this milestone, to avoid changing this
contract's shape; see the TODO below.

Dead letter ownership (Milestone 4.6)
-----------------------------------------
A permanently-failed QueueItem is answered the same way Milestone 4.2
answers Reserved/Unreserved and Milestone 4.5 answers retry
eligibility: externally, not as a field on this object. This module
gains no `dead_letter` flag, no `failed` flag, and no `reason` field —
for exactly the reason given in "Reservation relationship" and "Retry
ownership" above: mutating a frozen QueueItem in place is forbidden,
and constructing a brand-new QueueItem just to flip one flag would
mint a new queue_item_id-bearing identity for work that has not
actually changed.

Instead, "has this QueueItem permanently failed, when, and why" is
tracked externally, by the owning Queue, in a private queue_item_id ->
DeadLetter index (see dead_letter.py and queue.py's module docstring)
— the same shape as the existing queue_item_id -> Reservation and
queue_item_id -> RetryRecord indexes. Queue.is_dead_letter() /
Queue.dead_letter() (queue.py) are how a caller answers dead-letter
questions for a given queue_item_id; this QueueItem carries nothing
new to support it, referencing that external bookkeeping only
implicitly, by the queue_item_id it already had. Runtime owns
failures — this contract does not.

TODO(future milestones):
    - Phase 4.2+ (Queue Framework): reservation.py will need a
      reservation state and owner beyond what this module carries;
      that will most likely be layered on by constructing the richer
      engine.contracts.QueueItem (or a new wrapper) rather than adding
      fields here, to keep this milestone's contract stable.
    - Reconciling the dormant `retry_count` field with the live
      RetryRecord.attempts counter (retry_record.py) — e.g.
      deprecating one in favor of the other, or having a future
      re-enqueue construct a new QueueItem whose retry_count mirrors
      its RetryRecord — is a decision for whichever milestone actually
      executes retries (not this one; see retry_policy.py's Status
      section).
    - A future routing milestone that acts on Queue.is_dead_letter()
      (e.g. moving a permanently-failed QueueItem's payload elsewhere)
      is expected to construct a new object for that destination
      rather than mutating this QueueItem, exactly as every other
      transition in this module does.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Any, Optional


@dataclass(frozen=True, slots=True)
class QueueItem:
    """
    Immutable unit of work stored by one Queue. See the module
    docstring for exactly what is (and is not) carried, and why this
    is a separate, smaller contract from engine.contracts.QueueItem.

    Attributes
    ----------
    queue_item_id:
        Identifier for this item, minted by Queue.enqueue().
    pipeline_id:
        The constant Business identity this item belongs to (Phase
        1.4 "Pipeline Ownership").
    stage:
        Which pipeline stage this item represents. Optional,
        free-form.
    payload:
        The data being carried. Untyped at this layer.
    created_at:
        When this item was enqueued.
    retry_count:
        Carried only; never incremented by this milestone's Queue.

    Note on reservations (Milestone 4.2): this object has no
    reservation field. Whether a given queue_item_id is currently
    Reserved or Unreserved, and by which worker_id, is answered by the
    owning Queue's is_reserved() / reservation() methods, not by an
    attribute here — see the module docstring's "Reservation
    relationship" section for why.

    Note on retries (Milestone 4.5): this object gains no new field
    either. Whether a given queue_item_id may still be retried, and
    how many attempts it has accumulated, is answered by the owning
    Queue's can_retry() / attempt_count() methods, not by an attribute
    here — see the module docstring's "Retry ownership" section for
    why. `retry_count` below stays exactly as inert as Milestone 4.1
    left it.

    Note on dead letters (Milestone 4.6): this object gains no new
    field either. Whether a given queue_item_id has permanently
    failed, and why, is answered by the owning Queue's
    is_dead_letter() / dead_letter() methods, not by an attribute here
    — see the module docstring's "Dead letter ownership" section for
    why.
    """

    queue_item_id: str
    pipeline_id: str
    stage: Optional[str]
    payload: Optional[Any]
    created_at: datetime
    retry_count: int = 0

    def __post_init__(self) -> None:
        if not self.queue_item_id:
            raise ValueError("QueueItem.queue_item_id must be a non-empty string")
        if not self.pipeline_id:
            raise ValueError("QueueItem.pipeline_id must be a non-empty string")
        if self.retry_count < 0:
            raise ValueError("QueueItem.retry_count must be >= 0")
