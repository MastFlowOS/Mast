"""
providers/discovery_composition.py
===================================

MAST — Provider Parallelism v1: Composition Root.

Responsibility
--------------
The single function service.py calls to go from "here is a discovery
request" to "here is one DiscoveryProviderInterface and one request
object ready to hand to DiscoveryWorker" — the minimal production
wiring this phase's own instructions ask for ("If the provider
framework is still not connected to production, wire ONLY the minimal
production composition needed for this phase").

Pipeline, in order:

    1. Build the production ProviderRegistry (providers/
       production_registry.py) — all eight providers registered.
    2. Select relevant providers by declared entity type (Step 2 —
       providers/provider_selection.py), against `entity_types`
       (defaults to local-business).
    3. Drop any selected-but-unconfigured provider (missing API
       credential — providers/production_registry.py:is_configured()),
       logging why. `google_maps` and `overpass` are never dropped for
       this reason (neither needs a credential).
    4. Translate the request for every remaining provider (Step 3 —
       providers/provider_request_translation.py), dropping any
       provider this milestone cannot honestly translate a request
       for (see that module's own "Honesty rule"), logging why.
    5. If nothing is left after steps 3-4, raise a clear
       `NoRelevantProviderError` — Test I's "fail clearly rather than
       silently returning zero candidates."
    6. Compose what's left directly (mirroring
       `ProviderRegistry.create()`'s own single/parallel + dedup
       logic — see `_construct_provider()` for why this is assembled
       by hand here rather than by calling `registry.create()`
       itself): a single selected provider runs bare, unwrapped —
       ProviderDeduplicator exists for CROSS-provider identity
       collisions and is only applied when more than one provider is
       actually running (Steps 4-6: concurrent execution +
       cross-provider dedup + no double-enrichment, all inherited
       unmodified from the existing provider layer — see those
       modules' own docstrings).

       Provider-failure isolation (Provider Failure Isolation phase):
       when more than one provider is selected, the
       `ParallelCompositeDiscoveryProvider` here is constructed with
       `continue_on_provider_error=True` (diverging from that class's
       own strict `False` default) plus `on_provider_error=
       _log_provider_error`. This is a deliberate, composition-root-
       only policy choice, not a change to
       `ParallelCompositeDiscoveryProvider` itself (still defaults to
       strict elsewhere): a single auxiliary provider failing (e.g.
       Overpass returning HTTP 406) is logged and isolated rather than
       aborting the whole discovery stage, while candidates already
       produced by every healthy provider (e.g. Google Maps) keep
       flowing. If every selected provider fails, the composite's
       queue still empties with no candidates ever yielded — that
       degrades to `DiscoveryWorker` seeing a normally-exhausted
       (empty) provider, which is genuine discovery failure/exhaustion
       surfacing through existing semantics, not hidden. The
       single-provider case above is unaffected: with nothing to
       isolate *from*, that provider's own failure still propagates
       exactly as it always has.
    7. Wrap the result in `TargetAwareDiscoveryProvider` (Step 7 —
       providers/target_aware_provider.py) so target-reached /
       shutdown-requested cancellation reaches every active provider,
       not just Google Maps.
    8. Wrap the *request* in a `ParallelDiscoveryRequest` /
       `CompositeDiscoveryRequest` mapping provider_id -> translated
       request (or hand back the single provider's own bare request,
       for the single-provider case — `ProviderRegistry.create()`
       returns a bare, unwrapped provider then, which expects its own
       bare request, not a mapping).

Observability (Step 8)
----------------------------------------------------------------------
Emits one concise log line per selected provider at composition time
(`[provider] <id> selected` / `[provider] <id> excluded: <reason>`),
so a caller inspecting logs can see, per request, exactly which
providers were considered and why each one that didn't run was
dropped — deliberately not per-candidate or per-HTTP-call, which
`ParallelCompositeDiscoveryProvider` and each provider's own module
already avoid logging for the same "do not flood logs" reason.

Status
------
Provider Parallelism v1 milestone. Wires the existing, unmodified
provider layer (ProviderRegistry, ParallelCompositeDiscoveryProvider,
ProviderDeduplicator) into production for the first time. Does not
modify DiscoveryWorker, ExecutionDriver, or any provider.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any, Callable, Optional, Sequence

from engine.interfaces import DiscoveryProviderInterface
from providers.parallel_composite_provider import (
    ParallelCompositeDiscoveryProvider,
    ParallelDiscoveryRequest,
)
from providers.production_registry import build_production_registry, is_configured
from providers.provider_configuration import ProviderConfiguration
from providers.provider_deduplicator import ProviderDeduplicator
from providers.provider_request_translation import (
    DiscoveryQueryContext,
    translate_request,
)
from providers.provider_selection import DEFAULT_ENTITY_TYPES, select_relevant_providers
from providers.provider_timing import wrap_with_timing
from providers.target_aware_provider import TargetAwareDiscoveryProvider

log = logging.getLogger(__name__)


def _log_provider_error(provider_id: str, exc: BaseException) -> None:
    """
    `on_provider_error` callback handed to `ParallelCompositeDiscoveryProvider`
    (see Composition rule 6, below). Logs the isolated provider failure
    at composition-root observability granularity — one line per
    failure, matching the "[provider] ..." log lines already emitted
    during selection above — and does nothing else: this is a pure
    observability hook, not a retry/failover mechanism (out of scope,
    per parallel_composite_provider.py's own module docstring).
    """
    log.warning(
        "[provider] %s failed during discovery, isolated: %s: %s",
        provider_id,
        type(exc).__name__,
        exc,
    )


class NoRelevantProviderError(RuntimeError):
    """
    Raised when, after relevance selection, credential filtering, and
    request translation, no provider is left to actually run this
    discovery request. A caller-visible, explicit failure — see Test I
    ("no-provider / unsupported-provider configuration: fail clearly
    rather than silently returning zero candidates").
    """


@dataclass(frozen=True, slots=True)
class ComposedDiscovery:
    """
    The result of composing a discovery request: one
    DiscoveryProviderInterface (already wrapped for target/shutdown
    cancellation and, when more than one provider is active, parallel
    execution + cross-provider dedup) and the one request object it
    expects.
    """

    provider: DiscoveryProviderInterface
    request: Any
    selected_provider_ids: tuple[str, ...]


def compose_discovery(
    *,
    session_id: str,
    query: str,
    city: str,
    country: str = "",
    niche: str = "",
    region: str = "",
    max_results: int = 60,
    entity_types: Sequence[str] = DEFAULT_ENTITY_TYPES,
    osm_tags: Optional[dict] = None,
    organization_query: Optional[str] = None,
    should_stop: Optional[Callable[[], bool]] = None,
    on_progress: Optional[Callable[[str, str, Optional[str]], None]] = None,
    google_maps_factory: Optional[Callable[[], DiscoveryProviderInterface]] = None,
    overpass_factory: Optional[Callable[[], DiscoveryProviderInterface]] = None,
    profiler: Any = None,
) -> ComposedDiscovery:
    """
    Build the one DiscoveryProviderInterface + request pair
    production should run for this discovery request. See module
    docstring for the full pipeline.

    `google_maps_factory` — forwarded unchanged to
    `build_production_registry()`; see that function's own docstring
    for why this exists (preserving the pre-existing
    `service.GoogleMapsProvider` test seam).

    `overpass_factory` — PHASE 2B addition, same shape and same reason
    as `google_maps_factory` immediately above (a zero-arg override for
    how `overpass` is constructed, forwarded unchanged to
    `build_production_registry()`), added so a caller (service.py) can
    construct an `OverpassProvider` carrying this run's real `profiler`
    the same way it now does for `GoogleMapsProvider`, without breaking
    the existing test seam for callers that don't supply one.

    `profiler` — PHASE 2B addition. When supplied, every constructed
    provider instance is wrapped in a `TimedDiscoveryProvider` (see
    providers/provider_timing.py) that records that provider's own
    authoritative wall-clock total (`google_maps_provider_total` /
    `overpass_provider_total` / `<provider_id>_provider_total`) into
    this profiler — independent of, and not derived from, whatever
    internal sub-stage timers that provider does or doesn't have. Does
    NOT change candidate output, ordering, or content in any way; a
    `None` profiler (the default) makes every wrap a no-op passthrough
    (see `wrap_with_timing()`), so a caller that doesn't pass one gets
    byte-for-byte the same composed provider this function has always
    returned.

    Raises NoRelevantProviderError if no provider survives selection,
    configuration-availability filtering, and request translation.
    """
    registry = build_production_registry(
        google_maps_factory=google_maps_factory, overpass_factory=overpass_factory,
    )
    capabilities_by_id = registry.capabilities_all()

    relevant = select_relevant_providers(capabilities_by_id, entity_types=entity_types)

    context = DiscoveryQueryContext(
        session_id=session_id,
        query=query,
        city=city,
        country=country,
        niche=niche,
        region=region,
        max_results=max_results,
        osm_tags=osm_tags,
        organization_query=organization_query,
        should_stop=should_stop,
        on_progress=on_progress,
    )

    selected_ids: list[str] = []
    translated_requests: dict[str, Any] = {}
    for provider_id in relevant:
        if not is_configured(provider_id):
            log.info(
                "[provider] %s excluded: missing credential (%s not set)",
                provider_id,
                _env_var_hint(provider_id),
            )
            continue
        provider_request = translate_request(provider_id, context)
        if provider_request is None:
            log.info(
                "[provider] %s excluded: request could not be honestly "
                "translated for this query (see provider_request_translation.py)",
                provider_id,
            )
            continue
        selected_ids.append(provider_id)
        translated_requests[provider_id] = provider_request
        log.info("[provider] %s selected", provider_id)

    if not selected_ids:
        raise NoRelevantProviderError(
            f"No provider is relevant, configured, and translatable for "
            f"this discovery request (entity_types={tuple(entity_types)!r}, "
            f"niche={niche!r}, query={query!r}). Relevant-by-capability "
            f"providers were {tuple(relevant)!r}, but none survived "
            f"credential/translation filtering."
        )

    # Validate the selection the same way ProviderRegistry.create() would
    # (non-empty, no duplicates) even though composition below is done
    # manually rather than via registry.create() — see
    # `_construct_provider()`'s own docstring for why.
    configuration = ProviderConfiguration(
        providers=tuple(selected_ids),
        parallel=True,
        deduplicate=True,
    )
    instances = [
        wrap_with_timing(
            _construct_provider(registry, provider_id, google_maps_factory, overpass_factory),
            profiler=profiler,
            total_stage=f"{provider_id}_provider_total",
        )
        for provider_id in configuration.providers
    ]
    composed_provider: DiscoveryProviderInterface
    if len(instances) == 1:
        # Single-provider case: no dedup wrapper. ProviderDeduplicator
        # exists for CROSS-provider identity collisions (Step 5 — see
        # provider_deduplicator.py); with only one provider running,
        # there is no "cross" to dedup against, and wrapping it anyway
        # would be a real behavior change for exactly the single-
        # provider case this phase promises to leave alone (see module
        # docstring, "No behavior change for existing single-provider
        # production callers") — a provider is free to yield candidates
        # that share identity signals (e.g. Overpass venues that share
        # a building) and those are not cross-provider duplicates.
        composed_provider = instances[0]
    else:
        composed_provider = ProviderDeduplicator(
            ParallelCompositeDiscoveryProvider(
                instances,
                continue_on_provider_error=True,
                on_provider_error=_log_provider_error,
            )
        )
    composed_provider = TargetAwareDiscoveryProvider(
        composed_provider, should_stop=should_stop
    )

    if len(selected_ids) == 1:
        # ProviderRegistry.create() returned a bare (deduplicator-
        # wrapped) single provider for the single-selection case — see
        # that method's own docstring, point 2 — which expects its own
        # bare request, not a {provider_id: request} mapping.
        composed_request: Any = translated_requests[selected_ids[0]]
    else:
        composed_request = ParallelDiscoveryRequest(requests=translated_requests)

    return ComposedDiscovery(
        provider=composed_provider,
        request=composed_request,
        selected_provider_ids=tuple(selected_ids),
    )


def _construct_provider(
    registry,
    provider_id: str,
    google_maps_factory: Optional[Callable[[], DiscoveryProviderInterface]],
    overpass_factory: Optional[Callable[[], DiscoveryProviderInterface]] = None,
) -> DiscoveryProviderInterface:
    """
    Construct one provider instance for composition.

    Delegates to `registry.get(provider_id)` for every provider —
    except `google_maps` when a `google_maps_factory` override was
    given, or `overpass` when an `overpass_factory` override was given
    (PHASE 2B addition, same reasoning), either of which is called
    directly instead, bypassing `ProviderRegistry`'s own
    `isinstance(..., DiscoveryProviderInterface)` construction check.

    Why this bypass is necessary (and only for these two cases): the
    pre-existing test seam this override exists to preserve (see
    `compose_discovery()`'s own docstring and
    `build_production_registry()`'s) substitutes a plain duck-typed
    fake — e.g. `tests/test_run_query_target_reached_lifecycle.py`'s
    `_CountingFakeProvider`, deliberately not a
    `DiscoveryProviderInterface` subclass, matching exactly what
    `service.py` accepted before this phase (a bare
    `provider.discover(request)` call, no isinstance check anywhere).
    Composition is therefore assembled directly here (mirroring
    `ProviderRegistry.create()`'s own single/parallel + dedup logic
    exactly — see that method) instead of calling `registry.create()`,
    so this one test-only relaxation never has to be added to
    `ProviderRegistry` itself.
    """
    if provider_id == "google_maps" and google_maps_factory is not None:
        return google_maps_factory()
    if provider_id == "overpass" and overpass_factory is not None:
        return overpass_factory()
    return registry.get(provider_id)


def _env_var_hint(provider_id: str) -> str:
    from providers.production_registry import credential_env_var

    return credential_env_var(provider_id) or "n/a"
