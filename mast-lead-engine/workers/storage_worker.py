"""
MAST Engine V2 — Storage Worker
==================================

Source: Engine BluePrint Phase 1.3 (Worker Types — Storage Worker),
Phase 1.5 (Stage 6 — "Persist QualifiedOpportunities. Nothing else."),
Phase 1.2 (Golden Rule — one input, one output), and the Phase 5.8
implementation prompt. Builds on workers/base_worker.py without
duplicating any lifecycle logic, exactly as workers/website_worker.py,
workers/instagram_worker.py, workers/contact_worker.py, and
workers/qualification_worker.py do.

Responsibility
--------------
StorageWorker performs exactly one transformation:

    QualifiedOpportunity -> StorageWorker.process() -> StoredOpportunity

It is the LAST worker in the Phase 5 pipeline. It does not discover,
inspect websites, crawl Instagram, extract contacts, qualify, score,
retry, deduplicate, enqueue, or talk to any queue/session/runtime
component. Its only job is to hand a QualifiedOpportunity to a
persistence backend and return whatever StoredOpportunity that backend
produces.

Architecture review first (Phase 5.8, pre-implementation)
--------------------------------------------------------------------
Reviewing `engine.contracts.StoredOpportunity` against this milestone's
stated responsibility, and against StorageWorker's only permitted
input (`QualifiedOpportunity`: `pipeline_id`, `session_id`, `business`,
`qualification`, `score`), surfaced three problems. Two are corrected
in `engine/contracts.py` directly, exactly the discipline
WebsiteWorker/InstagramWorker/ContactWorker/QualificationWorker's own
reviews used — not worked around here. The third could not be
corrected the same way, because it is not a contract-shape problem —
see item 3.

1. `StoredOpportunity.user_id` — removed. Nothing on
   QualifiedOpportunity (or anything it references) carries a user
   identity, and StorageWorker is explicitly forbidden from depending
   on Sessions/Runtime/EngineCoordinator to look one up from
   `session_id`. A required field with no possible producer cannot be
   honestly populated. See `StoredOpportunity`'s own docstring in
   `engine/contracts.py` for the full rationale and where this
   properly belongs instead (Session/Engine, once a future milestone
   threads it through).

2. `StoredOpportunity.business_id` — removed. Also absent from
   QualifiedOpportunity and everything upstream of it. Phase 1.4
   (AD-021) already establishes `pipeline_id` as "the identity of the
   Business throughout the engine"; nothing in Phase 1.1-1.5 defines a
   second, storage-generated business identity, and no
   normalized-table or deduplication concept exists anywhere in this
   architecture to justify inventing one now. See
   `StoredOpportunity`'s own docstring for the full rationale.

3. No Storage abstraction actually exists. The Phase 5.8 prompt lists
   "Storage abstraction already defined by the architecture" as an
   allowed dependency, but `engine/interfaces.py` defines exactly
   three interfaces — `WorkerInterface`, `DiscoveryProviderInterface`,
   `QueueInterface` — and none of them is a persistence abstraction.
   `storage/` (Phase 1.5's V2 folder structure) is the *V1* storage
   pipeline, untouched and unrelated to V2's contracts. This is a real
   gap, flagged rather than silently worked around: StorageWorker
   fundamentally cannot satisfy "persist it" without depending on
   *something* that performs I/O, and nothing in Phase 1.1-1.5 says
   what that something's shape is.

   Rather than stall the milestone or invent a project-wide interface
   this file has no authorization to add to `engine/interfaces.py`
   (out of this milestone's file scope — only `engine/contracts.py`
   and `workers/storage_worker.py` are in scope, and only the former
   conditionally), this module defines the smallest possible local
   stand-in: `_StoragePersistenceProtocol`, a one-method `Protocol`
   scoped exactly to "persist a QualifiedOpportunity, get back a
   StoredOpportunity" — see its own docstring below. The leading
   underscore is deliberate, not a style choice: it marks this as
   module-private and explicitly provisional, never intended to be
   imported or depended on from outside this file. It is
   constructor-injected, never constructed by this module, and never
   defaulted to a concrete implementation, since no concrete V2
   persistence implementation exists yet anywhere in this codebase.
   This protocol exists only until a future architecture milestone
   defines a real, shared Storage abstraction — wrapping `storage/`
   the way a future `GoogleMapsProvider` will wrap
   `scraper/maps_scraper.py` (Phase 1.5) — at which point this local
   stand-in should be deleted and StorageWorker should depend on that
   shared abstraction instead, the same way DiscoveryProviderInterface
   is the shared abstraction a concrete provider depends on today.

See `StoredOpportunity`'s own docstring in `engine/contracts.py` for
the complete field-by-field rationale behind items 1 and 2.

Persistence behavior
------------------------
StorageWorker.process() is pure delegation — it reads no field off its
input, transforms nothing, defaults nothing, and validates nothing:

    QualifiedOpportunity -> self._backend.persist(item) -> StoredOpportunity

This is deliberate, not an oversight. The milestone's own boundaries
("must not modify business facts... must not enrich data... must not
recalculate qualification... must not perform deduplication unless an
existing architecture contract explicitly assigns that responsibility
to StorageWorker") rule out this worker inspecting or second-guessing
`item.qualification.qualified`, filtering on it, or filling in any
field the backend didn't supply. Deciding whether a business qualifies
already happened upstream (QualificationWorker); StorageWorker's job
starts after that decision, not a second check of it.

Error handling
----------------
No exception is caught or swallowed anywhere in this module. If
`self._backend.persist()` fails for any reason, that exception
propagates unmodified — per this milestone's "allow exceptions to
propagate... do not retry... do not swallow exceptions... do not
return partial StorageResult." There is no fallback value and no
partial `StoredOpportunity` this module could construct on failure
that wouldn't misrepresent what was actually persisted.

Thread safety / statelessness
-------------------------------
No module-level mutable state, no caches. `_backend` and `_timeout` are
set once at construction (mirroring WebsiteWorker's `timeout` and
QualificationWorker's `required_categories`) and never mutated;
process() reads only its own argument and that frozen configuration.

Status
------
Phase 5.8. Depends only on QualifiedOpportunity, StoredOpportunity,
BaseWorker, WorkerCapability, and the standard library (`typing.
Protocol`, used solely to define the local, provisional
`_StoragePersistenceProtocol` stand-in described above). No queue/,
providers/, engine.coordinator, session, or runtime import anywhere in
this file — matching WebsiteWorker/InstagramWorker/ContactWorker/
QualificationWorker exactly.

Phase 5.8 refinement (post-approval): `PersistenceBackend` was renamed
to `_StoragePersistenceProtocol` to make its provisional, module-
private nature explicit at the call site rather than only in prose —
see that class's own docstring. Purely a naming/documentation change;
no behavior, signature shape, or method changed.
"""

from __future__ import annotations

from typing import Optional, Protocol, runtime_checkable

from engine.contracts import QualifiedOpportunity, StoredOpportunity
from workers.base_worker import BaseWorker
from workers.worker_capability import WorkerCapability

WORKER_TYPE = "storage"

#: engine/interfaces.py's own "Timeout Rules" example list names
#: Storage's per-fetch budget explicitly ("Website=8s, Instagram=6s,
#: Contact=6s, Merge=2s, Qualification=2s, Storage=3s"). Unlike
#: QualificationWorker (Phase 5.7), which makes no network call of its
#: own and explicitly declined to borrow any figure from that table,
#: StorageWorker's one call — persisting through
#: `_StoragePersistenceProtocol` — is exactly the kind of per-fetch
#: operation that table describes.
#: This worker borrows the figure directly rather than inventing its
#: own.
DEFAULT_TIMEOUT_SECONDS = 3.0


@runtime_checkable
class _StoragePersistenceProtocol(Protocol):
    """
    PROVISIONAL — module-private by convention (leading underscore).

    Local stand-in for the Storage abstraction the architecture does
    not yet define — see module docstring, "Architecture review
    first", item 3, for why this exists and why it lives here rather
    than in engine/interfaces.py.

    This exists only until a future architecture milestone defines a
    real, shared Storage abstraction (the persistence-layer
    counterpart to DiscoveryProviderInterface, Phase 5.1). At that
    point this protocol should be deleted from this module entirely
    and StorageWorker should be re-pointed at that shared abstraction
    instead — it is not meant to be imported anywhere else, extended,
    or treated as this codebase's answer to "what does a Storage
    interface look like." It is a scaffold, not a decision.

    Deliberately as narrow as DiscoveryProviderInterface (Phase 5.1)
    was scoped: one method, no health checks, no capabilities, no
    connection management, no retry policy. Those remain out of scope
    here for the same reason Provider Registry concerns remain out of
    scope there — inventing them now would be inventing architecture
    this milestone is not authorized to invent.
    """

    def persist(self, opportunity: QualifiedOpportunity) -> StoredOpportunity:
        """
        Persist one QualifiedOpportunity and return the resulting
        StoredOpportunity. An implementation performs the actual
        insert (e.g. into Supabase) and mints `opportunity_id` /
        `created_at` as part of a successful write — see
        StoredOpportunity's own docstring in engine/contracts.py.
        Must raise on failure; must never return a partial
        StoredOpportunity — see module docstring, "Error handling".
        """
        raise NotImplementedError


class StorageWorker(BaseWorker[QualifiedOpportunity, StoredOpportunity]):
    """
    Transforms one QualifiedOpportunity into one StoredOpportunity by
    delegating entirely to an injected _StoragePersistenceProtocol
    (provisional — see that class's own docstring). Owns nothing
    else — see module docstring.
    """

    def __init__(
        self,
        *,
        backend: _StoragePersistenceProtocol,
        timeout: float = DEFAULT_TIMEOUT_SECONDS,
        worker_id: Optional[str] = None,
    ) -> None:
        """
        backend:
            The persistence dependency this worker delegates to — see
            _StoragePersistenceProtocol above (provisional; will be
            replaced once a shared Storage abstraction exists).
            Required, with no default:
            StorageWorker has nothing sensible to fall back on, since
            no concrete V2 persistence implementation exists anywhere
            in this codebase yet (`storage/` is the untouched V1
            pipeline — see Phase 1.5's V2 folder structure).
        """
        super().__init__(
            worker_type=WORKER_TYPE,
            capabilities=(WorkerCapability(name=WORKER_TYPE),),
            worker_id=worker_id,
        )
        self._backend = backend
        self._timeout = timeout

    # -- WorkerInterface -------------------------------------------------

    def process(self, item: QualifiedOpportunity) -> StoredOpportunity:
        """
        Consume exactly one QualifiedOpportunity and produce exactly
        one StoredOpportunity. Never mutates `item`. Pure delegation —
        see module docstring, "Persistence behavior": no field of
        `item` is read, transformed, defaulted, or validated by this
        method itself. No exception is caught — see module docstring,
        "Error handling".
        """
        return self._backend.persist(item)

    def timeout_seconds(self) -> float:
        return self._timeout
