"""
MAST Engine V2 — Worker Record
=================================

Source: Engine BluePrint, Phase 1.3 ("Worker Lifecycle") and Phase 1.4
("Heartbeat", "Queue Ownership"). Milestone 3D ("Worker Registry"), as
amended by Milestone 4.4 ("Worker Heartbeats") — see "Relationship to
HeartbeatIndex" below.

Responsibility
--------------
WorkerRecord is WorkerRegistry's own bookkeeping entry for one
registered worker: which WorkerDefinition it was registered against
(by id), its WorkerState as last reported to the registry, when it
registered, when it last heartbeat, and which session / pipeline item
(if any) it is currently assigned to. It is metadata only.

WorkerRecord holds no business data (no BusinessCandidate, no
DiscoverySession object, no QueueItem — only their ids where relevant)
and no BaseWorker instance, and no WorkerHandle
(workers/worker_handle.py) either. WorkerRegistry stores WorkerRecords
and WorkerHandles in two separate maps, both keyed by worker_id, and
never merges them — see workers/worker_registry.py's module docstring
for why.

Unlike WorkerContext (workers/worker_context.py) — the RESERVED /
WORKING assignment record BaseWorker itself owns and replaces wholesale
on every transition, per Phase 1.2 Rule #1 ("Objects are immutable") —
WorkerRecord is deliberately mutable. It is the registry's own view of
a worker, updated in place, under WorkerRegistry's lock, by the
registry itself (via heartbeat() / update_state()) — never by the
worker, and never directly by a caller.

Relationship to HeartbeatIndex
---------------------------------
Milestone 4.4 ("Worker Heartbeats") introduces HeartbeatIndex
(workers/heartbeat.py) as WorkerRegistry's private worker_id ->
HeartbeatRecord map, mirroring the Queue/ReservationIndex/LeaseIndex
split already established in the queue subsystem. HeartbeatRecord —
not this class — is the authoritative, detailed source of heartbeat
runtime metadata (heartbeat_count, missed_heartbeats).

last_heartbeat below is kept exactly as it already was in this
class: a lightweight convenience timestamp, updated by
WorkerRegistry.heartbeat() alongside (not instead of) the
HeartbeatIndex update, so a caller reading one WorkerRecord snapshot
(list_workers(), get_record(), ...) can still see "did this worker
heartbeat recently" without a second lookup. No new fields were added
here for heartbeat_count/missed_heartbeats — see heartbeat_record.py
for those, and worker_registry.py's last_heartbeat()/is_alive() for
how a caller reaches them.

Status
------
FOUNDATION ONLY (Milestone 3D, amended 4.4). Only ever constructed and
mutated by workers/worker_registry.py. This module defines the record
shape only — no lifecycle enforcement, no scheduling, no queue
awareness, and (per the section above) no heartbeat *policy* either.
See workers/worker_registry.py for what does and does not read/write
this object.

TODO(future milestones):
    - Phase 4 (Queue Framework): current_session_id /
      current_pipeline_id will be kept in sync with real reservations
      instead of being caller-supplied through
      WorkerRegistry.update_state().
    - Recovery milestone: nothing here anticipates combining
      last_heartbeat with lease expiration — see heartbeat.py's
      module docstring TODO.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Optional

from engine.state import WorkerState


@dataclass
class WorkerRecord:
    """
    Mutable registry metadata for one registered worker.

    Attributes
    ----------
    worker_id:
        The BaseWorker instance (workers/base_worker.py) this record
        describes. A WorkerRecord is never shared between workers.
    definition_id:
        The WorkerDefinition (workers/worker_definition.py) this
        worker was registered against, referenced by id only — the
        registry does not keep a copy of the WorkerDefinition object
        next to the record.
    worker_state:
        This worker's WorkerState (engine/state.py) as last reported
        to the registry via WorkerRegistry.update_state(). This is the
        registry's own tracked copy, used for its listing/filtering
        (list_idle_workers(), list_busy_workers()) — the BaseWorker
        instance itself remains the source of truth for its actual
        state; nothing here re-derives one from the other
        automatically.
    registered_at:
        When WorkerRegistry.register_worker() created this record.
    last_heartbeat:
        When WorkerRegistry.heartbeat() was last called for this
        worker_id. None if no heartbeat has been recorded since
        registration. A convenience copy only, as of Milestone 4.4 —
        the authoritative heartbeat metadata (including
        heartbeat_count and missed_heartbeats) lives in this worker's
        HeartbeatRecord inside HeartbeatIndex (workers/heartbeat.py);
        see this class's "Relationship to HeartbeatIndex" module note.
    current_session_id:
        The DiscoverySession this worker is currently assigned to, if
        any — caller-supplied via WorkerRegistry.update_state(). None
        while unassigned.
    current_pipeline_id:
        The pipeline item this worker is currently assigned to, if
        any — caller-supplied via WorkerRegistry.update_state(). None
        while unassigned (e.g. a Discovery Worker reservation, which
        has no pipeline_id yet — see workers/worker_context.py).
    """

    worker_id: str
    definition_id: str
    worker_state: WorkerState
    registered_at: datetime
    last_heartbeat: Optional[datetime] = None
    current_session_id: Optional[str] = None
    current_pipeline_id: Optional[str] = None

    def __post_init__(self) -> None:
        if not self.worker_id:
            raise ValueError("WorkerRecord.worker_id must be a non-empty string")
        if not self.definition_id:
            raise ValueError(
                "WorkerRecord.definition_id must be a non-empty string"
            )
