"""
MAST Engine V2 — Interfaces
=============================

Source: Engine BluePrint, Phase 1.3 ("Distributed Worker Architecture"),
Phase 1.4 ("Queue System, Concurrency & Recovery"), and Phase 1.5
("Migration Strategy" — provider plug-in principle).

Responsibility
--------------
This module defines the *contracts* (abstract base classes) that
future concrete implementations must satisfy. It does not implement
any worker, provider, or queue. Defining these interfaces now lets
later milestones build against a stable shape without this milestone
making any architectural decisions of its own.

Three interfaces are defined:

    WorkerInterface   — Phase 1.3: "A worker performs ONE task.
                         Nothing else." Workers communicate ONLY
                         through queues (Principle 6); they never call
                         another worker directly. Generic over its
                         input/output contract types (Phase 1.2
                         "Golden Rule": one input object in, one
                         different output object out) since concrete
                         worker types differ (WebsiteWorker:
                         BusinessCandidate -> WebsiteIntel;
                         QualificationWorker: EnrichedBusiness ->
                         QualifiedOpportunity; etc.) — this module does
                         not pick a single input/output pair for all
                         workers.

    DiscoveryProviderInterface — Phase 1.1 Principle 9 / Phase 1.5
                         final principle: discovery providers are
                         plug-ins (Google Maps today; LinkedIn, Yelp,
                         etc. tomorrow) without changing the engine.
                         Its output type is fixed to
                         BusinessCandidate, per Phase 1.2 ("This is the
                         ONLY object Google Maps is allowed to
                         create.") — that constraint applies to every
                         provider, not just Google Maps.

                         Phase 5.1 ("Provider Layer") scoped this
                         interface to identity and discovery only:
                         provider_id, display_name, and a streaming
                         discover() that yields BusinessCandidate
                         objects one at a time rather than
                         materializing a list (so a provider naturally
                         supports very large result sets). Provider
                         runtime status and descriptive metadata
                         (health checks, capabilities) are deliberately
                         deferred to a future Provider Registry
                         milestone. Providers remain stateless
                         execution components: they never own runtime
                         state, queues, workers, sessions, or
                         opportunities, and they never mutate a
                         BusinessCandidate once produced.

    QueueInterface    — Phase 1.4: "Queues own work. Workers are
                         disposable." Reconciled (post-Milestone 4.7)
                         to the minimal contract every queue actually
                         needs: enqueue() and dequeue(), matching
                         queues/queue.py:Queue's real signatures
                         exactly. Reservation, leasing, retry, and
                         dead-letter semantics are real capabilities of
                         the concrete Queue that this interface does
                         not (yet) abstract over — see the class
                         docstring for why. Typed against
                         queues.queue_item.QueueItem, the small
                         six-field contract Queue actually stores —
                         not engine.contracts.QueueItem, a
                         differently-shaped, unreconciled contract
                         nothing in queues/ constructs.

Milestone 2 change: these interfaces previously typed everything as
`Any`. Now that engine/contracts.py defines the real contract types,
signatures reference them directly. This is a typing-only change —
no method gained a body, and no new abstract methods were added.

Milestone 3C change: none, to this module's code. workers/base_worker.py
was added and subclasses WorkerInterface[InputT, OutputT] directly,
reusing its InputT/OutputT type variables — WorkerInterface did not
need any new method, property, or signature to support that (see the
WorkerInterface docstring below for how the two now relate). This is a
documentation-only update recording that fact.

A note on the Contact Worker (Phase 1.3): the blueprint combines Email
and Phone into a single ContactWorker as an implementation choice, not
an architectural limitation. This module does not encode that choice
either way — it only defines the generic WorkerInterface that any
worker (including a future ContactWorker) must satisfy.

Status
------
FOUNDATION ONLY (Milestone 1/2, DiscoveryProviderInterface refined at
Phase 5.1). No class in this module is instantiated or referenced by
the currently running engine.

Phase 5.1 change: DiscoveryProviderInterface gained provider_id and
display_name (identity), and discover()'s return type changed from a
single BusinessCandidate to ``Iterator[BusinessCandidate]`` to make
streaming explicit in the signature rather than merely described in
prose. Provider runtime status and descriptive metadata (health
checks, capabilities) are deliberately out of scope for this
milestone — they'll be introduced alongside the future Provider
Registry milestone, which is the right place to decide their shape.
This module still introduces no provider implementation, no business
logic, no scraping, no HTTP, and no Google Maps code — only the
abstraction. WorkerInterface and QueueInterface are unchanged by this
milestone.

TODO(future milestones):
    - Phase 3 (Worker Framework): workers/base_worker.py will provide
      the first concrete subclass of WorkerInterface.
    - Phase 4 (Queue Framework): landed as queues/queue.py:Queue
      (Milestones 4.1-4.7). Queue does not formally subclass
      QueueInterface (it was written against the queue's own emerging
      design, not this early ABC) but its enqueue()/dequeue() now
      match this interface's reconciled shape exactly — see
      QueueInterface's own docstring below for the full reconciliation
      and what remains out of scope (reservation, leasing, retry,
      dead-letters).
    - Phase 5 (Discovery Provider): providers/google_maps will provide
      the first concrete implementation of DiscoveryProviderInterface,
      wrapping (not modifying) scraper/maps_scraper.py.
    - Provider Registry milestone: health()/capabilities() (or their
      equivalents) will be introduced once that milestone defines
      their shape and how providers are registered/selected.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Any, Generic, Iterator, Optional, TypeVar

from engine.contracts import BusinessCandidate
from queues.queue_item import QueueItem

InputT = TypeVar("InputT")
OutputT = TypeVar("OutputT")


class WorkerInterface(ABC, Generic[InputT, OutputT]):
    """
    Phase 1.3: a worker performs ONE task, nothing else, and is
    stateless — all progress lives in queues (see engine/state.py:
    WorkerState). Workers never call another worker; they only read
    from an input queue and write to an output queue.

    Generic over (InputT, OutputT) so a concrete subclass can pin down
    its exact contract pair, e.g.
    ``WorkerInterface[BusinessCandidate, WebsiteIntel]`` for a future
    WebsiteWorker, without this module inventing which pairs exist.

    Relationship to BaseWorker (workers/base_worker.py, Milestone 3C):
    BaseWorker is a direct subclass, ``BaseWorker(WorkerInterface[InputT,
    OutputT])``, reusing InputT/OutputT from this module. It adds
    worker *lifecycle* state (CREATED/INITIALIZING/IDLE/RESERVED/
    WORKING/COMPLETED/FAILED — see engine/state.py:WorkerState) on top
    of this interface, but deliberately leaves process() and
    timeout_seconds() abstract, exactly as they are here. That keeps
    BaseWorker non-instantiable — a lifecycle without any work behind
    it — until a concrete worker type (Phase 6+) supplies both.

    TODO(Phase 3): implemented by workers/base_worker.py, which
    provides lifecycle/state management only. process() and
    timeout_seconds() are still unimplemented anywhere in the
    codebase; there is no behavior behind either yet.
    """

    @abstractmethod
    def process(self, item: InputT) -> OutputT:
        """
        Consume exactly one input object and produce exactly one
        output object (Phase 1.2 "Golden Rule"). Must never mutate
        `item`.

        TODO(Phase 3+): implemented by concrete worker subclasses.
        """
        raise NotImplementedError

    @abstractmethod
    def timeout_seconds(self) -> float:
        """
        Per-worker-type timeout (Phase 1.3 "Timeout Rules"), e.g.
        Website=8s, Instagram=6s, Contact=6s, Merge=2s,
        Qualification=2s, Storage=3s.

        TODO(Phase 3+): implemented by concrete worker subclasses.
        """
        raise NotImplementedError


class DiscoveryProviderInterface(ABC):
    """
    Phase 1.1 Principle 9 / Phase 1.5: discovery providers are
    plug-ins. Google Maps is one provider today; LinkedIn, Facebook,
    Yelp, Clutch, etc. can be added tomorrow without changing the
    engine. A provider's only output is BusinessCandidate (Phase 1.2)
    — it must never enrich, score, or qualify.

    Phase 5.1 scope: identity and discovery only.

        provider_id      — a stable machine identifier (e.g.
                            "google_maps"), used for registration and
                            routing.
        display_name     — a human-readable name (e.g. "Google Maps").
        discover(request) — streams BusinessCandidate objects for a
                            discovery request. Returns an iterator, not
                            a materialized list, so a provider naturally
                            supports very large result sets without this
                            interface (or its callers) needing to change.

    Provider runtime status and descriptive metadata (health checks,
    capabilities such as supported countries/languages/rate limits) are
    deliberately deferred, not part of this interface yet — they belong
    to the future Provider Registry milestone, which is the right place
    to decide their shape alongside how providers get registered and
    selected. Adding them here now would be inventing that shape early.

    Providers are stateless execution components: they never own
    runtime state, queues, workers, sessions, or opportunities; they
    never mutate a BusinessCandidate once produced; and they never
    communicate with other providers. This module still does not
    implement any of this — no provider, no business logic, no
    scraping, no HTTP.

    TODO(Phase 5+): implemented first by providers/google_maps, which
    will wrap scraper/maps_scraper.py without modifying it.
    TODO(Provider Registry milestone): health() and capabilities() (or
    their equivalents) will be introduced here, or on a separate
    registry-facing interface, once that milestone defines their shape.
    """

    @property
    @abstractmethod
    def provider_id(self) -> str:
        """
        Stable machine identifier for this provider (e.g.
        "google_maps"). Used for registration/routing; never shown to
        end users.

        TODO(Phase 5+): implemented by concrete provider subclasses.
        """
        raise NotImplementedError

    @property
    @abstractmethod
    def display_name(self) -> str:
        """
        Human-readable name for this provider (e.g. "Google Maps").

        TODO(Phase 5+): implemented by concrete provider subclasses.
        """
        raise NotImplementedError

    @abstractmethod
    def discover(self, request: Any) -> Iterator[BusinessCandidate]:
        """
        Consume a discovery request and stream BusinessCandidate
        objects. Must not enrich, score, or qualify. Must not
        materialize the full result set before returning — callers may
        iterate this incrementally, and a provider with a very large
        result set must be able to yield candidates as it finds them.

        `request` remains `Any`: the shape of a "discovery request" is
        not defined anywhere in Phase 1.1-1.5 and is out of scope for
        this milestone (abstraction only) — inventing it here would be
        an architecture decision this milestone is not authorized to
        make.

        TODO(Phase 5+): implemented by concrete provider subclasses.
        """
        raise NotImplementedError


class QueueInterface(ABC):
    """
    Phase 1.4: queues own work; workers are disposable.

    Reconciliation note (post-Milestone 4.7 / Phase 5.3 review): this
    interface originally declared `push(item)` / `reserve(worker_id) ->
    Optional[item]` / `ack(pipeline_id)`, written before Phase 4's
    actual queue framework existed. The real implementation
    (`queues/queue.py:Queue`, Milestones 4.1-4.7) landed on a
    materially different shape:

        - Items are created BY the queue (`enqueue(pipeline_id, stage,
          payload) -> QueueItem`, minting queue_item_id itself), not
          handed to it pre-built — there is no `push(item)`.
        - Plain FIFO consumption is `dequeue() -> Optional[QueueItem]`,
          which removes the item outright. Reservation is a separate,
          opt-in operation, `reserve(queue_item_id, worker_id,
          ttl_seconds=None)` — it requires the caller to already know
          *which* item (typically via `peek()`) rather than handing
          back "the next available item for this worker_id", and it
          does not remove the item from FIFO storage. There is no
          `ack(pipeline_id)`; completion is a fact recorded elsewhere
          (nothing in this codebase's Queue moves an item to
          COMPLETED yet — see Phase 1.4 "QueueItem Lifecycle").
        - `Queue` also carries a substantial surface with no analogue
          here at all: lease expiration, retry bookkeeping, dead-letter
          recording, and point-in-time metrics (Phase 1.4 "Lease
          Expiration" / "Retry Philosophy" / "Dead Letter Runtime" /
          "Queue Metrics").

    Rather than expand this interface to mirror `Queue`'s full surface
    (which would just recreate the original problem one milestone
    later, the moment retries or dead-letters change shape again), this
    interface is intentionally re-scoped to the minimal contract every
    queue implementation actually needs to satisfy: create work, and
    consume it in plain FIFO order. `enqueue()` / `dequeue()` below
    match `Queue`'s real method names, signatures, and return types
    exactly. Reservation, leasing, retry, and dead-letter semantics are
    real, implemented capabilities of the concrete `Queue` — richer
    than this interface requires, not narrower — the same relationship
    `DiscoveryProviderInterface` already has with health()/
    capabilities() (Phase 5.1: deliberately deferred, not force-fit
    into an early interface). A future milestone that needs to depend
    on reservation/retry/dead-letter behavior *through an interface*
    (rather than the concrete `Queue` class directly) should extend
    this ABC then, once that milestone can see how it's actually used
    — not now, speculatively.

    Typed against `queues.queue_item.QueueItem` (the small, six-field
    contract `Queue` actually stores and returns) rather than
    `engine.contracts.QueueItem` (the richer, differently-shaped
    contract with `state`/`session_id`/`worker_id`/`timeout_at` that
    nothing in `queues/` constructs — see Phase 1.4's own note that
    these two `QueueItem` types remain unreconciled). Importing
    `queues.queue_item` here is safe: AD-041 (Phase 1.3, "Runtime
    Independence") forbids `workers/` <-> `queues/` imports
    specifically; it says nothing about `engine/`, which already sits
    above both in the ownership hierarchy (`RuntimeContext` groups
    `WorkerRegistry` and `QueueManager` side by side) and is the
    correct place for a contract that describes `Queue`'s real shape.

    TODO(Phase 4+, if/when needed): a caller wanting reservation, ACK,
    heartbeat, or retry behavior through an interface (rather than the
    concrete `Queue`) should extend this ABC with methods matching
    `Queue.reserve()` / `Queue.release()` / `Queue.can_retry()` /
    `Queue.dead_letter()`'s real signatures, at the point something
    actually needs to depend on that abstractly.
    """

    @abstractmethod
    def enqueue(
        self,
        pipeline_id: str,
        stage: Optional[str] = None,
        payload: Optional[Any] = None,
    ) -> QueueItem:
        """
        Create a new QueueItem for `pipeline_id` and append it to the
        back of the queue. Matches `Queue.enqueue()` exactly: the
        queue mints queue_item_id and created_at itself; a caller never
        supplies either.
        """
        raise NotImplementedError

    @abstractmethod
    def dequeue(self) -> Optional[QueueItem]:
        """
        Remove and return the QueueItem at the front of the queue
        (FIFO), or None if empty. Matches `Queue.dequeue()` exactly —
        plain FIFO pop, no reservation involved.
        """
        raise NotImplementedError
