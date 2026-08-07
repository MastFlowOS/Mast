"""
MAST Engine V2 — Orchestration Layer
=======================================

Source: Engine BluePrint, Phase 1.1 – 1.5.

This package is the new home for the engine's orchestration layer:

    coordinator.py  — EngineCoordinator: starts sessions, allocates
                      workers, monitors queues/health, resumes failed
                      work, ends sessions. Never processes businesses.
    session.py      — DiscoverySession: owns everything created by one
                      "Discover Opportunities" click (workers, queues,
                      opportunities, progress).
    contracts.py    — Immutable data contracts (BusinessCandidate,
                      WebsiteIntel, InstagramIntel, ContactIntel,
                      EnrichedBusiness, QualificationResult,
                      OpportunityScore, QualifiedOpportunity,
                      StoredOpportunity, QueueItem).
    interfaces.py   — Abstract contracts for future workers, discovery
                      providers, and queues.
    state.py        — Finite-state enums for pipeline stage, worker
                      lifecycle, queue item lifecycle, and session
                      status.

Status: Milestone 3B
---------------------
This package introduces structure (Milestone 1), real immutable data
contracts (Milestone 2), and a working EngineCoordinator that manages
Discovery Session lifecycle only — create / start / mark_running /
finish / cancel / fail / get / list — backed by an in-memory registry
and a dedicated SessionStateMachine (see engine/coordinator.py). The
registry stores session_id -> SessionContext (engine/session.py), a
mutable per-session container that wraps the frozen DiscoverySession
metadata and reserves fields for everything a session will eventually
own (queues, workers, statistics, provider state, cache, timers,
metrics) as later phases land. STARTING is a real, independently
reachable status, not something callers jump over. This package still
does not perform discovery, create workers or queues, enrich
businesses, or store opportunities.

service.py now instantiates a singleton EngineCoordinator as its
future entry point, but does not yet route discovery through it — the
currently running engine (scraper/, enrichment/, storage/, scoring/,
service.py, main.py) continues to operate exactly as it does today.

See mast-lead-engine repository root for the eventual V2 layout
(providers/, workers/, queue/, models/, exceptions/ packages), which
this package will be wired into over the course of Phases 3-10.

Milestone Phase 5.1 change: engine/interfaces.py's
DiscoveryProviderInterface has been refined to cover identity and
discovery only (provider_id, display_name, a streaming discover()).
Provider runtime status and descriptive metadata (health checks,
capabilities) are deliberately deferred — they'll be introduced
alongside the future Provider Registry milestone. This is an
interface-only change — no provider implementation exists anywhere in
the codebase yet, providers/ remains an empty placeholder package,
WorkerInterface and QueueInterface are untouched, and the currently
running engine (scraper/, enrichment/, storage/, scoring/, service.py)
continues to operate exactly as it does today.
"""

from __future__ import annotations
