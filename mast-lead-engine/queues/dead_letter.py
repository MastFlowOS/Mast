"""
MAST Engine V2 — Dead Letter
===============================

Source: Engine BluePrint, Phase 1.4 ("Queue System, Concurrency &
Recovery" — "Retry Philosophy": "Retries belong to QueueItems...
Worker fails -> QueueItem retry count increases -> Queue reassigns
later"). Milestone 4.6 ("Dead Letter Runtime"), following on from
Milestone 4.5 ("Retry Policy") — see retry_policy.py's Status section
("A permanent failure (retries exhausted) will move it to
failed_count") and queue_record.py's TODO ("a permanent failure...
will move it to failed_count"), both of which anticipated this
milestone without building it.

Responsibility
--------------
DeadLetter is the immutable record of exactly one fact: *this
QueueItem permanently failed*. It carries identity, a timestamp, and a
structured reason — nothing else. This is the same shape of
responsibility QueueDefinition (queue_definition.py) and RetryPolicy
(retry_policy.py) already occupy elsewhere in queues/: a frozen
description of one fact, with no behavior attached.

DeadLetter answers only "did this QueueItem permanently fail, when,
and (broadly) why?" It does not answer, and this milestone does not
build:

    - *where* a permanently-failed QueueItem should go (there is no
      separate Dead Letter Queue — see the module docstring's
      "Explicitly not a queue" section below)
    - *whether* it should be retried again (that question belongs to
      Queue.can_retry() / RetryPolicy — retry_policy.py — and is
      answered before a caller ever decides to call
      Queue.dead_letter())
    - *who* decides a QueueItem is permanently failed (a future
      milestone's job — this module and Queue.dead_letter() only
      record that decision once made)

Explicitly not a queue
-----------------------
"Dead Letter" here names a runtime *fact* about one QueueItem, not a
second Queue that items move into. The QueueItem this DeadLetter
describes is never duplicated, moved, or removed from wherever it
already was (see queue.py's "Dead Letter Bookkeeping" section) — only
this metadata is created. A future milestone may build an actual
routing/scheduling mechanism that *uses* this bookkeeping to decide
where a QueueItem goes next; this module carries none of that.

Fields
------
    dead_letter_id      -- stable identifier for this DeadLetter
                            record, minted by Queue.dead_letter()
                            (uuid4 hex), never supplied by a caller —
                            mirrors how Queue.enqueue() mints
                            queue_item_id and Queue.reserve() mints
                            reservation_id.
    queue_item_id        -- which QueueItem this DeadLetter describes.
                            Carried for the same self-describing reason
                            RetryRecord carries queue_item_id even
                            though it is also the owning index's key
                            (retry_record.py).
    failed_at             -- when Queue.dead_letter() recorded this
                            permanent failure.
    reason                -- a structured DeadLetterReason (see below)
                            describing, at a category level, why this
                            QueueItem permanently failed. Kept
                            structured — rather than a free-form
                            string — specifically so future analytics
                            and debugging can group and filter dead
                            letters by category without parsing text
                            (per the Milestone 4.6 architecture
                            review).

Structured reason (architecture review)
------------------------------------------
`reason` is a DeadLetterReason enum member, not a free-form string.
The category set below is deliberately small and generic — it
describes *where in the pipeline* a permanent failure category
originates, not the specific error — because this module (like
RetryPolicy.strategy before it) does not interpret or branch on the
value; it only carries it.

    VALIDATION_FAILED  -- the QueueItem's payload or shape was
                            rejected before/without ever reaching a
                            Worker.
    RETRY_EXHAUSTED    -- Queue.can_retry() reported the QueueItem
                            ineligible for further attempts (Milestone
                            4.5's RetryPolicy.max_attempts reached).
    WORKER_FAILURE     -- a Worker itself failed while processing the
                            QueueItem, independent of the payload.
    PROVIDER_FAILURE   -- an external provider/dependency the Worker
                            relied on failed.
    UNKNOWN            -- catch-all for a permanent failure whose
                            category the caller cannot or does not
                            distinguish. Not a default silently
                            applied by this module — a caller must
                            still pass a reason explicitly; UNKNOWN is
                            simply one of the values it may pass.

`detail` is an optional, free-form human-readable string carried
alongside `reason` (e.g. an exception message or short explanation)
for debugging — exactly as free-form and exactly as uninterpreted as
RetryPolicy.strategy is elsewhere in this package. It adds context
without loosening `reason` itself back into a free-form field: every
DeadLetter is still filterable and groupable by its structured
category regardless of whether `detail` was supplied.

No Worker, no WorkerPool, no Provider, no Session, no Business logic
— this module does not import anything from workers/ or engine/, for
exactly the same reason retry_policy.py and reservation.py do not
(see those modules' docstrings and queues/README.md for the full
independence statement).

Status
------
FOUNDATION ONLY (Milestone 4.6). A plain, frozen data contract with no
behavior beyond the __post_init__ validation below (mirrors
QueueDefinition's, QueueItem's, and RetryPolicy's own __post_init__
validation pattern). It does not decide whether a QueueItem should be
dead-lettered — Queue.dead_letter() (queue.py) does that, by recording
one of these; this module only describes the resulting fact.

Explicitly NOT this module's job:
    - executing or scheduling anything
    - moving, duplicating, or removing the underlying QueueItem
    - deciding retry eligibility (RetryPolicy / Queue.can_retry()
      already answer that, upstream of this module)
    - notifying a Worker, WorkerPool, or QueueManager

TODO(future milestones):
    - A future Queue Framework milestone may build an actual routing
      mechanism (e.g. surfacing dead-lettered items to an operator, or
      to a separate storage backend) that reads DeadLetter records via
      Queue.dead_letter_count() / Queue.is_dead_letter(). Nothing here
      builds that; this milestone only answers "did this QueueItem
      permanently fail, when, and in what category?"
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from enum import Enum
from typing import Optional


class DeadLetterReason(Enum):
    """
    Structured category for why a QueueItem was permanently failed.
    See the module docstring's "Structured reason" section for what
    each value means and why this is an enum rather than a free-form
    string. This module does not branch on these values — no code
    anywhere treats one category differently from another; the
    structure exists purely so a DeadLetter's `reason` is filterable
    and groupable rather than free text.
    """

    VALIDATION_FAILED = "validation_failed"
    RETRY_EXHAUSTED = "retry_exhausted"
    WORKER_FAILURE = "worker_failure"
    PROVIDER_FAILURE = "provider_failure"
    UNKNOWN = "unknown"


@dataclass(frozen=True, slots=True)
class DeadLetter:
    """
    Immutable record of one permanent QueueItem failure. See the
    module docstring for exactly what is (and is not) carried, and
    why this is bookkeeping only rather than a second queue.

    Attributes
    ----------
    dead_letter_id:
        Identifier for this record, minted by Queue.dead_letter().
    queue_item_id:
        The QueueItem this record describes.
    failed_at:
        When Queue.dead_letter() recorded this permanent failure.
    reason:
        Structured DeadLetterReason category for the failure.
    detail:
        Optional free-form human-readable message alongside `reason`.
        Not interpreted by this module.
    """

    dead_letter_id: str
    queue_item_id: str
    failed_at: datetime
    reason: DeadLetterReason
    detail: Optional[str] = None

    def __post_init__(self) -> None:
        if not self.dead_letter_id:
            raise ValueError("DeadLetter.dead_letter_id must be a non-empty string")
        if not self.queue_item_id:
            raise ValueError("DeadLetter.queue_item_id must be a non-empty string")
        if not isinstance(self.reason, DeadLetterReason):
            raise ValueError(
                "DeadLetter.reason must be a DeadLetterReason member, "
                f"got {self.reason!r}"
            )
