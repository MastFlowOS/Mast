"""
MAST Engine V2 — Worker Capability
=====================================

Source: Engine BluePrint, Phase 1.3 ("Worker Types", "The 10 / 10 / 10
Model") and Phase 1.5 ("V2 Folder Structure" — workers/ subpackages,
one per worker type).

Responsibility
--------------
WorkerCapability is a lightweight, immutable description of what a
worker type CAN do — not what a given worker instance is currently
doing (that is worker_state, see engine/state.py:WorkerState). It has
no behavior of its own: no method other than the validation in
__post_init__.

This module defines the capability *shape* only. Nothing in this
milestone builds a real capability list from an actual worker type,
and nothing consumes a capability to decide anything — no scheduling,
no worker-pool sizing, no concurrency enforcement. That is a future
milestone's job.

Status
------
FOUNDATION ONLY (Milestone 3C). BaseWorker (workers/base_worker.py)
accepts a sequence of these at construction time and stores them
as-is; no lifecycle method in this milestone reads or enforces them.

TODO(future milestones):
    - Phase 6+: concrete worker subclasses (WebsiteWorker,
      InstagramWorker, ContactWorker, ...) will each declare their own
      WorkerCapability.
    - workers/worker_pool.py (not yet created): will read
      `capabilities` to decide worker allocation — the Phase 1.3
      "10 / 10 / 10 Model".
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class WorkerCapability:
    """
    Immutable description of one thing a worker type can do.

    Example (Phase 1.3, Website Worker)::

        WorkerCapability(
            name="website",
            supports_parallelism=True,
            max_concurrency=1,
        )

    Attributes
    ----------
    name:
        Short identifier for the capability, e.g. "website",
        "instagram", "contact". Not validated against the seven Phase
        1.3 worker types here — that mapping doesn't exist yet.
    supports_parallelism:
        Whether many instances of this worker type may run at once
        (Phase 1.3 "10 / 10 / 10 Model"). True for every worker type
        described in the blueprint.
    max_concurrency:
        How many jobs a single worker instance may hold at once.
        Every worker described in Phase 1.3 processes exactly one item
        at a time (Phase 1.2 "Golden Rule": one input in, one output
        out), so this defaults to 1.
    """

    name: str
    supports_parallelism: bool = True
    max_concurrency: int = 1

    def __post_init__(self) -> None:
        if not self.name:
            raise ValueError("WorkerCapability.name must be a non-empty string")
        if self.max_concurrency < 1:
            raise ValueError("WorkerCapability.max_concurrency must be >= 1")
