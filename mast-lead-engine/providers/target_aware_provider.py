"""
providers/target_aware_provider.py
===================================

MAST — Provider Parallelism v1: Global Target Propagation (Step 7).

Responsibility
--------------
Wrap any DiscoveryProviderInterface (typically the composed result of
`ProviderRegistry.create()` — a bare provider, a
`ParallelCompositeDiscoveryProvider`, a `CompositeDiscoveryProvider`,
or a `ProviderDeduplicator` around any of those) and stop pulling
candidates from it — cooperatively, between items, never mid-item —
once a caller-supplied `should_stop()` callable reports True.

Why this is needed
----------------------------------------------------------------------
Today, exactly one provider (`GoogleMapsProvider`) supports a
cooperative `should_stop` field on its own request dataclass, threaded
all the way down into `MapsScraper.search()`'s scrolling loop — that
is how `service.py`'s `_should_stop_discovery()` (target reached /
shutdown requested) currently stops discovery early for the single-
provider case. None of the other seven providers
(Yelp/AppleMaps/Foursquare/AzureMaps/Overpass/Crunchbase/Apollo)
expose an equivalent hook on their own request dataclasses — each
one's own `discover()` streams whatever its own `limit`/`max_results`
bounds it to, with no mid-call cancellation surface, by design (see
each provider's own module docstring: request shape mirrors the
underlying API's own parameters one-to-one, nothing invented).

Rather than retrofit a `should_stop` field onto seven existing,
already-reviewed request dataclasses (a real behavior change to files
this milestone's own instructions say not to modify), this file adds
the identical cooperative-stop capability at the *composition*
boundary instead — the same "check between items, never assume
mid-item cancellation" discipline `ParallelCompositeDiscoveryProvider`
already uses for its own `stop_event` (see that module's docstring,
"Concurrency design"). `DiscoveryWorker.process()` (workers/
discovery_worker.py, unmodified) already drains whatever provider it
is given with a plain `for candidate in provider.discover(item.request):`
— it has no target-awareness of its own and needs none: once this
wrapper's `discover()` generator stops yielding, that plain for-loop
ends on its own, exactly as if the wrapped provider had naturally
exhausted its own results.

How cancellation actually reaches every active provider
----------------------------------------------------------------------
When `should_stop()` becomes true, this wrapper does not just stop
yielding — it calls `.close()` on the underlying generator before
returning. For a `ParallelCompositeDiscoveryProvider`, closing its
`discover()` generator early delivers `GeneratorExit` at its
suspended `yield`, which runs its own `finally` block: `stop_event.set()`
followed by `join()` on every producer thread (see that module's
docstring, "Clean shutdown"). That is what "cancel all active
providers" actually means for this phase — this wrapper is the
trigger, `ParallelCompositeDiscoveryProvider` (unmodified) is what
carries it out.

Composition
----------------------------------------------------------------------
This wrapper is applied *outermost*, around whatever
`ProviderRegistry.create()` already produced — e.g.:

    TargetAwareDiscoveryProvider(
        ProviderDeduplicator(ParallelCompositeDiscoveryProvider(providers)),
        should_stop=_should_stop_discovery,
    )

exactly the same "wrap a DiscoveryProviderInterface, return a
DiscoveryProviderInterface" pattern `ProviderDeduplicator` and every
composite in this package already establish. No provider,
`CompositeDiscoveryProvider`, `ParallelCompositeDiscoveryProvider`,
`ProviderDeduplicator`, or `ProviderRegistry` is modified to make this
work.

Status
------
Provider Parallelism v1 milestone. Adds cooperative target/shutdown
propagation on top of the existing, unmodified provider layer.
"""

from __future__ import annotations

from typing import Any, Callable, Iterator, Optional

from engine.contracts import BusinessCandidate
from engine.interfaces import DiscoveryProviderInterface


class TargetAwareDiscoveryProvider(DiscoveryProviderInterface):
    """
    Wraps a single DiscoveryProviderInterface and stops draining it,
    cooperatively, once `should_stop()` reports True. See module
    docstring for the full rationale.

    Stateless between calls, like every other provider-layer wrapper
    in this package: `should_stop` is a caller-owned closure (this
    class never constructs or owns one), and this class holds no
    mutable state of its own across `discover()` calls.
    """

    def __init__(
        self,
        wrapped: DiscoveryProviderInterface,
        *,
        should_stop: Optional[Callable[[], bool]] = None,
        provider_id: str = "target_aware",
        display_name: str = "Target Aware",
    ) -> None:
        """
        `wrapped` — the DiscoveryProviderInterface this wrapper
        cooperatively stops draining. Typically the composed result of
        `ProviderRegistry.create()`.

        `should_stop` — a zero-argument callable returning True once
        no further candidates should be pulled (target reached,
        shutdown requested, ...). `None` (the default) means "never
        stop early" — this wrapper then behaves as a pure pass-through,
        so a caller with no target/shutdown concept can use it
        unconditionally without a branch.
        """
        self._wrapped = wrapped
        self._should_stop = should_stop
        self._provider_id = provider_id
        self._display_name = display_name

    @property
    def provider_id(self) -> str:
        return self._provider_id

    @property
    def display_name(self) -> str:
        return self._display_name

    @property
    def wrapped(self) -> DiscoveryProviderInterface:
        """Read-only access to the wrapped provider, for introspection/testing."""
        return self._wrapped

    def discover(self, request: Any) -> Iterator[BusinessCandidate]:
        """
        Streams BusinessCandidate objects from the wrapped provider,
        checked against `should_stop()` between each item (never
        mid-item — the same discipline every other cooperative-stop
        mechanism in this package already follows). The moment
        `should_stop()` reports True, the wrapped generator is closed
        (triggering its own cleanup — see module docstring, "How
        cancellation actually reaches every active provider") and this
        generator ends.

        `request` is forwarded to `self._wrapped.discover(request)`
        unexamined — this wrapper has no request shape of its own.

        Error handling: matches every existing provider-layer wrapper.
        An exception raised while driving the wrapped provider
        propagates unchanged, uncaught.
        """
        gen = self._wrapped.discover(request)
        try:
            while True:
                if self._should_stop is not None and self._should_stop():
                    gen.close()
                    return
                try:
                    candidate = next(gen)
                except StopIteration:
                    return
                yield candidate
        finally:
            gen.close()
