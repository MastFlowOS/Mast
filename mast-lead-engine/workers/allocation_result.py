"""
MAST Engine V2 — Allocation Result
=====================================

Source: Engine BluePrint, Phase 1.3 ("Worker Architecture", "Dynamic
Worker Allocation"). Milestone 3F ("Worker Allocator").

Responsibility
--------------
AllocationResult is the immutable, opaque outcome of a single
WorkerAllocator.allocate() call (workers/worker_allocator.py). It
answers exactly one question — "did I get a worker, and if so which
one?" — and nothing else.

It carries no business data and no runtime references: no
BusinessCandidate, no QueueItem, no DiscoverySession, no BaseWorker
instance, no WorkerHandle. Just enough identifiers for a caller to
know what it was handed:

    worker_id        -- which worker (None on failure)
    worker_type      -- that worker's type (None on failure)
    reservation_id    -- this allocator's own bookkeeping token for
                          the allocation (None on failure) — see
                          worker_allocator.py's module docstring for
                          how this differs from
                          BaseWorker.reserve()'s reservation_id
    allocated_at      -- when the attempt was made (always set)
    success           -- whether a worker was actually acquired
    reason            -- why not, when success is False (optional
                          when success is True; unused)

Status
------
FOUNDATION ONLY (Milestone 3F). A plain, frozen data contract. It has
no behavior beyond the internal-consistency check in __post_init__
below (mirrors WorkerCapability's and WorkerDefinition's own
__post_init__ validation) — nothing here decides whether an allocation
should succeed; workers/worker_allocator.py does that and constructs
this object to report the outcome.

TODO(future milestones):
    - Phase 4 (Queue Framework): a caller pairing a successful
      AllocationResult with a real queue reservation will likely mint
      its own, separate queue reservation id rather than reusing this
      one — this module makes no assumption either way.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Optional


@dataclass(frozen=True, slots=True)
class AllocationResult:
    """
    Immutable outcome of one WorkerAllocator.allocate() call.

    Attributes
    ----------
    worker_id:
        The worker that was allocated. None when success is False.
    worker_type:
        That worker's worker_type (matches BaseWorker.worker_type /
        WorkerDefinition.worker_type). None when success is False.
    reservation_id:
        Opaque token minted by WorkerAllocator for this allocation.
        None when success is False. Not the same thing as, and never
        derived from, BaseWorker.reserve()'s own reservation_id
        parameter — see worker_allocator.py's module docstring.
    allocated_at:
        When this allocation attempt was made. Always set, whether or
        not it succeeded.
    success:
        Whether a worker was actually acquired.
    reason:
        Why allocation failed, when success is False (e.g. "no idle
        worker available"). Always None when success is True.
    """

    worker_id: Optional[str]
    worker_type: Optional[str]
    reservation_id: Optional[str]
    allocated_at: datetime
    success: bool
    reason: Optional[str] = None

    def __post_init__(self) -> None:
        if self.success:
            if not self.worker_id:
                raise ValueError(
                    "AllocationResult.worker_id is required when "
                    "success is True"
                )
            if not self.worker_type:
                raise ValueError(
                    "AllocationResult.worker_type is required when "
                    "success is True"
                )
            if not self.reservation_id:
                raise ValueError(
                    "AllocationResult.reservation_id is required when "
                    "success is True"
                )
            if self.reason is not None:
                raise ValueError(
                    "AllocationResult.reason must be None when "
                    "success is True"
                )
        else:
            if self.worker_id is not None:
                raise ValueError(
                    "AllocationResult.worker_id must be None when "
                    "success is False"
                )
            if self.worker_type is not None:
                raise ValueError(
                    "AllocationResult.worker_type must be None when "
                    "success is False"
                )
            if self.reservation_id is not None:
                raise ValueError(
                    "AllocationResult.reservation_id must be None when "
                    "success is False"
                )
            if not self.reason:
                raise ValueError(
                    "AllocationResult.reason must be a non-empty string "
                    "when success is False"
                )
