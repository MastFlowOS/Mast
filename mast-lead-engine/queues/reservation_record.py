"""
MAST Engine V2 — Reservation Record
======================================

Source: Engine BluePrint, Phase 1.4 ("Queue System, Concurrency &
Recovery" — "Reservation Model"). Milestone 4.2 ("Queue Reservations"),
revised Milestone 4.3 ("Lease Expiration").

Responsibility
--------------
ReservationRecord is the mutable runtime metadata for one Queue's
reservations — counters only, never the Reservations themselves, never
the Leases (lease.py) attached to some of them, never the QueueItems
they point at, and never a Worker. It exists so a caller (or, later, a
monitoring layer — see the precedent set by QueueRecord in
queue_record.py) can read "how much reservation/lease activity has
this queue seen?" without walking the queue's internal reservation or
lease indexes.

This mirrors the split Queue/QueueRecord already establish for FIFO
storage: a Reservation (reservation.py) is one immutable fact, a Lease
(lease.py) is one immutable fact about that fact's timing, and this
record is live counters describing many of them over time; none of
these is the index that maps a QueueItem to its current Reservation,
or a Reservation to its current Lease (those indexes are Queue's own
private implementation detail — see queue.py).

Fields
------
    queue_id           -- which queue this record describes (matches
                          the owning Queue's QueueDefinition.queue_id).
    created_at          -- when the owning Queue's reservation
                          bookkeeping was created (i.e. when the Queue
                          itself was constructed).
    active_count        -- reservations currently outstanding (created
                          by Queue.reserve(), not yet released or
                          expired). Driven by Queue.reserve() /
                          release() / expire_leases().
    completed_count     -- reservations that ended because the
                          underlying work finished successfully.
                          Always 0 this milestone — see Status below.
    expired_count       -- reservations that ended because their lease
                          lapsed before a Worker released them.
                          Driven by Queue.expire_leases() as of
                          Milestone 4.3 (previously always 0 — see
                          Status below).
    active_lease_count  -- (Milestone 4.3) leases currently
                          outstanding: reservations created with a
                          ttl_seconds, not yet released or expired.
                          A subset of active_count — a reservation
                          created without a ttl_seconds has no lease
                          and is never counted here. Driven by
                          Queue.reserve() / release() /
                          expire_leases().
    expired_lease_count -- (Milestone 4.3) leases that have lapsed
                          (expires_at reached) and been reclaimed by
                          Queue.expire_leases(). Equal to
                          expired_count this milestone, since the only
                          way a reservation currently expires is via
                          its lease lapsing — kept as a separate field
                          because "leases expired" and "reservations
                          expired" are conceptually distinct counters
                          that could diverge under a future expiration
                          mechanism that is not lease-based.

Status
------
FOUNDATION + LIVE (Milestone 4.2 foundation, Milestone 4.3 makes
expired_count / active_lease_count / expired_lease_count live).
Queue keeps active_count in sync with its own reservation index on
every reserve()/release()/expire_leases() call, and keeps
active_lease_count / expired_lease_count in sync with its own lease
index on every reserve()/release()/expire_leases() call that involves
a leased reservation. completed_count is still always 0 — the concept
it represents (a completion/ACK signal) does not exist yet.

No retry information is tracked here, on purpose — retries belong to
QueueItem (Phase 1.4 "Retry Philosophy"), not to reservation
bookkeeping, and no retry logic exists anywhere in Milestone 4.3.

TODO(future milestones):
    - Phase 4.4 (Worker Liveness): heartbeat.py may introduce
      liveness-driven signals distinct from lease expiration. Whether
      those move counters here or elsewhere is not decided by this
      milestone.
    - A future ACK mechanism will move a successfully-finished
      reservation from active_count to completed_count. None of that
      transition logic lives here — ReservationRecord is counters
      only, exactly like QueueRecord is counters only and not a state
      machine.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime


@dataclass(slots=True)
class ReservationRecord:
    """
    Mutable runtime counters for one Queue's reservations and leases.
    No Reservations, no Leases, no QueueItems, no Workers — see the
    module docstring for exactly what is (and is not) tracked here,
    and by whom.

    Deliberately NOT frozen (unlike Reservation and Lease themselves):
    Queue owns one ReservationRecord per queue and mutates its
    counters in place, under its own lock, on every
    reserve()/release()/expire_leases() call — see queue.py.
    """

    queue_id: str
    created_at: datetime
    active_count: int = 0
    completed_count: int = 0
    expired_count: int = 0
    active_lease_count: int = 0
    expired_lease_count: int = 0
