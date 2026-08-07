"""
MAST Engine V2 — ParallelCompositeDiscoveryProvider
======================================================

Source: this milestone's own instructions ("implement Parallel
Discovery"), engine/interfaces.py (DiscoveryProviderInterface),
engine/contracts.py (BusinessCandidate), and the existing provider
layer this sits beside — providers/composite_provider.py
(CompositeDiscoveryProvider), providers/registry.py
(ProviderRegistry), providers/provider_deduplicator.py
(ProviderDeduplicator), providers/google_maps_provider.py, and
providers/yelp_provider.py — all read for precedent, none modified.

Responsibility
--------------
ParallelCompositeDiscoveryProvider has exactly one job: hold an
ordered collection of other DiscoveryProviderInterface instances and
run their discover() calls concurrently, streaming every
BusinessCandidate any of them produces back out as soon as it is
available — instead of CompositeDiscoveryProvider's sequential
"drain provider[0] fully, then provider[1]" behaviour. It does not
discover anything itself, does not enrich, qualify, score, store,
deduplicate, retry, or cache, and does not own workers or queues —
the same boundary every other file in this package already respects.
It adds exactly one new capability to that boundary: running several
already-correct providers at the same time instead of one after
another.

Architecture review (performed before writing any code)
----------------------------------------------------------------------
Reviewed: DiscoveryProviderInterface (engine/interfaces.py),
BusinessCandidate (engine/contracts.py), GoogleMapsProvider,
YelpProvider, CompositeDiscoveryProvider, ProviderRegistry,
ProviderDeduplicator, and the existing provider validation scripts'
style (canned/fake providers injected directly, no live network in
tests).

Finding: no architectural contradiction exists. Parallel provider
execution can be built entirely inside providers/, for the same
reasons CompositeDiscoveryProvider's and ProviderDeduplicator's own
reviews already established, plus two points specific to concurrency:

1. DiscoveryProviderInterface's contract (`provider_id`,
   `display_name`, `discover(request) -> Iterator[BusinessCandidate]`)
   says nothing about *how* a conforming implementation produces the
   items of that iterator — only that it is an iterator streaming
   BusinessCandidate objects. Nothing in the interface, or in
   BusinessCandidate, requires or forbids concurrency inside a single
   `discover()` call. A caller — including the Engine — that holds a
   `DiscoveryProviderInterface` and iterates it has no way to observe,
   and no contractual right to assume, whether the object on the other
   side of that iterator is running one provider, five providers in
   sequence, or five providers in parallel. This is exactly what
   CompositeDiscoveryProvider's own review already established for
   sequential composition ("the Engine cannot tell the difference");
   parallel composition changes nothing about that — it is still one
   `discover()` call returning one iterator of BusinessCandidate.

2. `request: Any` is already unconstrained, and both
   CompositeDiscoveryProvider and ProviderDeduplicator have already
   established the precedent of a provider-layer class that takes
   whatever its wrapped provider(s) need and passes it through
   unexamined. ParallelDiscoveryRequest below reuses
   CompositeDiscoveryRequest's exact shape (a `{provider_id:
   provider_specific_request}` mapping) for the same reason
   CompositeDiscoveryRequest gave: the wrapped providers are
   independent, possibly-incompatible request shapes
   (GoogleMapsDiscoveryRequest vs. YelpDiscoveryRequest), and this
   layer has no business inventing a shared shape or translating
   between them.

3. Streaming, statelessness, and "never mutate a BusinessCandidate"
   remain preservable under concurrency: each wrapped provider's own
   generator is still stepped by pulling from it (see "Concurrency
   design" below for exactly how); no full result set is ever
   materialized at any point; and every BusinessCandidate that reaches
   the caller is the exact object its originating provider yielded —
   this file never constructs, edits, or copies-with-changes a
   BusinessCandidate.

4. (Concurrency-specific) The one real constraint concurrency adds is
   that `DiscoveryProviderInterface.discover()` is declared as a
   synchronous method returning `Iterator[BusinessCandidate]` — see
   engine/interfaces.py — not an async one, and this milestone is
   explicitly forbidden from modifying that interface.
   GoogleMapsProvider already establishes (its own Ambiguity 4) that a
   provider's *internal* implementation may be async while its public
   `discover()` surface stays a plain synchronous generator — the
   bridge from async-internals to sync-interface is each provider's
   own problem to solve, already solved, and not something this file
   needs to know about or redo. What that leaves this file needing is
   a way to run N independent synchronous, blocking iterators
   concurrently while still exposing a single synchronous
   `Iterator[BusinessCandidate]` itself. Python has no way to run
   multiple blocking generators concurrently on one thread; the
   standard, minimal-footprint way to do it without touching any
   provider's internals is one OS thread per wrapped provider, each
   pulling from that provider's own `discover()` and pushing results
   through a thread-safe queue that the calling thread's `discover()`
   generator drains and yields from. See "Concurrency design" below.

Nothing under engine/, workers/, queues/, or models/ needs to change,
be read differently, or be reinterpreted for this to work, and none of
DiscoveryProviderInterface, GoogleMapsProvider, YelpProvider,
CompositeDiscoveryProvider, ProviderRegistry, or ProviderDeduplicator
needed to change either — a ParallelCompositeDiscoveryProvider
instance is just another DiscoveryProviderInterface value. It can be
handed to the Engine directly, wrapped inside a
CompositeDiscoveryProvider, wrapped by a ProviderDeduplicator, or
registered in a ProviderRegistry exactly like any other provider — see
validate_parallel_provider.py, "engine compatibility", for the
concrete demonstration.

No genuine architectural blocker was found. (Reviewed and explicitly
rejected as *not* blockers, per this milestone's instructions not to
stop for these: whether one-thread-per-provider is the "best"
concurrency primitive available — a style/optimization question, not
a contradiction; whether a future async DiscoveryProviderInterface
would let this be written without threads — a future-improvement
question, moot until that interface exists; queue backpressure sizing
— a tuning question, addressed below as a design decision, not a
blocker.)

Concurrency design
----------------------------------------------------------------------
One producer thread per wrapped provider, one shared thread-safe
`queue.Queue`, one consumer (the calling thread, inside `discover()`
itself).

    - Each producer thread owns exactly one wrapped provider. It calls
      that provider's own `discover(provider_request)`, manually steps
      the resulting generator one item at a time (never `for candidate
      in gen`, so it can check a cooperative stop signal *between*
      items — see "Error handling" below), and pushes each
      BusinessCandidate onto the shared queue as soon as it is
      produced. This is the "stream as soon as available, never wait
      for one provider to finish before yielding another's results"
      requirement: nothing here waits for a producer thread to
      *finish* before another producer's items reach the queue — they
      arrive in whatever order they're actually produced, interleaved
      by real wall-clock concurrency, not by any ordering this file
      imposes.

    - The queue also carries two kinds of control messages, not just
      candidates: "this provider is done" and "this provider raised
      an exception" (see `_Candidate` / `_ProviderDone` /
      `_ProviderError` below). This lets the single consumer loop in
      `discover()` learn both data and provider lifecycle through one
      channel, with no separate polling of thread state needed.

    - The consumer (`discover()` itself, running on the caller's
      thread) pulls from the queue in a plain loop, `yield`-ing every
      candidate it receives and tracking which providers have not yet
      reported done. It exits the loop once every wrapped provider has
      reported done (or, in strict error mode, as soon as any provider
      reports an error — see below). Because this is an ordinary
      Python generator, the caller (the Engine) still just iterates a
      synchronous `Iterator[BusinessCandidate]` exactly as it does for
      every other provider in this layer — it is not aware threads
      exist underneath.

    - The shared queue is intentionally unbounded (`queue.Queue()`
      with no `maxsize`). A bounded queue would give backpressure (a
      fast producer would block once the queue filled, until the
      consumer catches up) but was rejected here: `put()` on a full
      bounded queue blocks the producer thread indefinitely if nothing
      is currently draining it, which is exactly the state the shared
      stop-signal path is in immediately after a strict-mode error
      (the consumer stops calling `get()` for that shutdown case — see
      below) — that combination can deadlock a bounded queue. An
      unbounded queue cannot deadlock this way; the tradeoff is that a
      much-faster producer can build up a backlog in the queue ahead
      of a slow consumer. This is an ordinary, bounded-by-conversation
      producer/consumer tradeoff (not "materializing the full result
      set" — the queue still only ever holds items already produced
      but not yet consumed, not the entire, possibly-still-unproduced
      stream), flagged here as a real design decision rather than
      picked silently.

    - Clean shutdown: `discover()`'s body is wrapped in `try/finally`.
      The `finally` block sets a shared `threading.Event`
      (`_stop_event`) and then `join()`s every producer thread before
      `discover()`'s generator actually returns or re-raises. This
      `finally` runs in every exit path a Python generator has: normal
      exhaustion (all providers reported done), an exception
      propagating out (strict-mode provider error), and early
      termination by the caller (the caller stops iterating and the
      generator is closed, which Python delivers as a `GeneratorExit`
      at the suspended `yield` — the `finally` still runs). In every
      case, no `discover()` call returns control to its caller while
      any producer thread it started is still alive — satisfying "no
      leaked threads."

    - Honest limit on shutdown speed: a producer thread only checks
      `_stop_event` *between* items it pulls from its own wrapped
      provider's generator (see `_run_provider` below) — it cannot
      interrupt a wrapped provider's `discover()` mid-item, because
      `DiscoveryProviderInterface.discover()` offers no cancellation
      hook and this milestone may not add one. If a wrapped provider
      is blocked inside a single slow network call when shutdown is
      requested, that producer thread — and therefore `join()` — waits
      for that one call to return (or raise) before it can observe
      `_stop_event` and stop. This is a real, honest limit of
      cooperating with a synchronous, non-cancellable interface, not a
      bug; it's the same limit every other file in this layer already
      has (e.g. CompositeDiscoveryProvider's `continue_on_provider_error`
      still has to wait for a failing provider's current item to
      raise before moving on — nothing before this milestone made
      wrapped-provider execution preemptible, and this milestone
      doesn't invent that either).

Error handling
----------------------------------------------------------------------
Every provider built so far (GoogleMapsProvider, YelpProvider) and
CompositeDiscoveryProvider all follow the same rule: by default, a
failure raised while driving a wrapped source propagates uncaught out
of `discover()`, and CompositeDiscoveryProvider's own review already
established the honest reasoning for keeping that as the default
rather than silently swallowing errors. ParallelCompositeDiscoveryProvider
adopts the identical policy, for the identical reason, and reuses the
identical opt-in shape:

    - `continue_on_provider_error: bool = False` (default, strict):
      the first `_ProviderError` the consumer loop observes on the
      queue is re-raised immediately out of `discover()`, ending the
      composite's stream right there — matching CompositeDiscoveryProvider's
      strict-mode behaviour exactly: from the Engine's point of view, a
      parallel composite failing looks identical to a single provider
      or a sequential composite failing. Candidates from *other*
      providers that are already sitting in the queue ahead of the
      error are still yielded first (the consumer drains the queue in
      arrival order, and the error is just another item in that same
      order) — they were already produced and handing them to the
      caller doesn't hide or undo the failure, it just doesn't discard
      work that had already succeeded. Once the error is reached and
      re-raised, no further items are pulled from the queue.

    - `continue_on_provider_error=True` (opt-in, best-effort): a
      `_ProviderError` for one provider is recorded and that
      provider's thread is treated as done; the consumer loop keeps
      running and keeps yielding candidates from every other still-
      running or not-yet-finished provider, exactly mirroring
      CompositeDiscoveryProvider's own best-effort mode, just applied
      across concurrently-running providers instead of sequential
      ones.

Both modes still guarantee clean shutdown: `_stop_event` is set and
every thread is joined in `discover()`'s `finally` block regardless of
which error-handling branch was taken, or whether no error occurred at
all.

Explicitly out of scope (per this milestone's instructions — not
implemented here, not partially implemented, not stubbed for later)
----------------------------------------------------------------------
- Deduplication of any kind. That is ProviderDeduplicator's
  responsibility; this file's output may contain the same real-world
  business reported by two different wrapped providers, exactly as
  CompositeDiscoveryProvider's output already can, unchanged. A caller
  wanting both parallel execution and cross-provider dedup composes
  them exactly as any two independent DiscoveryProviderInterface-
  shaped layers compose: `ProviderDeduplicator(ParallelCompositeDiscoveryProvider(...))`.
  This file does not need to know ProviderDeduplicator exists to make
  that true, and doesn't import it.
- Provider metrics (call counts, latencies).
- Provider health checks.
- Provider failover (retrying a failed provider on another, or
  substituting one provider for another).
- Provider prioritization (weighting or ordering which provider's
  results are preferred when both report the same business — again,
  a dedup-layer concern, not this one).

Status
------
Parallel Discovery milestone. Adds concurrent execution on top of the
existing, unmodified Provider Layer (DiscoveryProviderInterface,
GoogleMapsProvider, YelpProvider, CompositeDiscoveryProvider,
ProviderRegistry, ProviderDeduplicator). Nothing under engine/,
workers/, queues/, or models/ is read differently or modified to make
this work, and none of those five existing provider-layer files are
modified either.
"""

from __future__ import annotations

import queue
import threading
from dataclasses import dataclass, field
from typing import Any, Iterable, Iterator, Mapping

from engine.contracts import BusinessCandidate
from engine.interfaces import DiscoveryProviderInterface


# ---------------------------------------------------------------------------
# Request shape (provider-local — same shape and reasoning as
# CompositeDiscoveryRequest; see module docstring, review point 2)
# ---------------------------------------------------------------------------
@dataclass(frozen=True, slots=True)
class ParallelDiscoveryRequest:
    """
    This provider's own accepted request shape. Not a shared
    engine/contracts.py contract — same reasoning as
    GoogleMapsDiscoveryRequest / YelpDiscoveryRequest /
    CompositeDiscoveryRequest.

    `requests` maps each wrapped provider's `provider_id` to that
    provider's own request object, unchanged and uninterpreted —
    identical semantics to CompositeDiscoveryRequest.requests. This
    provider never reads, validates, or reshapes the contents of any
    entry, only routes it to the matching wrapped provider.

    Unlike CompositeDiscoveryProvider (which discovers a missing
    provider_id lazily, only once it reaches that provider in its
    sequential loop), ParallelCompositeDiscoveryProvider validates that
    every wrapped provider has a matching entry in `requests` up front,
    before starting any thread — see `discover()` below. This is not a
    behavioural divergence in what counts as an error, only in *when*
    it's raised: a parallel composite that started three provider
    threads and only then discovered the fourth has no request would
    have to tear down three already-running threads to report a
    caller-configuration error, which is strictly worse than catching
    it before anything starts.
    """

    requests: Mapping[str, Any] = field(default_factory=dict)


# ---------------------------------------------------------------------------
# Internal queue message types — never exposed to callers. A producer
# thread puts exactly one of these three per event; the consumer loop
# in discover() is the only code that ever reads them.
# ---------------------------------------------------------------------------
class _Candidate:
    __slots__ = ("candidate",)

    def __init__(self, candidate: BusinessCandidate) -> None:
        self.candidate = candidate


class _ProviderDone:
    __slots__ = ("provider_id",)

    def __init__(self, provider_id: str) -> None:
        self.provider_id = provider_id


class _ProviderError:
    __slots__ = ("provider_id", "exc")

    def __init__(self, provider_id: str, exc: BaseException) -> None:
        self.provider_id = provider_id
        self.exc = exc


class ParallelCompositeDiscoveryProvider(DiscoveryProviderInterface):
    """
    Wraps an arbitrary, ordered collection of DiscoveryProviderInterface
    instances and runs their `discover()` calls concurrently, presenting
    the merged stream to the Engine as a single DiscoveryProviderInterface.
    See module docstring for the full architecture review and
    concurrency/error-handling design.

    Stateless across calls, like every other provider in this layer:
    the wrapped providers themselves are held (they are the caller's
    already-constructed instances, not rebuilt here), but this class
    owns no mutable runtime state between `discover()` calls — every
    call spins up its own fresh threads and queue, and tears them down
    completely before returning.
    """

    def __init__(
        self,
        providers: Iterable[DiscoveryProviderInterface],
        *,
        provider_id: str = "parallel_composite",
        display_name: str = "Parallel Composite",
        continue_on_provider_error: bool = False,
    ) -> None:
        """
        `providers` — an arbitrary collection of already-constructed
        DiscoveryProviderInterface instances. Unlike
        CompositeDiscoveryProvider, construction order carries no
        streaming-order guarantee (see module docstring — items arrive
        interleaved by real concurrency, not by this order); order is
        still preserved in the `providers` property purely for
        introspection/testing.

        `provider_id` / `display_name` — this composite's own identity,
        distinct from any wrapped provider's identity, same as
        CompositeDiscoveryProvider.

        `continue_on_provider_error` — see module docstring, "Error
        handling". Defaults to False (strict propagation, matching
        every existing provider's and CompositeDiscoveryProvider's
        default behaviour exactly).

        Raises ValueError if `providers` is empty or contains duplicate
        provider_id values — identical validation to
        CompositeDiscoveryProvider, for the identical reason (a caller-
        configuration error caught immediately rather than surfacing
        confusingly mid-discovery).
        """
        providers = tuple(providers)
        if not providers:
            raise ValueError(
                "ParallelCompositeDiscoveryProvider requires at least "
                "one wrapped provider."
            )
        seen_ids: set[str] = set()
        for p in providers:
            if p.provider_id in seen_ids:
                raise ValueError(
                    f"Duplicate provider_id {p.provider_id!r} among "
                    "wrapped providers — each wrapped provider must "
                    "have a unique provider_id."
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
        Read-only view of the wrapped providers, in construction order.
        Exposed for introspection/testing only — carries no ordering
        guarantee about the stream itself; see `__init__`.
        """
        return self._providers

    # ------------------------------------------------------------------
    # Discovery — the only public streaming entry point.
    # ------------------------------------------------------------------
    def discover(self, request: ParallelDiscoveryRequest) -> Iterator[BusinessCandidate]:
        """
        Streams BusinessCandidate objects produced by every wrapped
        provider running concurrently. See module docstring,
        "Concurrency design" and "Error handling", for the full
        rationale; this docstring covers the observable contract only.

        Validates that every wrapped provider has a matching entry in
        `request.requests` before starting any thread; raises
        ValueError immediately if not (a caller-configuration error,
        not a provider failure — nothing has started running yet when
        this is raised).

        Streaming order is interleaved by real wall-clock concurrency:
        no guarantee is made, or can honestly be made, about the
        relative order of candidates from two different wrapped
        providers. Candidates from the *same* wrapped provider are
        still yielded in that provider's own order (a single producer
        thread drains one provider's generator strictly in sequence).

        Error handling: see module docstring, "Error handling". By
        default (`continue_on_provider_error=False`), the first
        provider failure encountered propagates out of this generator
        and ends the stream; already-queued candidates from other
        providers ahead of that failure in arrival order are yielded
        first. When `continue_on_provider_error=True`, a failing
        provider is dropped and every other provider's candidates
        continue streaming.

        Guarantees clean shutdown in every exit path (normal
        exhaustion, propagated error, or early termination by the
        caller): no producer thread this call started outlives the
        call — see module docstring, "Clean shutdown", including its
        honest limit on shutdown *speed* when a wrapped provider is
        blocked mid-item.
        """
        for provider in self._providers:
            if provider.provider_id not in request.requests:
                raise ValueError(
                    f"ParallelDiscoveryRequest has no request entry for "
                    f"wrapped provider {provider.provider_id!r} "
                    f"({provider.display_name})."
                )

        result_queue: "queue.Queue[Any]" = queue.Queue()
        stop_event = threading.Event()

        threads = [
            threading.Thread(
                target=self._run_provider,
                args=(provider, request.requests[provider.provider_id], result_queue, stop_event),
                name=f"parallel-discovery-{provider.provider_id}",
                daemon=True,
            )
            for provider in self._providers
        ]

        for thread in threads:
            thread.start()

        remaining = {provider.provider_id for provider in self._providers}
        try:
            while remaining:
                item = result_queue.get()
                if isinstance(item, _Candidate):
                    yield item.candidate
                elif isinstance(item, _ProviderDone):
                    remaining.discard(item.provider_id)
                elif isinstance(item, _ProviderError):
                    remaining.discard(item.provider_id)
                    if not self._continue_on_provider_error:
                        raise item.exc
                    # Best-effort mode: this provider's failure is
                    # dropped; every other provider already running
                    # keeps streaming. Nothing else to do here — the
                    # loop simply continues with a smaller `remaining`.
        finally:
            # Runs on every exit path: normal exhaustion, a re-raised
            # provider error, or GeneratorExit from the caller closing
            # this generator early. Signal every producer thread to
            # stop at its next checkpoint, then wait for all of them —
            # see module docstring, "Clean shutdown", for the honest
            # limit on how fast a producer can actually respond.
            stop_event.set()
            for thread in threads:
                thread.join()

    # ------------------------------------------------------------------
    # Producer — runs on its own thread, one per wrapped provider.
    # ------------------------------------------------------------------
    @staticmethod
    def _run_provider(
        provider: DiscoveryProviderInterface,
        provider_request: Any,
        result_queue: "queue.Queue[Any]",
        stop_event: threading.Event,
    ) -> None:
        """
        Drives exactly one wrapped provider's `discover()` to
        completion (or until `stop_event` is observed, or until it
        raises), pushing each BusinessCandidate onto `result_queue` as
        soon as it's produced, followed by exactly one `_ProviderDone`
        or `_ProviderError` terminal message.

        `next()` is called manually here rather than using `for
        candidate in gen:` specifically so `stop_event` can be checked
        *between* items — a plain `for` loop already commits to
        pulling the next item before the loop body (where a stop check
        would live) ever runs again. This mirrors exactly why
        CompositeDiscoveryProvider's own best-effort mode drives its
        wrapped provider's generator manually instead of with `yield
        from` — same technique, applied here for cooperative
        cancellation instead of error isolation.

        Any exception raised by the wrapped provider (including one it
        couldn't recover from internally) is caught here — not to
        swallow it, but to convert it into a `_ProviderError` message
        so it can travel across the thread boundary to the consumer,
        which is the only place this milestone's chosen error policy
        (strict vs. best-effort) is actually applied. A raw exception
        raised on a background thread has no caller to propagate to;
        putting it on the queue is what lets the *consumer's* thread
        re-raise it, preserving "provider failures are never hidden
        from the caller" across the thread boundary.
        """
        try:
            gen = provider.discover(provider_request)
            while True:
                if stop_event.is_set():
                    gen.close()
                    return
                try:
                    candidate = next(gen)
                except StopIteration:
                    break
                result_queue.put(_Candidate(candidate))
        except Exception as exc:  # noqa: BLE001 — see docstring: converted, not swallowed.
            result_queue.put(_ProviderError(provider.provider_id, exc))
            return

        result_queue.put(_ProviderDone(provider.provider_id))
