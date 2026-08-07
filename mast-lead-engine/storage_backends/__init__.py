"""
MAST Engine V2 — Storage Backends Package
============================================

Source: Engine BluePrint Phase 1.5 Stage 6 ("Storage Pipeline" —
"Persist QualifiedOpportunities. Nothing else."), and
workers/storage_worker.py's own "Architecture review first" (item 3),
which identified that no shared Storage abstraction exists in
engine/interfaces.py and defined a local, provisional
`_StoragePersistenceProtocol` scoped to exactly one method:

    persist(QualifiedOpportunity) -> StoredOpportunity

Responsibility
--------------
This package is the home for concrete implementations of that
protocol — the persistence-layer counterpart to `providers/`, which
holds concrete DiscoveryProviderInterface implementations
(GoogleMapsProvider today). Nothing in `engine/`, `workers/`, or
`queues/` imports this package; only whichever caller constructs a
StorageWorker (via a StageBlueprint.worker_factory closure — see
engine/coordinator.py's StageBlueprint docstring) imports a concrete
backend from here and injects it.

Why a new top-level package rather than `storage/`
----------------------------------------------------
`storage/` (dedup.py) is the V1 storage pipeline — untouched, still
running in production, and explicitly called out in
workers/storage_worker.py's own docstring as "unrelated to V2's
contracts". Placing a V2 persistence backend inside it would blur
that already-documented boundary. `storage_backends/` is a new,
V2-only package, following the same flat, single-file-per-integration
shape `providers/google_maps_provider.py` already established (rather
than the nested `providers/google_maps/` the blueprint's *target*
layout describes but nothing has migrated to yet).

Status
------
Phase 6.6. First concrete implementation: supabase_backend.py
(SupabaseStorageBackend). Not registered or constructed anywhere
automatically — per engine/coordinator.py's StageBlueprint docstring,
EngineCoordinator "never constructs a Provider, a persistence backend,
or any other business-logic object itself"; a caller supplies an
already-configured `worker_factory` (e.g.
``lambda: StorageWorker(backend=SupabaseStorageBackend(...))``).
"""

from __future__ import annotations
