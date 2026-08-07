"""
MAST Engine V2 — Reservation
==============================

Source: Engine BluePrint, Phase 1.4 ("Queue System, Concurrency &
Recovery" — "Reservation Model": "Reservations prevent duplicate
processing... Only one Worker may own one reservation at a time...
Reservation expiration returns the QueueItem to the Queue."), AD-019
("Reservations prevent duplicate processing"). Milestone 4.2 ("Queue
Reservations"), revised Milestone 4.3 ("Lease Expiration").

Responsibility
--------------
Reservation is the immutable record of one Worker's temporary
ownership of one QueueItem. It answers exactly one question:

    "Who currently owns this QueueItem?"

It carries identity only — no execution, no retry, no scheduling, and
(as of Milestone 4.3) no timing. This is the same shape of
responsibility QueueItem (queue_item.py) has for a unit of work: a
frozen data contract, not a behavior.

Fields
------
    reservation_id -- stable identifier for this reservation, minted
                       by Queue.reserve() (uuid4 hex), never supplied
                       by a caller — mirrors how Queue.enqueue() mints
                       QueueItem.queue_item_id rather than accepting
                       one.
    queue_item_id   -- which QueueItem this reservation temporarily
                        owns. Exactly one active Reservation may exist
                        for a given queue_item_id at a time (Phase 1.4
                        "Only one Worker may own one reservation at a
                        time") — enforced by Queue.reserve(), not by
                        this module.
    worker_id       -- identifies the Worker that holds this
                        reservation. An opaque string at this layer —
                        this module does not import anything from
                        workers/ and does not know what a Worker is,
                        on purpose (see queue.py's module docstring
                        for why that separation is load-bearing).
    reserved_at     -- when this reservation was created.
    lease_id        -- (Milestone 4.3) which Lease (lease.py) governs
                        this reservation's expiration, or None if this
                        reservation has no lease and therefore never
                        expires on its own. This is an opaque
                        reference only — Reservation does not import
                        Lease and does not know what a Lease looks
                        like beyond its id, exactly as it does not
                        know what a Worker looks like beyond
                        worker_id. Looking up the Lease itself (to
                        read expires_at, or to check whether it has
                        lapsed) is Queue's job, not this module's —
                        see queue.py's expire_leases().

No Worker, no WorkerPool, no WorkerAllocator, no Provider, no Session,
and no Business logic — this module does not import anything from
workers/ or engine/, on purpose (see queues/README.md for why
QueueManager and everything under queues/ stays independent of worker
infrastructure).

Status
------
FOUNDATION ONLY (Milestone 4.2, revised 4.3). A plain, frozen data
contract with no behavior beyond the __post_init__ validation below
(mirrors QueueItem's and QueueDefinition's own __post_init__
validation pattern). It does not decide *when* a reservation is
created, released, or expired — queue.py does that; this module only
describes what one reservation looks like once it exists.

Explicitly NOT this module's job (see queue.py for where these belong
instead, mostly as future work):
    - deciding whether a worker is still alive (no heartbeat)
    - deciding whether a reservation should be retried
    - deciding whether a reservation (or its lease, if any) has
      expired right now
    - deciding whether a QueueItem should be reassigned

Milestone 4.3 change: expires_at removed
-------------------------------------------
Prior to this milestone, Reservation carried its own optional
`expires_at` directly, and nothing evaluated it. Milestone 4.3
("Lease Expiration") introduces Lease (lease.py) as the object that
owns expiration timing, and Queue.expire_leases() as the logic that
acts on it. Reservation no longer carries timing at all — it carries
`lease_id`, an opaque pointer to the Lease that (if one exists) governs
this reservation's expiration. This keeps Reservation exactly as small
as "who owns this QueueItem" and nothing more, the same way Milestone
4.2 kept QueueItem free of a `reservation` field by tracking that
externally (see queue_item.py's module docstring for the identical
reasoning applied one layer earlier).

TODO(future milestones):
    - Phase 4.4 (Worker Liveness): heartbeat.py will add liveness
      signals on top of leases. Nothing here anticipates that shape;
      this module still only carries an opaque lease_id.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Optional


@dataclass(frozen=True, slots=True)
class Reservation:
    """
    Immutable record of one Worker's temporary ownership of one
    QueueItem. See the module docstring for exactly what is (and is
    not) carried.

    Attributes
    ----------
    reservation_id:
        Identifier for this reservation, minted by Queue.reserve().
    queue_item_id:
        The QueueItem this reservation temporarily owns.
    worker_id:
        Opaque identifier of the Worker holding this reservation.
    reserved_at:
        When this reservation was created.
    lease_id:
        Opaque identifier of the Lease (lease.py) governing this
        reservation's expiration, or None if this reservation has no
        lease and therefore never expires on its own. Carried only —
        this module does not evaluate it; see queue.py's
        expire_leases().
    """

    reservation_id: str
    queue_item_id: str
    worker_id: str
    reserved_at: datetime
    lease_id: Optional[str] = None

    def __post_init__(self) -> None:
        if not self.reservation_id:
            raise ValueError(
                "Reservation.reservation_id must be a non-empty string"
            )
        if not self.queue_item_id:
            raise ValueError(
                "Reservation.queue_item_id must be a non-empty string"
            )
        if not self.worker_id:
            raise ValueError(
                "Reservation.worker_id must be a non-empty string"
            )
        if self.lease_id is not None and not self.lease_id:
            raise ValueError(
                "Reservation.lease_id must be a non-empty string when provided"
            )
