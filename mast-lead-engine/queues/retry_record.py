"""
MAST Engine V2 — Retry Record
================================

Source: Engine BluePrint, Phase 1.4 ("Queue System, Concurrency &
Recovery" — "Retry Philosophy": "Retries belong to QueueItems...
QueueItem retry count increases... Queue reassigns later"). Milestone
4.5 ("Retry Policy").

Responsibility
--------------
RetryRecord is the mutable runtime metadata for one QueueItem's retry
history within one Queue. It answers exactly one question:

    "How many times has this QueueItem been attempted, and is it
    still eligible to be attempted again?"

It carries counters and a timestamp only — no QueueItem, no Worker, no
Provider, no Business logic, and no payload. This is the same shape of
responsibility ReservationRecord has for reservation counters and
QueueRecord (queue_record.py) has for queue-wide counters: live,
mutable bookkeeping, kept separate from the immutable contracts
(QueueItem, RetryPolicy) it describes.

Ownership
---------
Unlike QueueRecord (one per Queue) or ReservationRecord (one per
Queue, aggregate counters), a RetryRecord is **one per QueueItem**:
Queue owns a private index — queue_item_id -> RetryRecord — mirroring
exactly how Queue already owns a private queue_item_id -> Reservation
index (see queue_item.py's "Reservation relationship" section and
queue.py's `_ReservationIndex`). A RetryRecord is created lazily, on
a QueueItem's first recorded attempt (Queue.record_attempt() —
queue.py) — a QueueItem that has never failed has no RetryRecord at
all, exactly as a QueueItem that has never been reserved has no
Reservation.

This index deliberately does **not** check whether `queue_item_id` is
still present in the owning Queue's FIFO storage (unlike reserve(),
which requires the item to still be enqueued — see queue.py's
_find_item()). A retry decision is normally made *after* a QueueItem
has already left FIFO storage (dequeued for processing, or
dequeued/released following a reservation) and failed — by the time
Queue.record_attempt() is called, the QueueItem is typically no longer
sitting in the deque at all. Requiring presence would make retry
bookkeeping impossible for the exact case it exists to serve.

Fields
------
    queue_item_id       -- which QueueItem this record describes.
                            Carried for the same self-describing reason
                            QueueRecord carries queue_id even though it
                            is also the owning Queue's dict key.
    attempts              -- number of times Queue.record_attempt() has
                            been called for this queue_item_id. Starts
                            at 0 (Milestone 4.5 rule: "attempt count
                            starts at zero") and only ever increases —
                            no code decrements it.
    last_attempt_at       -- when the most recent attempt was recorded,
                            or None if record_attempt() has never been
                            called for this queue_item_id.
    eligible_for_retry    -- whether this QueueItem may still be
                            retried, per the owning Queue's
                            RetryPolicy (retry_policy.py). Recomputed
                            by Queue.record_attempt() on every call
                            (attempts < policy.max_attempts); read
                            directly by Queue.can_retry() rather than
                            recomputed there, so this field is always
                            the single source of truth for a
                            QueueItem that has at least one recorded
                            attempt.

Status
------
FOUNDATION ONLY (Milestone 4.5). A plain, mutable data container with
no behavior of its own — Queue.can_retry() / record_attempt() /
attempt_count() (queue.py) read and mutate it under Queue's existing
lock; this module does not decide eligibility, does not compare
against a RetryPolicy, and does not know what a RetryPolicy is (it has
no reference to one — see the module docstring's "Fields" section:
`eligible_for_retry` is a plain bool this record carries, not
something it computes itself).

Explicitly NOT this module's job (see queue.py for where retry
bookkeeping behavior lives instead, and retry_policy.py for what
remains genuinely unbuilt):
    - deciding *when* a retry should run (no delay, no timer)
    - deciding *who* retries the QueueItem (no worker_id anywhere)
    - deciding *where* an ineligible QueueItem goes (no Dead Letter
      Queue reference)
    - re-enqueueing, dequeuing, or otherwise touching the QueueItem
      or its payload
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Optional


@dataclass(slots=True)
class RetryRecord:
    """
    Mutable runtime retry metadata for one QueueItem. No QueueItems,
    no Workers, no Providers — see the module docstring for exactly
    what is (and is not) tracked here, and by whom.

    Deliberately NOT frozen (unlike QueueItem and RetryPolicy): Queue
    owns one RetryRecord per retried queue_item_id and mutates its
    counters in place, under its own lock, on every record_attempt()
    call — see queue.py.
    """

    queue_item_id: str
    attempts: int = 0
    last_attempt_at: Optional[datetime] = None
    eligible_for_retry: bool = True
