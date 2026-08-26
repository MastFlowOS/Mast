"""
providers/target_aware_provider.py
===================================

MAST — Provider Parallelism v1: Global Target Propagation (Step 7).

PHASE 42C addendum — polling drain, not blocking `next()`
----------------------------------------------------------------------
Root cause of the remaining discovery wall-clock waste (production
telemetry: `discovery_total` ~= the SLOWEST wrapped provider's own
duration even when the FASTEST provider alone already produced every
candidate the caller needed — e.g. Google Maps returns in ~2.5s with
enough candidates to satisfy `should_stop()`, but `discovery_total`
still reads ~74s because Overpass, on the same request, took ~74s to
finish its own work):

Before this addendum, `discover()` below called the wrapped
provider's generator with a single, plain, *blocking* `next(gen)` per
item, and checked `should_stop()` only in between those calls — i.e.
only once a full item had actually arrived. That is fine when every
wrapped provider answers quickly. It is not fine when `wrapped` is a
`ParallelCompositeDiscoveryProvider`: that class's own `discover()`
consumer loop (see parallel_composite_provider.py) calls
`result_queue.get()` with NO timeout, which blocks until *some*
producer thread pushes an item — including a producer thread for a
provider whose candidates are no longer wanted. A single `next(gen)`
call on that composite can therefore legitimately block for up to the
SLOWEST still-running wrapped provider's remaining duration, and
during that single blocking call `should_stop()` cannot be
re-consulted — it already returned False (or wasn't checked yet) the
one time this wrapper looked, before making the call that then hangs.
This is "target/budget reached" arriving too late to matter: the
condition becomes true, but the only place that checks it is stuck
waiting on a provider whose result is no longer needed.

The fix keeps every other guarantee this file already documents
(cooperative, between-item stopping only; `wrapped.discover()` is
still driven by manual `next()` calls, never `for candidate in gen:`;
closing `wrapped`'s generator on stop still triggers
ParallelCompositeDiscoveryProvider's own existing clean-shutdown path
unchanged — see that module's docstring) and changes exactly one
thing: `wrapped`'s generator is now drained on a dedicated helper
thread — the same "one thread, manual `next()`, checked against a
`stop_event` between items" idiom `ParallelCompositeDiscoveryProvider`
already uses for each of ITS wrapped providers (see that module's
`_run_provider`), applied one level up, generically, around whatever
single `DiscoveryProviderInterface` this wrapper was given. The
calling thread never calls the wrapped generator's `next()` directly
any more; it polls a small thread-safe queue with a short timeout
(`_POLL_INTERVAL_SECONDS`) and re-checks `should_stop()` on every poll
— including every timed-out, empty poll, not just after an item
arrives. This is what actually delivers "first-useful-result"
semantics at the composition boundary: the moment `should_stop()`
turns true, this wrapper stops waiting (bounded by one poll interval,
not by whatever the slowest wrapped provider is doing) and signals the
helper thread to close `wrapped`'s generator, which — for a
`ParallelCompositeDiscoveryProvider` — sets its own `_stop_event` and
lets each of its own producer threads wind down exactly as documented
there (bounded by that file's own "honest limit on shutdown speed",
unchanged). No wrapped provider, and no other file, is modified to
achieve this — only how THIS wrapper drives whatever single generator
it was constructed with.

A subtlety this design has to get right, found and fixed during this
same phase: the helper thread's OWN `next(gen)` call can itself be
mid-flight and uninterruptible (e.g. the composite's internal
`result_queue.get()`, itself waiting on a still-sleeping wrapped
provider). A first version of this fix still called
`thread.join()` with no timeout in `discover()`'s own `finally` block
— which re-introduced the exact wait this phase exists to remove:
returning control to the *caller* (the generator's own `return`
completing) was blocked on that `join()`, which was blocked on the
helper thread's in-flight call, which was blocked on the slow
provider. Detecting `should_stop()` promptly bought nothing if the
generator's own `return` statement couldn't actually finish executing
until the slow provider did. The fix: `finally` still signals
`stop_event` immediately, but joins the helper thread with only a
short, bounded timeout (`_POLL_INTERVAL_SECONDS`) rather than
indefinitely. In the common case (the helper thread is idle or
between items, which is most of the time under real concurrent
providers) that join succeeds immediately and the thread is reaped
cleanly, same as before. In the rare case a wrapped provider's single
call is still in flight, this wrapper's own `discover()` call returns
to its caller promptly anyway; the daemon helper thread is left to
notice `stop_event` and close `wrapped`'s generator itself once that
one call finishes — bounded by that provider's own timeout (e.g.
OverpassProvider's already-fixed wall-clock budget, Phase 42B,
unmodified here), running fully off the caller's critical path rather
than blocking it. This is the same "honest limit on shutdown speed"
trade-off `ParallelCompositeDiscoveryProvider`'s own module docstring
already accepts for its own producer threads, applied consistently
one layer up instead of pretending this layer could do better.

When `should_stop=None` (the default — "never stop early"), this
addendum's polling machinery is skipped entirely: `discover()` falls
back to a plain `yield from`, identical to this wrapper's original
pure-passthrough behavior, so a caller with no target/shutdown concept
pays no extra thread or polling overhead. Likewise, if `should_stop()`
is already true before a single item has been requested, no helper
thread is started at all — matching the original "never even touch
the wrapped provider" behavior for that case exactly.

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

import queue
import threading
from typing import Any, Callable, Iterator, Optional

from engine.contracts import BusinessCandidate
from engine.interfaces import DiscoveryProviderInterface

#: How often the consumer re-checks `should_stop()` while waiting for
#: the helper drain thread to produce the next item, in seconds. Small
#: enough that "target reached while a slow wrapped provider is still
#: working" is noticed promptly (a small, bounded multiple of this
#: value) regardless of how long that provider takes; large enough
#: that idle polling never shows up as meaningful CPU/log overhead.
#: See module docstring, "PHASE 42C addendum", for the root cause this
#: exists to fix.
_POLL_INTERVAL_SECONDS = 0.1


# ---------------------------------------------------------------------------
# Internal queue message types for the helper drain thread — never
# exposed to callers. Mirrors parallel_composite_provider.py's own
# _Candidate/_ProviderDone/_ProviderError idiom exactly (same
# reasoning: one thread-safe channel carries both data and lifecycle).
# ---------------------------------------------------------------------------
class _Item:
    __slots__ = ("candidate",)

    def __init__(self, candidate: BusinessCandidate) -> None:
        self.candidate = candidate


class _Done:
    __slots__ = ()


class _Error:
    __slots__ = ("exc",)

    def __init__(self, exc: BaseException) -> None:
        self.exc = exc


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
        poll_interval_seconds: float = _POLL_INTERVAL_SECONDS,
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

        `poll_interval_seconds` — how often `should_stop()` is
        re-checked while waiting for the helper drain thread to
        produce the next item (see module docstring, "PHASE 42C
        addendum"). Defaults to `_POLL_INTERVAL_SECONDS` (0.1s);
        exposed mainly so tests can use a smaller value without
        sleeping for realistic production durations.
        """
        self._wrapped = wrapped
        self._should_stop = should_stop
        self._provider_id = provider_id
        self._display_name = display_name
        self._poll_interval_seconds = poll_interval_seconds

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
        checked against `should_stop()` on a short, bounded poll
        interval rather than only in between fully-produced items —
        see module docstring, "PHASE 42C addendum", for exactly why
        that distinction matters. The moment `should_stop()` reports
        True, the wrapped generator is closed (triggering its own
        cleanup — see module docstring, "How cancellation actually
        reaches every active provider") and this generator ends.

        `request` is forwarded to `self._wrapped.discover(request)`
        unexamined — this wrapper has no request shape of its own.

        Error handling: matches every existing provider-layer wrapper.
        An exception raised while driving the wrapped provider
        propagates unchanged, uncaught.

        Fast path: when no `should_stop` was configured, this is a
        plain pass-through with no helper thread and no polling — the
        exact behavior this class always had.
        """
        if self._should_stop is None:
            gen = self._wrapped.discover(request)
            try:
                yield from gen
            finally:
                gen.close()
            return

        # Cheapest possible early-out: if the caller already wants to
        # stop before a single item has been requested, never touch
        # the wrapped provider at all — no thread, no generator even
        # started. Matches the pre-42C behavior for this exact case.
        if self._should_stop():
            return

        gen = self._wrapped.discover(request)
        item_queue: "queue.Queue[Any]" = queue.Queue()
        stop_event = threading.Event()

        def _drain() -> None:
            """
            Runs on its own helper thread. Manually steps `gen` one
            item at a time (never `for candidate in gen:`, for the
            same "check the stop signal between items, not via a
            construct that always commits to the next item first"
            reason parallel_composite_provider.py's own `_run_provider`
            gives), pushing each item onto `item_queue` — mirroring
            that same producer/consumer idiom one layer up, generically,
            around whatever single wrapped provider this class holds.
            """
            try:
                while True:
                    if stop_event.is_set():
                        gen.close()
                        return
                    try:
                        candidate = next(gen)
                    except StopIteration:
                        break
                    item_queue.put(_Item(candidate))
            except Exception as exc:  # noqa: BLE001 — converted, not swallowed; see _run_provider's identical comment.
                item_queue.put(_Error(exc))
                return
            item_queue.put(_Done())

        thread = threading.Thread(
            target=_drain,
            name="target-aware-drain",
            daemon=True,
        )
        thread.start()
        try:
            while True:
                if self._should_stop():
                    return
                try:
                    item = item_queue.get(timeout=self._poll_interval_seconds)
                except queue.Empty:
                    # Nothing arrived within this poll window — loop
                    # back and re-check should_stop() immediately,
                    # rather than committing to another indefinite
                    # wait. This is the entire fix: no single wait here
                    # can ever be longer than `poll_interval_seconds`,
                    # regardless of how long the wrapped provider (or,
                    # for a ParallelCompositeDiscoveryProvider, its
                    # slowest still-running wrapped provider) takes to
                    # produce its next item.
                    continue
                if isinstance(item, _Item):
                    yield item.candidate
                elif isinstance(item, _Done):
                    return
                elif isinstance(item, _Error):
                    raise item.exc
        finally:
            # Runs on every exit path (should_stop became true,
            # wrapped exhaustion, a propagated error, or GeneratorExit
            # from the caller closing this generator early). Signals
            # the helper thread to stop at its next checkpoint. The
            # join is intentionally bounded, not indefinite — see
            # module docstring, "PHASE 42C addendum", the "subtlety"
            # paragraph, for exactly why an unbounded join here would
            # silently reintroduce the wall-clock wait this whole fix
            # exists to remove. Most of the time (helper thread is
            # idle or between items) this still reaps the thread
            # immediately, same as an unbounded join would; only when
            # the helper thread's own single `next()` call on `gen` is
            # genuinely in flight does this return early and leave
            # that one daemon thread to finish tearing itself (and
            # `gen`) down on its own, bounded by whatever timeout the
            # wrapped provider itself already honors.
            stop_event.set()
            thread.join(timeout=self._poll_interval_seconds)
