"""
Mast Lead Engine — Service Entrypoint (Part 3 / Phase 2 addition, extended
in Phase 6 and Phase 7).

This is the ONLY new file added to the engine. It does not modify
scraper/, enrichment/, storage/, scoring/, or utils/ in any way — it only
imports and orchestrates them, the same way main.py already does.

Two operations, both usable as a library or as a subprocess:

1. SEARCH (Phase 2) — finds new places for a niche/city, streaming
   enriched, scored leads as they clear the pipeline:

       from service import run_query
       async for lead_dict in run_query(query="yoga studios", city="Austin"):
           ...

       echo '{"query":"yoga studios","city":"Austin","max_results":20}' \\
           | python service.py

2. VERIFY (Phase 7) — re-checks a single, already-known business's website
   and/or Instagram directly, with NO Maps search involved:

       from service import verify_business
       result = await verify_business(website="https://example.com", instagram="https://instagram.com/example")

       echo '{"website":"https://example.com","instagram":"https://instagram.com/example"}' \\
           | python service.py verify

Search mode is the default (no mode argument) for backward compatibility
with the Phase 2 Node bridge, which spawns `python service.py` with no
argv and writes params to stdin.
"""

from __future__ import annotations

import sys as _sys

# Milestone 2 (Engine 2.0 Enrichment Bridge): the `enrich` CLI mode's
# entire contract, like `verify`'s before it, is "stdout is exactly one
# JSON line" for pythonBridge.ts to JSON.parse() directly. utils/runtime.py
# — imported transitively by every project import below — configures
# `logging.basicConfig(stream=sys.stdout, ...)` at IMPORT TIME, so
# redirecting sys.stdout has to happen here, before that import runs, to
# have any effect; doing it inside _enrich_cli() (after imports already
# completed) is too late. `_REAL_STDOUT` is where _enrich_cli() writes its
# actual JSON result once everything else has finished logging to the now-
# redirected sys.stdout. Search/verify mode (no "enrich" argv) are
# unaffected — this only swaps sys.stdout under `enrich`.
_REAL_STDOUT = _sys.stdout
_JSON_CLI_MODES = ("enrich", "score", "qualify", "prioritize", "workflow", "crm", "analytics", "ai_coach", "mission_intelligence", "feedback")
if len(_sys.argv) > 1 and _sys.argv[1] in _JSON_CLI_MODES:
    _sys.stdout = _sys.stderr


import time as _time
# Phase 2A instrumentation: approximates the "Python imports" stage the
# audit asked for — the delta between this line (as early as the module
# can record a timestamp) and the point right after every project import
# below finishes. This does NOT capture interpreter startup itself (process
# spawn -> first bytecode of this file), which can only be measured from
# outside the process (e.g. at the Node bridge's spawn() call) — that
# boundary is out of scope for this phase (no TS changes), so it's reported
# as unmeasured rather than guessed at.
_IMPORTS_START_TS = _time.perf_counter()

import asyncio
import json
import os
import queue as thread_queue
import signal
import sys
import tempfile
import threading
import time
from typing import Any, AsyncIterator, Callable, Optional

from exceptions import DiscoveryFailure, DiscoveryFailureReason
from scraper.maps_scraper import MapsScraper
from enrichment.site_crawler import SiteCrawler
from enrichment.ig_intel import IGIntelligence
from scoring.scorer import is_cannabis, is_chain
from storage.dedup import LeadStore, fingerprints_for
from utils.runtime import ProxyManager, RunStats, ScraperConfig, get_logger
from utils.lifecycle_tracker import log_milestone
from utils.perf import RunProfiler, NullProfiler
from utils.pipeline_trace import PipelineTracer
from utils.parsing import is_valid_email, is_weak_site

# Engine 2.0 — production entrypoint now drives discovery / enrichment /
# qualification / storage through the real seven-stage runtime instead of
# the old V1 EnrichmentPipeline (formerly scraper/pipeline.py, removed —
# it had no remaining importers). See the migration notes above
# run_query() for exactly what replaced what.
from engine.acceptance import LeadAcceptanceGate
from engine.coordinator import EngineCoordinator
from engine.contracts import QualifiedOpportunity, StoredOpportunity
from engine.execution_driver import ExecutionDriver, build_seven_stage_pipeline, run_batch_intelligence
from storage.early_persistent_dedup import PersistentEarlyDedupChecker, PersistentEarlyDedupError
from providers.google_maps_provider import GoogleMapsProvider, GoogleMapsDiscoveryRequest
from providers.overpass_provider import OverpassProvider
from providers.discovery_composition import compose_discovery, NoRelevantProviderError
from storage_backends.supabase_backend import SupabaseStorageBackend
from storage_backends.batch_intelligence_backend import SupabaseBatchIntelligenceBackend

# Milestone 2 (pg-boss business-processing integration) — Engine 2.0's
# canonical Website/Instagram/Contact/Merge workers, wired to replace the
# V1 SiteCrawler/IGIntelligence path verify_business() below still serves
# to the (separate, out-of-scope-for-this-milestone) periodic verification
# job. See engine_enrichment_bridge.py's own module docstring for exactly
# what is and is not covered.
from engine_enrichment_bridge import enrich_business as _engine_enrich_business

from opportunity_scoring.service import OpportunityScoringService
from opportunity_qualification.service import OpportunityQualificationService
from crm_intelligence.service import CRMIntelligenceService
from crm_intelligence.models import (
    RelationshipEvaluationRequest as CRMRelationshipRequest,
    InteractionRecord as CRMInteractionRecord,
    ContactPolicy as CRMContactPolicy,
)
from workers.scoring_worker import ScoringWorker


_IMPORTS_DONE_TS = _time.perf_counter()
_IMPORTS_ELAPSED_MS = (_IMPORTS_DONE_TS - _IMPORTS_START_TS) * 1000.0

log = get_logger("service")

# Engine 2.0 cutover: this module-level EngineCoordinator is now the real
# entry point run_query() drives every session through (create_session ->
# start_session -> build_seven_stage_pipeline -> mark_running ->
# ExecutionDriver.run_once() loop). One coordinator per process is
# correct here because the Node bridge spawns one `python service.py`
# subprocess per query (see module docstring) — sessions from different
# queries never collide because each run_query() call mints its own
# session_id.
engine_coordinator = EngineCoordinator()

# Phase 2: module-level slot so _main_cli can read the profiler's summary
# after run_query's finally block has populated it.  This avoids changing
# run_query's public async-generator signature.
_last_perf_summary: dict = {}

_SENTINEL = object()

# LIFECYCLE FIX (bridge delivery / watchdog / graceful shutdown phase):
# module-level cooperative shutdown flag, set by _run_with_graceful_
# shutdown()'s SIGTERM handler and consulted by run_query() at safe
# checkpoints (between ExecutionDriver.run_once() passes, and once per
# discovered candidate via GoogleMapsDiscoveryRequest.should_stop) instead
# of the previous behavior of hard-cancelling the asyncio task.
#
# WHY NOT task.cancel(): run_query()'s production path drives
# ExecutionDriver.run_once() via `asyncio.to_thread(...)`, which runs on a
# real OS thread. asyncio.Task.cancel() cannot actually interrupt code
# already executing on that thread — it can only make the *awaiting*
# coroutine stop waiting for it. The previous implementation did exactly
# that: cancelling the outer task made `await asyncio.to_thread(...)`
# raise CancelledError immediately, while the underlying thread (Discovery
# stage -> GoogleMapsProvider -> MapsScraper, holding an open Playwright
# browser/context/page) kept running, orphaned, completely detached from
# the coroutine that was "waiting" for it. The main coroutine would then
# proceed straight into run_query()'s cleanup (and, if the process didn't
# exit fast enough, the Node bridge's escalation from SIGTERM to SIGKILL —
# see src/scraperBridge/pythonBridge.ts's gracefulKillProcessTree) while
# that orphaned thread was still actively calling into Playwright — the
# exact "Target page, context or browser has been closed" race reported
# from the live test.
#
# This flag fixes that at the root: nothing here ever force-interrupts
# in-flight thread work. Instead, discovery is given a cheap, frequent
# checkpoint (after every candidate it already streamed) to notice a stop
# request and simply stop asking Maps for more — the current
# `driver.run_once()` call is then allowed to return *normally*, at which
# point no thread is touching Playwright anymore and cleanup (including
# closing the browser) is safe. See `_run_with_graceful_shutdown` below
# for the (bounded) hard-cancel fallback kept as a last resort for a run
# that doesn't check this flag often enough to wind down in time.
_shutdown_event = threading.Event()
_shutdown_reason: Optional[str] = None


def _get_shutdown_reason() -> Optional[str]:
    """
    Returns the cooperative shutdown reason if one was signaled by the parent
    process (via IPC stop-reason file or internal setter).
    """
    global _shutdown_reason
    if _shutdown_reason is not None:
        return _shutdown_reason
    stop_file = os.path.join(tempfile.gettempdir(), f"mast_stop_{os.getpid()}.txt")
    if os.path.exists(stop_file):
        try:
            with open(stop_file, "r", encoding="utf-8") as f:
                content = f.read().strip()
                if content:
                    _shutdown_reason = content
                    return content
        except Exception:
            pass
    return None


def _set_shutdown_reason(reason: Optional[str]) -> None:
    """Explicit setter for in-process lifecycle tests."""
    global _shutdown_reason
    _shutdown_reason = reason


# LIFECYCLE FIX (FINAL SHUTDOWN LATENCY + CONSUMER_STOPPED FIX): both of
# these reasons mean "this run stopped on request, not because anything
# went wrong" — TARGET_REACHED (the parent request's target was already
# satisfied by a sibling) and CONSUMER_STOPPED (the Node bridge's own
# consumer, e.g. area rotation hitting its streaming batch quota, simply
# stopped iterating early; see pythonBridge.ts's `consumerStoppedEarly`).
# Previously only TARGET_REACHED was recognized here, so a plain area-
# worker rotation SIGTERM (reason=CONSUMER_STOPPED) fell through to the
# `else` branch at every call site below and was misreported as
# `DiscoveryFailure(CANCELLED)` — a normal, expected termination surfaced
# as a failure. USER_CANCELLED/WATCHDOG_TIMEOUT/unspecified are
# deliberately NOT included here: those must keep raising
# DiscoveryFailure(CANCELLED) unchanged (see module docstring — "Keep real
# crash/watchdog/user-cancelled semantics unchanged").
_NON_FAILURE_SHUTDOWN_REASONS = frozenset({"TARGET_REACHED", "CONSUMER_STOPPED"})


def _is_non_failure_shutdown(reason: Optional[str]) -> bool:
    return reason in _NON_FAILURE_SHUTDOWN_REASONS


# How long _run_with_graceful_shutdown waits for the cooperative shutdown
# above to finish on its own before escalating to a forced task
# cancellation (the old, unconditional behavior). Comfortably shorter than
# the Node bridge's own SIGTERM->SIGKILL grace period
# (GRACEFUL_SHUTDOWN_MS / SCRAPER_GRACEFUL_SHUTDOWN_MS in
# pythonBridge.ts — kept above this value there) so Python's own graceful
# path (which still gets to write __done__ and close resources in order)
# has a real chance to win the race before Node's hard kill would fire.
COOPERATIVE_SHUTDOWN_GRACE_S = 12.0

# LIFECYCLE FIX (FAST TARGET CLEANUP — FINAL SHUTDOWN LATENCY +
# CONSUMER_STOPPED FIX): the live run this fix responds to spent ~20s
# after TARGET_REACHED just waiting out this escalation window on unused
# sibling workers, even though `should_stop`/`_should_stop_discovery` were
# already true and there was no useful work left to wind down. That full
# 12s window exists to protect a run that's still actively finishing
# meaningful work (a genuine watchdog/user-cancel mid-scrape) — it is
# unnecessary generosity for a reason that already means "nothing useful
# is left to do", so those two reasons get a much shorter fuse before
# falling back to forced cancellation. Not zero: `run_query`'s own
# checkpoints (should_stop / the between-pass shutdown_event check) are
# frequent but not synchronous with an in-flight Playwright call, so a
# short window still lets an already-cheap checkpoint fire and exit
# cleanly instead of hitting the forced-cancellation path on every run.
FAST_SHUTDOWN_GRACE_S = 2.0


def _shutdown_grace_period_s(reason: Optional[str]) -> float:
    return FAST_SHUTDOWN_GRACE_S if _is_non_failure_shutdown(reason) else COOPERATIVE_SHUTDOWN_GRACE_S


def _build_storage_backend() -> SupabaseStorageBackend:
    """
    Engine 2.0 composition-root wiring for the Storage stage.
    SupabaseStorageBackend (storage_backends/supabase_backend.py) is the
    one concrete `_StoragePersistenceProtocol` implementation that exists
    today; it reads SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY from the
    environment by default (see its own constructor docstring) — no new
    env var names invented here.
    """
    return SupabaseStorageBackend()


#: Phase 3C-4B — cached once per process. `_build_early_dedup_checker()`
#: is called on every `run_query()` invocation (unlike `_build_storage_backend`,
#: this one is optional and allowed to fail), so the attempt-and-log-once
#: behavior lives here rather than being repeated at every call site.
_early_dedup_checker_cache: "dict[str, Optional[PersistentEarlyDedupChecker]]" = {}


def _build_early_dedup_checker() -> Optional[PersistentEarlyDedupChecker]:
    """
    Composition-root wiring for Phase 3C-4B's early dedup stage. Same
    SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY env-var convention as
    `_build_storage_backend()` above — no new config surface. Unlike
    Storage, this is optional: a missing/invalid config must never break
    `run_query()`, since early dedup is a fast-reject optimization, not a
    required stage (Step 4). Constructed at most once per process and
    cached (including the "not configured" outcome) so a missing config
    doesn't get silently re-attempted (and re-logged) on every run_query()
    call within a long-lived worker process.
    """
    if "checker" in _early_dedup_checker_cache:
        return _early_dedup_checker_cache["checker"]
    try:
        checker: Optional[PersistentEarlyDedupChecker] = PersistentEarlyDedupChecker()
    except PersistentEarlyDedupError:
        log.info(
            "[early-dedup] SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY not configured — "
            "early persistent dedup disabled for this process; every candidate "
            "will still go through the existing final dedup unchanged."
        )
        checker = None
    _early_dedup_checker_cache["checker"] = checker
    return checker


def _build_batch_intelligence_backend() -> SupabaseBatchIntelligenceBackend:
    """
    Composition-root wiring for the Persistence Integration milestone's
    batch intelligence backend (storage_backends/batch_intelligence_backend.py).
    Identical env-var convention to `_build_storage_backend()` above —
    SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY, no new names invented.
    """
    return SupabaseBatchIntelligenceBackend()


class _StreamingStorageBackend:
    """
    Composition-root-only wrapper around the real
    `_StoragePersistenceProtocol` backend. StorageWorker (unmodified)
    only ever sees this wrapper's `persist()` — it has no idea a
    generator on the other side of a thread boundary is waiting for its
    result. This is the seam that lets run_query() stream a lead the
    moment it's actually persisted, without StorageWorker/ExecutionDriver
    knowing anything about asyncio, queues, or the Node bridge.
    """

    def __init__(self, inner: SupabaseStorageBackend, on_persisted) -> None:
        self._inner = inner
        self._on_persisted = on_persisted

    def persist(self, opportunity: QualifiedOpportunity) -> StoredOpportunity:
        stored = self._inner.persist(opportunity)
        self._on_persisted(opportunity, stored)
        return stored


def _candidate_dict(candidate) -> dict:
    """BusinessCandidate -> plain dict, field-for-field, no new facts."""
    return {
        "pipeline_id": candidate.pipeline_id,
        "provider": candidate.provider,
        "maps_link": candidate.maps_url,
        "name": candidate.name,
        "category": candidate.category,
        "address": candidate.address,
        "city": candidate.city,
        "country": candidate.country,
        "website": candidate.website,
        "phone": candidate.phone,
        "rating": candidate.rating,
        "review_count": candidate.review_count,
        "discovered_at": candidate.discovered_at,
    }


def _resolve_instagram_url(candidate, instagram_intel, contact_intel) -> str | None:
    """
    SCHEMA MISMATCH FIX (Node channelFilter vs Python Qualification):
    QualificationWorker's "instagram" required-channel rule
    (workers/qualification_worker.py) treats the channel as satisfied
    by ANY of three independent sources, in this priority order:

        1. business.instagram_url    — an authoritative URL a discovery
                                        provider (e.g. a future Maps
                                        variant) attached directly to
                                        the BusinessCandidate.
        2. instagram_intel           — InstagramWorker actually reached
                                        a live, reachable profile
                                        (`profile_reachable is True`).
        3. contact_intel.instagram_url — ContactWorker found an
                                        Instagram link on the business's
                                        own website/contact page (the
                                        "4-channel blocker fix" — see
                                        ContactIntel's docstring).

    `_opportunity_to_lead_dict` previously only ever read
    `instagram_intel.profile_url`, ignoring sources 1 and 3 entirely.
    That meant a candidate qualified by ContactWorker's site-discovered
    Instagram link (source 3 — the common real-world case once a
    profile itself is private/rate-limited/unreachable) was PASSED by
    QualificationWorker but then reached Node's `channelFilter.ts`
    (src/lib/channelFilter.ts, which independently re-checks
    `lead.instagram`) with an empty `instagram` field, and was silently
    rejected downstream with `channel_filter:[...]` even though
    Qualification had already said all four channels were satisfied.

    This resolver mirrors QualificationWorker's exact source priority
    and boolean semantics so the `instagram` value handed to Node is
    non-empty in precisely the cases QualificationWorker already
    counted as "has Instagram" — no channel semantics change, only the
    lead_dict's field now agrees with the decision already made.
    """
    if candidate is not None and getattr(candidate, "instagram_url", None):
        return candidate.instagram_url
    if (
        instagram_intel is not None
        and instagram_intel.profile_reachable is True
        and instagram_intel.profile_url
    ):
        return instagram_intel.profile_url
    if contact_intel is not None and getattr(contact_intel, "instagram_url", None):
        return contact_intel.instagram_url
    return None


def _opportunity_to_lead_dict(
    opportunity: QualifiedOpportunity, stored: StoredOpportunity
) -> dict[str, Any]:
    """
    QualifiedOpportunity + StoredOpportunity -> the flat lead dict shape
    run_query() has always yielded, keeping the Node bridge's existing
    field names wherever an Engine 2.0 contract has an equivalent field
    (name/website/phone/rating/etc.), and adding the new engine's own
    identifiers (opportunity_id, pipeline_id, session_id) alongside them.
    """
    enriched = opportunity.business
    candidate = enriched.business if enriched else None
    website_intel = enriched.website_intel if enriched else None
    instagram_intel = enriched.instagram_intel if enriched else None
    contact_intel = enriched.contact_intel if enriched else None
    qualification = opportunity.qualification
    score = opportunity.score

    emails = [e for e in (contact_intel.emails or ()) if is_valid_email(e)] if contact_intel else []
    phones = list(contact_intel.phones) if contact_intel and contact_intel.phones else []

    lead_dict: dict[str, Any] = {
        "pipeline_id": opportunity.pipeline_id,
        "session_id": opportunity.session_id,
        "opportunity_id": stored.opportunity_id,
        "stored_at": stored.created_at,
        "name": candidate.name if candidate else None,
        "category": candidate.category if candidate else None,
        "address": candidate.address if candidate else None,
        "city": candidate.city if candidate else None,
        "country": candidate.country if candidate else None,
        "website": candidate.website if candidate else None,
        "maps_link": candidate.maps_url if candidate else None,
        "rating": candidate.rating if candidate else None,
        "review_count": candidate.review_count if candidate else None,
        "phone": (candidate.phone if candidate else None) or (phones[0] if phones else None),
        "phones": phones,
        "email": emails[0] if emails else None,
        "emails": emails,
        "website_reachable": website_intel.website_reachable if website_intel else None,
        # SCHEMA MISMATCH FIX: was `instagram_intel.profile_url if instagram_intel
        # else None`, which silently dropped the ContactWorker-discovered and
        # BusinessCandidate-level sources QualificationWorker's "instagram"
        # required-channel rule already accepts — see
        # `_resolve_instagram_url`'s own docstring above for the full
        # production trace (candidate_qualified -> storage success ->
        # NODE_RECEIVED -> REJECTED reason=channel_filter:[...]).
        "instagram": _resolve_instagram_url(candidate, instagram_intel, contact_intel),
        "ig_username": instagram_intel.username if instagram_intel else None,
        "ig_followers": instagram_intel.followers if instagram_intel else None,
        "ig_verified": instagram_intel.verified if instagram_intel else None,
        "score": score.opportunity_score if score else None,
        "tier": score.tier if score else None,
        "business_health_score": score.business_health_score if score else None,
        "qualified": qualification.qualified if qualification else None,
        "reasons": list(qualification.reasons) if qualification else [],
        "business_problems": list(qualification.business_problems) if qualification else [],
        "needed_services": list(qualification.needed_services) if qualification else [],
    }
    return lead_dict


async def run_query(
    *,
    query: str,
    city: str,
    country: str = "US",
    niche: str = "",
    region: str = "",
    area: str = "",
    max_results: int = 60,
    deliver_target: int | None = None,
    max_ig_followers: int = 5000,
    max_reviews: int = 500,
    min_score: int = 0,
    fast: bool = False,
    skip_ig: bool = False,
    skip_site_crawl: bool = False,
    require_viability: bool = True,
    discovery_only: bool = False,
    db_path: str = "data/leads.db",
    required_channels: Optional[list[str] | tuple[str, ...]] = None,
    # LIFECYCLE FIX (bridge delivery / watchdog / graceful shutdown phase):
    # optional cooperative shutdown flag — see the module-level
    # `_shutdown_event` docstring above for why this replaced hard task
    # cancellation. `_main_cli` always passes the module-level event;
    # `None` (the default) preserves old behavior for any other caller
    # (library use, tests/validate_service_run_query.py) that doesn't
    # pass one — such a caller simply never requests early shutdown.
    shutdown_event: Optional[threading.Event] = None,
    shutdown_reason: Optional[str] = None,
) -> AsyncIterator[dict[str, Any]]:
    """
    Async generator now driven by Engine 2.0 instead of the V1
    MapsScraper -> EnrichmentPipeline asyncio-queue pipeline:

        discovery_only=True:
            GoogleMapsProvider.discover() (Engine 2.0's
            DiscoveryProviderInterface implementation, replacing this
            branch's former direct MapsScraper.search() call) streamed
            through a background thread, chain/cannabis-filtered and
            fingerprinted here exactly as before (see
            providers/google_maps_provider.py's own docstring, Ambiguity
            1/2, for why that filtering stays a caller/service.py
            responsibility rather than moving into the provider).

        discovery_only=False (production search):
            EngineCoordinator.create_session() -> start_session() ->
            build_seven_stage_pipeline() -> mark_running() assembles the
            full Discovery -> Website/Instagram/Contact -> Merge ->
            Qualification -> (Scoring, called synchronously) -> Storage
            graph (engine/execution_driver.py, unmodified). This
            generator then drives ExecutionDriver.run_once() itself, one
            pass at a time, off the event loop thread
            (asyncio.to_thread), and streams a lead dict the moment
            StorageWorker actually persists a QualifiedOpportunity (via
            _StreamingStorageBackend below) — the same "stream as it
            clears the pipeline" contract this generator has always had.

    Still yields one lead dict at a time, with `fingerprints` /
    `is_disqualified` attached the same way as before (LeadStore /
    fingerprints_for are V1 dedup-cache modules that Engine 2.0's
    StorageWorker deliberately does not replace — see
    workers/storage_worker.py / providers/google_maps_provider.py, both
    explicit that deduplication is not this milestone's job — so
    service.py, as composition root, keeps applying it exactly as
    before).

    `area` — AREA-SCOPE OVERPASS FIX (Phase 13C). Optional, more
    specific sub-city scope (e.g. a curated borough/neighborhood name
    such as "Brooklyn") already known by the caller for this run,
    forwarded unchanged to `compose_discovery()` -> `DiscoveryQueryContext`.
    Today this is consumed only by Overpass's own request translation
    (see providers/provider_request_translation.py), which prefers it
    over `city`/`country` for its `area_name` when present. Every
    other provider (including Google Maps), qualification, scoring,
    dedup, worker counts, and resource capacity are untouched by this
    parameter. Omitted (the default, `""`) preserves the exact prior
    city/country-scoped Overpass behavior for any existing caller that
    doesn't pass it — see providers/provider_request_translation.py's
    own docstring for the fallback rule.

    Known, intentional behavior changes from V1 (not bugs — see the
    accompanying migration review):
      * `fast`, `skip_ig`, `skip_site_crawl`, `max_ig_followers`,
        `max_reviews`, `require_viability` have no Engine 2.0 equivalent
        yet (WebsiteWorker/InstagramWorker/ContactWorker always run;
        QualificationWorker's only configuration is `niche` /
        `required_categories`). They are still accepted here so
        existing callers don't break, but are currently no-ops for the
        production (non discovery_only) path.
      * STALE NOTE, corrected (Phase 2B): this paragraph previously
        claimed discovery does not overlap with enrichment because
        DiscoveryWorker.process() blocks until its provider is
        exhausted. That was true of the ORIGINAL inline scheduling
        this driver used, but is no longer true of the pipeline this
        function actually drives. `ExecutionDriver` now runs every
        producer StageConfig (today: only Discovery) on its own
        dedicated thread, started as soon as this driver begins
        producing passes at all, decoupled from the transformer-stage
        pass loop (engine/execution_driver.py, "PHASE 2B FIX
        (continuous pipeline flow)"). `DiscoveryWorker.process()`
        still blocks its own thread until the provider is exhausted —
        that part of the quoted claim above was correct and remains
        unchanged (workers/discovery_worker.py, "Revision history,
        v3") — but that thread is no longer the same thread the
        Website/Instagram/Contact/Merge/Qualification/Storage passes
        run on, so it no longer blocks them. Each candidate is handed
        to `website_in`/`instagram_in` via `on_candidate` the instant
        it streams in (engine/execution_driver.py's `_on_candidate`),
        and the transformer-stage loop dequeues it immediately,
        concurrently with discovery still producing more candidates.
        `driver.producers_finished()` — not "every queue empty" — is
        what `_fully_drained()` below now checks before declaring
        genuine exhaustion, precisely because discovery may simply be
        between candidates. See tests/test_pipeline_continuous_flow.py
        for the regression coverage (including an instrumentation
        report asserting first_candidate_enqueued < discovery_complete)
        proving this actually holds for the real, unmodified
        `ExecutionDriver` + `build_seven_stage_pipeline()` this
        function drives.
    """
    _legacy_knobs_ignored = {
        k: v for k, v in {
            "fast": fast, "skip_ig": skip_ig, "skip_site_crawl": skip_site_crawl,
            "max_ig_followers": max_ig_followers if max_ig_followers != 5000 else None,
            "max_reviews": max_reviews if max_reviews != 500 else None,
            "require_viability": require_viability if require_viability is not True else None,
        }.items() if v
    }
    if _legacy_knobs_ignored and not discovery_only:
        log.warning(
            "[run_query] legacy knobs %s have no Engine 2.0 equivalent yet "
            "and are currently no-ops for the production pipeline",
            sorted(_legacy_knobs_ignored),
        )

    stats = RunStats()

    # Phase 2: create profiler for this run. Created before LeadStore
    # (Phase 2A reorder) so the fingerprint cache load (audit §3.7) can be
    # timed instead of running invisibly before any timer exists.
    profiler = RunProfiler()
    profiler.mark("python_imports_done")  # see _IMPORTS_ELAPSED_MS below

    def _google_maps_factory() -> Any:
        # PHASE 2B ROOT CAUSE FIX: threads this run's real `profiler`
        # into GoogleMapsProvider (see that class's own docstring) —
        # but via a `try/except TypeError` fallback rather than a bare
        # `GoogleMapsProvider(profiler=profiler)` call, because
        # `GoogleMapsProvider` here is looked up from THIS module's
        # global namespace at call time, and several existing tests
        # (e.g. tests/test_run_query_target_reached_lifecycle.py)
        # deliberately monkeypatch `service.GoogleMapsProvider` with a
        # zero-arg `lambda: fake_provider` to inject a fake — the
        # pre-existing test seam `compose_discovery()`'s own docstring
        # documents. A real `GoogleMapsProvider` accepts `profiler=`;
        # a zero-arg test fake does not, so the fallback preserves
        # that seam exactly as it worked before this phase.
        try:
            return GoogleMapsProvider(profiler=profiler)
        except TypeError:
            return GoogleMapsProvider()

    def _overpass_factory() -> Any:
        # PHASE 2B: same fix, same reasoning, for Overpass.
        try:
            return OverpassProvider(profiler=profiler)
        except TypeError:
            return OverpassProvider()

    store = LeadStore(db_path, profiler=profiler)

    # Phase S1: one PipelineTracer per run_query() call — lives entirely in
    # memory for the duration of this single engine run, discarded when
    # this generator returns. See utils/pipeline_trace.py.
    tracer = PipelineTracer()

    # _deliver_target is the number of qualified leads to yield before
    # declaring ourselves done.  It is always <= max_results (the raw
    # scan budget given to the discovery provider).  When the caller
    # passes deliver_target explicitly, we stop at that number;
    # otherwise we fall back to max_results for backward compatibility.
    _deliver_target: int = deliver_target if deliver_target is not None else max_results

    # Phase 1A (authoritative target/acceptance state): `gate` is the one
    # source of truth for requested/accepted/target-reached for this
    # request — see engine/acceptance.py. It replaces the old bare
    # `delivered` int, which every stop decision below used to read and
    # increment directly with no atomicity guarantee at all (safe only
    # because exactly one coroutine ever touched it). `gate.accepted` is
    # the drop-in equivalent of the old `delivered` value; nothing else in
    # this function tracks "how many leads have been accepted" anymore.
    gate = LeadAcceptanceGate(_deliver_target)
    _last_lead_time: float | None = None   # for inter-lead gap tracking
    log_milestone("Before run_query discovery starts")

    # PART E (Phase 2B — truthful first-lead latency): recorded once each,
    # the first time they happen, in wall-clock seconds since this
    # run_query() call started. Previously the only comparable metric was
    # the bridge's own (Node-side) firstLeadMs, which — per the Phase 2
    # forensic audit — actually measured "how long until the watchdog
    # forced a shutdown that then burst-processed one candidate", not a
    # real first-lead time. These marks are additive; nothing existing is
    # removed. `_mark()` only ever records the FIRST call for a given
    # name — later calls are no-ops — so these always reflect the first
    # occurrence even though multiple candidates/stages produce the same
    # event repeatedly over the run.
    _request_started_ts = time.perf_counter()
    _latency_marks: dict[str, float] = {}

    def _mark(name: str) -> None:
        if name not in _latency_marks:
            _latency_marks[name] = time.perf_counter() - _request_started_ts

    def _on_progress(stage: str, event: str, item_id: str | None) -> None:
        # PART C (Phase 2B — watchdog progress protocol): every one of
        # these events is written to the SAME stdout the lead dicts and
        # the __done__ sentinel already use, as its own one-line JSON
        # object, distinguished by `"type": "progress"` so
        # pythonBridge.ts can tell it apart from a real lead or the
        # __done__ sentinel without any ambiguity. This is deliberately
        # NOT routed through stderr (which the Node bridge already
        # ignores for watchdog purposes — stderr volume is not evidence
        # of protocol-level progress) and deliberately does not touch
        # sys.stdout redirection (that only happens for the separate
        # `enrich`/`score`/... JSON-CLI modes — see the top of this
        # file — never for this, the default search/production mode).
        try:
            sys.stdout.write(json.dumps({
                "type": "progress",
                "session_id": session_id,
                "stage": stage,
                "event": event,
                "item_id": item_id,
                "timestamp": time.time(),
            }, default=str) + "\n")
            sys.stdout.flush()
        except (BrokenPipeError, IOError, OSError):
            pass

        if stage == "discovery" and event == "candidate_discovered":
            _mark("first_candidate_discovered")
            profiler.incr("raw_candidates")
        elif stage == "discovery" and event == "candidate_queued":
            _mark("first_candidate_accepted")
            profiler.incr("early_new")
        elif stage == "discovery" and event == "candidate_early_duplicate":
            profiler.incr("early_duplicates")
        elif event == "candidate_early_channel_pruned":
            # Emitted by discovery (pre-enqueue) and by website/contact
            # (post-enqueue, once a channel becomes provably unsatisfiable)
            # — see engine/execution_driver.py's `_on_candidate` /
            # `_on_enrichment_failure_outcome`. All three count toward the
            # same "early_pruned" area-sla figure; this stage never gets
            # fully enriched either way, so the distinction between
            # pre-enqueue and post-enqueue pruning doesn't change what the
            # figure is meant to answer ("how many candidates did the
            # pipeline give up on early").
            profiler.incr("early_pruned")
        elif event == "stage_completed" and stage in ("website", "instagram", "contact"):
            _mark("first_enrichment_completed")
        elif event == "stage_failed" and stage == "contact":
            profiler.incr("contact_failures")
        # Phase 8.1 (ContactWorker resilience fix) — additive per-page
        # counters, emitted alongside (never instead of) the existing
        # contact_stage_failed / contact_failures counters above. See
        # engine/execution_driver.py's `_contact_downstream`.
        elif stage == "contact" and event == "contact_page_fetch_failed":
            profiler.incr("contact_page_fetch_failures")
        elif stage == "contact" and event == "homepage_fetch_failed":
            profiler.incr("homepage_fetch_failures")
        elif stage == "contact" and event == "mailto_link_extracted":
            profiler.incr("mailto_links_extracted")
        elif stage == "contact" and event == "tel_link_extracted":
            profiler.incr("tel_links_extracted")
        elif stage == "contact" and event == "partial_contact_success":
            profiler.incr("partial_contact_successes")
        # Phase 14.2 (Instagram acquisition, quality-preserving) —
        # "Make Instagram telemetry truthful". Additive counters only;
        # never gate/prune anything. See engine/execution_driver.py's
        # `_instagram_downstream` / `_contact_downstream` for what each
        # event means and the InstagramIntel/ContactIntel fields it's
        # derived from.
        elif stage == "instagram" and event == "instagram_attempted":
            profiler.incr("instagram_attempted")
        elif stage == "instagram" and event == "instagram_url_input_present":
            profiler.incr("instagram_url_input_present")
        elif stage == "instagram" and event == "instagram_profile_reachable":
            profiler.incr("instagram_profile_reachable")
        elif stage == "instagram" and event == "instagram_short_circuited":
            profiler.incr("instagram_short_circuited")
        elif stage == "contact" and event.startswith("instagram_discovery_found:"):
            profiler.incr("instagram_discovery_found")
            profiler.incr(f"instagram_source_{event.rsplit(':', 1)[1]}")
        elif stage == "contact" and event == "instagram_discovery_invalid":
            profiler.incr("instagram_discovery_invalid")
        elif stage == "contact" and event == "instagram_discovery_missing":
            profiler.incr("instagram_discovery_missing")
        # Phase 15 (Email / Contact Acquisition telemetry)
        elif stage == "contact" and event == "email_secondary_page_fetched":
            profiler.incr("email_secondary_page_fetched")
        elif stage == "contact" and event == "email_secondary_page_found":
            profiler.incr("email_secondary_page_found")
        elif stage == "contact" and event == "email_acquired":
            profiler.incr("email_acquired")
        elif stage == "contact" and event == "email_missing_after_scan":
            profiler.incr("email_missing_after_scan")
        elif stage == "contact" and event == "phone_secondary_page_fetched":
            profiler.incr("phone_secondary_page_fetched")
        elif stage == "contact" and event == "phone_acquired":
            profiler.incr("phone_acquired")
        elif stage == "contact" and event == "phone_missing_after_scan":
            profiler.incr("phone_missing_after_scan")
        elif stage == "contact" and event == "secondary_page_fetch_failures":
            profiler.incr("secondary_page_fetch_failures")
        # Phase 9.1 (audit follow-up) — additive, observational only:
        # which broadened contact-page hint keyword WebsiteWorker's
        # secondary-page match used (contact/help/support/about/press/
        # careers/wholesale/partners/terms/policy/policies/locations).
        # Never gates anything; see engine/execution_driver.py's
        # `_website_downstream`.
        elif stage == "website" and event.startswith("contact_page_hint:"):
            profiler.incr(f"contact_page_hint_{event.rsplit(':', 1)[1]}")
        elif stage == "qualification" and event == "candidate_qualified":
            _mark("first_candidate_qualified")
            profiler.incr("qualified")
        # Phase 3B-VALIDATION (observability only): these `site_class_*`
        # events are new, additive labels emitted alongside the existing
        # events above (see engine/execution_driver.py's `_site_class`
        # usages) — they never replace or gate anything already handled
        # above; they only route into their own, separately-summed
        # `*_weak_site`/`*_normal_site` counters so §Task 1-4 of the
        # Phase 3B audit can be answered from real run telemetry instead
        # of a one-off log query.
        elif stage == "discovery" and event.startswith("site_class_queued:"):
            profiler.incr(f"early_new_{event.rsplit(':', 1)[1]}_site")
        elif stage == "website" and event.startswith("site_class_stage_completed:"):
            profiler.incr(f"website_reached_{event.rsplit(':', 1)[1]}_site")
        elif stage == "website" and event.startswith("site_class_stage_failed:"):
            profiler.incr(f"website_failed_{event.rsplit(':', 1)[1]}_site")
        elif stage == "contact" and event.startswith("site_class_stage_completed:"):
            profiler.incr(f"contact_reached_{event.rsplit(':', 1)[1]}_site")
        elif stage == "contact" and event.startswith("site_class_stage_failed:"):
            profiler.incr(f"contact_failures_{event.rsplit(':', 1)[1]}_site")
        elif stage == "qualification" and event.startswith("site_class_qualified:"):
            profiler.incr(f"qualified_{event.rsplit(':', 1)[1]}_site")

    def _on_stage_timing(outcome) -> None:
        # PHASE 2 (per-area latency profiling): route each stage's
        # `EngineRuntime.execute_stage()` timing into the profiler's
        # existing StageTimer machinery under a `<stage>_worker` name, so
        # `area_sla_line()` can read it back via `_sum("website_worker")`
        # etc. Deliberately named `<stage>_worker` rather than bare
        # `<stage>` so it can never collide with a scraper-side stage name
        # (e.g. a hypothetical future "storage" timer inside a worker
        # itself) sharing the same StageTimer dict. Never allowed to raise
        # — `build_seven_stage_pipeline()` already wraps this call in its
        # own try/except, but a defensive check here costs nothing.
        try:
            profiler.record_stage_duration(f"{outcome.stage_name}_worker", outcome.duration_ms)
        except Exception:
            pass

    # LIFECYCLE FIX (target reached / graceful shutdown): a single
    # cooperative check, shared by both branches below, threaded into
    # GoogleMapsDiscoveryRequest.should_stop (see providers/
    # google_maps_provider.py) so discovery stops asking Maps for more raw
    # candidates the moment either condition is true, instead of always
    # running to `max_results`/raw_supply_cap. Reads `gate` and
    # `shutdown_event` from this closure's enclosing scope live, at call
    # time — ordinary Python closure semantics, not a snapshot — so it
    # always reflects the current state even though it's constructed once,
    # here, before `gate` has accepted any leads yet.
    def _should_stop_discovery() -> bool:
        return gate.target_reached or (
            shutdown_event is not None and shutdown_event.is_set()
        )

    # See run() in main.py / the ROOT CAUSE note this replaces: request a
    # generous raw-supply ceiling rather than a guessed pass-rate multiple,
    # so genuine exhaustion (no more matching businesses) is what actually
    # stops discovery, not an artificial cap.
    raw_supply_cap = max(max_results * 20, 200)

    session_id: Optional[str] = None
    driver: Optional[ExecutionDriver] = None
    _stopped_by_shutdown: bool = False
    try:
        if discovery_only:
            # PROVIDER PARALLELISM v1: composes every relevant, configured
            # provider (see providers/discovery_composition.py) instead of
            # constructing a bare GoogleMapsProvider directly. With no
            # provider API keys configured in the environment (today's
            # actual deployment state), this resolves to exactly
            # {"google_maps"} plus, when a niche keyword matches
            # provider_request_translation.py's small OSM tag table,
            # "overpass" — i.e. behavior is unchanged from before this
            # phase for a deployment with no additional credentials set.
            # `should_stop`/`on_progress` are threaded through exactly as
            # they were passed directly to GoogleMapsDiscoveryRequest
            # before this phase — see DiscoveryQueryContext.
            composed = compose_discovery(
                session_id=str(_time.time_ns()),  # no session/pipeline is created in this mode
                query=query, city=city, country=country,
                niche=niche, region=region, area=area, max_results=raw_supply_cap,
                should_stop=_should_stop_discovery,
                # MINIMAL FIX (discovery liveness — forensic audit §9):
                # `_on_progress` already exists and already writes the
                # stdout `"type":"progress"` line pythonBridge.ts's
                # watchdog resets on — this is the discovery_only branch's
                # own equivalent of the `on_progress=_on_progress` already
                # passed to `build_seven_stage_pipeline()` in the other
                # branch below, so both code paths get the same liveness
                # heartbeat from MapsScraper.search().
                on_progress=_on_progress,
                # PHASE 2B ROOT CAUSE FIX — see the matching comment in
                # the non-discovery_only branch below for the full
                # explanation. This is very likely the exact branch the
                # Phase 2B production log evidence (discovery_worker
                # consuming 100% of Bronx/Queens/Staten Island/Manhattan
                # runtime, [area-sla] fields all reading 0) was captured
                # from: `discovery_only=True` runs no enrichment stage at
                # all, so "discovery is the dominant stage" is trivially
                # true here, not merely observed.
                google_maps_factory=_google_maps_factory,
                overpass_factory=_overpass_factory,
                profiler=profiler,
            )
            provider, request = composed.provider, composed.request
            log.info(
                "[provider] discovery_only composed providers=%s",
                composed.selected_provider_ids,
            )
            result_q: "thread_queue.Queue" = thread_queue.Queue(maxsize=1)

            def _discover_worker() -> None:
                # PHASE 2B (discovery wall-clock instrumentation):
                # this thread's entire body IS discovery, start to
                # finish (this branch runs no enrichment stage at
                # all — see the composition call above) — so timing
                # its full lifetime directly is authoritative
                # discovery_total_ms, not a derived/summed value.
                profiler.mark("discovery_worker_start")
                _t0 = _time.perf_counter()
                try:
                    for candidate in provider.discover(request):
                        result_q.put(candidate)
                except BaseException as exc:  # noqa: BLE001 - forwarded below
                    result_q.put(exc)
                finally:
                    profiler.record_stage_duration(
                        "discovery_total_ms", (_time.perf_counter() - _t0) * 1000.0
                    )
                    profiler.mark("discovery_worker_end")
                    result_q.put(_SENTINEL)

            thread = threading.Thread(
                target=_discover_worker, name="mast-discovery-only", daemon=True
            )
            thread.start()
            try:
                while not gate.target_reached:
                    # LIFECYCLE FIX: checked *before* the next (blocking)
                    # queue read, not just relied upon inside the worker
                    # thread — if shutdown was requested while this
                    # coroutine was doing something else entirely (e.g.
                    # between candidates), stop draining immediately
                    # instead of waiting on one more `result_q.get()`.
                    if shutdown_event is not None and shutdown_event.is_set():
                        _stopped_by_shutdown = True
                        log.info(
                            "[run_query] discovery_only: shutdown requested — "
                            "stopping early (delivered=%d/%d so far)",
                            gate.accepted, _deliver_target,
                        )
                        break
                    item = await asyncio.to_thread(result_q.get)
                    if item is _SENTINEL:
                        if shutdown_event is not None and shutdown_event.is_set():
                            _stopped_by_shutdown = True
                            log.info("[run_query] discovery_only: stopped by shutdown before provider exhaustion")
                        else:
                            log.info("[run_query] discovery_only: provider exhausted")
                        break
                    if isinstance(item, BaseException):
                        raise item
                    candidate = item
                    pid = tracer.discover(candidate.name or "<unnamed>")
                    raw_dict = _candidate_dict(candidate)
                    if is_chain(candidate.name) or is_cannabis(raw_dict):
                        tracer.reject(pid, "chain_or_cannabis")
                        continue
                    raw_dict["fingerprints"] = sorted(fingerprints_for(raw_dict))
                    raw_dict["is_disqualified"] = False
                    raw_dict["_pipeline_id"] = pid
                    # Phase 1A: the authoritative accept/reject decision.
                    # Under the current single-consumer architecture this
                    # can only fail if the target was already reached on a
                    # prior iteration (the `while not gate.target_reached`
                    # guard above already covers that) — checked explicitly
                    # anyway so this remains correct if a second concurrent
                    # producer is ever added without this loop changing.
                    if not gate.try_accept_lead():
                        tracer.reject(pid, "target_already_reached")
                        break
                    tracer.transition(pid, "YIELDED_TO_NODE")
                    tracer.deliver(pid)
                    yield raw_dict
            finally:
                # Best-effort: nothing to cancel (provider.discover() runs on
                # a daemon thread with its own private event loop — see
                # GoogleMapsProvider's own docstring, Ambiguity 4), but drain
                # the sentinel so the thread is never left blocked on a full
                # queue if we broke out early.
                try:
                    while thread.is_alive():
                        try:
                            result_q.get_nowait()
                        except thread_queue.Empty:
                            break
                except Exception:
                    pass
                tracer.sweep_incomplete("run_ended_before_business_finished (discovery_only)")
            if _stopped_by_shutdown and not gate.target_reached:
                effective_reason = shutdown_reason or _get_shutdown_reason()
                if _is_non_failure_shutdown(effective_reason):
                    log.info(
                        "[run_query] discovery_only: cooperative shutdown stopped this run due to "
                        "%s — completing as successful early stop (delivered=%d/%d)",
                        effective_reason, gate.accepted, _deliver_target,
                    )
                else:
                    log.warning(
                        "[run_query] discovery_only: cooperative shutdown stopped this run "
                        "before target_reached or genuine exhaustion — "
                        "raising DiscoveryFailure(CANCELLED) so __done__ "
                        "reports this accurately instead of as an ordinary "
                        "success=True completion (delivered=%d/%d)",
                        gate.accepted, _deliver_target,
                    )
                    raise DiscoveryFailure(
                        DiscoveryFailureReason.CANCELLED,
                        "cooperative shutdown (watchdog inactivity/ceiling, caller "
                        "abort, or process shutdown) stopped this run before it "
                        "reached its target or genuinely exhausted its search space",
                    )
        else:
            ctx = engine_coordinator.create_session(
                user_id="service.run_query",
                provider="google_maps",
                niche=niche or None,
                country=country or None,
                city=city or None,
                requested_count=_deliver_target,
            )
            session_id = ctx.session.id
            engine_coordinator.start_session(session_id)

            # PROVIDER PARALLELISM v1: composes every relevant, configured
            # provider (see providers/discovery_composition.py) instead of
            # constructing a bare GoogleMapsProvider directly — see the
            # matching comment in the discovery_only branch above for what
            # this resolves to with today's actual (no extra API keys)
            # deployment state.
            composed = compose_discovery(
                session_id=session_id, query=query, city=city, country=country,
                niche=niche, region=region, area=area, max_results=raw_supply_cap,
                should_stop=_should_stop_discovery,
                # MINIMAL FIX (discovery liveness — forensic audit §9):
                # `on_progress=_on_progress` below (passed to
                # `build_seven_stage_pipeline()`) only reaches
                # execution_driver.py's own `_emit()` closure, which is
                # invoked from `_on_candidate()`/`_emit_stage_outcome()` —
                # i.e. still only AFTER a candidate exists, exactly the
                # blind spot this fix closes. Threading the same
                # `_on_progress` straight onto the request itself is what
                # lets MapsScraper.search()'s new panel_resolved/
                # round_scanned/crash_detected/crash_recovered heartbeats
                # (see scraper/maps_scraper.py) reach stdout at all in this
                # (non-discovery_only) branch.
                on_progress=_on_progress,
                # PHASE 2B ROOT CAUSE FIX: thread this run's real
                # `profiler` (constructed above, near the top of
                # run_query()) into the GoogleMapsProvider/OverpassProvider
                # instances compose_discovery() actually builds, instead
                # of the bare `GoogleMapsProvider`/`OverpassProvider`
                # classes (zero-arg factories that always left
                # MapsScraper defaulting to a NullProfiler — see
                # GoogleMapsProvider's own docstring for the full
                # explanation). `_google_maps_factory`/`_overpass_factory`
                # (defined near the top of run_query(), just after
                # `profiler` itself) preserve the exact pre-existing
                # `Callable[[], DiscoveryProviderInterface]` test seam —
                # monkeypatching `service.GoogleMapsProvider` with a
                # zero-arg fake still works via their `try/except
                # TypeError` fallback (see their own docstrings).
                google_maps_factory=_google_maps_factory,
                overpass_factory=_overpass_factory,
                profiler=profiler,
            )
            discovery_provider = composed.provider
            discovery_request = composed.request
            log.info(
                "[provider] session=%s composed providers=%s",
                session_id, composed.selected_provider_ids,
            )

            result_q: "thread_queue.Queue" = thread_queue.Queue()

            def _on_persisted(opportunity: QualifiedOpportunity, stored: StoredOpportunity) -> None:
                result_q.put((opportunity, stored))

            streaming_backend = _StreamingStorageBackend(_build_storage_backend(), _on_persisted)

            instance_counts = {
                "website": 8,
                "instagram": 4,
                "contact": 8,
                "merge": 4,
                "qualification": 4,
                "storage": 2,
            }
            stages, queue_ids, fan_in, cleanup_cb = build_seven_stage_pipeline(
                engine_coordinator, session_id,
                discovery_provider=discovery_provider,
                discovery_request=discovery_request,
                storage_backend=streaming_backend,
                niche=niche or None,
                on_progress=_on_progress,
                on_stage_timing=_on_stage_timing,
                early_dedup_checker=_build_early_dedup_checker(),
                required_channels=tuple(required_channels) if required_channels else None,
                instance_counts=instance_counts,
            )
            engine_coordinator.mark_running(session_id)
            engine_runtime = engine_coordinator.get_engine_runtime(session_id)

            def _on_discovery_wallclock(stage_name: str, elapsed_ms: float) -> None:
                # PHASE 2B (discovery wall-clock instrumentation): the
                # `discovery` stage's single `execute_stage()` call
                # already blocks until `discovery_provider` is fully
                # exhausted (see ExecutionDriver's own "PHASE 2B FIX
                # (continuous pipeline flow)" docstring note) — so this
                # one measurement IS discovery_total_ms, not a sum of
                # anything. Also fixes the pre-existing
                # "discovery_worker_end" gap: that mark was set nowhere
                # in this codebase before this fix, silently degrading
                # `_discovery_span_ms()`/`_browser_utilization_pct()`/
                # `_discovery_worker_utilization_pct()` in print_report()
                # to a whole-run-span fallback.
                if stage_name == "discovery":
                    profiler.record_stage_duration("discovery_total_ms", elapsed_ms)
                    profiler.mark("discovery_worker_end")

            driver = ExecutionDriver(
                engine_runtime, stages, on_stage_outcome=cleanup_cb,
                on_stage_wallclock=_on_discovery_wallclock, run_producers_once=True,
            )

            all_input_queue_ids = [
                queue_ids.website_in, queue_ids.instagram_in, queue_ids.contact_in,
                queue_ids.merge_in, queue_ids.qualification_in, queue_ids.storage_in,
            ]
            queue_manager = ctx.runtime.queue_manager

            def _fully_drained() -> bool:
                # PART B/D (Phase 2B): with Discovery now running on its
                # own dedicated thread (engine/execution_driver.py's
                # producer-thread decoupling), "every input queue is
                # currently empty" is no longer sufficient evidence of
                # genuine exhaustion — discovery may simply be between
                # candidates. `driver.producers_finished()` is checked
                # first so this can never declare exhaustion while
                # discovery is still actively running.
                if driver is not None and not driver.producers_finished():
                    return False
                if fan_in.pending_count() != 0:
                    return False
                return all(queue_manager.get_queue(qid).is_empty() for qid in all_input_queue_ids)

            profiler.mark("discovery_worker_start")

            # PART D (Phase 2B — watchdog shutdown semantics): set when
            # the loop below breaks specifically because
            # `shutdown_event` was seen set, as opposed to breaking
            # because `gate.target_reached` or genuine `_fully_drained()`
            # exhaustion. Consulted right after the loop (still inside
            # this `try`, before the shared cleanup `finally`) to decide
            # whether to raise `DiscoveryFailure(CANCELLED)` — see there
            # for why a cooperative-shutdown break must never be allowed
            # to fall through and be reported as an ordinary
            # `success=True` completion.
            _stopped_by_shutdown = False
            hb_stop = asyncio.Event()

            async def _hb_ticker():
                while not hb_stop.is_set():
                    try:
                        await asyncio.sleep(15)
                    except asyncio.CancelledError:
                        break
                    if not hb_stop.is_set():
                        _on_progress("engine", "heartbeat", None)

            hb_task = asyncio.create_task(_hb_ticker())
            try:
                idle_passes = 0
                while not gate.target_reached:
                    # LIFECYCLE FIX (graceful shutdown ordering): checked
                    # *before* starting another driver.run_once() pass, not
                    # after — this is the safe checkpoint. Whatever pass is
                    # already in flight when a shutdown is requested is
                    # never interrupted (see the module-level
                    # `_shutdown_event` docstring for why forcing that would
                    # orphan the thread mid-Playwright-use); it's simply the
                    # LAST pass. Combined with GoogleMapsDiscoveryRequest.
                    # should_stop (checked once per candidate, inside that
                    # in-flight pass, whenever Discovery happens to be the
                    # stage still running), a pass that's mid-discovery when
                    # shutdown is requested still winds down promptly rather
                    # than continuing toward raw_supply_cap.
                    if shutdown_event is not None and shutdown_event.is_set():
                        log.info(
                            "[run_query] shutdown requested — not starting "
                            "another execution pass (delivered=%d/%d so far)",
                            gate.accepted, _deliver_target,
                        )
                        _stopped_by_shutdown = True
                        break

                    outcomes = await asyncio.to_thread(driver.run_once)
                    await asyncio.sleep(0)
                    if driver.last_error is not None:
                        raise driver.last_error
                    any_ran = any(o.ran for o in outcomes)

                    drained_any = False
                    while True:
                        try:
                            opportunity, stored = result_q.get_nowait()
                        except thread_queue.Empty:
                            break
                        drained_any = True
                        engine_pid = opportunity.pipeline_id

                        lead_dict = _opportunity_to_lead_dict(opportunity, stored)
                        lead_dict["fingerprints"] = sorted(fingerprints_for(lead_dict))
                        lead_dict["is_disqualified"] = (
                            bool(is_chain(lead_dict.get("name")))
                            or bool(is_cannabis(lead_dict))
                        )
                        lead_dict["_pipeline_id"] = engine_pid

                        # PipelineTracer mints its own id via discover() — it
                        # does not accept a caller-supplied one (see
                        # utils/pipeline_trace.py). Under Engine 2.0,
                        # discovery/enrichment/qualification all happen
                        # inside the pipeline before service.py ever sees a
                        # business, so this is the first point in this
                        # branch a pipeline_id becomes observable here;
                        # tracer.discover() is called right here rather than
                        # at actual discovery time. Businesses Qualification
                        # rejects are therefore not tracked by this tracer at
                        # all (they never reach result_q) — that rejection
                        # is still fully visible in the engine's own
                        # mast.engine.execution_driver log line, just not in
                        # this report.
                        pid = tracer.discover(lead_dict.get("name") or "<unnamed>")
                        tracer.transition(pid, "RESULTS_QUEUE")

                        if required_channels and "email" in required_channels and not is_valid_email(lead_dict.get("email")):
                            stats.skip("invalid_or_placeholder_email")
                            tracer.reject(pid, "invalid_or_placeholder_email")
                            continue

                        score_value = lead_dict.get("score") or 0
                        if score_value < min_score:
                            stats.skip(f"score_<_{min_score}")
                            profiler.record_rejection(
                                reason=f"score_<_{min_score}",
                                elapsed_ms=profiler.elapsed_since_business_start_ms(),
                            )
                            tracer.reject(pid, f"score_<_{min_score}")
                            continue

                        _now = time.perf_counter()
                        if _last_lead_time is not None:
                            profiler._stages["inter_lead_gap"].record(
                                (_now - _last_lead_time) * 1000.0
                            )
                        _last_lead_time = _now
                        profiler.mark_first_opportunity()
                        _mark("first_lead_delivered")

                        # Phase 1A: the authoritative accept/reject
                        # decision — see LeadAcceptanceGate.try_accept_lead
                        # docstring. Rejection here (target already reached
                        # by a lead drained earlier in this same inner
                        # while-loop) means this opportunity is dropped
                        # without being yielded, exactly like the old
                        # `delivered >= _deliver_target` post-yield break
                        # below used to prevent going one over — the check
                        # is just moved before the yield instead of after.
                        if not gate.try_accept_lead():
                            tracer.reject(pid, "target_already_reached")
                            break
                        tracer.transition(pid, "YIELDED_TO_NODE")
                        tracer.deliver(pid)
                        profiler.incr("delivered")
                        # Phase 3B-VALIDATION (observability only): label
                        # this delivered lead weak vs normal site, read
                        # straight off the already-in-hand `opportunity`
                        # (EnrichedBusiness.business is the original
                        # BusinessCandidate — no new lookup, no new state).
                        _delivered_business = (
                            opportunity.business.business if opportunity.business else None
                        )
                        if _delivered_business is not None:
                            _delivered_cls = "weak" if is_weak_site(_delivered_business.website) else "normal"
                            profiler.incr(f"delivered_{_delivered_cls}_site")
                        yield lead_dict
                        if gate.target_reached:
                            break

                    if gate.target_reached:
                        log.info(
                            "[run_query] requested quantity reached — delivered=%d deliver_target=%d",
                            gate.accepted, _deliver_target,
                        )
                        if driver is not None:
                            driver.stop()
                        break

                    if not any_ran and not drained_any:
                        idle_passes += 1
                        if _fully_drained():
                            if driver is not None and driver.last_error is not None:
                                raise driver.last_error
                            log.info(
                                "[run_query] pipeline fully drained — exhausted before "
                                "reaching deliver_target (delivered=%d/%d)",
                                gate.accepted, _deliver_target,
                            )
                            break
                    else:
                        idle_passes = 0

                # PART D (Phase 2B — watchdog shutdown semantics): a
                # cooperative-shutdown break (watchdog inactivity/ceiling,
                # caller abort, or process shutdown — service.py cannot
                # tell which; only the Node bridge's own local timedOut
                # state can, and does, see EngineDoneInfo.terminationReason
                # in pythonBridge.ts) must NEVER be allowed to reach
                # `_main_cli` as an ordinary loop-exhaustion, which would
                # be reported as `success=True` — see this file's
                # `_main_cli` and `exceptions.DiscoveryFailureReason.
                # CANCELLED` for the existing, established mechanism this
                # reuses rather than inventing a second status system.
                # Guarded by `not gate.target_reached` so "target reached
                # AND shutdown also happened to be requested moments
                # later" still correctly reports as a target-reached
                # success (PART F: "Target completion still wins") — that
                # case already `break`s via the `gate.target_reached`
                # check above, earlier in the same pass, before this line
                # is ever reached.
                if _stopped_by_shutdown and not gate.target_reached:
                    effective_reason = shutdown_reason or _get_shutdown_reason()
                    if _is_non_failure_shutdown(effective_reason):
                        log.info(
                            "[run_query] cooperative shutdown stopped this run due to "
                            "%s — completing as successful early stop (delivered=%d/%d)",
                            effective_reason, gate.accepted, _deliver_target,
                        )
                    else:
                        log.warning(
                            "[run_query] cooperative shutdown stopped this run "
                            "before target_reached or genuine exhaustion — "
                            "raising DiscoveryFailure(CANCELLED) so __done__ "
                            "reports this accurately instead of as an ordinary "
                            "success=True completion (delivered=%d/%d)",
                            gate.accepted, _deliver_target,
                        )
                        raise DiscoveryFailure(
                            DiscoveryFailureReason.CANCELLED,
                            "cooperative shutdown (watchdog inactivity/ceiling, caller "
                            "abort, or process shutdown) stopped this run before it "
                            "reached its target or genuinely exhausted its search space",
                        )
            finally:
                hb_stop.set()
                hb_task.cancel()
                try:
                    await hb_task
                except (asyncio.CancelledError, Exception):
                    pass
                if driver is not None:
                    await asyncio.to_thread(driver.stop)
                tracer.sweep_incomplete("run_ended_before_business_finished (cancelled/aborted)")
    finally:
        log.info("[run_query] entering outer cleanup (store close, profiler report)")
        store.close()
        if session_id is not None:
            try:
                if gate.target_reached:
                    engine_coordinator.finish_session(session_id)
                else:
                    engine_coordinator.cancel_session(session_id)
                # Part 3 (batch intelligence chain): Ranking is
                # session-scoped and must wait until the discovery
                # session completes (locked architecture) -- finish_session
                # / cancel_session above IS that completion signal, the
                # same existing lifecycle hook the rest of this cleanup
                # block already reuses. A batch-intelligence failure must
                # never mask that the session itself already reached a
                # terminal state, so it is logged, not re-raised.
                try:
                    batch_result = run_batch_intelligence(engine_coordinator, session_id)
                    log.info(
                        "[run_query] batch intelligence chain: session=%s "
                        "ranked=%d missions=%d workflow_states=%d",
                        session_id,
                        len(batch_result["ranked_opportunities"]),
                        len(batch_result["missions"]),
                        len(batch_result["workflow_states"]),
                    )
                    # Persistence Integration milestone, Part 4: persist
                    # the batch result ONLY after run_batch_intelligence()
                    # above has already returned successfully -- this line
                    # is unreachable if that call raised, so a partially-
                    # computed intelligence chain is never persisted. A
                    # persistence failure itself must not mask that the
                    # session and its (in-memory) batch result already
                    # completed, so it is logged, not re-raised -- the
                    # same posture the batch-intelligence try/except above
                    # already takes toward run_batch_intelligence() itself.
                    try:
                        batch_backend = _build_batch_intelligence_backend()
                        batch_backend.persist_batch_result(
                            session_id,
                            priorities=batch_result["priorities"],
                            ranked_opportunities=batch_result["ranked_opportunities"],
                            missions=batch_result["missions"],
                            workflow_states=batch_result["workflow_states"],
                        )
                        log.info(
                            "[run_query] batch intelligence persisted: session=%s "
                            "priorities=%d ranked=%d missions=%d workflow_states=%d",
                            session_id,
                            len(batch_result["priorities"]),
                            len(batch_result["ranked_opportunities"]),
                            len(batch_result["missions"]),
                            len(batch_result["workflow_states"]),
                        )
                    except Exception:
                        log.warning(
                            "[run_query] batch intelligence persistence failed "
                            "for session=%s (in-memory batch result is still "
                            "available via engine_coordinator.get_batch_result)",
                            session_id, exc_info=True,
                        )
                except Exception:
                    log.warning(
                        "[run_query] batch intelligence chain failed for session=%s",
                        session_id, exc_info=True,
                    )
            except Exception:
                log.debug("[run_query] session %s already terminal", session_id, exc_info=True)
        log_milestone("After run_query cleanup")
        # Phase 1A: `gate.accepted` is the authoritative count — reading it
        # here (rather than a separately-tracked local) is what guarantees
        # this closing log line can never drift from what the gate itself
        # decided was accepted.
        log.info(f"[service] done — delivered={gate.accepted} {stats.summary()}")
        log.info(
            "[service] rejection summary:\n" + stats.rejection_summary()
        )
        # Phase S1: any business not already swept above is closed out here
        # too, then the full reconciliation — counts plus any invariant
        # violation — is logged as the last thing this run does.
        tracer.sweep_incomplete("run_ended_before_business_finished")
        log.info("[pipeline] reconciliation:\n" + tracer.reconcile())
        # Phase 2: stash profiler summary so _main_cli can embed it in
        # the __done__ sentinel without changing run_query's public API.
        global _last_perf_summary
        _last_perf_summary = profiler.summary()
        # PART E (Phase 2B — truthful first-lead latency): additive
        # sub-report alongside the existing profiler summary (nothing
        # existing removed/renamed). Values are seconds since this
        # run_query() call started (`_request_started_ts`), each recorded
        # once, the first time it happened — see `_mark()`'s own comment
        # above. A key's absence means that milestone never happened this
        # run (e.g. no candidates ever discovered), not that it was zero.
        _last_perf_summary["latency"] = {
            "time_to_first_candidate_s": _latency_marks.get("first_candidate_discovered"),
            "time_to_first_accepted_s": _latency_marks.get("first_candidate_accepted"),
            "time_to_first_enrichment_s": _latency_marks.get("first_enrichment_completed"),
            "time_to_first_lead_s": _latency_marks.get("first_lead_delivered"),
        }
        # Phase 2A: attach the module-level import timing captured once at
        # process start. Not per-run (imports only happen once per Python
        # process, not once per run_query() call), but embedding it here
        # means every run's __perf__ output carries it for visibility.
        _last_perf_summary["python_imports_ms"] = round(_IMPORTS_ELAPSED_MS, 1)
        profiler.print_report(
            query=query,
            city=city,
            delivered=gate.accepted,
            requested=_deliver_target,  # report the user-facing target, not the scan budget
        )
        # Phase 2 (per-area latency profiling, Step 2): the ONE
        # authoritative per-area summary this phase adds. `city` is the
        # per-child area name (Bronx, Queens, ... — see pythonBridge.ts,
        # which spawns one `run_query()` per area with `city=<area>`).
        # Uses `_request_started_ts` as its time base (same reference
        # `_latency_marks` already uses) so `runtime_ms` and the
        # `first_*_ms` fields share one clock; the stage-time and counter
        # fields come from `profiler` directly and are clock-independent.
        _area_runtime_ms = (time.perf_counter() - _request_started_ts) * 1000.0
        _area_sla_kwargs = dict(
            area=city,
            runtime_ms=_area_runtime_ms,
            first_candidate_ms=(
                _latency_marks["first_candidate_discovered"] * 1000.0
                if "first_candidate_discovered" in _latency_marks else None
            ),
            first_enrichment_ms=(
                _latency_marks["first_enrichment_completed"] * 1000.0
                if "first_enrichment_completed" in _latency_marks else None
            ),
            first_qualified_ms=(
                _latency_marks["first_candidate_qualified"] * 1000.0
                if "first_candidate_qualified" in _latency_marks else None
            ),
            first_delivered_ms=(
                _latency_marks["first_lead_delivered"] * 1000.0
                if "first_lead_delivered" in _latency_marks else None
            ),
        )
        profiler.print_area_sla(**_area_sla_kwargs)
        # Also embed the same fields, structurally, in the __done__
        # sentinel payload (`_last_perf_summary`) — the stderr block above
        # is for a human tailing logs; this is for anything that wants to
        # parse it (e.g. a future dashboard aggregating area-sla across
        # a whole production run) without scraping text.
        _last_perf_summary["area_sla"] = {
            **{k: v for k, v in _area_sla_kwargs.items()},
            "maps_ms": profiler._stages["playwright_startup"].total_ms
                + profiler._stages["browser_startup"].total_ms
                + profiler._stages["context_creation"].total_ms
                + profiler._stages["page_creation"].total_ms,
            "navigation_ms": profiler._stages["maps_initial_load"].total_ms,
            "panel_ms": profiler._stages["place_panel_wait"].total_ms
                + profiler._stages["place_settle"].total_ms,
            "scroll_ms": profiler._stages["scroll_movement"].total_ms
                + profiler._stages["scroll_wait"].total_ms,
            "place_click_ms": profiler._stages["place_click"].total_ms,
            "rate_limit_ms": profiler._stages["rate_limit_wait_search"].total_ms
                + profiler._stages["rate_limit_wait_place"].total_ms,
            "extraction_ms": profiler._stages["maps_place_extraction"].total_ms,
            # PHASE 2B (discovery wall-clock instrumentation) — kept in
            # sync with the new fields `RunProfiler.area_sla_line()`
            # itself now reports; see that method's own docstring for
            # why these are direct measurements, not sums, for the
            # three *_total_ms fields.
            "discovery_total_ms": profiler._stages["discovery_total_ms"].total_ms,
            "google_maps_total_ms": profiler._stages["google_maps_provider_total"].total_ms,
            "overpass_total_ms": profiler._stages["overpass_provider_total"].total_ms,
            "maps_navigation_ms": profiler._stages["maps_initial_load"].total_ms,
            "panel_resolution_ms": profiler._stages["place_panel_wait"].total_ms
                + profiler._stages["place_settle"].total_ms,
            "place_detail_ms": profiler._stages["place_click"].total_ms,
            "candidate_extraction_ms": profiler._stages["maps_place_extraction"].total_ms,
            "retry_wait_ms": profiler._stages["retry_wait"].total_ms,
            "maps_rounds": profiler.counter("maps_rounds"),
            "maps_candidates_seen": profiler.counter("maps_candidates_seen"),
            "maps_candidates_yielded": profiler.counter("maps_candidates_yielded"),
            # PHASE 12A (zero-risk Maps click reduction) — kept in sync
            # with the same two new fields RunProfiler.area_sla_line()
            # now reports; see that method's docstring.
            "maps_candidates_clicked": profiler.counter("maps_candidates_clicked"),
            "maps_candidates_card_closed_skipped": profiler.counter("maps_candidates_card_closed_skipped"),
            "overpass_requests": profiler.counter("overpass_requests"),
            "overpass_retries": profiler.counter("overpass_retries"),
            "website_ms": profiler._stages["website_worker"].total_ms,
            "instagram_ms": profiler._stages["instagram_worker"].total_ms,
            "contact_ms": profiler._stages["contact_worker"].total_ms,
            "merge_ms": profiler._stages["merge_worker"].total_ms,
            "qualification_ms": profiler._stages["qualification_worker"].total_ms,
            "storage_ms": profiler._stages["storage_worker"].total_ms,
            "raw_candidates": profiler.counter("raw_candidates"),
            "early_new": profiler.counter("early_new"),
            "early_duplicates": profiler.counter("early_duplicates"),
            "early_pruned": profiler.counter("early_pruned"),
            "contact_failures": profiler.counter("contact_failures"),
            # Phase 14.2 (Instagram acquisition telemetry) — additive,
            # observational only; see engine/execution_driver.py's
            # `_instagram_downstream`/`_contact_downstream` and
            # service.py's `_on_progress` above for what each counts.
            "instagram_attempted": profiler.counter("instagram_attempted"),
            "instagram_url_input_present": profiler.counter("instagram_url_input_present"),
            "instagram_profile_reachable": profiler.counter("instagram_profile_reachable"),
            "instagram_short_circuited": profiler.counter("instagram_short_circuited"),
            "instagram_discovery_found": profiler.counter("instagram_discovery_found"),
            "instagram_discovery_missing": profiler.counter("instagram_discovery_missing"),
            "instagram_discovery_invalid": profiler.counter("instagram_discovery_invalid"),
            # Phase 15 (Email / Contact Acquisition telemetry)
            "email_secondary_page_fetched": profiler.counter("email_secondary_page_fetched"),
            "email_secondary_page_found": profiler.counter("email_secondary_page_found"),
            "email_acquired": profiler.counter("email_acquired"),
            "email_missing_after_scan": profiler.counter("email_missing_after_scan"),
            "phone_secondary_page_fetched": profiler.counter("phone_secondary_page_fetched"),
            "phone_acquired": profiler.counter("phone_acquired"),
            "phone_missing_after_scan": profiler.counter("phone_missing_after_scan"),
            "secondary_page_fetch_failures": profiler.counter("secondary_page_fetch_failures"),
            "qualified": profiler.counter("qualified"),
            "delivered": profiler.counter("delivered"),
        }
        log.info("[run_query] outer cleanup finished")


async def _main_cli() -> None:
    raw_args = sys.argv[1] if len(sys.argv) > 1 else sys.stdin.read()
    params = json.loads(raw_args)
    # deliver_target is the user-facing qualified-lead count (what the user
    # actually requested).  max_results is the raw scan budget (how many
    # Maps places may be scanned to find enough qualified leads after
    # filtering).  The __done__ sentinel reports `requested=deliver_target`
    # so the Node bridge's onDone callback sees the true count.
    requested = params.get("deliver_target") or params.get("max_results", 60)

    delivered = 0
    log.info("[main_cli] entering run_query async for loop")
    # ROOT CAUSE FIX (Part 8 — false "exhausted" results): a discovery
    # provider that fails to access/parse results (no valid results panel,
    # a consent/block/challenge interstitial, a navigation timeout, or an
    # unclassified scraper error) now raises `DiscoveryFailure` — see
    # exceptions/__init__.py and scraper/maps_scraper.py — instead of the
    # old silent `return`. That failure propagates up through
    # `run_query()`'s async generator unchanged. Catching it specifically
    # here, instead of letting it crash the subprocess with no `__done__`
    # sentinel at all, is what lets the __done__ payload carry an explicit
    # `success: False` + `failure_reason` pair — the Node bridge
    # (src/scraperBridge/pythonBridge.ts) and its callers
    # (src/jobs/discoverJob.ts's `citySearchExhausted` handling) key off
    # `success` to make sure a failure is never treated the same as a
    # query whose search space genuinely ran out. Any OTHER (unclassified)
    # exception is intentionally NOT caught here — it propagates, crashes
    # the subprocess with a non-zero exit code, and is surfaced by the
    # bridge's existing `exitCode !== 0` handling, exactly as before.
    failure: DiscoveryFailure | None = None
    try:
        async for lead_dict in run_query(**params, shutdown_event=_shutdown_event):
            delivered += 1
            try:
                sys.stdout.write(json.dumps(lead_dict, default=str) + "\n")
                sys.stdout.flush()
            except (BrokenPipeError, IOError, OSError):
                log.info("[main_cli] stdout pipe closed by consumer (early break / TARGET_REACHED)")
                break
        log.info(f"[main_cli] run_query async for loop ended normally (delivered={delivered}) — about to write __done__")
    except DiscoveryFailure as exc:
        failure = exc
        log.error(
            f"[main_cli] run_query ended with a discovery failure "
            f"(reason={exc.reason.value}, delivered={delivered} before "
            f"failure) — about to write __done__ with success=False: {exc.detail}"
        )
    except asyncio.CancelledError:
        # LIFECYCLE FIX (bridge delivery / watchdog / graceful shutdown
        # phase): this only fires if _run_with_graceful_shutdown's
        # COOPERATIVE_SHUTDOWN_GRACE_S fallback actually escalated to a
        # forced task.cancel() — i.e. run_query()'s own cooperative
        # checkpoints (should_stop / the between-pass shutdown_event check)
        # didn't finish in time. Before this fix, this exception propagated
        # straight out of `_main_cli()` uncaught, skipping the __done__
        # write entirely — that is the direct cause of the reported
        # "sawDone=false" / "Delivered: 0" outcome, even for a run whose
        # leads had already been fully qualified/stored (every already-
        # written stdout line up to this point is real and already reached
        # Node; only the sentinel was missing). Catching it here, the same
        # way DiscoveryFailure is caught above, guarantees __done__ is
        # ALWAYS written — every branch of "python yields a lead -> node
        # receives it -> ... -> completion reports it correctly" now holds
        # even on a forced shutdown, not just a clean one. Never reported
        # as `exhausted=True` — see DiscoveryFailureReason.CANCELLED's own
        # docstring for why that invariant matters here specifically.
        effective_reason = _get_shutdown_reason()
        if _is_non_failure_shutdown(effective_reason):
            log.info(
                f"[main_cli] run_query cancelled during {effective_reason} shutdown "
                f"(delivered={delivered}) — completing as successful early stop"
            )
            failure = None
        else:
            failure = DiscoveryFailure(
                DiscoveryFailureReason.CANCELLED,
                "graceful shutdown (SIGTERM) requested before this run finished "
                "naturally, and the cooperative shutdown checkpoints did not "
                "wind down in time — escalated to a forced cancellation",
            )
            log.warning(
                f"[main_cli] run_query cancelled during shutdown "
                f"(delivered={delivered} before cancellation) — writing "
                f"__done__ with success=False, failure_reason=CANCELLED"
            )
    except Exception as exc:
        failure = DiscoveryFailure(
            DiscoveryFailureReason.SCRAPER_ERROR,
            f"Unhandled engine failure: {type(exc).__name__}: {exc}",
        )
        log.exception(
            f"[main_cli] run_query crashed with unhandled exception "
            f"(delivered={delivered} before crash) — writing __done__ with success=False"
        )

    # `exhausted=True` means this query's own search space ran out (Maps
    # end-of-results / scroll cap) before `requested` was reached — i.e.
    # this is a genuine shortfall for this query, not an artificial stop.
    # `exhausted=False` means either we stopped because we delivered
    # everything that was asked for (there may well be more out there), OR
    # the attempt failed (`success=False`) before exhaustion could even be
    # determined — `exhausted` is meaningless in that case and callers must
    # check `success` first, never infer failure from `exhausted` alone.
    #
    # LIFECYCLE FIX (TARGET_REACHED semantics): When parent target is reached,
    # child termination is a SUCCESSFUL EARLY STOP: success=True,
    # target_reached=True, termination_reason="SUCCESS_TARGET_REACHED".
    #
    # LIFECYCLE FIX (CONSUMER_STOPPED semantics — FINAL SHUTDOWN LATENCY +
    # CONSUMER_STOPPED FIX): a plain CONSUMER_STOPPED stop (area rotation /
    # the Node bridge's own consumer breaking out early) is ALSO a
    # successful early stop, but it must NOT be reported as
    # target_reached=True (the PARENT request's target was not necessarily
    # met — only this call's own batch was satisfied; see
    # pythonBridge.ts's SUCCESS_CONSUMER_STOPPED doc comment) and must NOT
    # be reported as exhausted=True either (the search space did not run
    # out — this run was asked to stop, mid-search, by its consumer).
    effective_reason = _get_shutdown_reason()
    is_target_reached_stop = failure is None and (delivered >= requested or effective_reason == "TARGET_REACHED")
    is_consumer_stopped_stop = (
        failure is None and not is_target_reached_stop and effective_reason == "CONSUMER_STOPPED"
    )
    target_reached = is_target_reached_stop
    success = failure is None
    exhausted = (
        False if (failure is not None or target_reached or is_consumer_stopped_stop)
        else delivered < requested
    )
    termination_reason = (
        "SUCCESS_TARGET_REACHED" if (success and target_reached)
        else "SUCCESS_CONSUMER_STOPPED" if (success and is_consumer_stopped_stop)
        else "SUCCESS_EXHAUSTED" if success
        else failure.reason.value
    )
    try:
        sys.stdout.write(json.dumps({
            "__done__": True,
            "delivered": delivered,
            "requested": requested,
            "exhausted": exhausted,
            "success": success,
            "target_reached": target_reached,
            "termination_reason": termination_reason,
            "failure_reason": failure.reason.value if failure is not None else None,
            "failure_detail": failure.detail if failure is not None else None,
            "__perf__": _last_perf_summary,
        }, default=str) + "\n")
        sys.stdout.flush()
        log.info(
            f"[main_cli] __done__ sentinel written (delivered={delivered}, "
            f"requested={requested}, target_reached={target_reached}, "
            f"success={success}, termination_reason={termination_reason}, "
            f"failure_reason={failure.reason.value if failure else None!r})"
        )
    except (BrokenPipeError, IOError, OSError):
        log.info("[main_cli] stdout pipe closed before __done__ could be flushed")
    finally:
        stop_file = os.path.join(tempfile.gettempdir(), f"mast_stop_{os.getpid()}.txt")
        if os.path.exists(stop_file):
            try:
                os.remove(stop_file)
            except Exception:
                pass


async def verify_business(*, website: str = "", instagram: str = "", headless: bool = True) -> dict:
    """
    Phase 7. Re-checks a single, already-known business's website and/or
    Instagram DIRECTLY — no Maps search, no niche/city query. Reuses
    `SiteCrawler` / `IGIntelligence` exactly as `EnrichmentPipeline` does
    internally for extraction; the only genuinely new logic is the raw
    reachability probe below (a bare `page.goto` + catch), since
    `SiteCrawler.crawl()` was built to answer "what did we extract" and
    silently returns an empty dict on both a dead site and a live-but-
    contentless one — it has no reason to distinguish those, so it can't
    tell verification whether the site is still up. Duplicating its
    extraction logic to add that distinction would violate "don't
    duplicate crawler logic"; a two-line separate probe doesn't.

    Returns:
      {
        "website_ok": bool | None,      # None = no website on file to check
        "website_data": dict,           # SiteCrawler.crawl() output, only if website_ok
        "instagram_ok": bool | None,    # None = no instagram on file to check
        "instagram_data": dict,         # IGIntelligence.fetch_profile() output, only if instagram_ok
      }
    """
    config = ScraperConfig(headless=headless)
    stats = RunStats()
    proxy_manager = ProxyManager()

    result: dict[str, Any] = {
        "website_ok": None,
        "website_data": {},
        "instagram_ok": None,
        "instagram_data": {},
    }

    async with MapsScraper(config, proxy_manager, stats) as scraper:
        browser = scraper.browser

        if website:
            page = await browser.new_page()
            try:
                await page.goto(website, wait_until="domcontentloaded", timeout=config.site_timeout_ms)
                result["website_ok"] = True
            except Exception as e:
                log.debug(f"[verify] website unreachable: {website} ({e})")
                result["website_ok"] = False
            finally:
                await page.close()

            if result["website_ok"]:
                crawler = SiteCrawler(config, browser)
                try:
                    result["website_data"] = await crawler.crawl(website)
                except Exception as e:
                    # The reachability probe above already succeeded (the
                    # page loaded), so website_ok stays True — this is an
                    # extraction failure, not a dead site. Website crawling
                    # and Instagram intelligence are independent
                    # responsibilities; a crash here must not prevent the
                    # Instagram check below from running.
                    log.debug(f"[verify] website crawl failed after reachability check succeeded: {website} ({e})")

        if instagram:
            ig = IGIntelligence(config, browser)
            profile = await ig.fetch_profile(instagram)
            # `blocked` is IG_intel's own signal for "sorry, this page isn't
            # available" — i.e. the handle no longer resolves, distinct from
            # a merely private (but still existing) account.
            result["instagram_ok"] = not profile.get("blocked", False)
            result["instagram_data"] = profile

    return result


async def _verify_cli() -> None:
    raw_args = sys.argv[2] if len(sys.argv) > 2 else sys.stdin.read()
    params = json.loads(raw_args)
    result = await verify_business(**params)
    sys.stdout.write(json.dumps(result, default=str))
    sys.stdout.flush()


async def enrich_business_v2(payload: dict) -> dict:
    """
    Milestone 2 entrypoint: runs Engine 2.0's WebsiteWorker /
    InstagramWorker / ContactWorker / MergeWorker for one already-known
    business (businessProcessingJob.ts's enrichBusiness()/scoreBusiness(),
    via runEngineEnrich() in pythonBridge.ts). Async only for calling-
    convention symmetry with verify_business() and run_query() — every
    Engine 2.0 worker this delegates to is itself synchronous (see
    engine_enrichment_bridge.py).
    """
    return _engine_enrich_business(payload)


async def _enrich_cli() -> None:
    # See the _REAL_STDOUT / sys.stdout swap at the top of this module for
    # why the result is written there rather than to `sys.stdout` directly
    # (sys.stdout has been redirected to stderr for this mode, so logging
    # from here on doesn't corrupt the one JSON line pythonBridge.ts's
    # runEngineEnrich() expects on real stdout).
    raw_args = sys.argv[2] if len(sys.argv) > 2 else sys.stdin.read()
    params = json.loads(raw_args)
    result = await enrich_business_v2(params)
    _REAL_STDOUT.write(json.dumps(result, default=str))
    _REAL_STDOUT.flush()


async def _run_with_graceful_shutdown(coro_fn) -> None:
    """
    BUG FIX (missing profiler report): the Node bridge (pythonBridge.ts /
    runEngineQuery) deliberately asks this process for more leads than it
    needs (`askFor`) and breaks out of its consuming loop as soon as its own
    target is met — that is the NORMAL way almost every run ends, not an
    error case. When it stops consuming early, its cleanup path now sends
    SIGTERM (see pythonBridge.ts gracefulKillProcessTree), falling back to
    SIGKILL only if this process doesn't exit on its own within a grace
    period.

    Without a handler, SIGTERM's default OS action terminates the
    interpreter immediately — same as SIGKILL — so run_query()'s outer
    `finally` (store.close(), profiler.print_report(), the __done__
    sentinel) never runs. That's the actual root cause of the missing
    profiler report: it's not that print_report() has a bug, it's that the
    process is being killed before Python ever gets to run it.

    LIFECYCLE FIX (bridge delivery / watchdog / graceful shutdown phase):
    this used to respond to SIGTERM by calling `task.cancel()`
    unconditionally. For every OTHER cli mode (verify/enrich/score/...) —
    short-lived, no background-thread work — that's safe and still exactly
    what happens below, just after a bounded wait. For the long-running
    discovery mode (`_main_cli` -> `run_query()`), it was actually the root
    cause of the reported "Target page, context or browser has been
    closed" race: `run_query()`'s production path drives
    `ExecutionDriver.run_once()` via `asyncio.to_thread(...)`, a real OS
    thread that `task.cancel()` cannot interrupt once it's running —
    cancelling only makes the *awaiting* coroutine stop waiting for it,
    orphaning the thread (see the module-level `_shutdown_event` docstring
    for the full mechanics). The orphaned thread would then keep calling
    into Playwright while the main coroutine's `finally` blocks (and,
    eventually, the Node bridge's SIGKILL escalation) tore down the very
    process the orphaned thread's browser lived in.

    The fix: SIGTERM now sets `_shutdown_event` — a cooperative flag
    `run_query()` itself checks at safe checkpoints (see its own
    docstring/comments) — and gives it `COOPERATIVE_SHUTDOWN_GRACE_S`
    seconds to wind down and finish *on its own* before falling back to
    the old `task.cancel()` behavior as a last resort. `_main_cli` also
    now catches the resulting `CancelledError` (if the fallback ever does
    fire) so `__done__` is still written either way — see `_main_cli`'s
    own comment for that half of the fix.
    """
    task = asyncio.ensure_future(coro_fn())
    _shutdown_event.clear()
    _set_shutdown_reason(None)
    escalate_task: Optional["asyncio.Task[None]"] = None

    def _on_sigterm() -> None:
        nonlocal escalate_task
        reason = _get_shutdown_reason()
        grace_s = _shutdown_grace_period_s(reason)
        log.warning(
            f"[service] received SIGTERM (reason={reason or 'unspecified'}) — requesting cooperative shutdown "
            "(run_query's own checkpoints get up to "
            f"{grace_s:.0f}s to wind down active work "
            "and let cleanup — including __done__ — run normally, before "
            "falling back to a forced cancellation)"
        )
        _shutdown_event.set()

        async def _escalate_if_still_running() -> None:
            await asyncio.sleep(grace_s)
            if not task.done():
                log.warning(
                    "[service] cooperative shutdown did not finish within "
                    f"{grace_s:.0f}s of SIGTERM ({reason or 'unspecified'}) — "
                    "escalating to forced task cancellation (same "
                    "last-resort behavior this handler always had; may "
                    "leave a background thread orphaned if one is still "
                    "running — see _shutdown_event's docstring)"
                )
                task.cancel()

        escalate_task = asyncio.ensure_future(_escalate_if_still_running())

    if sys.platform != "win32":
        # add_signal_handler needs a running loop and isn't supported on
        # Windows' default event loop; on Windows the process falls back to
        # the pre-existing (immediate) shutdown behavior.
        asyncio.get_running_loop().add_signal_handler(signal.SIGTERM, _on_sigterm)

    try:
        await task
    except asyncio.CancelledError:
        log.info("[service] exited after escalated (forced) SIGTERM shutdown")
    finally:
        if escalate_task is not None and not escalate_task.done():
            escalate_task.cancel()


async def score_business_v2(payload: dict) -> dict:
    """
    Evaluates Engine 2.0 Opportunity Scoring for a business payload, including universal breakdown,
    profession scores for all canonical professions, and business health score.
    """
    biz_id = str(payload.get("id") or payload.get("business_id") or "biz_unknown")
    biz_data = payload.get("business") if isinstance(payload.get("business"), dict) else payload

    scoring_service = OpportunityScoringService()
    res = scoring_service.evaluate_business_professions(biz_data, business_id=biz_id)

    health_score = ScoringWorker._business_health_component(
        type("TempBiz", (), {
            "rating": biz_data.get("reviews_rating") or biz_data.get("rating"),
            "review_count": biz_data.get("reviews_count") or biz_data.get("reviews"),
            "website": biz_data.get("website"),
        })(),
        type("TempWebsite", (), {
            "website_reachable": bool(biz_data.get("website")),
            "https": str(biz_data.get("website") or "").startswith("https://"),
        })(),
        type("TempIG", (), {
            "profile_reachable": bool(biz_data.get("instagram")),
            "last_post_date": None,
        })()
    )

    return {
        "business_id": res.business_id,
        "is_disqualified": res.is_disqualified,
        "universal_breakdown": res.universal_breakdown.to_dict(),
        "health_score": health_score,
        "profession_scores": {
            s.profession_slug: {
                "score": s.score,
                "breakdown": s.breakdown.to_dict(),
                "summary": s.summary,
                "reasons": list(s.reasons),
            }
            for s in res.profession_scores
        }
    }


async def _score_cli() -> None:
    raw_args = sys.argv[2] if len(sys.argv) > 2 else sys.stdin.read()
    params = json.loads(raw_args)
    result = await score_business_v2(params)
    _REAL_STDOUT.write(json.dumps(result, default=str))
    _REAL_STDOUT.flush()


def _opportunity_from_payload(raw_opp: dict):
    """
    Shared Opportunity construction used by qualify, prioritize (and any
    future CLI mode that needs a canonical Opportunity). Factored out of
    qualify_business_v2 so prioritize_opportunity_v2 builds the identical
    Opportunity instead of duplicating the parsing/coercion logic.
    """
    import datetime as _dt
    from opportunities import Opportunity

    discovered_raw = raw_opp.get("discovered_at")
    if isinstance(discovered_raw, str):
        try:
            discovered_at = _dt.datetime.fromisoformat(discovered_raw.replace("Z", "+00:00"))
        except ValueError:
            discovered_at = _dt.datetime.now(_dt.timezone.utc)
    elif isinstance(discovered_raw, (int, float)):
        discovered_at = _dt.datetime.fromtimestamp(discovered_raw / 1000, tz=_dt.timezone.utc)
    else:
        discovered_at = _dt.datetime.now(_dt.timezone.utc)

    return Opportunity(
        opportunity_id=str(raw_opp.get("opportunity_id") or raw_opp.get("id") or "opp_unknown"),
        business_id=str(raw_opp.get("business_id") or raw_opp.get("businessId") or "biz_unknown"),
        niche_id=str(raw_opp.get("niche_id") or raw_opp.get("nicheId") or raw_opp.get("niche") or "unknown"),
        opportunity_type_id=str(raw_opp.get("opportunity_type_id") or raw_opp.get("type") or "unknown"),
        discovered_at=discovered_at,
        supporting_signal_ids=tuple(raw_opp.get("supporting_signal_ids") or []),
    )


async def qualify_business_v2(payload: dict) -> dict:
    """
    Evaluates Engine 2.0 Qualification for an opportunity payload.

    Accepts either:
      - An Opportunity-shaped dict: {opportunity_id, business_id, niche_id,
        opportunity_type_id, discovered_at?, supporting_signal_ids?}
      - A top-level payload with an "opportunity" key containing the above.

    Returns the canonical OpportunityQualification result serialised as a plain dict.
    """
    raw_opp = payload.get("opportunity") if isinstance(payload.get("opportunity"), dict) else payload
    opp = _opportunity_from_payload(raw_opp)

    qual_service = OpportunityQualificationService()
    res = qual_service.evaluate(opp)
    return {
        "opportunity_id": res.opportunity_id,
        "status": res.status.value,
        "qualified": res.status.value == "QUALIFIED",
        "passed_rule_ids": list(res.passed_rule_ids),
        "failed_rule_ids": list(res.failed_rule_ids),
    }


async def _qualify_cli() -> None:
    raw_args = sys.argv[2] if len(sys.argv) > 2 else sys.stdin.read()
    params = json.loads(raw_args)
    result = await qualify_business_v2(params)
    _REAL_STDOUT.write(json.dumps(result, default=str))
    _REAL_STDOUT.flush()


async def prioritize_opportunity_v2(payload: dict) -> dict:
    """
    Evaluates Engine 2.0 Opportunity Prioritization (Subsystem 12) for a
    single opportunity payload.

    Mirrors qualify_business_v2 / score_business_v2's payload shape:
      - An Opportunity-shaped dict, or a top-level payload with an
        "opportunity" key containing one.
      - Optional "policy": {strategy?, evaluation_at?, score_weight?,
        recency_weight?, recency_half_life_days?, require_qualification?}

    Reuses the same Qualification and Scoring evaluations qualify/score
    already expose, then feeds all three into
    OpportunityPrioritizationService per the locked batch pipeline order
    (Qualification -> Scoring -> Prioritization).
    """
    import datetime as _dt
    from opportunity_prioritization.service import OpportunityPrioritizationService
    from opportunity_prioritization.models import PrioritizationPolicy, PrioritizationStrategy

    raw_opp = payload.get("opportunity") if isinstance(payload.get("opportunity"), dict) else payload
    opp = _opportunity_from_payload(raw_opp)

    qualification = OpportunityQualificationService().evaluate(opp)
    score = OpportunityScoringService().evaluate(opp)

    raw_policy = payload.get("policy") or {}
    strategy_raw = str(raw_policy.get("strategy") or "BALANCED").upper()
    try:
        strategy = PrioritizationStrategy(strategy_raw)
    except ValueError:
        strategy = PrioritizationStrategy.BALANCED

    eval_at_raw = raw_policy.get("evaluation_at")
    if isinstance(eval_at_raw, str):
        try:
            evaluation_at = _dt.datetime.fromisoformat(eval_at_raw.replace("Z", "+00:00"))
        except ValueError:
            evaluation_at = _dt.datetime.now(_dt.timezone.utc)
    elif isinstance(eval_at_raw, (int, float)):
        evaluation_at = _dt.datetime.fromtimestamp(eval_at_raw / 1000, tz=_dt.timezone.utc)
    else:
        evaluation_at = _dt.datetime.now(_dt.timezone.utc)

    policy_kwargs = dict(
        strategy=strategy,
        evaluation_at=evaluation_at,
        recency_half_life_days=float(raw_policy.get("recency_half_life_days", 30.0)),
        require_qualification=bool(raw_policy.get("require_qualification", True)),
    )
    if strategy == PrioritizationStrategy.CUSTOM_WEIGHTED:
        policy_kwargs["score_weight"] = raw_policy.get("score_weight")
        policy_kwargs["recency_weight"] = raw_policy.get("recency_weight")

    policy = PrioritizationPolicy(**policy_kwargs)

    result = OpportunityPrioritizationService.evaluate_priority(opp, qualification, score, policy)

    return {
        "opportunity_id": result.opportunity_id,
        "priority_score": result.priority_score,
        "score_contribution": result.score_contribution,
        "recency_contribution": result.recency_contribution,
        "is_eligible": result.is_eligible,
        "qualification_status": qualification.status.value,
        "overall_score": score.overall_score,
    }


async def _prioritize_cli() -> None:
    raw_args = sys.argv[2] if len(sys.argv) > 2 else sys.stdin.read()
    params = json.loads(raw_args)
    result = await prioritize_opportunity_v2(params)
    _REAL_STDOUT.write(json.dumps(result, default=str))
    _REAL_STDOUT.flush()


async def evaluate_crm_v2(payload: dict) -> dict:
    """
    Evaluates Engine 2.0 CRM Intelligence (relationship health, lifecycle stage,
    contact guardrail). Accepts the Node bridge payload containing:
      - workspace_id, business_id, current_timestamp_iso (required)
      - interaction_history: list of {timestamp_iso, interaction_type, outcome_type?,
        is_opt_out?, is_conversion?, is_positive?}
      - policy: optional {max_attempts_per_window, window_days, cooling_off_days, dormancy_days}
    """
    import datetime as _dt
    workspace_id = payload.get("workspace_id") or "workspace"
    business_id = payload.get("business_id") or payload.get("id") or "business"
    ts = payload.get("current_timestamp_iso") or _dt.datetime.now(_dt.timezone.utc).isoformat()

    raw_history = payload.get("interaction_history") or []
    history = tuple(
        CRMInteractionRecord(
            timestamp_iso=r.get("timestamp_iso", ts),
            interaction_type=r.get("interaction_type", "contact"),
            outcome_type=r.get("outcome_type", ""),
            is_opt_out=bool(r.get("is_opt_out", False)),
            is_conversion=bool(r.get("is_conversion", False)),
            is_positive=bool(r.get("is_positive", False)),
        )
        for r in raw_history
        if isinstance(r, dict) and r.get("timestamp_iso")
    )

    raw_policy = payload.get("policy") or {}
    policy = CRMContactPolicy(
        max_attempts_per_window=int(raw_policy.get("max_attempts_per_window", 3)),
        window_days=int(raw_policy.get("window_days", 30)),
        cooling_off_days=int(raw_policy.get("cooling_off_days", 14)),
        dormancy_days=int(raw_policy.get("dormancy_days", 60)),
    )

    req = CRMRelationshipRequest(
        workspace_id=workspace_id,
        business_id=business_id,
        current_timestamp_iso=ts,
        interaction_history=history,
        policy=policy,
    )
    rel = CRMIntelligenceService.evaluate_relationship(req)
    return {
        "stage": rel.stage.value,
        "health": rel.health.value,
        "guardrail": rel.guardrail_decision.value,
        "total_attempts": rel.total_attempts,
        "attempts_in_window": rel.attempts_in_window,
        "days_since_last_interaction": rel.days_since_last_interaction,
        "reason": rel.reason,
    }


async def _crm_cli() -> None:
    raw_args = sys.argv[2] if len(sys.argv) > 2 else sys.stdin.read()
    params = json.loads(raw_args)
    result = await evaluate_crm_v2(params)
    _REAL_STDOUT.write(json.dumps(result, default=str))
    _REAL_STDOUT.flush()


def _fetch_batch_intelligence_context(session_id: str):
    """
    Persistence Integration milestone, Part 5 (read path): loads this
    session's persisted priorities/ranks/missions/workflow_states via
    SupabaseBatchIntelligenceBackend and projects them into an
    EngineContext (engine_context/service.py's ContextProjectionService
    -- Subsystem 16, which existed for exactly this purpose but had no
    caller anywhere in this repo before this milestone) so
    AnalyticsService.compute_analytics() (analytics/service.py) can
    consume real persisted state instead of anything being recomputed.
    Never raises for a session with no persisted rows yet (returns an
    EngineContext with empty tuples, the same as
    ContextProjectionService.project()'s own documented behavior for
    absent inputs) -- callers decide whether an empty context is
    meaningful for their response.
    """
    from engine_context.models import (
        ContextComponent,
        ContextProjectionRequest,
        ContextSubject,
        ContextSubjectType,
    )
    from engine_context.service import ContextProjectionService

    batch_backend = _build_batch_intelligence_backend()
    priorities = batch_backend.fetch_priorities_for_session(session_id)
    ranks = batch_backend.fetch_ranked_opportunities(session_id)
    missions = batch_backend.fetch_missions_for_session(session_id)
    workflows = batch_backend.fetch_workflow_states_for_session(session_id)

    request = ContextProjectionRequest(
        subject=ContextSubject(subject_id=session_id, subject_type=ContextSubjectType.WORKSPACE),
        requested_components=(
            ContextComponent.PRIORITY,
            ContextComponent.RANK,
            ContextComponent.MISSION,
            ContextComponent.WORKFLOW,
        ),
    )
    return ContextProjectionService.project(
        request,
        priorities=priorities,
        ranks=ranks,
        missions=missions,
        workflows=workflows,
    )


def _analytics_report_dict(report) -> dict:
    import dataclasses

    return dataclasses.asdict(report)


async def evaluate_analytics_v2(payload: dict) -> dict:
    """
    Returns pipeline analytics from raw pipeline snapshot metrics.
    The AnalyticsService requires an EngineContext object; for the lightweight
    Node-bridge use case we compute summary statistics directly from the
    snapshot fields that Node already has (total_discovered, total_qualified,
    total_contacted, total_won, stalled_deals_count).

    Persistence Integration milestone, Part 5 addition: when payload
    also carries "session_id", the response additionally includes
    "batch_intelligence" -- a real AnalyticsService.compute_analytics()
    report (analytics/models.AnalyticsReport, Subsystem 18) computed
    from that session's persisted Prioritization/Ranking/Mission
    Generation/Workflow Initialization output, loaded via
    _fetch_batch_intelligence_context() rather than recomputed. This is
    purely additive: callers that do not pass session_id (every existing
    caller today) see byte-identical output to before this milestone.
    """
    total_discovered = int(payload.get("total_discovered") or 0)
    total_qualified = int(payload.get("total_qualified") or 0)
    total_contacted = int(payload.get("total_contacted") or 0)
    total_won = int(payload.get("total_won") or 0)

    def _rate(num: int, denom: int) -> float:
        return round(num / denom * 100, 1) if denom > 0 else 0.0

    result = {
        "total_discovered": total_discovered,
        "total_qualified": total_qualified,
        "total_contacted": total_contacted,
        "total_won": total_won,
        "qualification_rate_pct": _rate(total_qualified, total_discovered),
        "contact_rate_pct": _rate(total_contacted, total_qualified),
        "win_rate_pct": _rate(total_won, total_contacted),
        "end_to_end_rate_pct": _rate(total_won, total_discovered),
    }

    session_id = payload.get("session_id")
    if session_id:
        from analytics.service import AnalyticsService

        try:
            context = _fetch_batch_intelligence_context(str(session_id))
            report = AnalyticsService.compute_analytics(context)
            result["batch_intelligence"] = _analytics_report_dict(report)
        except Exception:
            log.warning(
                "[evaluate_analytics_v2] failed to load persisted batch "
                "intelligence for session_id=%s", session_id, exc_info=True,
            )

    return result


async def _analytics_cli() -> None:
    raw_args = sys.argv[2] if len(sys.argv) > 2 else sys.stdin.read()
    params = json.loads(raw_args)
    result = await evaluate_analytics_v2(params)
    _REAL_STDOUT.write(json.dumps(result, default=str))
    _REAL_STDOUT.flush()


async def build_ai_coach_context_v2(payload: dict) -> dict:
    """
    Engine 2.0 builds the canonical structured intelligence context payload
    (BusinessContext, ScoringContext, RelationshipContext, AnalyticsContext)
    that Node transports verbatim to Claude/OpenAI — Engine reasons, Node transports.
    """
    biz_data = payload.get("business") or {}
    crm_data = payload.get("crm") or {}
    stalled_deals = payload.get("stalledDeals") or []
    snapshot = payload.get("snapshot") or {}

    # Business scoring context — Engine 2.0 computes all profession scores.
    scores_res = OpportunityScoringService().evaluate_business_professions(biz_data) if biz_data else None

    # CRM relationship context — synchronous Engine 2.0 evaluation.
    crm_res: dict = {}
    if crm_data:
        crm_res = await evaluate_crm_v2(crm_data)

    # Analytics context — pass through from Node's already-computed snapshot.
    analytics_res: dict = {}
    if snapshot:
        analytics_res = await evaluate_analytics_v2(snapshot)

    result = {
        "business_context": {
            "name": biz_data.get("name"),
            "category": biz_data.get("category") or biz_data.get("niche"),
            "website": biz_data.get("website"),
            "rating": biz_data.get("reviews_rating") or biz_data.get("rating"),
            "reviews_count": biz_data.get("reviews_count") or biz_data.get("reviews"),
        },
        "scoring_context": {
            "is_disqualified": scores_res.is_disqualified if scores_res else False,
            "universal_breakdown": scores_res.universal_breakdown.to_dict() if scores_res else {},
            "profession_scores": {
                s.profession_slug: {"score": s.score, "summary": s.summary, "reasons": list(s.reasons)}
                for s in scores_res.profession_scores
            } if scores_res else {},
        },
        "relationship_context": crm_res,
        "analytics_context": analytics_res,
        "stalled_deals": stalled_deals,
    }

    # Persistence Integration milestone, Part 5 addition: when payload
    # carries "opportunity_id", surface that opportunity's persisted
    # Mission + WorkflowState (Subsystems 14/15, written by
    # run_batch_intelligence()) as "mission_context" -- read-path-only,
    # via the same SupabaseBatchIntelligenceBackend every other reader
    # in this file now uses. Additive: callers that don't pass
    # opportunity_id (every existing caller today) see byte-identical
    # output to before this milestone.
    opportunity_id = payload.get("opportunity_id")
    if opportunity_id:
        try:
            batch_backend = _build_batch_intelligence_backend()
            mission = batch_backend.fetch_mission(str(opportunity_id))
            workflow_state = batch_backend.fetch_workflow_state(str(opportunity_id))
            result["mission_context"] = {
                "mission": (
                    {
                        "opportunity_id": mission.opportunity_id,
                        "business_id": mission.business_id,
                        "mission_type": mission.mission_type.value,
                    }
                    if mission is not None else None
                ),
                "workflow_state": (
                    _workflow_state_dict(workflow_state)
                    if workflow_state is not None else None
                ),
            }
        except Exception:
            log.warning(
                "[build_ai_coach_context_v2] failed to load persisted "
                "mission context for opportunity_id=%s", opportunity_id,
                exc_info=True,
            )

    return result


async def _ai_coach_cli() -> None:
    raw_args = sys.argv[2] if len(sys.argv) > 2 else sys.stdin.read()
    params = json.loads(raw_args)
    result = await build_ai_coach_context_v2(params)
    _REAL_STDOUT.write(json.dumps(result, default=str))
    _REAL_STDOUT.flush()


def _workflow_state_dict(state) -> dict:
    return {
        "mission_id": state.mission_id,
        "opportunity_id": state.opportunity_id,
        "business_id": state.business_id,
        "status": state.status.value,
    }


async def evaluate_workflow_v2(payload: dict) -> dict:
    """
    Evaluates Engine 2.0 Workflow Engine (Subsystem 15) transitions for the
    Node bridge's on-demand "Workflow Transition" step.

    Two actions, selected by payload["action"] (case-insensitive):
      - "initialize": builds a Mission from payload["mission"] and returns
        the initial UNSTARTED WorkflowState via
        WorkflowEngineService.initialize_workflow(). Used when a workspace
        needs a WorkflowState for a mission that doesn't have one on
        record yet.
      - "transition" (default): evaluates a single (WorkflowState,
        WorkflowEvent) pair from payload["state"] and payload["event"] via
        WorkflowEngineService.transition().
    """
    import datetime as _dt
    from mission_generation.models import Mission, MissionType
    from workflow.service import WorkflowEngineService
    from workflow.models import WorkflowEvent, WorkflowEventType, WorkflowState, WorkflowStatus

    action = str(payload.get("action") or "").lower()
    if not action:
        action = "initialize" if "mission" in payload and "event" not in payload else "transition"

    if action == "initialize":
        raw_mission = payload.get("mission") if isinstance(payload.get("mission"), dict) else payload
        mission = Mission(
            opportunity_id=str(raw_mission.get("opportunity_id") or raw_mission.get("id") or "opp_unknown"),
            business_id=str(raw_mission.get("business_id") or raw_mission.get("businessId") or "biz_unknown"),
            mission_type=MissionType(str(raw_mission.get("mission_type") or raw_mission.get("type") or "OUTREACH").upper()),
        )
        state = WorkflowEngineService.initialize_workflow(mission)
        return {"action": "initialize", "state": _workflow_state_dict(state)}

    raw_state = payload.get("state") or payload.get("current_state")
    if raw_state:
        current_state = WorkflowState(
            mission_id=str(raw_state.get("mission_id") or raw_state.get("opportunity_id") or "opp_unknown"),
            opportunity_id=str(raw_state.get("opportunity_id") or "opp_unknown"),
            business_id=str(raw_state.get("business_id") or "biz_unknown"),
            status=WorkflowStatus(str(raw_state.get("status") or "UNSTARTED").upper()),
        )
    else:
        # Persistence Integration milestone, Part 5 (read path): no
        # inline `state`/`current_state` payload was supplied -- rather
        # than falling back to a fabricated "opp_unknown" WorkflowState
        # (the pre-persistence behavior), load the real persisted
        # WorkflowState for payload["opportunity_id"] via
        # SupabaseBatchIntelligenceBackend.fetch_workflow_state(),
        # written by run_batch_intelligence()'s Workflow Initialization
        # step. This is the on-demand chain consuming persisted state
        # instead of recomputing/guessing it.
        opportunity_id = str(
            payload.get("opportunity_id") or payload.get("id") or ""
        ).strip()
        if not opportunity_id:
            raise ValueError(
                "evaluate_workflow_v2: 'transition' action requires either "
                "a 'state'/'current_state' payload or an 'opportunity_id' "
                "to load a persisted WorkflowState for."
            )
        batch_backend = _build_batch_intelligence_backend()
        current_state = batch_backend.fetch_workflow_state(opportunity_id)
        if current_state is None:
            raise ValueError(
                f"evaluate_workflow_v2: no persisted WorkflowState found for "
                f"opportunity_id={opportunity_id!r}; Workflow Initialization "
                f"may not have run for this opportunity yet."
            )

    raw_event = payload.get("event") or {}
    event = WorkflowEvent(
        event_type=WorkflowEventType(str(raw_event.get("event_type") or raw_event.get("type") or "QUEUE").upper()),
        timestamp_iso=str(raw_event.get("timestamp_iso") or _dt.datetime.now(_dt.timezone.utc).isoformat()),
        reason=raw_event.get("reason"),
    )

    result = WorkflowEngineService.transition(current_state, event)

    if result.success:
        # Persist the advanced state back so the next on-demand
        # transition (and Mission Intelligence / Analytics / AI Coach
        # reads) see the new status rather than the stale batch-
        # initialization one. Never persists a failed transition's
        # unchanged new_state==previous_state.
        try:
            batch_backend = _build_batch_intelligence_backend()
            batch_backend.update_workflow_state(result.new_state)
        except Exception:
            log.warning(
                "[evaluate_workflow_v2] failed to persist transitioned "
                "WorkflowState for opportunity_id=%s",
                result.new_state.opportunity_id, exc_info=True,
            )

    return {
        "action": "transition",
        "success": result.success,
        "previous_state": _workflow_state_dict(result.previous_state),
        "new_state": _workflow_state_dict(result.new_state),
        "error_message": result.error_message,
    }


async def _workflow_cli() -> None:
    raw_args = sys.argv[2] if len(sys.argv) > 2 else sys.stdin.read()
    params = json.loads(raw_args)
    result = await evaluate_workflow_v2(params)
    _REAL_STDOUT.write(json.dumps(result, default=str))
    _REAL_STDOUT.flush()


def _mission_progression_dict(evaluation) -> dict:
    from mission_generation.models import Mission

    def _mission_dict(m: Mission | None) -> dict | None:
        if m is None:
            return None
        return {
            "opportunity_id": m.opportunity_id,
            "business_id": m.business_id,
            "mission_type": m.mission_type.value,
        }

    return {
        "current_mission": _mission_dict(evaluation.current_mission),
        "workflow_state": _workflow_state_dict(evaluation.workflow_state),
        "next_mission": _mission_dict(evaluation.next_mission),
        "rule_applied": evaluation.rule_applied.value,
        "reason": evaluation.reason,
    }


async def evaluate_mission_intelligence_v2(payload: dict) -> dict:
    """
    Persistence Integration milestone, Part 5 (read path): Mission
    Intelligence (Subsystem 22) had no CLI entrypoint anywhere in this
    file before this milestone -- MissionIntelligenceService.
    derive_next_mission() (mission_intelligence/service.py) has existed
    since that subsystem was built but was never wired to anything
    outside tests/validate_mission_intelligence.py. This is that wiring,
    and it is read-path-only: it loads the persisted Mission and
    WorkflowState for payload["opportunity_id"] (written by
    run_batch_intelligence()'s Mission Generation / Workflow
    Initialization steps) and the most recent persisted FeedbackRecord
    for that opportunity, if any -- it does not recompute Prioritization,
    Ranking, or Mission Generation itself (Part 5's own requirement).

    payload:
      - opportunity_id (required)
    """
    from feedback.models import FeedbackTargetType
    from mission_intelligence.service import MissionIntelligenceService

    opportunity_id = str(payload.get("opportunity_id") or payload.get("id") or "").strip()
    if not opportunity_id:
        raise ValueError(
            "evaluate_mission_intelligence_v2 requires 'opportunity_id'."
        )

    batch_backend = _build_batch_intelligence_backend()

    mission = batch_backend.fetch_mission(opportunity_id)
    if mission is None:
        raise ValueError(
            f"evaluate_mission_intelligence_v2: no persisted Mission found "
            f"for opportunity_id={opportunity_id!r}; Mission Generation may "
            f"not have run for this opportunity yet."
        )

    workflow_state = batch_backend.fetch_workflow_state(opportunity_id)
    if workflow_state is None:
        raise ValueError(
            f"evaluate_mission_intelligence_v2: no persisted WorkflowState "
            f"found for opportunity_id={opportunity_id!r}; Workflow "
            f"Initialization may not have run for this opportunity yet."
        )

    feedback_records = batch_backend.fetch_feedback_for_target(
        FeedbackTargetType.OPPORTUNITY, opportunity_id
    )
    latest_feedback = feedback_records[0] if feedback_records else None

    evaluation = MissionIntelligenceService.derive_next_mission(
        mission, workflow_state, latest_feedback
    )
    return _mission_progression_dict(evaluation)


async def _mission_intelligence_cli() -> None:
    raw_args = sys.argv[2] if len(sys.argv) > 2 else sys.stdin.read()
    params = json.loads(raw_args)
    result = await evaluate_mission_intelligence_v2(params)
    _REAL_STDOUT.write(json.dumps(result, default=str))
    _REAL_STDOUT.flush()


async def capture_feedback_v2(payload: dict) -> dict:
    """
    Persistence Integration milestone, Part 4/5 (write path for
    Feedback): feedback/service.py's FeedbackService.capture_feedback()
    has existed since Subsystem 19 was built but, like Mission
    Intelligence, had zero production callers before this milestone
    (repository audit confirmed only tests/validate_feedback.py
    exercised it). This CLI mode captures a FeedbackRecord and persists
    it via SupabaseBatchIntelligenceBackend.persist_feedback() so
    evaluate_mission_intelligence_v2() above (and any future on-demand
    reader) can read it back without the caller having to resupply it.

    payload:
      - target_type (required — 'opportunity' | 'mission' | 'business' | 'provider')
      - target_id (required)
      - outcome (required)
      - notes (optional)
      - metadata (optional — list of [key, value] pairs)
    """
    from feedback.service import FeedbackService

    record = FeedbackService.capture_feedback(
        target_type=str(payload.get("target_type") or ""),
        target_id=str(payload.get("target_id") or ""),
        outcome=str(payload.get("outcome") or ""),
        notes=payload.get("notes"),
        metadata=[tuple(pair) for pair in (payload.get("metadata") or [])],
    )

    batch_backend = _build_batch_intelligence_backend()
    batch_backend.persist_feedback(record)

    return {
        "target_type": record.target_type.value,
        "target_id": record.target_id,
        "outcome": record.outcome.value,
        "notes": record.evidence.notes,
        "metadata": [list(pair) for pair in record.evidence.metadata],
    }


async def _feedback_cli() -> None:
    raw_args = sys.argv[2] if len(sys.argv) > 2 else sys.stdin.read()
    params = json.loads(raw_args)
    result = await capture_feedback_v2(params)
    _REAL_STDOUT.write(json.dumps(result, default=str))
    _REAL_STDOUT.flush()


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "verify":
        asyncio.run(_run_with_graceful_shutdown(_verify_cli))
    elif len(sys.argv) > 1 and sys.argv[1] == "enrich":
        asyncio.run(_run_with_graceful_shutdown(_enrich_cli))
    elif len(sys.argv) > 1 and sys.argv[1] == "score":
        asyncio.run(_run_with_graceful_shutdown(_score_cli))
    elif len(sys.argv) > 1 and sys.argv[1] == "qualify":
        asyncio.run(_run_with_graceful_shutdown(_qualify_cli))
    elif len(sys.argv) > 1 and sys.argv[1] == "prioritize":
        asyncio.run(_run_with_graceful_shutdown(_prioritize_cli))
    elif len(sys.argv) > 1 and sys.argv[1] == "workflow":
        asyncio.run(_run_with_graceful_shutdown(_workflow_cli))
    elif len(sys.argv) > 1 and sys.argv[1] == "crm":
        asyncio.run(_run_with_graceful_shutdown(_crm_cli))
    elif len(sys.argv) > 1 and sys.argv[1] == "analytics":
        asyncio.run(_run_with_graceful_shutdown(_analytics_cli))
    elif len(sys.argv) > 1 and sys.argv[1] == "ai_coach":
        asyncio.run(_run_with_graceful_shutdown(_ai_coach_cli))
    elif len(sys.argv) > 1 and sys.argv[1] == "mission_intelligence":
        asyncio.run(_run_with_graceful_shutdown(_mission_intelligence_cli))
    elif len(sys.argv) > 1 and sys.argv[1] == "feedback":
        asyncio.run(_run_with_graceful_shutdown(_feedback_cli))
    else:
        asyncio.run(_run_with_graceful_shutdown(_main_cli))

