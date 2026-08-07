"""
MAST Engine V2 — Worker Handle
=================================

Source: Engine BluePrint, Phase 1.3 ("Distributed Worker Architecture").
Milestone 3D, Architecture Review correction ("Introduce WorkerHandle").
This correction is not yet reflected in the attached blueprint text
itself — see workers/worker_registry.py's module docstring for the
before/after this change makes.

Responsibility
--------------
WorkerHandle is a thin indirection layer between WorkerRegistry and a
BaseWorker instance. Before this correction, the registry held
BaseWorker objects directly:

    WorkerRegistry
        ├── WorkerRecord
        └── BaseWorker

That couples "a worker is registered" to "a live local BaseWorker
object exists in this process". WorkerHandle breaks that coupling:

    WorkerRegistry
        ├── WorkerRecord
        └── WorkerHandle
                 │
                 ▼
            BaseWorker

A WorkerHandle always exists once a worker is registered; the
BaseWorker instance it points to (`instance`) may or may not be
locally present (`attached`). This milestone only introduces the
indirection — it does not build anything that uses the case where
`instance` is None. In particular:

    - No remote worker implementation exists anywhere in this
      codebase. WorkerHandle does not talk to a remote process, does
      not serialize anything, and does not know what "remote" means.
    - No scheduling or networking code lives here or anywhere in
      workers/worker_registry.py.
    - Nothing in this milestone ever constructs a WorkerHandle with
      `instance=None` — WorkerRegistry.register_worker() always wraps
      a real, already-constructed BaseWorker. The Optional/`attached`
      shape exists so a *future* milestone (a worker running in
      another process, reached over some transport that doesn't exist
      yet) can represent "this worker is registered but not currently
      attached to a local instance" without changing WorkerRecord or
      the registry's map structure again.

WorkerHandle has no methods of its own beyond the minimal
consistency check in __post_init__ below. It does not decide when a
worker attaches or detaches, does not reconnect anything, and is not
itself thread-safe — WorkerRegistry's lock is what protects handles
stored inside it (see worker_registry.py).

Status
------
FOUNDATION ONLY. Introduced by this architecture-review correction to
Milestone 3D. Only ever constructed by
WorkerRegistry.register_worker(); nothing else in this codebase
constructs one.

TODO(future milestones):
    - A future distributed-worker milestone (not yet scoped in
      Phase 1.1-1.5) would be the first to construct a WorkerHandle
      with `attached=False` / `instance=None`, and the first to need
      any attach/detach operation — no such operation exists on
      WorkerRegistry or WorkerHandle today.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Optional

from workers.base_worker import BaseWorker


@dataclass
class WorkerHandle:
    """
    Indirection between a registered worker_id and its BaseWorker
    instance, if one is currently attached.

    Attributes
    ----------
    worker_id:
        The worker this handle refers to. Matches the WorkerRecord
        stored under the same key in WorkerRegistry — a WorkerHandle
        is never shared between workers.
    instance:
        The live BaseWorker object, if one is currently attached to
        this handle locally. None is reserved for a future case this
        milestone does not construct — see the module docstring.
    attached:
        Whether `instance` currently points to a live BaseWorker.
        True whenever WorkerRegistry.register_worker() creates this
        handle in this milestone.
    created_at:
        When this handle was created (i.e. when
        WorkerRegistry.register_worker() ran).
    """

    worker_id: str
    instance: Optional[BaseWorker]
    attached: bool
    created_at: datetime

    def __post_init__(self) -> None:
        if not self.worker_id:
            raise ValueError("WorkerHandle.worker_id must be a non-empty string")
        if self.attached and self.instance is None:
            raise ValueError(
                "WorkerHandle cannot be attached=True with instance=None"
            )
