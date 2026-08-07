"""
MAST Engine V2 — ProviderConfiguration
=========================================

Source: this milestone's own instructions ("implement Provider
Configuration & Selection"), and the existing provider layer this sits
beside — providers/registry.py (ProviderRegistry, whose docstring
already anticipates configuration/selection as the next milestone),
providers/composite_provider.py (CompositeDiscoveryProvider),
providers/parallel_composite_provider.py
(ParallelCompositeDiscoveryProvider), and
providers/provider_deduplicator.py (ProviderDeduplicator) — all read
for precedent, none modified by this file.

Responsibility
--------------
ProviderConfiguration has exactly one job: describe, declaratively,
which providers a caller wants and how they should be run — which
provider_ids, sequential vs. parallel execution, and whether
cross-provider deduplication is on. It is pure data. It does not
construct a provider, does not know how to look a provider_id up, does
not import CompositeDiscoveryProvider / ParallelCompositeDiscoveryProvider
/ ProviderDeduplicator, and does not talk to ProviderRegistry. Turning
a ProviderConfiguration into a live DiscoveryProviderInterface is
ProviderRegistry.create()'s job (see registry.py) — same separation
GoogleMapsDiscoveryRequest already draws between "describe a discovery
request" (data, provider-local) and "execute it"
(GoogleMapsProvider.discover(), a different class entirely).

Why this is safe to add without touching engine/, workers/, queues/,
or models/
----------------------------------------------------------------------
ProviderConfiguration never appears in any DiscoveryProviderInterface
signature. It is a construction-time input to ProviderRegistry.create()
only — the composition root, not the Engine. The Engine still never
sees a ProviderConfiguration, a provider_id list, a parallel flag, or a
deduplicate flag; it only ever receives whatever
DiscoveryProviderInterface ProviderRegistry.create() hands back. This
is the same "the Engine cannot tell the difference" property
CompositeDiscoveryProvider's own review already established for
composition, and ParallelCompositeDiscoveryProvider's review re-
confirmed for concurrency — configuration is a third case of the same
property, not a new one.

Validation performed here vs. deferred to ProviderRegistry.create()
----------------------------------------------------------------------
This class validates only what can be checked from the configuration's
own data, without a registry to consult:

    - `providers` must be non-empty (a configuration selecting zero
      providers can never produce a usable DiscoveryProviderInterface
      — same reasoning CompositeDiscoveryProvider and
      ParallelCompositeDiscoveryProvider's own constructors already
      apply to their `providers` argument).
    - `providers` must not contain duplicate provider_ids (selecting
      "google_maps" twice is a caller-configuration error, not a
      request for two independent instances — same duplicate-id
      reasoning CompositeDiscoveryProvider / ParallelCompositeDiscoveryProvider
      already apply to their wrapped-instance lists).

It deliberately does NOT validate that every listed provider_id is
actually registered anywhere — a ProviderConfiguration has no registry
reference and no business holding one (it is plain data, constructed
before, independently of, or without ever touching a
ProviderRegistry). That check requires a registry to check against, so
it belongs to `ProviderRegistry.create()`, which raises KeyError for
an unregistered provider_id — exactly how `ProviderRegistry.get()`
already reports the identical error today for a single lookup. See
registry.py:ProviderRegistry.create().

Status
------
Provider Configuration & Selection milestone. Pure data addition;
does not modify CompositeDiscoveryProvider, ParallelCompositeDiscoveryProvider,
ProviderDeduplicator, or any concrete provider. registry.py gains one
new method (`create()`) that consumes this class — see that module's
own updated docstring.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Sequence


@dataclass(frozen=True, slots=True)
class ProviderConfiguration:
    """
    Declarative description of which providers to run and how.

        providers    — provider_ids to select, in the order they
                        should be composed (sequential mode) or
                        started (parallel mode — see
                        ParallelCompositeDiscoveryProvider's own
                        docstring on why construction order carries no
                        streaming-order guarantee there). Must be
                        non-empty and contain no duplicates.
        parallel     — False (default): providers run sequentially,
                        via CompositeDiscoveryProvider semantics.
                        True: providers run concurrently, via
                        ParallelCompositeDiscoveryProvider semantics.
                        Meaningless (and ignored — see
                        ProviderRegistry.create()) when `providers`
                        has exactly one entry, since there is nothing
                        to run sequentially-or-concurrently relative
                        to.
        deduplicate  — False (default): raw output, exactly as the
                        selected provider(s) produced it. True: the
                        composed provider is wrapped in a
                        ProviderDeduplicator before being handed back,
                        exactly as if a caller had wrapped it manually
                        (see provider_deduplicator.py — wrapping a
                        single bare provider is equally valid as
                        wrapping a composite).

    Raises ValueError if `providers` is empty or contains a duplicate
    provider_id — see module docstring, "Validation performed here."
    """

    providers: Sequence[str] = field(default_factory=tuple)
    parallel: bool = False
    deduplicate: bool = False

    def __post_init__(self) -> None:
        # Normalize to a tuple regardless of what was passed in (a
        # list literal, per this milestone's own example usage, or an
        # already-built tuple) — this is the one place a frozen
        # dataclass may reassign a field, via object.__setattr__,
        # specifically to pin down an immutable representation before
        # any validation or downstream consumer (ProviderRegistry.create())
        # ever sees `self.providers`. Mirrors CompositeDiscoveryProvider's
        # own `providers = tuple(providers)` normalization in its
        # constructor.
        object.__setattr__(self, "providers", tuple(self.providers))
        if not self.providers:
            raise ValueError(
                "ProviderConfiguration requires at least one selected "
                "provider_id."
            )
        seen: set[str] = set()
        for provider_id in self.providers:
            if provider_id in seen:
                raise ValueError(
                    f"Duplicate provider_id {provider_id!r} in "
                    "ProviderConfiguration.providers — each selected "
                    "provider_id must be unique."
                )
            seen.add(provider_id)
