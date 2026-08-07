"""
MAST Engine V2 — Worker Definition
=====================================

Source: Engine BluePrint, Phase 1.3 ("Worker Types", "Timeout Rules",
"The 10 / 10 / 10 Model") and Phase 1.4 ("Heartbeat", "Retry
Strategy"). Milestone 3D ("Worker Registry").

Responsibility
--------------
WorkerDefinition is a lightweight, immutable description of a worker
*type* — e.g. "this is what a Website Worker is": which capabilities
it declares (worker_capability.py:WorkerCapability), how often it must
heartbeat, its per-job timeout, how many jobs one instance may hold
concurrently, how many retries it gets before a job is given up on,
and an opaque health policy for future health-monitoring use.

It is the type-level counterpart to WorkerRecord
(workers/worker_record.py), which is the instance-level (per-worker)
runtime metadata WorkerRegistry tracks. A WorkerDefinition never
changes once created — it describes a worker type's fixed contract,
not any one worker's current situation:

    WorkerDefinition  -> "what a Website Worker is"   (immutable, one per type)
    WorkerRecord       -> "what worker abc123 is doing right now" (mutable, one per instance)
    BaseWorker          -> the actual running object (behavior)

Nothing in this module reads a WorkerDefinition to make a decision.
WorkerRegistry.register_worker() only reads definition_id and
worker_type off of it (to populate a WorkerRecord and to sanity-check
the registration) — it does not enforce timeout_seconds,
max_concurrency, max_retries, or health_policy anywhere. Those remain
inert data until a future milestone (the queue framework, the retry
policy, and health monitoring respectively) reads them.

Status
------
FOUNDATION ONLY (Milestone 3D). Describes a worker type's shape only.
No scheduling, no queue awareness, no statistics, no per-instance
state — see workers/worker_record.py and workers/worker_context.py for
those.

TODO(future milestones):
    - Phase 3 (remaining): workers/worker_pool.py will use
      max_concurrency (Phase 1.3 "10 / 10 / 10 Model") to decide how
      many BaseWorker instances of a type to keep running.
    - Phase 4 (Queue Framework): heartbeat_interval and timeout_seconds
      will drive queue/heartbeat.py and queue/retry.py; max_retries
      will bound queue/retry.py's retry loop (Phase 1.4 "Retry
      Strategy").
    - health_policy's shape is not defined anywhere in Phase 1.1-1.5;
      inventing one is out of scope for this milestone. It is carried
      as an opaque value so a future health-monitoring milestone
      (Phase 1.3 "Health Monitoring") can attach one without another
      change to this dataclass.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Sequence, Tuple

from workers.worker_capability import WorkerCapability


@dataclass(frozen=True, slots=True)
class WorkerDefinition:
    """
    Immutable description of one worker type.

    Attributes
    ----------
    definition_id:
        Stable identifier for this worker type's definition, e.g.
        "website-v1". Referenced by id (never embedded whole) from
        WorkerRecord.definition_id — WorkerRegistry keeps the two as
        separate concepts, per the module docstring.
    worker_type:
        Short type name, e.g. "website", "instagram", "contact" —
        matches BaseWorker.worker_type for the instances constructed
        against this definition. Not validated against the seven Phase
        1.3 worker types here, matching WorkerCapability.name's own
        note that this mapping doesn't exist yet.
    capabilities:
        The WorkerCapability entries this worker type declares.
        Stored as a tuple regardless of what sequence was passed in,
        so the definition stays immutable end to end.
    heartbeat_interval:
        Expected seconds between heartbeats for a worker of this type
        (Phase 1.4 "Every worker sends heartbeat every 2 seconds").
        Not enforced anywhere in this milestone — WorkerRegistry.
        heartbeat() only records that a heartbeat happened, exactly
        like BaseWorker.heartbeat() does; detecting a *missed* one is
        Phase 4 (queue/heartbeat.py).
    timeout_seconds:
        Per-job timeout for this worker type (Phase 1.3 "Timeout
        Rules", e.g. Website=8s, Instagram=6s). Not enforced here.
    max_concurrency:
        How many jobs one instance of this worker type may hold at
        once. Mirrors WorkerCapability.max_concurrency's own default
        of 1 (Phase 1.2 "Golden Rule").
    max_retries:
        How many retries a job of this worker type gets before it is
        given up on (Phase 1.4 "Retry Strategy"). Not enforced here —
        Phase 4's queue/retry.py will read it.
    health_policy:
        Opaque, worker-type-specific health-monitoring configuration
        (Phase 1.3 "Health Monitoring"). Its shape is intentionally
        left undefined by this milestone — see the module TODO.
        Carried through unread and unvalidated.
    """

    definition_id: str
    worker_type: str
    capabilities: Tuple[WorkerCapability, ...]
    heartbeat_interval: float = 2.0
    timeout_seconds: float = 8.0
    max_concurrency: int = 1
    max_retries: int = 1
    health_policy: Any = None

    def __post_init__(self) -> None:
        if not self.definition_id:
            raise ValueError(
                "WorkerDefinition.definition_id must be a non-empty string"
            )
        if not self.worker_type:
            raise ValueError(
                "WorkerDefinition.worker_type must be a non-empty string"
            )

        # Normalize whatever sequence was passed (list, tuple, ...) to
        # an immutable tuple. frozen=True blocks a normal assignment
        # here, so this goes through object.__setattr__ instead — the
        # dataclass-frozen equivalent of BaseWorker.__init__'s own
        # `tuple(capabilities or ())` coercion.
        capabilities: Sequence[WorkerCapability] = self.capabilities
        object.__setattr__(self, "capabilities", tuple(capabilities))

        if not self.capabilities:
            raise ValueError(
                "WorkerDefinition.capabilities must contain at least one "
                "WorkerCapability"
            )
        if not all(isinstance(c, WorkerCapability) for c in self.capabilities):
            raise TypeError(
                "WorkerDefinition.capabilities must contain only "
                "WorkerCapability instances"
            )
        if self.heartbeat_interval <= 0:
            raise ValueError(
                "WorkerDefinition.heartbeat_interval must be > 0"
            )
        if self.timeout_seconds <= 0:
            raise ValueError("WorkerDefinition.timeout_seconds must be > 0")
        if self.max_concurrency < 1:
            raise ValueError("WorkerDefinition.max_concurrency must be >= 1")
        if self.max_retries < 0:
            raise ValueError("WorkerDefinition.max_retries must be >= 0")
