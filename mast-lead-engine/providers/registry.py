"""
MAST Engine V2 — ProviderRegistry
====================================

Source: this milestone's own instructions ("build the Provider
Registry"), engine/interfaces.py (DiscoveryProviderInterface),
providers/google_maps_provider.py, providers/yelp_provider.py, and
providers/composite_provider.py — read for precedent, not modified.

Responsibility
--------------
ProviderRegistry is the single source of truth for which discovery
providers exist, how to build them, and what their identity is. It
owns registration and construction. It does not discover anything
itself, does not enrich, qualify, score, store, deduplicate, retry,
cache, or own queues — same boundary every other file in this package
already respects.

The Engine never sees this class. It holds a bare
DiscoveryProviderInterface reference exactly as it already does today
— the registry is a construction-time convenience for whoever
assembles that reference (a caller, a config file, a CLI, a future
DiscoverySession), not a runtime dependency of the Engine itself. See
this milestone's architecture review (delivered alongside this file)
for the full reasoning on why this fits entirely inside providers/
with zero changes to engine/, workers/, queues/, or models/.

Design: registration is a factory, not an instance
----------------------------------------------------
`register()` takes a zero-argument `factory: Callable[[],
DiscoveryProviderInterface]`, not a pre-built provider instance. This
mirrors the real shape of the two existing providers:

    - GoogleMapsProvider() takes no constructor arguments.
    - YelpProvider(api_key=..., http_get=...) requires credentials
      (and optionally a transport) the registry has no business
      sourcing itself (see yelp_provider.py: "credential management
      belongs to whoever configures the provider, not to the provider
      itself").

A registry that stored pre-built instances would force every caller
to construct every provider up front, at registration time, whether
or not that provider is ever actually used in a given `build()` call
— including paying for a YelpProvider's credential wiring even when a
caller only ever wants GoogleMapsProvider. Storing a factory instead
defers construction to the moment a provider is actually requested
(`get()`, `build()`, `build_all()`), which is also the only point at
which construction failure (e.g. a missing API key) is a caller's
problem to see, not the registry's problem to hide behind a batch of
unrelated registrations.

Design: what "validate registrations" means here
----------------------------------------------------
`register()` validates the things a registry can check without
running a provider's constructor:

    - `provider_id` is a non-empty string.
    - `factory` is callable.
    - `provider_id` is not already registered (see "duplicate
      detection" below).

It deliberately does NOT call `factory()` at registration time to
verify the result is a `DiscoveryProviderInterface` instance. Doing so
would mean every `register()` call pays the cost (and risk) of a real
construction — for YelpProvider, that's fine (a bearer-token attach,
no network call), but nothing about `register()`'s contract can assume
every future provider's constructor is equally cheap or side-effect
free, and a registry deciding that up front would be inventing a
constraint on provider constructors this milestone has no authority
to impose. Instead, type-correctness is validated lazily, exactly
once, the first time a given registration is actually built (`get()`,
`build()`, `build_all()`) — `_construct()` below raises `TypeError`
immediately if a factory's return value is not a
`DiscoveryProviderInterface`, before that value is ever handed to a
caller or wrapped in a composite.

Design: duplicate detection only — no dedup, no plugin discovery,
no metrics
----------------------------------------------------
Per this milestone's explicit instructions: `register()` rejects a
second registration under an already-used `provider_id` (raises
`ValueError`). This is identity-collision prevention, not the kind of
business-level deduplication `google_maps_provider.py`'s Ambiguity 1
explicitly scoped out of the provider layer (that's about duplicate
*businesses*, a Qualification/Storage concern; this is about duplicate
*provider registrations*, a registry concern — unrelated). Likewise,
no plugin auto-discovery (e.g. scanning a directory for provider
modules) and no runtime metrics (call counts, latencies, health) are
implemented here — both are explicitly out of scope per this
milestone's instructions and are left for a future milestone once
their shape is actually needed.

Design: build() always returns a CompositeDiscoveryProvider
----------------------------------------------------
`build(provider_ids)` — including the single-id case — always wraps
its result in `CompositeDiscoveryProvider`, never returns a bare
provider. The alternative (returning a bare provider when exactly one
id is requested) would make `build()`'s return type conditional on how
many ids were passed, for no behavioral benefit: both a bare provider
and a one-provider composite already satisfy
`DiscoveryProviderInterface` identically, and
`CompositeDiscoveryProvider.providers` already exposes the wrapped
tuple for introspection regardless of length. Uniform return type wins
over saving one object allocation. `build_all()` is defined purely in
terms of `build()` — `build(self.provider_ids())` — so it gains
nothing extra and needs no separate logic to stay correct as new
providers are registered.

Status
------
Provider Registry milestone. Adds registration/construction on top of
the existing, unmodified Provider Layer (DiscoveryProviderInterface,
GoogleMapsProvider, YelpProvider, CompositeDiscoveryProvider). Nothing
under engine/, workers/, queues/, or models/ is read differently or
modified to make this work.

Provider Configuration & Selection milestone update: ProviderRegistry
gains one new public method, `create(configuration)` (see that
method's own docstring below), which is now the registry's
composition root — the single place a ProviderConfiguration (see
providers/provider_configuration.py) is turned into a live
DiscoveryProviderInterface, composing CompositeDiscoveryProvider,
ParallelCompositeDiscoveryProvider, and ProviderDeduplicator as
needed. `register()`, `get()`, `build()`, and `build_all()` are
unmodified by this addition. The Engine remains completely unaware
any of this exists — it still only ever holds a bare
DiscoveryProviderInterface reference.

Provider Metadata milestone update: the registry's own previous,
identity-only `ProviderMetadata` (provider_id + display_name) is
replaced by the richer, shared `ProviderMetadata` now defined in
providers/provider_metadata.py (description, provider_type,
requires_api_key, default_enabled, homepage, version, in addition to
provider_id/display_name). `register()` gains an optional `metadata`
keyword — the registry stores exactly the ProviderMetadata it is
given (typically obtained from the provider's own `metadata()`
classmethod, e.g. `GoogleMapsProvider.metadata()`), rather than
constructing or guessing any of it itself; this is the "avoid
duplicate sources of truth" requirement. `metadata()` and the new
`metadata_all()` (aliased by the now-deprecated `list_metadata()`)
are unchanged in spirit — still no construction required — but now
return the richer shape. `get()`, `build()`, `build_all()`, `create()`,
and provider construction generally are entirely unmodified by this
milestone. The Engine remains completely unaware metadata exists.

Provider Capabilities milestone update: `register()` gains a second,
independent optional keyword, `capabilities` — a provider's own
ProviderCapabilities (providers/provider_capabilities.py), describing
functionality (what a provider's discover() can be asked to do), not
identity (that remains `metadata`'s job). Stored exactly as given, at
registration time, via the same "avoid duplicate sources of truth"
rule metadata already follows — never derived from a constructed
instance. Two new read methods, `capabilities(provider_id)` and
`capabilities_all()`, mirror `metadata()` / `metadata_all()` exactly:
no provider is constructed to answer either. `register()`'s existing
`metadata` keyword, `get()`, `build()`, `build_all()`, `create()`, and
provider construction generally are entirely unmodified by this
milestone. The Engine remains completely unaware capabilities exist.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Callable, Mapping, Optional, Sequence

from engine.interfaces import DiscoveryProviderInterface
from providers.composite_provider import CompositeDiscoveryProvider
from providers.parallel_composite_provider import ParallelCompositeDiscoveryProvider
from providers.provider_configuration import ProviderConfiguration
from providers.provider_capabilities import ProviderCapabilities
from providers.provider_deduplicator import ProviderDeduplicator
from providers.provider_metadata import ProviderMetadata


class ProviderRegistry:
    """
    Single source of truth for discovery-provider registration,
    metadata, lookup, and composite construction. See module docstring
    for the full design rationale.

    Stateful by necessity (it holds the registration table), but that
    state is purely configuration — which providers exist and how to
    build them — not runtime/discovery state. It never holds a
    constructed provider instance across calls; every `get()` /
    `build()` / `build_all()` call constructs fresh via the stored
    factory, matching every provider's own "stateless, freshly
    constructed per use" pattern (see GoogleMapsProvider and
    YelpProvider docstrings).
    """

    def __init__(self) -> None:
        self._factories: dict[str, Callable[[], DiscoveryProviderInterface]] = {}
        self._metadata: dict[str, ProviderMetadata] = {}
        self._capabilities: dict[str, ProviderCapabilities] = {}

    # ------------------------------------------------------------------
    # Registration
    # ------------------------------------------------------------------
    def register(
        self,
        provider_id: str,
        factory: Callable[[], DiscoveryProviderInterface],
        *,
        metadata: Optional[ProviderMetadata] = None,
        display_name: Optional[str] = None,
        capabilities: Optional[ProviderCapabilities] = None,
    ) -> None:
        """
        Register `factory` under `provider_id`. `factory` is called
        with no arguments each time this registration is built — see
        module docstring, "registration is a factory, not an
        instance."

        `metadata` is this provider's own ProviderMetadata (see
        providers/provider_metadata.py) — the registry stores exactly
        what it is given here rather than deriving or inventing any
        of it, per this milestone's "avoid duplicate sources of truth"
        instruction. The caller obtains it from the provider itself,
        independent of construction — e.g.
        `registry.register("google_maps", GoogleMapsProvider,
        metadata=GoogleMapsProvider.metadata())`. Because `metadata`
        is read here, at registration time, rather than by calling
        `factory()`, a provider whose construction is expensive or
        requires credentials (YelpProvider) is never constructed just
        to answer "what is this provider" — see `metadata()` below,
        "Metadata lookup must be independent of provider construction."

        `display_name` is a narrower, backward-compatible convenience
        for a caller that has no full ProviderMetadata to hand and
        only wants to set a human-readable name (e.g. quick manual
        registrations, tests). It is used only when `metadata` is
        omitted, to build a minimal ProviderMetadata whose other
        fields fall back to this class's own defaults. When both are
        omitted, `display_name` itself falls back to `provider_id`.
        Only one metadata record is ever stored per registration —
        passing both `metadata` and `display_name` uses `metadata` and
        ignores `display_name`, so there is exactly one source of
        truth per provider, never two competing ones.

        `capabilities` is this provider's own ProviderCapabilities (see
        providers/provider_capabilities.py) — same "avoid duplicate
        sources of truth" rule as `metadata`: the registry stores
        exactly what it is given here, obtained from the provider
        itself, independent of construction — e.g.
        `registry.register("google_maps", GoogleMapsProvider,
        metadata=GoogleMapsProvider.metadata(),
        capabilities=GoogleMapsProvider.capabilities())`. When omitted,
        a default `ProviderCapabilities()` (every flag False) is
        stored rather than guessing what a provider supports —
        capabilities, unlike `display_name`, has no honest
        provider-identity-derived fallback, so an omitted value means
        "unknown/unspecified," never "assumed to support everything"
        or "assumed to support nothing has been claimed."
        ProviderCapabilities carries no `provider_id` field (it
        describes functionality, not identity — see
        provider_capabilities.py), so there is no identity-mismatch
        check to perform here, unlike `metadata`.

        Raises:
            ValueError: `provider_id` is empty, already registered, or
                `metadata.provider_id` (if `metadata` is given) does
                not match `provider_id`.
            TypeError: `factory` is not callable.
        """
        if not isinstance(provider_id, str) or not provider_id:
            raise ValueError("provider_id must be a non-empty string.")
        if not callable(factory):
            raise TypeError(f"factory for {provider_id!r} must be callable.")
        if provider_id in self._factories:
            raise ValueError(
                f"provider_id {provider_id!r} is already registered — "
                "duplicate provider_ids are not allowed."
            )
        if metadata is not None and metadata.provider_id != provider_id:
            raise ValueError(
                f"metadata.provider_id {metadata.provider_id!r} does not "
                f"match the registration key {provider_id!r} — a "
                "provider's declared identity and its registration key "
                "must agree."
            )

        self._factories[provider_id] = factory
        self._metadata[provider_id] = metadata or ProviderMetadata(
            provider_id=provider_id,
            display_name=display_name or provider_id,
        )
        self._capabilities[provider_id] = capabilities or ProviderCapabilities()

    def is_registered(self, provider_id: str) -> bool:
        return provider_id in self._factories

    # ------------------------------------------------------------------
    # Metadata (no construction required)
    # ------------------------------------------------------------------
    def metadata(self, provider_id: str) -> ProviderMetadata:
        """
        Return this provider's own ProviderMetadata, exactly as given
        at registration time (see `register()`) — never derived from a
        constructed instance, so this never calls `factory()`.
        Metadata lookup is therefore independent of provider
        construction: it works identically whether or not the
        provider has ever been built via `get()` / `build()` /
        `build_all()` / `create()`, and whether or not the provider's
        own constructor requires credentials (e.g. YelpProvider) or
        could even succeed in the caller's current environment.

        Raises KeyError if `provider_id` is not registered.
        """
        self._require_registered(provider_id)
        return self._metadata[provider_id]

    def metadata_all(self) -> tuple[ProviderMetadata, ...]:
        """
        ProviderMetadata for every registered provider, in
        registration order. Same construction-independence guarantee
        as `metadata()` — no provider is built to produce this list.
        """
        return tuple(self._metadata[pid] for pid in self._factories)

    def list_metadata(self) -> tuple[ProviderMetadata, ...]:
        """
        Deprecated alias for `metadata_all()`, kept so any existing
        caller of the pre-Provider-Metadata-milestone name keeps
        working unchanged. New callers should use `metadata_all()`.
        """
        return self.metadata_all()

    # ------------------------------------------------------------------
    # Capabilities (no construction required)
    # ------------------------------------------------------------------
    def capabilities(self, provider_id: str) -> ProviderCapabilities:
        """
        Return this provider's own ProviderCapabilities, exactly as
        given at registration time (see `register()`) — never derived
        from a constructed instance, so this never calls `factory()`.
        Capabilities lookup is therefore independent of provider
        construction, for exactly the same reason `metadata()` above
        is: it works identically whether or not the provider has ever
        been built via `get()` / `build()` / `build_all()` / `create()`,
        and whether or not the provider's own constructor requires
        credentials (e.g. YelpProvider) or could even succeed in the
        caller's current environment.

        Raises KeyError if `provider_id` is not registered.
        """
        self._require_registered(provider_id)
        return self._capabilities[provider_id]

    def capabilities_all(self) -> Mapping[str, ProviderCapabilities]:
        """
        ProviderCapabilities for every registered provider, keyed by
        provider_id. Same construction-independence guarantee as
        `capabilities()` — no provider is built to produce this
        mapping. Keyed (unlike `metadata_all()`'s plain tuple) because
        a caller comparing capabilities across providers typically
        wants to look one up by id, not just iterate them in
        registration order; nothing here prevents a caller from doing
        `tuple(registry.capabilities_all().values())` if positional
        order is what they actually want instead.
        """
        return {pid: self._capabilities[pid] for pid in self._factories}

    def provider_ids(self) -> tuple[str, ...]:
        """Every registered provider_id, in registration order."""
        return tuple(self._factories.keys())

    # ------------------------------------------------------------------
    # Construction — single provider
    # ------------------------------------------------------------------
    def get(self, provider_id: str) -> DiscoveryProviderInterface:
        """
        Build and return a fresh instance of the provider registered
        under `provider_id`. Raises KeyError if not registered;
        TypeError if the registered factory does not return a
        DiscoveryProviderInterface (see module docstring, "what
        'validate registrations' means here").
        """
        self._require_registered(provider_id)
        return self._construct(provider_id)

    def all(self) -> tuple[DiscoveryProviderInterface, ...]:
        """Build and return a fresh instance of every registered provider."""
        return tuple(self._construct(pid) for pid in self._factories)

    # ------------------------------------------------------------------
    # Construction — composite
    # ------------------------------------------------------------------
    def build(self, provider_ids: Sequence[str]) -> CompositeDiscoveryProvider:
        """
        Build a CompositeDiscoveryProvider wrapping fresh instances of
        each provider named in `provider_ids`, in the given order.
        Always returns a composite, even for a single id — see module
        docstring, "build() always returns a CompositeDiscoveryProvider."

        Raises:
            ValueError: `provider_ids` is empty (delegated to
                CompositeDiscoveryProvider's own constructor guard).
            KeyError: any id in `provider_ids` is not registered.
            TypeError: any registered factory does not return a
                DiscoveryProviderInterface.
        """
        instances = [self.get(pid) for pid in provider_ids]
        return CompositeDiscoveryProvider(instances)

    def build_all(self) -> CompositeDiscoveryProvider:
        """
        Build a CompositeDiscoveryProvider wrapping every registered
        provider, in registration order. Defined purely in terms of
        `build()` — see module docstring.
        """
        return self.build(self.provider_ids())

    # ------------------------------------------------------------------
    # Composition root — Provider Configuration & Selection milestone
    # ------------------------------------------------------------------
    def create(self, configuration: ProviderConfiguration) -> DiscoveryProviderInterface:
        """
        The single public entry point for turning a declarative
        ProviderConfiguration (see provider_configuration.py) into a
        live DiscoveryProviderInterface. This is the composition root
        for the whole provider layer: a caller (eventually a
        DiscoverySession) hands this one configuration object and gets
        back exactly one DiscoveryProviderInterface — never assembling
        CompositeDiscoveryProvider, ParallelCompositeDiscoveryProvider,
        or ProviderDeduplicator by hand.

        Composition rules, applied in order:

            1. Construct a fresh instance of every provider named in
               `configuration.providers`, via `self.get()` — same
               construction path, same lazy type-validation, same
               KeyError-on-unregistered-id behavior as every other
               lookup method on this registry.
            2. If exactly one provider was selected, that bare
               instance is the base provider — no composite wrapper is
               introduced for a single selection. (This is a
               deliberate, narrower rule than `build()`'s "always
               wrap, even for one" — `build()` is a general-purpose
               "give me a composite of these ids" utility with a
               uniform return type; `create()` is answering this
               milestone's own explicit menu of outcomes — "single
               provider, or CompositeDiscoveryProvider, or
               ParallelCompositeDiscoveryProvider" — where the
               single-provider case is a distinct, first-class
               outcome, not a one-element composite. Both are valid,
               independent design choices for two different methods
               with two different callers in mind; neither depends on
               or conflicts with the other.)
            3. If more than one provider was selected,
               `configuration.parallel` decides the composition:
               `True` -> ParallelCompositeDiscoveryProvider,
               `False` (default) -> CompositeDiscoveryProvider. Both
               are constructed with their own default
               `continue_on_provider_error=False` — this milestone
               does not add a configuration knob for that; a caller
               wanting best-effort composition still has the
               constructors themselves available directly, unchanged.
            4. If `configuration.deduplicate` is True, the provider
               produced by steps 2-3 (bare or composite, either is
               valid — see provider_deduplicator.py) is wrapped in a
               ProviderDeduplicator before being returned.

        The result is always a single DiscoveryProviderInterface
        value. The caller — including the Engine, if this is ever
        threaded that far up — cannot tell from the returned object
        alone how many providers were selected, whether they ran in
        parallel, or whether deduplication is active; it is just
        another DiscoveryProviderInterface to iterate.

        Raises:
            KeyError: any id in `configuration.providers` is not
                registered (via `self.get()`).
            TypeError: any registered factory does not return a
                DiscoveryProviderInterface (via `self.get()`).
        """
        instances = [self.get(pid) for pid in configuration.providers]

        provider: DiscoveryProviderInterface
        if len(instances) == 1:
            provider = instances[0]
        elif configuration.parallel:
            provider = ParallelCompositeDiscoveryProvider(instances)
        else:
            provider = CompositeDiscoveryProvider(instances)

        if configuration.deduplicate:
            provider = ProviderDeduplicator(provider)

        return provider

    # ------------------------------------------------------------------
    # Internal
    # ------------------------------------------------------------------
    def _require_registered(self, provider_id: str) -> None:
        if provider_id not in self._factories:
            raise KeyError(
                f"No provider registered under provider_id {provider_id!r}. "
                f"Registered ids: {self.provider_ids()!r}"
            )

    def _construct(self, provider_id: str) -> DiscoveryProviderInterface:
        instance = self._factories[provider_id]()
        if not isinstance(instance, DiscoveryProviderInterface):
            raise TypeError(
                f"factory registered under {provider_id!r} returned "
                f"{type(instance)!r}, which does not implement "
                "DiscoveryProviderInterface."
            )
        # A provider's own `.provider_id` is authoritative and must
        # match the key it was registered under — a mismatch here is a
        # caller-configuration error (e.g. registering GoogleMapsProvider
        # under the key "yelp"), not a runtime provider failure.
        if instance.provider_id != provider_id:
            raise TypeError(
                f"Provider registered under {provider_id!r} constructed "
                f"an instance whose own provider_id is "
                f"{instance.provider_id!r} — registration key and "
                "provider identity must match."
            )
        return instance
