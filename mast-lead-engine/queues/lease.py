"""
MAST Engine V2 — Lease
=========================

Source: Engine BluePrint, Phase 1.4 ("Queue System, Concurrency &
Recovery" — "Reservation Model": "Reservation expiration returns the
QueueItem to the Queue." / "Fairness": "If a Worker exceeds its
reservation timeout, the reservation expires and another Worker may
continue."), AD-019 ("Reservations prevent duplicate processing").
Milestone 4.3 ("Lease Expiration").

Responsibility
--------------
Lease is the immutable record of *when* one Reservation
(reservation.py) stops being valid. It answers exactly one question:

    "Until when is this reservation good for, and how do I recognize
    the specific grant that answers that?"

Splitting this out of Reservation itself (which, prior to this
milestone, carried expires_at directly) mirrors every other split
already established in this package: Reservation is one immutable
fact about *ownership* (who owns a QueueItem); Lease is one immutable
fact about *time* (until when that ownership is good for). Neither
one is the other, exactly like a Reservation is not a QueueItem and a
ReservationRecord is not a Reservation.

Fields
------
    lease_id        -- stable identifier for this lease, minted by
                        Queue.reserve() (uuid4 hex) whenever a caller
                        supplies a ttl_seconds, never supplied by a
                        caller — mirrors how Queue.reserve() mints
                        Reservation.reservation_id rather than
                        accepting one.
    reservation_id  -- which Reservation this lease belongs to.
                        Exactly one Lease may exist for a given
                        reservation_id at a time; a Reservation with
                        no ttl_seconds at reserve()-time has no Lease
                        at all (an unleased reservation never expires
                        on its own — see queue.py).
    created_at       -- when this lease was created (equal to the
                         owning Reservation's reserved_at — a lease's
                         clock starts the moment the reservation is
                         granted, not later).
    expires_at       -- when this lease lapses. A Lease always has a
                         concrete expires_at (unlike the old
                         Reservation.expires_at, which could be None
                         for "never expires") — a Reservation that
                         should never expire simply has no Lease,
                         rather than a Lease with no expiry.

No Worker, no WorkerPool, no WorkerAllocator, no Provider, no Session,
and no Business logic — this module does not import anything from
workers/ or engine/, on purpose, for exactly the same reason
reservation.py does not (see that module's docstring and
queues/README.md for the full independence statement).

Status
------
FOUNDATION + BEHAVIOR (Milestone 4.3). Unlike Reservation and
QueueItem, a Lease is not purely passive data this milestone — Queue's
expire_leases() (queue.py) actively compares Lease.expires_at against
the current time and reclaims lapsed reservations. This module itself
still contains no behavior beyond __post_init__ validation; the
clock-comparison and reclaim logic lives entirely in queue.py, exactly
as reservation.py describes reserve()/release() logic living in
queue.py rather than on Reservation.

Explicitly NOT this module's job (see queue.py for where the one
piece of real behavior — expiration — lives instead):
    - deciding whether a worker is still alive (no heartbeat; that is
      Phase 4.4, not this milestone)
    - deciding whether an expired reservation should be retried (no
      retry logic exists anywhere in this milestone)
    - notifying anyone that a lease expired (no callbacks, no
      logging — queue.py's expire_leases() only removes state)
    - re-enqueueing or otherwise touching the underlying QueueItem's
      payload — the QueueItem was never removed from FIFO storage by
      reserve() in the first place, so nothing needs to be "returned"
      to it beyond dropping its reservation (see queue.py)

TODO(future milestones):
    - Phase 4.4 (Worker Liveness): heartbeat.py will layer worker
      health signals on top of leases (e.g. a worker actively
      renewing/extending a Lease while healthy). Nothing in this
      module anticipates that shape yet — expires_at is a fixed
      timestamp set once at reserve()-time, not renewed here.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime


@dataclass(frozen=True, slots=True)
class Lease:
    """
    Immutable record of when one Reservation's ownership of a
    QueueItem lapses. See the module docstring for exactly what is
    (and is not) carried, and why this is a separate object from
    Reservation.

    Attributes
    ----------
    lease_id:
        Identifier for this lease, minted by Queue.reserve().
    reservation_id:
        The Reservation this lease belongs to.
    created_at:
        When this lease was created (== the owning Reservation's
        reserved_at).
    expires_at:
        When this lease lapses. Always set — a Lease with no expiry
        does not exist; a reservation that should never expire simply
        has no Lease at all (see queue.py's reserve()).
    """

    lease_id: str
    reservation_id: str
    created_at: datetime
    expires_at: datetime

    def __post_init__(self) -> None:
        if not self.lease_id:
            raise ValueError("Lease.lease_id must be a non-empty string")
        if not self.reservation_id:
            raise ValueError("Lease.reservation_id must be a non-empty string")
        if self.expires_at <= self.created_at:
            raise ValueError(
                "Lease.expires_at must be strictly after created_at"
            )
