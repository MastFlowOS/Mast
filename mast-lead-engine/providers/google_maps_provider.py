"""
MAST Engine V2 — GoogleMapsProvider
=====================================

Source: Engine BluePrint, Phase 1.5 Stage 2 ("Provider Layer"),
engine/interfaces.py (DiscoveryProviderInterface, Phase 5.1), and the
Phase 5.2 implementation prompt. Behavioural reference: service.py's
`run_query(..., discovery_only=True)` branch and scraper/maps_scraper.py
(MapsScraper.search / RawPlace) — the V1 code path this milestone
migrates into the V2 architecture without redesigning it.

Responsibility
--------------
GoogleMapsProvider is the first concrete DiscoveryProviderInterface
implementation. It has exactly one job: accept a discovery request,
drive the existing MapsScraper.search() exactly as V1 already does,
and stream BusinessCandidate objects — nothing else. It does not
enrich, qualify, score, store, deduplicate, retry, cache, allocate
workers, own queues, or own runtime state. All of that already lives
elsewhere (or doesn't exist yet) in this architecture, and none of it
belongs here.

What "reuse V1 behaviour" means concretely
-------------------------------------------
service.py's discovery_only branch is the existing production code
path that already does *only* discovery — no EnrichmentPipeline call,
no scoring, no storage. It:

    1. Calls MapsScraper.search(query, city, country, niche, region,
       max_results) and iterates the RawPlace objects it yields.
    2. Skips a place if it's permanently closed, a known chain, or
       flagged as cannabis (is_chain / is_cannabis from
       scoring/scorer.py), via a check performed in service.py itself.
    3. Converts the survivor to a dict via RawPlace.to_dict(), attaches
       fingerprints (storage.dedup.fingerprints_for) and an
       is_disqualified flag, and yields it.

This provider reuses step 1 verbatim (MapsScraper.search() is called
with the same arguments, unmodified). Steps 2's "closed" half is also
preserved automatically, for free — MapsScraper.search() itself
already discards permanently-closed places internally (see its own
"Skip permanently closed" check) before a RawPlace is ever yielded, so
this provider never sees them and needs no code to repeat that check.

Step 2's is_chain / is_cannabis half, and all of step 3, are
deliberately NOT carried over here. See "Ambiguity 1" below for why.

Ambiguities found while implementing this milestone (flagged per this
project's established "stop and ask, don't guess" convention, called
out explicitly rather than resolved silently)
----------------------------------------------------------------------
1. is_chain / is_cannabis filtering. service.py's discovery_only
   branch filters these out today, so a byte-for-byte reproduction of
   current output would keep that filter. But:
     - Phase 1.5 Stage 2 defines this provider's scope in exactly
       these words: "No enrichment. No qualification. No storage."
     - This milestone's own instructions list "qualify opportunities"
       under GOOGLE MAPS PROVIDER MUST NOT.
     - is_chain / is_cannabis are imported from scoring/scorer.py in
       V1 — i.e. V1 itself already treats them as scoring-layer
       business judgment, not raw discovery.
   Chain/cannabis exclusion is a business-eligibility judgment, not a
   "did Google Maps show us this listing" fact, so I've kept it out of
   this provider and left it for the future Qualification stage
   (Stage 5) to apply against BusinessCandidate/EnrichedBusiness data.
   Net effect: this provider's raw output stream is slightly broader
   than service.py's current discovery_only output (chains and
   cannabis businesses are no longer pre-filtered at this layer). This
   is a real, intentional divergence from today's exact byte-for-byte
   output — flagging it rather than silently picking a side, since the
   blueprint text and the milestone instructions both point the same
   way (exclude), while "preserve V1 behaviour" alone would point the
   other way (include).

2. Fingerprints / is_disqualified. service.py's discovery_only branch
   attaches `fingerprints` (storage.dedup.fingerprints_for) and
   `is_disqualified` before yielding. Both are storage/dedup concerns
   ("must not deduplicate", "must not store anything" — explicit in
   this milestone's instructions), so neither is reproduced here. A
   future StorageWorker or dedup stage is the right owner of this
   logic against BusinessCandidate data.

3. Request shape. DiscoveryProviderInterface.discover(request: Any)
   deliberately leaves `request`'s shape undefined (see
   engine/interfaces.py — "inventing it here would be an architecture
   decision this milestone is not authorized to make"). No
   DiscoverySession / discovery-request contract exists yet in
   engine/contracts.py, and engine/ is out of scope to modify for this
   milestone. GoogleMapsDiscoveryRequest below is therefore defined
   locally, inside providers/, as this provider's own accepted request
   shape — not a shared engine contract. It carries exactly what
   MapsScraper.search() needs (query, city, country, niche, region,
   max_results) plus `session_id`, since BusinessCandidate.session_id
   is a required field and this provider must not invent or own
   session state itself (the caller — eventually DiscoverySession —
   is the correct owner of session identity). A future Provider
   Registry / DiscoverySession milestone may want to promote this (or
   something like it) into a real shared contract; this provider does
   not attempt to make that call.

4. Sync interface, async implementation. WorkerInterface's sibling
   `DiscoveryProviderInterface.discover()` is declared as a plain
   (non-async) method returning `Iterator[BusinessCandidate]`. The V1
   discovery logic it wraps is fully async (Playwright, `async with
   MapsScraper(...)`, `async for place in scraper.search(...)`) and
   cannot run outside an asyncio event loop. engine/interfaces.py is
   out of scope to modify for this milestone, so this provider bridges
   the mismatch itself: `discover()` opens a private event loop, steps
   the async generator one item at a time via
   `loop.run_until_complete(agen.__anext__())`, and yields each
   BusinessCandidate synchronously as it arrives — still streaming,
   never materializing the full result set, just synchronously from
   the caller's point of view. The loop is created fresh per call and
   closed in a `finally`, so there is no shared/global event loop state
   between calls (keeping the provider stateless per the "no mutable
   shared state, no global caches" requirement). The real cost of this
   bridge: the calling thread blocks for the entire discovery run,
   since nothing here schedules the work onto a background thread or
   loop. Whether callers should invoke `discover()` from a worker
   thread, or whether the interface itself should eventually become
   async, is a decision for a future milestone (DiscoveryWorker /
   Provider Registry) — flagging it rather than silently working
   around it.

Status
------
Phase 5.2. First concrete DiscoveryProviderInterface implementation.
providers/__init__.py's "empty placeholder package" status is now
superseded by this file's existence (see that module's updated
docstring). No other package (engine/, workers/, queues/, models/) is
touched. scraper/maps_scraper.py and service.py are read, not modified.
"""

from __future__ import annotations

import asyncio
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, AsyncIterator, Callable, Iterator, Optional

from engine.contracts import BusinessCandidate
from engine.interfaces import DiscoveryProviderInterface
from providers.provider_capabilities import ProviderCapabilities
from providers.provider_metadata import ProviderMetadata
from scraper.maps_scraper import MapsScraper, RawPlace
from utils.perf import NullProfiler
from utils.runtime import ProxyManager, RunStats, ScraperConfig, get_logger

log = get_logger("providers.google_maps")


# ---------------------------------------------------------------------------
# Request shape (provider-local — see Ambiguity 3 above)
# ---------------------------------------------------------------------------
@dataclass(frozen=True, slots=True)
class GoogleMapsDiscoveryRequest:
    """
    This provider's own accepted request shape. Not a shared
    engine/contracts.py contract — see Ambiguity 3 in this module's
    docstring for why. Mirrors exactly the arguments
    MapsScraper.search() already accepts today, plus `session_id`
    (required by BusinessCandidate, owned by the caller — this
    provider never invents or tracks session identity itself).

    Fields map 1:1 onto MapsScraper.search()'s own parameters, which
    themselves map onto run_query()'s discovery-relevant kwargs
    (query, city, country, niche, region, max_results) — the same
    names, same defaults, no renaming, so nothing is lost or
    reinterpreted in translation.
    """

    session_id: str
    query: str
    city: str
    country: str = "US"
    niche: str = ""
    region: str = ""
    max_results: int = 60
    # LIFECYCLE FIX (bridge delivery / watchdog / graceful shutdown phase):
    # optional cooperative early-stop check, consulted once per candidate
    # already streamed out of MapsScraper (see `discover()`/`_discover_async`
    # below) — never consulted from inside scraper/maps_scraper.py itself,
    # so this does not touch that module's scrolling/selector/parsing
    # internals at all. Lets a caller that already has enough (target
    # reached) or that has been asked to shut down (cooperative SIGTERM
    # handling — see service.py's `_run_with_graceful_shutdown` /
    # `run_query`) stop asking this provider for more candidates without
    # waiting for it to exhaust `max_results`. `None` (the default)
    # preserves the exact previous behavior — run to exhaustion — for any
    # caller that doesn't pass one (e.g. existing tests/validate scripts).
    should_stop: Optional[Callable[[], bool]] = None
    # MINIMAL FIX (discovery liveness / watchdog blindness — forensic audit
    # §9): threaded through to MapsScraper.search() the exact same way
    # `should_stop` already is (a plain optional callback, `None` by
    # default so any caller that doesn't pass one gets identical behavior
    # to before this fix). Called with `(stage, event, item_id)` — the same
    # signature service.py's own `_on_progress` already accepts — so a
    # caller can hand its existing `_on_progress` straight through with no
    # adapter. This is a liveness/heartbeat signal only ("the engine is
    # alive and looking at real DOM content"); it never carries a
    # BusinessCandidate and must never be treated as one.
    on_progress: Optional[Callable[[str, str, Optional[str]], None]] = None


def _or_none(value: str) -> Optional[str]:
    """
    RawPlace uses "" as its "not extracted" sentinel for string fields
    (dataclass defaults); BusinessCandidate uses None for the same
    concept ("Unknown values remain None" — this milestone's explicit
    instruction). This tiny helper is the one place that translation
    happens, so every field mapping below stays a plain 1:1 assignment.
    """
    return value if value else None


class GoogleMapsProvider(DiscoveryProviderInterface):
    """
    Adapts MapsScraper.search() (V1, unmodified) to
    DiscoveryProviderInterface (V2). Wraps, does not reimplement, does
    not redesign.

    Stateless: every discover() call builds its own ScraperConfig,
    RunStats, ProxyManager, and MapsScraper — nothing is cached or
    shared across calls or instances, matching MapsScraper's own
    existing usage pattern in service.py (a fresh instance per
    `async with` block, never reused).

    PHASE 2B (discovery wall-clock instrumentation) — ROOT CAUSE FIX:
    `profiler`, if supplied, is threaded straight into every
    `MapsScraper` this provider constructs. Before this fix, this
    class never accepted a profiler at all, so `_discover_async()`
    always built `MapsScraper(config, proxy_manager, stats)` with no
    third argument — `MapsScraper.__init__` defaults `profiler` to
    `NullProfiler()` in that case, which silently no-ops every
    `with self._profiler.timer(...)` call already wired into
    scraper/maps_scraper.py (playwright_startup, browser_startup,
    context_creation, page_creation, rate_limit_wait_search,
    maps_initial_load, place_click, place_panel_wait,
    rate_limit_wait_place, place_settle, maps_place_extraction,
    duplicate_detection, retry_wait, ...). That is the entire reason
    the production `[area-sla]` report's maps_ms/navigation_ms/
    panel_ms/scroll_ms/place_click_ms/rate_limit_ms/extraction_ms
    fields read 0 even while discovery_worker consumes 200-315s of
    real wall-clock time: the timers were always firing against a
    profiler nobody was ever going to read. `None` (the default)
    preserves the exact previous behavior for any caller that doesn't
    pass one (existing tests, validate_composite_provider.py, etc.).
    """

    def __init__(self, *, profiler: Any = None) -> None:
        self._profiler = profiler or NullProfiler()

    @property
    def provider_id(self) -> str:
        return "google_maps"

    @property
    def display_name(self) -> str:
        return "Google Maps"

    @classmethod
    def metadata(cls) -> ProviderMetadata:
        """
        This provider's own static characteristics — see
        provider_metadata.py for the full field-by-field rationale.

        A classmethod, not an instance property or attribute, so that
        a caller (typically whoever calls
        ProviderRegistry.register()) can read this provider's
        metadata WITHOUT constructing an instance first — see the
        Provider Metadata milestone's requirement that "metadata
        lookup must be independent of provider construction."
        GoogleMapsProvider() happens to take no constructor arguments
        today, so calling it would be cheap, but this provider's
        metadata should not be coupled to that being true — YelpProvider
        below is the concrete counter-example (its constructor
        requires an api_key), and both providers' metadata must be
        obtainable the same way, by the same registry code path,
        without special-casing either one.

        Values below are drawn directly from this class's own
        docstring and __init__ signature — no field here is invented;
        each is answerable by reading this file alone (see
        provider_metadata.py, "Field selection").
        """
        return ProviderMetadata(
            provider_id="google_maps",
            display_name="Google Maps",
            description=(
                "Streams BusinessCandidate objects by driving the "
                "existing MapsScraper.search() (V1, unmodified) — "
                "Google Maps business listing discovery via browser "
                "automation."
            ),
            provider_type="maps_scraper",
            requires_api_key=False,
            default_enabled=True,
            homepage="https://maps.google.com",
            version="1.0.0",
        )

    CAPABILITIES: ProviderCapabilities = ProviderCapabilities(
        supports_keyword_search=True,
        supports_category_search=True,
        supports_city_filter=True,
        supports_country_filter=True,
        supports_radius_search=False,
        supports_coordinate_search=False,
        supported_entity_types=("local_business",),
        provides_phone_numbers=True,
        supports_pagination=False,
        supports_streaming=True,
    )

    @classmethod
    def capabilities(cls) -> ProviderCapabilities:
        """
        This provider's own search functionality — see
        provider_capabilities.py for the full field-by-field rationale.

        A classmethod, not an instance property, for the same reason
        `metadata()` above is one: a caller must be able to learn what
        this provider's discover() can be asked to do WITHOUT
        constructing an instance first — capabilities lookup must stay
        independent of provider construction, exactly like metadata.
        Return what a caller can ask this provider's discover() to search by.
        """
        return cls.CAPABILITIES

    def discover(self, request: GoogleMapsDiscoveryRequest) -> Iterator[BusinessCandidate]:
        """
        Streams BusinessCandidate objects for `request`, one at a
        time, without materializing the full result set — see
        Ambiguity 4 above for how the sync interface / async
        implementation mismatch is bridged.

        Any exception raised while driving the scraper (including one
        MapsScraper.search() itself couldn't recover from after
        exhausting its own internal crash-retry budget) propagates
        unchanged out of this generator. Nothing here catches or
        swallows it — "keep provider failures isolated to the
        provider" means this provider must not reach into
        worker/queue/session machinery to handle the failure, not that
        the failure should be hidden from the caller.
        """
        loop = asyncio.new_event_loop()
        try:
            agen = self._discover_async(request)
            try:
                while True:
                    try:
                        candidate = loop.run_until_complete(agen.__anext__())
                    except StopAsyncIteration:
                        break
                    yield candidate
            finally:
                loop.run_until_complete(agen.aclose())
        finally:
            loop.close()

    async def _discover_async(
        self, request: GoogleMapsDiscoveryRequest
    ) -> AsyncIterator[BusinessCandidate]:
        """
        The actual async discovery flow — same shape as service.py's
        discovery_only branch, minus everything out of scope for a
        provider (see Ambiguities 1 and 2 above). `ScraperConfig(headless=True)`
        mirrors verify_business()'s own minimal-args construction in
        service.py (proof that every other ScraperConfig field has a
        usable default; discovery needs none of the enrichment-related
        ones — fast/skip_ig/skip_site_crawl/max_ig_followers/max_reviews
        — since this provider never enriches).
        """
        config = ScraperConfig(headless=True)
        stats = RunStats()
        proxy_manager = ProxyManager()

        # PHASE 2B ROOT CAUSE FIX: `self._profiler` (real profiler when
        # one was supplied at construction, NullProfiler otherwise) is
        # now actually threaded into MapsScraper — see this class's own
        # docstring for why omitting this argument was the entire cause
        # of the zeroed-out [area-sla] discovery stage timers. Falls
        # back to the old zero-profiler construction via `try/except
        # TypeError` (same backward-compatibility idiom used throughout
        # this codebase — see OverpassProvider.discover()) because some
        # existing tests (e.g.
        # tests/test_google_maps_provider_should_stop.py's
        # `_FakeMapsScraper`) monkeypatch this module's `MapsScraper`
        # name with a fake that predates the `profiler` keyword.
        try:
            scraper_cm = MapsScraper(config, proxy_manager, stats, profiler=self._profiler)
        except TypeError:
            scraper_cm = MapsScraper(config, proxy_manager, stats)
        async with scraper_cm as scraper:
            # LIFECYCLE FIX: hold the generator in a variable (rather than
            # inlining it into the `async for`) so it can be explicitly
            # `aclose()`d in `finally` below regardless of whether the loop
            # runs to natural exhaustion or exits early via the
            # `should_stop` check — `async for`'s own `break` does NOT
            # implicitly close the generator it was iterating, and leaving
            # it un-closed would emit an asyncio "was never awaited"-style
            # warning at GC time instead of letting MapsScraper's own
            # generator `finally` blocks run deterministically, right here,
            # while the surrounding `async with MapsScraper(...)` block
            # (this method's browser/context/page owner) is still open —
            # exactly the ordering "playwright resources must not be
            # closed while active generator code can still execute against
            # them" requires, just from the opposite direction: the
            # generator is closed *before* its browser, not after.
            search_gen = scraper.search(
                query=request.query,
                city=request.city,
                country=request.country,
                niche=request.niche,
                region=request.region,
                max_results=request.max_results,
                # PHASE 1B: same predicate already consulted below, after
                # each yielded candidate — also handed to MapsScraper.search()
                # itself so a crash-triggered retry (scraper/maps_scraper.py's
                # own internal recovery loop, untouched otherwise) does not
                # start a new browser attempt once discovery should already
                # be winding down. See that method's `should_stop` docstring
                # for exactly which checkpoint this is.
                should_stop=request.should_stop,
                # MINIMAL FIX (discovery liveness — forensic audit §9):
                # same pass-through pattern as should_stop immediately
                # above — see GoogleMapsDiscoveryRequest.on_progress's
                # docstring.
                on_progress=request.on_progress,
            )
            try:
                async for place in search_gen:
                    yield self._to_business_candidate(
                        place,
                        request.session_id,
                        requested_niche=request.niche or None,
                    )
                    # Checked *after* yielding, never before: whatever this
                    # iteration already retrieved from Maps is always
                    # propagated to the caller first ("finish current lead
                    # delivery" — see run_query()'s docstring for the full
                    # ordering this implements) — only the *next* pull from
                    # Maps is skipped once should_stop() reports true.
                    if request.should_stop is not None and request.should_stop():
                        log.info(
                            "[google_maps_provider] should_stop reported true "
                            "after streaming a candidate — stopping further "
                            "discovery for this request (session=%s) instead "
                            "of continuing toward max_results=%d",
                            request.session_id, request.max_results,
                        )
                        break
            finally:
                await search_gen.aclose()

    def _to_business_candidate(
        self,
        place: RawPlace,
        session_id: str,
        requested_niche: Optional[str] = None,
    ) -> BusinessCandidate:
        """
        Field-for-field mapping, RawPlace -> BusinessCandidate. Only
        fields Google Maps can legitimately provide are populated;
        nothing is fabricated. Notably absent from BusinessCandidate
        and therefore left None:

            provider_business_id — RawPlace never extracts a stable
                Google Place ID, only `maps_link` (a URL); a URL is not
                the same thing as a business ID, so it's mapped to
                `maps_url` instead and provider_business_id stays None
                rather than deriving a synthetic ID from the URL.
            coordinates — RawPlace never extracts latitude/longitude.

        `discovered_at` is populated with the current UTC timestamp at
        the moment of conversion — this is provider-generated
        operational metadata (when discovery happened), not a
        fabricated business fact, and is exactly what that field's
        "Metadata" grouping in engine/contracts.py describes.

        A fresh pipeline_id is minted per BusinessCandidate here,
        mirroring where V1's PipelineTracer.discover() mints a pipeline
        id — "immediately after MapsScraper yields a business" (see
        service.py). This provider does not use PipelineTracer itself
        (tracing/observability infrastructure is out of scope for a
        provider), but the identifier still needs to originate
        somewhere, and per the Ownership Table in engine/contracts.py,
        BusinessCandidate — the first contract in the pipeline — is
        the natural point of origin for a pipeline_id.
        """
        return BusinessCandidate(
            pipeline_id=str(uuid.uuid4()),
            session_id=session_id,
            provider=self.provider_id,
            provider_business_id=None,
            maps_url=_or_none(place.maps_link),
            name=_or_none(place.name),
            category=_or_none(place.category),
            address=_or_none(place.address),
            city=_or_none(place.city),
            country=_or_none(place.country),
            website=_or_none(place.website),
            phone=_or_none(place.phone),
            rating=place.rating,
            review_count=place.reviews,
            coordinates=None,
            discovered_at=datetime.now(timezone.utc).isoformat(),
            # Phase 4A: existing RawPlace.closed value, traced through
            # unchanged — see BusinessCandidate.closed's own docstring
            # in engine/contracts.py. No new closed-business rule is
            # invented here; this is a straight field-for-field mapping
            # like every other line above. getattr(..., False) rather
            # than a direct attribute access solely so this stays
            # tolerant of pre-Phase-4A test doubles for RawPlace (e.g.
            # tests/test_google_maps_provider_should_stop.py's
            # `_FakeRawPlace`) that don't set `closed` — RawPlace.closed
            # itself already defaults to False, so this preserves that
            # same default rather than changing behavior for them.
            closed=bool(getattr(place, "closed", False)),
            requested_niche=_or_none(requested_niche),
        )
