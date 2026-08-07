"""
MAST Engine V2 — Heartbeat
=============================

Source: Engine BluePrint, Phase 1.3 ("Worker Registry" — "heartbeat
tracking") and Phase 1.4 ("Fairness" — "If a Worker exceeds its
reservation timeout, the reservation expires and another Worker may
continue."). Milestone 4.4 ("Worker Heartbeats"), including the
Architecture Review refinement folded into this same milestone (see
"Architecture Review refinement" below).

Responsibility
--------------
This module answers exactly one question:

    "Is this worker still alive?"

It does this with two things:

    Heartbeat       -- an immutable record of one liveness signal
                        (heartbeat_id, worker_id, created_at). Nothing
                        else. A Heartbeat is not a lease and not a
                        reservation — it carries no expires_at, no
                        queue_item_id, and has no relationship to
                        lease.py/reservation.py whatsoever.

    HeartbeatIndex  -- the private, in-process worker_id ->
                        HeartbeatRecord map that turns a stream of
                        Heartbeats into the one HeartbeatRecord
                        (heartbeat_record.py) that matters for each
                        worker: when it last checked in, how many
                        times, and (reserved for a future milestone)
                        how many it has missed.

Architecture Review refinement
--------------------------------
The original milestone shape had WorkerRegistry keep only a single
`last_heartbeat` timestamp directly on WorkerRecord. This introduces
HeartbeatIndex as a separate structure instead, mirroring the
Queue/ReservationIndex/LeaseIndex split already established in the
queue subsystem (see reservation.py, lease.py):

    WorkerRegistry
        ├── WorkerRecord        (lightweight registry metadata)
        └── HeartbeatIndex
                 └── worker_id -> HeartbeatRecord

WorkerRegistry owns one HeartbeatIndex instance and is the only
caller of it. WorkerRecord.last_heartbeat remains as a convenience
field kept in sync for callers doing a quick read of a WorkerRecord
snapshot (list_workers(), etc.), but HeartbeatIndex/HeartbeatRecord
is the authoritative, richer source of heartbeat metadata
(heartbeat_count, missed_heartbeats) — see worker_record.py's module
docstring for the full explanation of that split.

What this module is NOT
--------------------------
Heartbeats only provide the worker-liveness signal. This module does
not:

    - expire leases (that is Queue.expire_leases(), lease.py/queue.py)
    - retry QueueItems (that is QueueItem/Queue's retry policy)
    - release reservations (that is Queue.release()/reserve())
    - allocate workers (that is WorkerAllocator)
    - execute workers (that is BaseWorker.process(), never called here)
    - know about queues, providers, or sessions — this module imports
      nothing from queues/ and nothing business-related, on purpose,
      mirroring reservation.py's and lease.py's own independence
      statements

It does not schedule anything either: nothing here runs on a timer,
spawns a thread, or calls itself periodically. A heartbeat is recorded
only when a caller explicitly calls HeartbeatIndex.record()
(via WorkerRegistry.heartbeat()); liveness is evaluated only when a
caller explicitly asks (via HeartbeatIndex.is_alive() /
WorkerRegistry.is_alive()). Both are plain, synchronous, on-demand
calls.

Liveness Policy
-----------------
A worker is alive if:

    now - last_heartbeat_at <= heartbeat_timeout

heartbeat_timeout is never hardcoded inside WorkerRegistry — it lives
here, as DEFAULT_HEARTBEAT_TIMEOUT_SECONDS, and can be overridden
per-call by passing timeout_seconds to HeartbeatIndex.is_alive() /
WorkerRegistry.is_alive(). A worker with no HeartbeatRecord at all
(never heartbeat) is never alive.

Thread Safety
---------------
HeartbeatIndex holds no lock of its own. It is only ever called from
inside WorkerRegistry's existing `threading.RLock` (see
worker_registry.py) — the same re-entrant lock that already guards
WorkerRegistry's own `_records`/`_handles` maps. This mirrors how
WorkerGroup/WorkerPool each guard their own state with their own lock
rather than sharing one: here, deliberately, HeartbeatIndex is *not*
given a second lock, because it is never reachable except through
WorkerRegistry, so a second lock would only add needless
lock-ordering risk for no benefit. No async primitives and no
background threads are introduced by this milestone.

Status
------
FOUNDATION ONLY (Milestone 4.4). Records heartbeats and answers
is_alive()/last_heartbeat() queries. Does not connect to Lease
Expiration, does not reconnect QueueManager, and does not implement
recovery — see the TODO below.

TODO(future milestones):
    - Recovery milestone: a future layer will read both
      Queue.expire_leases()-style lease expiry and
      WorkerRegistry.is_alive() together to decide what action to
      take (reassign a QueueItem vs. simply wait for a slow-but-alive
      worker). Nothing in this module anticipates that shape; the two
      subsystems remain independent until then.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Dict, Optional
from uuid import uuid4

from workers.heartbeat_record import HeartbeatRecord

#: Default liveness window, in seconds. A worker with no more recent
#: heartbeat than this is considered no longer alive. Configurable per
#: call via HeartbeatIndex.is_alive()'s / WorkerRegistry.is_alive()'s
#: own timeout_seconds argument — this constant is only the fallback
#: used when a caller does not supply one, so the timeout policy lives
#: in this module rather than being hardcoded inside WorkerRegistry.
DEFAULT_HEARTBEAT_TIMEOUT_SECONDS: float = 10.0


@dataclass(frozen=True, slots=True)
class Heartbeat:
    """
    Immutable record of one liveness signal from one worker. See the
    module docstring for exactly what is (and is not) carried — in
    particular, this is not a lease and not a reservation.

    Attributes
    ----------
    heartbeat_id:
        Identifier for this heartbeat, minted by
        HeartbeatIndex.record().
    worker_id:
        Opaque identifier of the worker that sent this heartbeat. As
        with Reservation.worker_id (reservation.py), this module does
        not import anything from workers/base_worker.py and does not
        know what a BaseWorker looks like beyond this id.
    created_at:
        When this heartbeat was recorded.
    """

    heartbeat_id: str
    worker_id: str
    created_at: datetime

    def __post_init__(self) -> None:
        if not self.heartbeat_id:
            raise ValueError("Heartbeat.heartbeat_id must be a non-empty string")
        if not self.worker_id:
            raise ValueError("Heartbeat.worker_id must be a non-empty string")


class HeartbeatIndex:
    """
    Private worker_id -> HeartbeatRecord map. The sole source of
    heartbeat runtime metadata (heartbeat_count, missed_heartbeats) for
    the worker subsystem — see the module docstring's "Architecture
    Review refinement" section.

    Holds no lock of its own; every method here must be called while
    the owning WorkerRegistry already holds its own lock (see
    "Thread Safety" above). Not part of this module's public surface
    for anything outside workers/worker_registry.py — WorkerRegistry
    is this index's only caller.
    """

    def __init__(self) -> None:
        self._records: Dict[str, HeartbeatRecord] = {}

    def record(self, worker_id: str) -> Heartbeat:
        """
        Record one Heartbeat for worker_id: mint a new Heartbeat,
        and create or update worker_id's HeartbeatRecord (
        last_heartbeat_at set to this Heartbeat's created_at,
        heartbeat_count incremented by one).

        Does not validate that worker_id is a known/registered
        worker — that check belongs to WorkerRegistry.heartbeat(),
        which is this index's only caller.
        """
        now = self._now()
        heartbeat = Heartbeat(
            heartbeat_id=uuid4().hex, worker_id=worker_id, created_at=now
        )
        existing = self._records.get(worker_id)
        if existing is None:
            self._records[worker_id] = HeartbeatRecord(
                worker_id=worker_id,
                last_heartbeat_at=now,
                heartbeat_count=1,
                missed_heartbeats=0,
            )
        else:
            existing.last_heartbeat_at = now
            existing.heartbeat_count += 1
        return heartbeat

    def get(self, worker_id: str) -> Optional[HeartbeatRecord]:
        """Return worker_id's HeartbeatRecord, or None if it has never heartbeat."""
        return self._records.get(worker_id)

    def last_heartbeat_at(self, worker_id: str) -> Optional[datetime]:
        """Return when worker_id last heartbeat, or None if it never has."""
        record = self._records.get(worker_id)
        return record.last_heartbeat_at if record is not None else None

    def is_alive(
        self,
        worker_id: str,
        timeout_seconds: Optional[float] = None,
        *,
        now: Optional[datetime] = None,
    ) -> bool:
        """
        Whether worker_id is alive: it has a HeartbeatRecord, and
        (now - last_heartbeat_at) <= timeout_seconds (defaulting to
        DEFAULT_HEARTBEAT_TIMEOUT_SECONDS when not supplied).

        Returns False — never raises — for a worker_id with no
        HeartbeatRecord at all.
        """
        record = self._records.get(worker_id)
        if record is None:
            return False
        effective_timeout = (
            DEFAULT_HEARTBEAT_TIMEOUT_SECONDS
            if timeout_seconds is None
            else timeout_seconds
        )
        moment = now if now is not None else self._now()
        elapsed = (moment - record.last_heartbeat_at).total_seconds()
        return elapsed <= effective_timeout

    def discard(self, worker_id: str) -> None:
        """
        Drop worker_id's HeartbeatRecord, if any. Called by
        WorkerRegistry.unregister_worker() so an unregistered worker
        does not leave a stale HeartbeatRecord behind. A no-op if
        worker_id has no record.
        """
        self._records.pop(worker_id, None)

    @staticmethod
    def _now() -> datetime:
        return datetime.now(timezone.utc)
