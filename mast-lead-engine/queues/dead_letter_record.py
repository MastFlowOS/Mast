"""
MAST Engine V2 — Dead Letter Record
=======================================

Source: Engine BluePrint, Phase 1.4 ("Queue System, Concurrency &
Recovery" — "Retry Philosophy"). Milestone 4.6 ("Dead Letter
Runtime").

Responsibility
--------------
DeadLetterRecord is the mutable runtime metadata for one Queue's
accumulated dead letters — counters only, never the DeadLetter records
themselves (see the private `_DeadLetterIndex` in queue.py for those)
and never the QueueItems they describe. It exists so a caller can read
"how many QueueItems has this queue permanently failed, and when was
the last one?" without walking the queue's private dead-letter index.

This is the same shape of responsibility QueueRecord (queue_record.py)
already has for FIFO counters and ReservationRecord already has for
reservation counters: live, mutable, aggregate bookkeeping, kept
separate from the immutable per-fact contract (DeadLetter,
dead_letter.py) it summarizes — one DeadLetterRecord per Queue,
alongside potentially many DeadLetter records (one per dead-lettered
QueueItem).

Fields
------
    queue_id             -- which queue this record describes
                            (matches the owning Queue's
                            QueueDefinition.queue_id). Carried for the
                            same self-describing reason QueueRecord
                            and ReservationRecord both carry queue_id
                            even though it is also the owning Queue's
                            dict key.
    created_at             -- when the owning Queue was created (same
                            convention as QueueRecord.created_at and
                            ReservationRecord.created_at).
    total_dead_letters     -- cumulative number of times
                            Queue.dead_letter() has succeeded for this
                            queue. Monotonically non-decreasing — no
                            code decrements it (a QueueItem's dead
                            letter is a permanent fact; this milestone
                            has no "un-dead-letter" operation).
    last_dead_letter_at    -- when the most recent successful
                            Queue.dead_letter() call was recorded, or
                            None if none ever has been.

Status
------
FOUNDATION ONLY (Milestone 4.6). A plain, mutable data container with
no behavior of its own — Queue.dead_letter() / dead_letter_count()
(queue.py) read and mutate it under Queue's existing lock; this module
does not decide when a QueueItem should be dead-lettered and does not
know what a DeadLetter's reason means (it has no reference to one —
see the module docstring's "Fields" section: this record carries
counters only, never a DeadLetter or a DeadLetterReason).
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Optional


@dataclass(slots=True)
class DeadLetterRecord:
    """
    Mutable runtime counters for one Queue's dead letters. No
    DeadLetter records, no QueueItems, no Workers — see the module
    docstring for exactly what is (and is not) tracked here, and by
    whom.

    Deliberately NOT frozen (unlike DeadLetter itself): Queue owns
    one DeadLetterRecord per queue and mutates its counters in place,
    under its own lock, on every successful dead_letter() call — see
    queue.py.
    """

    queue_id: str
    created_at: datetime
    total_dead_letters: int = 0
    last_dead_letter_at: Optional[datetime] = None
