"""
MAST Engine V2 — Queue Metrics
==================================

Source: Engine BluePrint, Phase 1.4 ("Queue System, Concurrency &
Recovery"), Architecture Decisions AD-017 ("The engine prioritizes
perceived speed" — performance priority order ending in "Resource
Utilization"). Milestone 4.7 ("Queue Metrics"), following on from
Milestone 4.2 ("Queue Reservations"), Milestone 4.3 ("Lease
Expiration"), Milestone 4.5 ("Retry Policy"), and Milestone 4.6
("Dead Letter Runtime") — this milestone introduces no new runtime
behavior of its own; it only observes what those milestones already
built.

Responsibility
--------------
QueueMetrics is the immutable snapshot of one Queue's operational
statistics at one instant. It carries numbers only — no QueueItems, no
Reservations, no Leases, no RetryRecords, no DeadLetters, and no
references back into the Queue that produced it. This is the same
shape of responsibility DeadLetter (dead_letter.py) already occupies
elsewhere in queues/: a frozen description of a fact, with no
behavior attached, produced by Queue and handed to a caller.

QueueMetrics answers only "what did this queue's operational picture
look like at generated_at?" It does not answer, and this milestone
does not build:

    - *why* the numbers are what they are (no history, no deltas, no
      trend — a snapshot has no memory of the snapshot before it)
    - *what to do* about the numbers (no alerting, no scaling
      decision, no autoscaling policy)
    - *who* should see the numbers (no export, no serialization
      format, no dashboard, no logging — Queue.metrics() simply
      returns one; what a caller does with it is entirely outside
      this milestone's scope)

Explicitly not a second source of truth
-----------------------------------------
A QueueMetrics instance is a snapshot, never the source of truth.
QueueRecord (queue_record.py), ReservationRecord
(reservation_record.py), the private retry index, and the private
dead-letter index remain exactly as authoritative as Milestones 4.1
through 4.6 already made them. QueueMetrics does not introduce a
parallel set of counters that Queue must remember to keep in sync —
Queue.metrics() computes every field of a QueueMetrics fresh, at
call time, by reading those existing counters and indexes under the
same lock that already guards them (see queue.py's "Metrics
(Milestone 4.7)" section). A QueueMetrics instance is immediately
stale the moment anything about the queue changes after it was
generated_at — this is expected and correct for a snapshot, exactly
as it would be for a photograph.

Fields
------
    queue_id            -- which queue this snapshot describes
                            (matches the owning Queue's
                            QueueDefinition.queue_id).
    generated_at         -- when Queue.metrics() produced this
                            snapshot. Not the same as any individual
                            counter's own timestamp (e.g.
                            QueueRecord.created_at) — this is the
                            moment the snapshot itself was taken.
    pending_items        -- items currently waiting in this queue's
                            FIFO storage, not yet dequeued. Read from
                            Queue's own FIFO storage at snapshot time
                            (equivalent to Queue.size()).
    reserved_items        -- items with an active reservation right
                            now. Read from ReservationRecord's
                            active_count (reservation_record.py) —
                            not recomputed by walking the reservation
                            index, since ReservationRecord already
                            keeps that count live (Milestone 4.2/4.3).
    active_leases         -- reservations above that additionally
                            carry an unexpired Lease right now. Read
                            from ReservationRecord's
                            active_lease_count — a subset of
                            reserved_items, exactly as
                            active_lease_count is documented as a
                            subset of active_count in
                            reservation_record.py.
    retrying_items         -- QueueItems that have recorded at least
                            one failed attempt (Milestone 4.5's
                            record_attempt()) and remain eligible for
                            a further attempt right now (their
                            RetryRecord.eligible_for_retry is True).
                            Not the same as "every QueueItem that has
                            ever failed once" — an item whose retries
                            are exhausted (or that has since been
                            dead-lettered) is no longer counted here,
                            because it is no longer, in any live
                            sense, "retrying".
    dead_letter_items      -- QueueItems this queue has permanently
                            failed via Milestone 4.6's dead_letter().
                            Read from DeadLetterRecord's
                            total_dead_letters — cumulative and
                            monotonically non-decreasing, exactly as
                            Queue.dead_letter_count() already reports
                            it.
    total_processed        -- QueueRecord.completed_count +
                            QueueRecord.failed_count at snapshot time.
                            completed_count is always 0 as of this
                            milestone (queue_record.py's Milestone 4.1
                            TODO — the successful-completion/ACK
                            concept it represents has not been built
                            yet), so total_processed currently equals
                            failed_count exactly; the sum is used
                            rather than failed_count alone so this
                            field requires no further change on the
                            day completed_count does become live.
    utilization           -- reserved_items / (pending_items +
                            reserved_items), or 0.0 if that sum is
                            zero (an idle queue with nothing pending
                            and nothing reserved is 0.0 utilized, not
                            undefined). A float in [0.0, 1.0]
                            describing what fraction of this queue's
                            currently-tracked work (waiting plus being
                            worked on) is being worked on right now.
                            This queue has no configured capacity or
                            concurrency ceiling for this milestone's
                            scope (no such field exists on
                            QueueDefinition), so utilization is
                            deliberately defined relative to this
                            queue's own current work, not against any
                            external limit — see Queue.utilization()
                            in queue.py for the identical calculation
                            performed standalone.

Status
------
FOUNDATION ONLY (Milestone 4.7). A plain, frozen data contract with no
behavior beyond the __post_init__ validation below (mirrors
DeadLetter's, QueueDefinition's, and RetryPolicy's own __post_init__
validation pattern). It does not collect its own fields — Queue's new
metrics() method (queue.py) does that, under Queue's existing lock,
by reading QueueRecord, ReservationRecord, the retry index, and the
dead-letter record that Milestones 4.1 through 4.6 already built and
maintain; this module only describes the resulting snapshot.

Explicitly NOT this module's job:
    - executing, scheduling, retrying, or expiring anything
    - allocating, notifying, or knowing about a Worker, WorkerPool,
      or WorkerAllocator
    - knowing about a Provider or a Session
    - releasing a reservation or otherwise mutating any queue state
    - deciding what counts as "too high" utilization, or doing
      anything in response to that question

No Worker, no WorkerPool, no Provider, no Session, and no Business
logic — this module does not import anything from workers/ or
engine/, for exactly the same reason dead_letter.py and lease.py do
not (see those modules' docstrings and queues/README.md for the full
independence statement).

TODO(future milestones):
    - Once a successful-completion/ACK mechanism exists and
      QueueRecord.completed_count becomes live (see queue_record.py's
      TODO), total_processed on this snapshot will reflect it
      automatically — no change to this module is anticipated.
    - A future monitoring/allocation-policy layer (anticipated by
      queue_record.py's own module docstring) may consume
      QueueMetrics snapshots to make scaling or alerting decisions.
      Nothing here builds that; this milestone only answers "what did
      the numbers look like just now?"
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime


@dataclass(frozen=True, slots=True)
class QueueMetrics:
    """
    Immutable snapshot of one Queue's operational statistics at one
    instant. See the module docstring for exactly what is (and is
    not) carried, and why this is a snapshot rather than a second
    source of truth.

    Attributes
    ----------
    queue_id:
        The queue this snapshot describes.
    generated_at:
        When Queue.metrics() produced this snapshot.
    pending_items:
        Items currently waiting in FIFO storage.
    reserved_items:
        Items with an active reservation right now.
    active_leases:
        Active reservations that additionally carry an unexpired
        Lease right now (a subset of reserved_items).
    retrying_items:
        Items that have failed at least once and remain eligible for
        a further attempt right now.
    dead_letter_items:
        Items permanently failed via dead_letter() (cumulative).
    total_processed:
        completed_count + failed_count at snapshot time.
    utilization:
        reserved_items / (pending_items + reserved_items), or 0.0 if
        that sum is zero.
    """

    queue_id: str
    generated_at: datetime
    pending_items: int
    reserved_items: int
    active_leases: int
    retrying_items: int
    dead_letter_items: int
    total_processed: int
    utilization: float

    def __post_init__(self) -> None:
        if not self.queue_id:
            raise ValueError("QueueMetrics.queue_id must be a non-empty string")
        for field_name in (
            "pending_items",
            "reserved_items",
            "active_leases",
            "retrying_items",
            "dead_letter_items",
            "total_processed",
        ):
            value = getattr(self, field_name)
            if value < 0:
                raise ValueError(f"QueueMetrics.{field_name} must be >= 0, got {value!r}")
        if self.active_leases > self.reserved_items:
            raise ValueError(
                "QueueMetrics.active_leases must not exceed reserved_items "
                f"(got active_leases={self.active_leases!r}, "
                f"reserved_items={self.reserved_items!r})"
            )
        if not (0.0 <= self.utilization <= 1.0):
            raise ValueError(
                f"QueueMetrics.utilization must be in [0.0, 1.0], got {self.utilization!r}"
            )
