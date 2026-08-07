"""
MAST Engine V2 — Heartbeat Record
====================================

Source: Engine BluePrint, Phase 1.3 ("Worker Registry" — "heartbeat
tracking") and Phase 1.4 ("Fairness" — "If a Worker exceeds its
reservation timeout, the reservation expires and another Worker may
continue."). Milestone 4.4 ("Worker Heartbeats").

Responsibility
--------------
HeartbeatRecord is the HeartbeatIndex's own bookkeeping entry for one
worker's liveness signal: when it last heartbeat, how many heartbeats
it has sent in total, and how many it has missed. It is metadata
only — the same shape of responsibility WorkerRecord
(workers/worker_record.py) has for registry metadata, one layer
further in.

HeartbeatRecord holds no QueueItem, no Session, no Provider, no
Reservation, and no Lease — it does not import anything from queue.py,
reservation.py, or lease.py, on purpose (see heartbeat.py's module
docstring for why the heartbeat subsystem stays independent of the
queue/lease subsystem for this milestone).

Fields
------
    worker_id          -- which worker this record describes. A
                           HeartbeatRecord is never shared between
                           workers.
    last_heartbeat_at  -- when the most recent Heartbeat (heartbeat.py)
                           was recorded for this worker.
    heartbeat_count     -- total number of heartbeats recorded for this
                            worker since it first appeared in the
                            HeartbeatIndex. Monotonically increasing;
                            never reset by this milestone.
    missed_heartbeats   -- number of heartbeats this worker is
                            considered to have missed. Carried here as
                            a field only — nothing in this milestone
                            increments it. Detecting a missed
                            heartbeat on a cadence (Phase 1.2 "Design
                            Principles" heartbeat_interval /
                            WorkerDefinition.heartbeat_interval) and
                            deciding what to do about it belongs to a
                            future recovery milestone that combines
                            heartbeat liveness with lease expiration —
                            see heartbeat.py's module docstring.

Unlike WorkerRecord, which WorkerRegistry updates directly under its
own lock, HeartbeatRecord is owned and mutated exclusively by
HeartbeatIndex (heartbeat.py) — WorkerRegistry never reaches into a
HeartbeatRecord's fields itself; it only calls HeartbeatIndex methods
and reads back what they return, exactly as it never reaches into a
WorkerHandle's BaseWorker instance itself.

Status
------
FOUNDATION ONLY (Milestone 4.4). Only ever constructed and mutated by
workers/heartbeat.py's HeartbeatIndex. This module defines the record
shape only — no liveness policy, no expiration, no recovery.

TODO(future milestones):
    - Recovery milestone (combining "lease expired?" with "worker
      alive?"): missed_heartbeats will start being incremented on some
      cadence, and read alongside Queue.expire_leases() to decide
      whether a stale reservation's owner is actually gone or merely
      slow. Nothing here anticipates that shape yet.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime


@dataclass
class HeartbeatRecord:
    """
    Mutable liveness metadata for one worker, owned by HeartbeatIndex.

    Attributes
    ----------
    worker_id:
        The worker this record describes.
    last_heartbeat_at:
        When the most recent Heartbeat was recorded for this worker.
    heartbeat_count:
        Total number of heartbeats recorded for this worker.
    missed_heartbeats:
        Number of heartbeats this worker is considered to have
        missed. Always 0 as produced by this milestone — see the
        module docstring for why nothing increments it yet.
    """

    worker_id: str
    last_heartbeat_at: datetime
    heartbeat_count: int = 0
    missed_heartbeats: int = 0

    def __post_init__(self) -> None:
        if not self.worker_id:
            raise ValueError(
                "HeartbeatRecord.worker_id must be a non-empty string"
            )
        if self.heartbeat_count < 0:
            raise ValueError(
                "HeartbeatRecord.heartbeat_count must not be negative"
            )
        if self.missed_heartbeats < 0:
            raise ValueError(
                "HeartbeatRecord.missed_heartbeats must not be negative"
            )
