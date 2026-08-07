"""
MAST Engine V2 — CompositeDiscoveryProvider
==============================================

Source: this milestone's own instructions ("Build the Provider
Ecosystem on top of [Engine 2.0]"), engine/interfaces.py
(DiscoveryProviderInterface), engine/contracts.py (BusinessCandidate),
and the two existing concrete providers this composes,
providers/google_maps_provider.py (GoogleMapsProvider) and
providers/yelp_provider.py (YelpProvider) — read for precedent, not
modified.

Responsibility
--------------
CompositeDiscoveryProvider has exactly one job: hold an ordered
collection of other DiscoveryProviderInterface instances and present
them to the Engine as a single DiscoveryProviderInterface. It does not
discover anything itself — every BusinessCandidate it yields was
produced, unmodified, by one of the wrapped providers. Like every other
provider in this layer, it does not enrich, qualify, score, store,
deduplicate, retry, cache, allocate workers, or own queues.

This is composition, not a new discovery source. The Engine holds one
DiscoveryProviderInterface reference whether that reference is a bare
GoogleMapsProvider, a bare YelpProvider, or a CompositeDiscoveryProvider
wrapping five of each — the Engine cannot tell the difference, and
nothing about the Engine changes to make that true.

Architecture review (performed before writing any code)
----------------------------------------------------------------------
Reviewed: DiscoveryProviderInterface (engine/interfaces.py),
BusinessCandidate (engine/contracts.py), GoogleMapsProvider,
YelpProvider, and providers/__init__.py.

Finding: no architectural contradiction exists. This can be built
entirely at the provider/composition layer, for three reasons:

1. DiscoveryProviderInterface's contract is exactly the shape a
   composite needs to both consume and produce. It asks for
   `provider_id`, `display_name`, and a `discover(request) ->
   Iterator[BusinessCandidate]` that streams rather than materializes.
   A CompositeDiscoveryProvider can satisfy that contract on its own
   output side by construction, and can consume it on the input side
   because every wrapped provider already satisfies the identical
   contract — there is nothing composition needs that the interface
   doesn't already provide, and nothing the interface promises that
   composition would violate.

2. `request: Any` is already deliberately unconstrained (see
   engine/interfaces.py's own note: "inventing it here would be an
   architecture decision this milestone is not authorized to make").
   GoogleMapsProvider and YelpProvider have each already exercised
   that freedom by defining their own provider-local request dataclass
   (GoogleMapsDiscoveryRequest, YelpDiscoveryRequest — see Ambiguity 3
   in google_maps_provider.py). CompositeDiscoveryRequest below is the
   same move a third time, not a new kind of move: a provider-local
   request shape, owned entirely by this file, that the Engine never
   needs to know exists (it just passes whatever `request` object the
   caller constructed through to `discover()`, exactly as it already
   does for every other provider).

3. Streaming, statelessness, and "never mutate a BusinessCandidate" are
   all preservable by a pure orchestration layer: iterate wrapped
   providers, iterate each one's own generator, yield what it yields.
   No buffering of a full result set is required at any point.

Nothing under engine/, workers/, queues/, or models/ needs to change,
be read differently, or be reinterpreted for this to work. The Engine
requires zero architectural changes — see validate_composite_provider.py
for the concrete demonstration.

Design decisions made at this layer (flagged per this project's
"stop and ask, don't guess" convention, called out rather than
resolved silently)
----------------------------------------------------------------------
1. Request shape: per-provider mapping, not a single shared request.
   GoogleMapsDiscoveryRequest and YelpDiscoveryRequest are different,
   incompatible shapes (query/city/country/... vs. term/location/
   categories/...) because the two providers wrap fundamentally
   different sources. A composite cannot invent a single request shape
   that means the same thing to both without either (a) inventing a
   new shared engine/contracts.py-level discovery-request contract —
   explicitly out of scope for every provider so far, per Ambiguity 3
   in google_maps_provider.py — or (b) silently picking one provider's
   shape and forcing the other to conform, which would be putting
   business logic about *how to translate a Yelp search into a Google
   Maps search* into the composite, which is not this layer's job.
   CompositeDiscoveryRequest instead carries a `{provider_id:
   provider_specific_request}` mapping: each wrapped provider gets
   exactly the request shape it already defines for itself, unchanged.
   The composite never inspects or interprets the contents of any
   individual request — it only routes.

2. Streaming order: sequential by provider, in construction order; not
   interleaved/round-robin. `discover()` fully drains provider[0]'s
   generator before advancing to provider[1], and so on. This was
   chosen over round-robin interleaving because interleaving would
   require holding open N live generators simultaneously and stepping
   between them, which is a legitimate design (and one a future
   milestone could add) but is additional orchestration complexity
   this milestone's scope ("this milestone only composes providers")
   does not ask for. Sequential draining is the simplest composition
   that still satisfies every hard requirement: it never materializes
   a full result set (each provider's own generator is still stepped
   one item at a time), and it is fully deterministic and easy to
   reason about for validation ("streaming order" below tests exactly
   this: all of provider A's candidates, in provider A's own order,
   before any of provider B's).

3. Error handling policy. Every provider built so far (GoogleMapsProvider,
   YelpProvider) already follows the same rule: a failure raised while
   driving the underlying source propagates unchanged, uncaught, out of
   `discover()`. Today, with exactly one provider wired into the
   Engine, that means "one provider fails" and "discovery for this
   request halts" are the same event — the Engine already has to
   handle a discovery-provider exception ending the stream early. A
   composite with several wrapped providers changes the *number* of
   providers.py

   Two honest options here:
     (a) Strict (propagate immediately): the first provider that
         raises ends the composite's stream immediately, exactly
         mirroring today's single-provider behavior — from the
         Engine's point of view, a composite provider failing looks
         identical to a single provider failing, so nothing downstream
         needs new failure-handling logic to accommodate composition.
     (b) Best-effort (catch, log/skip, continue with the next
         provider): one bad provider doesn't prevent candidates from
         providers that still work.
   (b) is tempting but is a real behavior change relative to every
   provider written so far — it would mean the composite silently
   swallows an exception that an equivalent single-provider caller
   would have seen. Swallowing errors is not this milestone's call to
   make silently, and "consistent with the current architecture" reads
   as (a): today, a provider failure is never hidden from the caller.
   So (a) is the default. To avoid forcing a hard, single-provider-wide
   design decision on every caller, `__init__` accepts an opt-in
   `continue_on_provider_error: bool = False` flag: when left at its
   default, behavior is byte-for-byte consistent with "a provider
   failure ends discovery," matching today's architecture exactly; a
   caller that explicitly wants best-effort composition (accepting
   partial results from a partially-failed composite) can opt in
   per-instance. Nothing about this flag is visible to or required by
   the Engine — it is a construction-time choice made by whoever
   assembles the composite, same as choosing which providers to wrap
   in the first place. When a provider fails, the composite itself is
   never left holding a corrupted or partially-mutated candidate: no
   BusinessCandidate is ever touched by this file, so there is nothing
   to corrupt — the only thing an error can affect is whether the
   *stream* continues.

Status
------
Provider Ecosystem milestone. Composes existing
DiscoveryProviderInterface implementations; does not add a new
discovery source, does not touch scraper/, engine/, workers/, queues/,
or models/, and does not modify GoogleMapsProvider, YelpProvider, or
any other provider.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Iterable, Iterator, Mapping

from engine.contracts import BusinessCandidate
from engine.interfaces import DiscoveryProviderInterface


# ---------------------------------------------------------------------------
# Request shape (provider-local — see Design Decision 1 above)
# ---------------------------------------------------------------------------
@dataclass(frozen=True, slots=True)
class CompositeDiscoveryRequest:
    """
    This provider's own accepted request shape. Not a shared
    engine/contracts.py contract — same reasoning as
    GoogleMapsDiscoveryRequest / YelpDiscoveryRequest (see
    google_maps_provider.py, Ambiguity 3).

    `requests` maps each wrapped provider's `provider_id` to that
    provider's own request object, unchanged and uninterpreted —
    whatever `GoogleMapsDiscoveryRequest(...)`, `YelpDiscoveryRequest(...)`,
    or any future provider's request type looks like is passed through
    verbatim to that provider's own `discover()`. The composite never
    reads, validates, or reshapes the contents of any entry.

    A provider_id present on the CompositeDiscoveryProvider but absent
    from `requests` is a caller error (there is no such thing as a
    default or inferred request for a provider the composite knows
    nothing about how to query) and raises ValueError at discovery
    time — see CompositeDiscoveryProvider.discover().
    """

    requests: Mapping[str, Any] = field(default_factory=dict)


class CompositeDiscoveryProvider(DiscoveryProviderInterface):
    """
    Wraps an arbitrary, ordered collection of DiscoveryProviderInterface
    instances and presents them to the Engine as a single
    DiscoveryProviderInterface. See module docstring for the full
    architecture review and design decisions.

    Stateless, like every other provider in this layer: the wrapped
    providers themselves are held (they are the caller's already-
    constructed instances, not rebuilt here), but this class owns no
    mutable runtime state, queue, worker, or session of its own, and
    every `discover()` call is independent of every other.
    """

    def __init__(
        self,
        providers: Iterable[DiscoveryProviderInterface],
        *,
        provider_id: str = "composite",
        display_name: str = "Composite",
        continue_on_provider_error: bool = False,
    ) -> None:
        """
        `providers` — an arbitrary collection of already-constructed
        DiscoveryProviderInterface instances, e.g. a mix of
        GoogleMapsProvider and YelpProvider instances, or any future
        provider satisfying the same interface. Order is preserved
        (materialized into a tuple here) and is exactly the order
        `discover()` drains them in — see Design Decision 2.

        `provider_id` / `display_name` — this composite's own identity,
        exposed to whatever registers/selects providers, distinct from
        any wrapped provider's identity. Defaulted so a caller who
        doesn't care can just wrap providers and go; overridable for a
        caller who wants a more specific composite identity (e.g.
        "google_maps_and_yelp").

        `continue_on_provider_error` — see Design Decision 3 above.
        Defaults to False (strict propagation, matching every existing
        provider's behavior exactly).

        Raises ValueError if `providers` is empty or contains duplicate
        provider_id values — both are caller-configuration errors this
        constructor can and should catch immediately rather than
        deferring to a confusing failure inside discover().
        """
        providers = tuple(providers)
        if not providers:
            raise ValueError(
                "CompositeDiscoveryProvider requires at least one wrapped "
                "provider."
            )
        seen_ids: set[str] = set()
        for p in providers:
            if p.provider_id in seen_ids:
                raise ValueError(
                    f"Duplicate provider_id {p.provider_id!r} among wrapped "
                    "providers — each wrapped provider must have a unique "
                    "provider_id."
                )
            seen_ids.add(p.provider_id)

        self._providers: tuple[DiscoveryProviderInterface, ...] = providers
        self._provider_id = provider_id
        self._display_name = display_name
        self._continue_on_provider_error = continue_on_provider_error

    @property
    def provider_id(self) -> str:
        return self._provider_id

    @property
    def display_name(self) -> str:
        return self._display_name

    @property
    def providers(self) -> tuple[DiscoveryProviderInterface, ...]:
        """
        Read-only view of the wrapped providers, in the order they'll
        be drained. Exposed for introspection/testing (e.g. provider
        substitution validation); the composite itself never mutates
        this tuple after construction.
        """
        return self._providers

    def discover(self, request: CompositeDiscoveryRequest) -> Iterator[BusinessCandidate]:
        """
        Streams BusinessCandidate objects by draining each wrapped
        provider's own `discover()` in turn, in construction order
        (Design Decision 2). No BusinessCandidate is inspected,
        modified, deduplicated, or reordered — each one is yielded
        exactly as its originating provider produced it.

        For each provider, looks up that provider's own request from
        `request.requests[provider.provider_id]`. A missing entry
        raises ValueError immediately (before that provider is touched)
        — a caller-configuration error, not a provider failure.

        Error handling: see Design Decision 3. By default
        (`continue_on_provider_error=False`), the first exception
        raised by any wrapped provider propagates immediately and ends
        the composite's stream, exactly as a single provider's failure
        already ends discovery today. When `continue_on_provider_error=True`,
        an exception from one provider is swallowed and the composite
        moves on to the next wrapped provider, so a caller who opted
        into that mode still receives every candidate the *other*
        providers were able to produce.
        """
        for provider in self._providers:
            if provider.provider_id not in request.requests:
                raise ValueError(
                    f"CompositeDiscoveryRequest has no request entry for "
                    f"wrapped provider {provider.provider_id!r} "
                    f"({provider.display_name})."
                )
            provider_request = request.requests[provider.provider_id]

            if not self._continue_on_provider_error:
                yield from provider.discover(provider_request)
                continue

            # Best-effort mode: isolate this provider's failure from the
            # rest of the composite. A generator's exception can only be
            # observed by stepping it, so we drive it manually here
            # instead of using a plain `for` loop / `yield from`, which
            # would let an exception raised mid-stream propagate past
            # this try/except before reaching the caller.
            provider_iter = provider.discover(provider_request)
            while True:
                try:
                    candidate = next(provider_iter)
                except StopIteration:
                    break
                except Exception:
                    # This provider is done for this discover() call;
                    # move on to the next wrapped provider. Candidates
                    # already yielded from this provider earlier in the
                    # loop were already handed to the caller and are
                    # unaffected.
                    break
                yield candidate
