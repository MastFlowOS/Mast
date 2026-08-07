"""
MAST Engine V2 — Discovery Worker
====================================

Source: Engine BluePrint, Phase 1.3 ("Distributed Worker Architecture"
— Worker Types, Discovery Worker, "Workers own only runtime
execution"), Phase 1.4 ("Queue Ownership" — "Workers temporarily
process QueueItems", never own them; "Streaming Philosophy" —
continuous streaming, no batching), Phase 1.5 Stage 3 ("Discovery
Pipeline"), and the Phase 5.3 implementation prompt. Builds directly
on workers/base_worker.py (Milestone 3C) and
engine/interfaces.py:DiscoveryProviderInterface (Phase 5.1) — neither
of which this module modifies.

Revision history
--------------------
v1 implemented `execute()`: a loop that drove the provider *and*
pushed each BusinessCandidate into a Discovery Queue via a locally
declared Protocol standing in for `queues.queue.Queue`. Reverted —
that conflated "runtime execution" (Phase 1.3: what a worker owns)
with orchestration (pulling from a provider, writing to a queue),
which this architecture keeps separate, and the Protocol reproduced
the exact coupling AD-041 exists to prevent, just without a literal
import statement.

v2 made `process()` a pure passthrough returning
`self._provider.discover(item)` — a cold iterator, unstarted until
something else iterates it. That fixed the queue-coupling problem but
introduced a different one: `provider.discover()` is a generator
function, so calling it runs no code at all. `process()` would always
"succeed" instantly regardless of whether discovery ever produced
anything, because nothing has executed by the time it returns. A
caller driving BaseWorker's lifecycle around it —
`start(); it = process(req); complete()` — would mark the worker
COMPLETED before a single business had been discovered, with any real
failure surfacing later, disconnected from that lifecycle entirely.

v3 (this version) resolves that by recognizing discovery is not the
same *shape* of worker as Website/Instagram/Contact/Qualification/
Storage. Those are transformers: one already-real input object in, one
already-computed output object out, and `process()` calling them is
itself the unit of work. Discovery is a producer: it doesn't transform
one object into another, it originates a stream. Forcing a producer
through a transformer-shaped return value is what produced both v1's
temptation to smuggle a queue in, and v2's cold-iterator problem — in
both cases the mismatch was papered over rather than named.

The fix: `process()` still returns exactly one output object (Phase
1.2's Golden Rule holds, literally), but that object is not the
stream itself — it's a summary produced only once the stream has
actually been driven to completion, *inside* `process()`'s own call.
The stream reaches its consumer through a callback supplied as part of
the input, invoked once per BusinessCandidate as `process()` iterates
the provider — push, not pull. Concretely:

    - `WorkerInterface.process(item: InputT) -> OutputT` is unchanged.
      Nothing in `engine/` needed editing for this version — the
      generic contract already allows any InputT/OutputT pair per
      worker type ("concrete worker types differ... this module does
      not pick a single input/output pair for all workers" —
      interfaces.py's own WorkerInterface docstring).
    - `InputT` here is `DiscoveryExecution`, a local, worker-scoped
      bundle of the opaque discovery `request` plus an
      `on_candidate` callback — the same "define it locally, it's not
      a shared engine contract" pattern
      `providers/google_maps_provider.py:GoogleMapsDiscoveryRequest`
      already established for exactly this kind of gap (Ambiguity 3
      there).
    - `OutputT` is `int` — the count of candidates streamed. A
      genuinely different object from the input, satisfying the
      Golden Rule, and only returned once true, meaning `process()`
      cannot "succeed" without having actually driven the provider to
      exhaustion (or raised trying to).
    - The callback is an opaque `Callable[[BusinessCandidate], None]`,
      not a queue reference of any kind. `DiscoveryWorker` never
      imports, stores, or type-checks against anything from `queues/`
      — AD-041 stays satisfied by construction, same as v2, but now
      without a cold return value standing in the way of correct
      lifecycle semantics. What the callback actually does (push to a
      Discovery Queue, append to a test list, anything else) is
      entirely the caller's business; this worker has no opinion.

This makes `process()` a genuinely synchronous unit of work again:
it blocks until the provider's stream is exhausted or raises, exactly
like every other worker type's `process()` blocks until its single
transformation is done. A future orchestrator can wrap it in the
ordinary `start(); process(...); complete()` /
`start(); process(...) [raises]; fail()` pattern without any special
casing for Discovery.

What this explicitly does NOT do (per review instruction): no
peeking, no buffering, no partial pre-fetch to "prove liveness" before
committing to the call. `process()` either fully drives the stream
(raising if the provider fails partway) or it doesn't start it at
all — there is no intermediate state to inspect from outside.

Ownership of `on_candidate`
-------------------------------
`DiscoveryWorker` never constructs `on_candidate`, never inspects what
it does, and never has an opinion about it. Ownership flows one
direction, and this class sits at the very end of it, as a pure
consumer of something built upstream:

    Engine Runtime
          │
          ▼
    creates on_candidate
    (closure over a Discovery Queue, e.g.
     lambda candidate: discovery_queue.enqueue(
         pipeline_id=candidate.pipeline_id, payload=candidate))
          │
          ▼
    constructs DiscoveryExecution(request, on_candidate)
          │
          ▼
    calls DiscoveryWorker.process(execution)
          │
          ▼
    DiscoveryWorker iterates the provider, calling
    on_candidate(candidate) once per BusinessCandidate —
    never storing, wrapping, or reasoning about what
    on_candidate does once called

"Engine Runtime" here is not a new component this module invents — it
is this blueprint's own name for the not-yet-built orchestration layer
already pointed at in the "Revision history, v1" note above ("something
in engine/... the only layer in this ownership hierarchy that already
knows about both" WorkerRegistry and QueueManager). Concretely, it maps
onto Phase 1.3's `RuntimeContext`, which groups WorkerRegistry,
QueueManager, and ProviderRuntime side by side for exactly this reason,
and which — per Phase 1.3's own status note, still true as of Milestone
4.7 — "is intentionally introduced before implementation" and does not
exist as a constructed object yet. This section documents where the
wiring belongs once it does; it does not build it.

This ownership shape is not special-cased to Discovery, which is the
reason it is worth writing down here even though no code changes as a
result. A future WebsiteWorker's InputT will typically be plainer —
just a BusinessCandidate, no callback, since a 1:1 transformer returns
its one output directly rather than emitting a stream — but the
ownership boundary is identical: Engine Runtime is the one that
dequeues the item, extracts the payload, calls
`website_worker.process(candidate)`, and is the one that pushes the
returned WebsiteIntel into the next queue. WebsiteWorker never touches
a queue, for exactly the reason DiscoveryWorker doesn't. What
Discovery's shape adds — a callback bundled into InputT instead of a
queue interaction happening entirely on the Engine Runtime side of the
call — is specific to being a producer rather than a transformer (see
"Revision history, v3" above); the rule that a worker is never handed
anything queue-shaped, and never wired to one itself, is the part every
future worker type is expected to inherit unchanged.

Timeout (unchanged ambiguity)
----------------------------------
Phase 1.3's "Timeout Rules" table (Website=8s, Instagram=6s,
Contact=6s, Merge=2s, Qualification=2s, Storage=3s) does not list
Discovery — `timeout_seconds()` still returns a
constructor-overridable `DEFAULT_TIMEOUT_SECONDS = 30.0`, flagged
rather than invented as authoritative. This now matters more than it
used to: since `process()` runs synchronously to completion, a
discovery run genuinely can exceed this timeout, whereas v2's
cold-iterator return could never take any time at all. Enforcing this
timeout (e.g. wall-clock cutoff around the loop below) is not
implemented here — nothing in Phase 1.3/1.4 assigns timeout
*enforcement* to the worker itself (see base_worker.py: `heartbeat()`
"only records that a heartbeat happened... detecting a missed one is
Phase 4"). `timeout_seconds()` remains a declared value for a future
caller to enforce, not a guarantee this method makes about itself.

Error handling
-----------------
If `self._provider.discover(item.request)` raises while being
iterated, the exception propagates out of `process()` unmodified —
no try/except, no retry, no partial/sentinel count returned. If
`item.on_candidate(candidate)` itself raises (e.g. because the
caller's callback failed to enqueue), that exception also propagates
unmodified; `process()` does not distinguish "the provider failed"
from "the consumer failed" and does not need to — both are simply
"this call did not complete," which is exactly what should reach
whoever is driving this worker's lifecycle.

Lifecycle
------------
Unchanged reasoning from v1/v2: DiscoveryWorker subclasses BaseWorker
and reuses its lifecycle machinery without duplicating any of it, but
does not call reserve()/start()/complete()/fail()/release() itself —
driving worker_state around a call to process() is a Worker
Pool/Allocator concern (Phase 1.3), out of scope here. What changes in
v3 is that doing so now behaves correctly: process() genuinely
completes only after real work is done, or raises before "success" is
ever implied.

Status
------
Phase 5.3 (second revision). No other package (engine/, queues/,
providers/) is imported or modified by this file.
providers/google_maps_provider.py is read, not modified.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable, Optional

from engine.contracts import BusinessCandidate
from engine.interfaces import DiscoveryProviderInterface
from workers.base_worker import BaseWorker
from workers.worker_capability import WorkerCapability

#: Discovery is not in Phase 1.3's per-worker-type timeout table — see
#: "Timeout (unchanged ambiguity)" above. Overridable per instance.
DEFAULT_TIMEOUT_SECONDS = 30.0

#: Stable worker_type / WorkerCapability.name for every DiscoveryWorker
#: instance, matching the naming style already used elsewhere (e.g.
#: providers' provider_id).
WORKER_TYPE = "discovery"


@dataclass(frozen=True)
class DiscoveryExecution:
    """
    This worker's own accepted input shape — local to this module, not
    a shared `engine.contracts` type, for exactly the reason
    `GoogleMapsDiscoveryRequest` gives in
    `providers/google_maps_provider.py` (Ambiguity 3 there): no shared
    "discovery request" or "discovery execution" contract exists
    anywhere in Phase 1.1-1.5, and inventing one for `engine/` is out
    of scope for this milestone.

    Bundles the opaque discovery `request` (passed through to
    `DiscoveryProviderInterface.discover()` unchanged, exactly as that
    interface already types it — `Any`) with `on_candidate`, the
    push-style consumer this worker calls once per BusinessCandidate as
    it streams in. `on_candidate` is deliberately just a
    `Callable[[BusinessCandidate], None]` — not a queue, not an
    interface type imported from `queues/` or `engine/` — so this
    module carries no opinion about what the caller does with each
    candidate.

    Who actually builds this object, and where `on_candidate` comes
    from, is not this class's concern to document — see the module
    docstring's "Ownership of `on_candidate`" section for the full
    chain of responsibility, from Engine Runtime down to this worker.
    """

    request: Any
    on_candidate: Callable[[BusinessCandidate], None]


class DiscoveryWorker(BaseWorker[DiscoveryExecution, int]):
    """
    Executes discovery: drives its DiscoveryProvider over `item.request`
    and calls `item.on_candidate(candidate)` once per BusinessCandidate
    as it streams in, in the order the provider yields them. Owns only
    this — see the module docstring for why this is a push-style
    producer rather than a transformer, and why that is the correct
    shape for this worker type specifically.

    Generic parameters (WorkerInterface[InputT, OutputT], reused from
    BaseWorker): InputT is `DiscoveryExecution` (request + callback,
    see above); OutputT is `int` — the number of candidates streamed
    during this call, returned only once the provider's stream is
    genuinely exhausted. See "Revision history, v3" above for why this
    pairing was chosen over a returned iterator.
    """

    def __init__(
        self,
        provider: DiscoveryProviderInterface,
        *,
        timeout: float = DEFAULT_TIMEOUT_SECONDS,
        worker_id: Optional[str] = None,
    ) -> None:
        """
        Parameters
        ----------
        provider:
            The DiscoveryProvider this worker drives. Bound at
            construction, mirroring how a WorkerDefinition ties a
            worker type to fixed configuration (worker_definition.py)
            — not mutated between executions, matching this worker's
            statelessness requirement. Exactly
            `engine.interfaces.DiscoveryProviderInterface`; nothing
            queue-shaped anywhere near this constructor.
        timeout:
            Per-run timeout in seconds, returned by
            `timeout_seconds()`. See "Timeout (unchanged ambiguity)"
            above — not enforced by this class.
        worker_id:
            Forwarded to BaseWorker; auto-generated if omitted.
        """
        super().__init__(
            worker_type=WORKER_TYPE,
            capabilities=(WorkerCapability(name=WORKER_TYPE),),
            worker_id=worker_id,
        )
        self._provider = provider
        self._timeout = timeout

    # -- WorkerInterface -------------------------------------------------

    def process(self, item: DiscoveryExecution) -> int:
        """
        Consume exactly one DiscoveryExecution and produce exactly one
        output object: the count of BusinessCandidates streamed.

        Owns the iteration itself — this is the one place in this
        module a `for` loop over the provider's generator appears.
        Each candidate is handed to `item.on_candidate()` the moment
        it arrives from `self._provider.discover(item.request)`;
        nothing is accumulated into a list or held back, so Phase
        1.4's "Streaming Philosophy" (continuous streaming, no
        batching) is preserved at the finest possible grain, one
        candidate at a time, even though this method itself does not
        return until the whole run is done.

        No filtering, enrichment, qualification, storage, or
        deduplication is added on top of what the provider yields
        (Phase 1.5 Stage 2: "No enrichment. No qualification. No
        storage."). If either the provider's generator or the caller's
        `on_candidate` callback raises, the exception propagates
        unmodified — no try/except here, no retry, no partial count
        returned in its place.
        """
        count = 0
        for candidate in self._provider.discover(item.request):
            item.on_candidate(candidate)
            count += 1
        return count

    def timeout_seconds(self) -> float:
        """
        Declared per-run timeout for this worker instance. Not
        enforced by this class — see "Timeout (unchanged ambiguity)"
        above.
        """
        return self._timeout
