"""
MAST Engine V2 — Queue
=========================

Source: Engine BluePrint, Phase 1.4 ("Queue System, Concurrency &
Recovery" — "Queues own work. Workers consume work. Workers never own
work." / "Reservation Model" — "Reservations prevent duplicate
processing... Only one Worker may own one reservation at a time...
Reservation expiration returns the QueueItem to the Queue." /
"Fairness" — "If a Worker exceeds its reservation timeout, the
reservation expires and another Worker may continue." / "Retry
Philosophy" — "Retries belong to QueueItems... Queue reassigns
later"), AD-019 ("Reservations prevent duplicate processing").
Milestone 4.1 ("Queue Manager"), Milestone 4.2 ("Queue
Reservations"), Milestone 4.3 ("Lease Expiration"), Milestone 4.5
("Retry Policy"), Milestone 4.6 ("Dead Letter Runtime"), and
Milestone 4.7 ("Queue Metrics").

Responsibility
--------------
Queue owns every QueueItem waiting for exactly ONE responsibility
(Phase 1.4 "Queue Isolation" — e.g. "the Website Queue", "the Storage
Queue"). It answers exactly two questions for that single queue:

    - what's next? (peek() / dequeue())
    - how much is waiting? (size() / is_empty())

and lets a caller add new work (enqueue()) or take the next item off
(dequeue()). This is the same shape of responsibility WorkerGroup
(workers/worker_group.py) has for one worker type — Queue is its
direct architectural mirror on the work side:

    WorkerGroup  manages availability of WorkerHandles for one
                 WorkerDefinition (idle set / busy set).
    Queue        manages FIFO storage of QueueItems for one
                 QueueDefinition (pending storage only).

Queue does not decide *when* an item is enqueued or dequeued, does not
know what worker (if any) will process an item, and does not know
about sessions, providers, or businesses — it only stores QueueItems
(queue_item.py) in the order they arrived. Exactly like WorkerGroup
never constructs a BaseWorker or calls a BaseWorker lifecycle method,
Queue never constructs a Worker, never calls anything on one, and
never reads WorkerRegistry/WorkerPool/WorkerAllocator — see
queues/README.md for the full independence statement.

Ownership
---------
Queue owns exactly three things (Milestone 4.1), plus two more added
across Milestones 4.2 and 4.3:

    - one QueueDefinition (queue_definition.py) — immutable
      configuration, set once at construction.
    - one QueueRecord (queue_record.py) — mutable runtime counters,
      kept in sync with this Queue's own FIFO storage.
    - FIFO storage of QueueItem objects (a collections.deque), which
      this Queue alone reads and mutates.
    - (Milestone 4.2) a private reservation index — queue_item_id ->
      Reservation (reservation.py) — plus one ReservationRecord
      (reservation_record.py) of runtime counters describing it. See
      "Reservations (Milestone 4.2)" below.
    - (Milestone 4.3) a private lease index — lease_id -> Lease
      (lease.py), ordered for cheap expiration — describing which of
      those Reservations additionally carry a time limit. See "Lease
      Expiration (Milestone 4.3)" below.
    - (Milestone 4.5) a private retry index — queue_item_id ->
      RetryRecord (retry_record.py) — describing how many attempts
      each retried QueueItem has accumulated. See "Retry Bookkeeping
      (Milestone 4.5)" below.
    - (Milestone 4.6) a private dead letter index — queue_item_id ->
      DeadLetter (dead_letter.py) — plus one DeadLetterRecord
      (dead_letter_record.py) of runtime counters describing it. See
      "Dead Letter Bookkeeping (Milestone 4.6)" below.

Reservations (Milestone 4.2)
------------------------------
Phase 1.4's "Reservation Model" describes temporary ownership of one
QueueItem by one Worker:

    QueueItem -> Reservation -> One Worker

A QueueItem is either Reserved (exactly one active Reservation exists
for its queue_item_id) or Unreserved (none does) — never both. This
Queue is the sole owner of that fact. It is tracked in a private,
internal index (the `_ReservationIndex` class below) rather than as a
field on QueueItem itself, so QueueItem stays exactly as immutable and
as small as Milestone 4.1 left it — see queue_item.py's module
docstring for the reasoning. The index maps queue_item_id ->
Reservation; nothing outside this Queue reads or mutates it directly.

reserve() / release() / is_reserved() / reservation() are plain
claim-and-release operations, now joined by clock-driven expiration:

    - reserve() fails cleanly (raises QueueReservationError) if the
      QueueItem is not present in this queue, or if it is already
      reserved (Phase 1.4 "Only one Worker may own one reservation at
      a time"). If called with a ttl_seconds, it also creates a Lease
      (see below) governing when this reservation expires.
    - release() removes the reservation (and its Lease, if any) and
      returns the QueueItem to Unreserved status (Phase 1.4
      "Reservation expiration returns the QueueItem to the Queue" —
      this milestone's release() is the explicit, caller-initiated
      version of that; see expire_leases() for the clock-driven
      version).
    - Reservations do not execute work, do not retry work, and do not
      know about worker liveness — see the class docstring below for
      the full list of what reservations deliberately do NOT do.

Lease Expiration (Milestone 4.3)
-----------------------------------
A Reservation created with a ttl_seconds is *leased*: a Lease
(lease.py) is minted alongside it, recording exactly when that
reservation's ownership lapses. Phase 1.4 describes this directly
("If a Worker exceeds its reservation timeout, the reservation
expires and another Worker may continue"). This milestone makes that
real:

    - expire_leases() reclaims every Lease whose expires_at has been
      reached: the Reservation it belonged to is removed, and the
      QueueItem becomes immediately reservable again. The QueueItem
      itself never left this queue's FIFO storage, so nothing is
      "returned" beyond dropping the reservation — the same shape
      release() already has, just triggered by the clock instead of a
      caller.
    - expired_count() reports the cumulative number of leases this
      queue has reclaimed.

Nothing about expiration involves a worker, a callback, a retry, or a
log line — see the QueueReservationError / _LeaseIndex docstrings and
the class docstring's "Explicitly NOT this milestone's job" list.
Worker liveness (whether the worker holding a lease is still healthy)
is Phase 4.4, not this milestone: a lease can lapse even for a
perfectly healthy worker that simply ran past its ttl_seconds.

Scaling note: expire_leases() does not scan every active reservation
looking for lapsed ones. The private `_LeaseIndex` below keeps active
leases in a min-heap ordered by expires_at, so a call only ever does
O(k log n) work, where k is the number of leases actually due and n is
the number of leases currently outstanding — not the number of
reservations that happen to still be within their ttl. See
`_LeaseIndex`'s own docstring for the stale-heap-entry handling that
makes this correct alongside release().

Retry Bookkeeping (Milestone 4.5)
------------------------------------
Phase 1.4's "Retry Philosophy" describes retry state as belonging to
QueueItems, decided by the Queue rather than by any Worker. This
milestone makes the *bookkeeping* half of that real — not execution:

    - can_retry(queue_item_id) answers "may this item be retried
      again?" by comparing its recorded attempt count against this
      queue's QueueDefinition.retry_policy (retry_policy.py). A queue
      with no retry_policy configured permits no retries at all.
    - record_attempt(queue_item_id) records one failed attempt:
      increments the attempt count, stamps the time, and recomputes
      eligibility — nothing else. It does not require
      `queue_item_id` to still be present in this queue's FIFO
      storage, because the normal case is a QueueItem that has
      already been dequeued (directly, or via a reservation that has
      since been released/expired) and then failed elsewhere.
    - attempt_count(queue_item_id) reports how many attempts have
      been recorded so far (0 if record_attempt() was never called
      for it).

Like reservations, this state is tracked in a private, internal index
(`_RetryIndex` below) rather than as a field on QueueItem — see
queue_item.py's "Retry ownership" section for why. Unlike the
reservation and lease indexes, `_RetryIndex` is never touched by
enqueue(), dequeue(), reserve(), release(), or expire_leases(): retry
bookkeeping this milestone is entirely driven by explicit
record_attempt() calls from whatever caller decided a QueueItem's
processing failed (a future milestone's job, not this Queue's — see
queue_manager.py's independence statement). None of these three
methods enqueues, dequeues, sleeps, delays, or executes a retry — see
the class docstring's "Explicitly NOT this milestone's job" list.

Dead Letter Bookkeeping (Milestone 4.6)
-------------------------------------------
Phase 1.4's "Retry Philosophy" describes a QueueItem's retry count
increasing on failure and the Queue reassigning it "later" — but says
nothing about a QueueItem that has exhausted its retries, or that
otherwise must never be retried at all. This milestone records that
outcome as a bookkeeping fact, without building the "later" itself:

    - dead_letter(queue_item_id, reason, detail=None) records that
      `queue_item_id` has permanently failed: a DeadLetter
      (dead_letter.py) is created, carrying a structured
      DeadLetterReason and an optional free-form detail string.
      Raises QueueDeadLetterError if `queue_item_id` has already been
      dead-lettered — a QueueItem may be dead-lettered at most once,
      exactly as a reservation may only be held by one Worker at a
      time. Does not require `queue_item_id` to still be present in
      this queue's FIFO storage — the normal case, exactly as with
      record_attempt(), is a QueueItem that has already left this
      queue (dequeued, or via a reservation that has since ended) and
      failed permanently elsewhere.
    - is_dead_letter(queue_item_id) answers "has this QueueItem been
      permanently failed?" — True/False, no detail.
    - dead_letter_count() reports the cumulative number of QueueItems
      this queue has dead-lettered.

Like reservations and retries, this state is tracked in a private,
internal index (`_DeadLetterIndex` below) rather than as a field on
QueueItem — see queue_item.py's "Dead letter ownership" section for
why. dead_letter() is the only place this milestone's Queue writes to
QueueRecord.failed_count (queue_record.py): recording a permanent
failure is exactly the transition queue_record.py's Milestone 4.1
TODO anticipated ("a permanent failure... will move it to
failed_count"). Nothing else changes about the underlying QueueItem —
it is never moved, duplicated, or removed from wherever it already
was; there is no second, physical "dead letter queue" (see
dead_letter.py's "Explicitly not a queue" section). Like `_RetryIndex`,
`_DeadLetterIndex` is never touched by enqueue(), dequeue(), reserve(),
release(), or expire_leases() — dead lettering this milestone is
entirely driven by explicit dead_letter() calls from whatever caller
decided a QueueItem's failure is permanent (a future milestone's job,
not this Queue's). dead_letter() does not remove any QueueItem, does
not retry, does not schedule, does not notify a Worker, WorkerPool, or
QueueManager — see the class docstring's "Explicitly NOT this
milestone's job" list.

Metrics (Milestone 4.7)
---------------------------
Phase 1.4's Concurrency and Fairness sections, and AD-017's
"Resource Utilization" priority, both describe wanting visibility
into how work is moving through the engine — but neither describes
*building* that visibility. This milestone adds exactly that, and
nothing else:

    - metrics() collects a single QueueMetrics (queue_metrics.py)
      snapshot: pending items, reserved items, active leases,
      currently-retrying items, cumulative dead-lettered items, total
      processed, and utilization — all read from this queue's
      existing FIFO storage, QueueRecord, ReservationRecord, retry
      index, and DeadLetterRecord, under this queue's existing lock.
    - processed_count() reports QueueRecord.completed_count +
      QueueRecord.failed_count in isolation (the same number metrics()
      places on QueueMetrics.total_processed), for a caller that
      wants just that one figure.
    - utilization() reports the same reserved_items / (pending_items
      + reserved_items) ratio metrics() places on
      QueueMetrics.utilization, in isolation.

None of these three methods creates, mutates, moves, retries, expires,
or removes anything — see the class docstring's "Explicitly NOT this
milestone's job" list below. They are read-only summaries of state
that Milestones 4.1 through 4.6 already built and already keep
current; this milestone adds no new counters of its own, and
QueueMetrics is never treated as a source of truth (see
queue_metrics.py's "Explicitly not a second source of truth"
section) — QueueRecord, ReservationRecord, and the private retry/
dead-letter indexes remain exactly as authoritative as before.

Ordering & Behavior
--------------------
Strict FIFO only (Phase 1.4 does not describe priority queues for this
milestone's scope): enqueue() appends to the right of the deque,
dequeue() pops from the left. No priorities and no delayed jobs — both
remain explicitly out of scope and future work (see queues/README.md
and the TODOs below). Retry *eligibility* is tracked (Milestone 4.5),
and permanent-failure *bookkeeping* is now tracked too (Milestone
4.6, see above), but *execution* of either — actually re-enqueueing an
item and running it again, or routing a dead-lettered item somewhere
new — remains just as out of scope as it was before this milestone.

Status
------
FOUNDATION + LIVE EXPIRATION + RETRY BOOKKEEPING + DEAD LETTER
BOOKKEEPING + METRICS (Milestone 4.7). Queue manages FIFO storage,
reservation claim/release, clock-driven lease expiration,
retry-eligibility bookkeeping, permanent-failure bookkeeping, and now
read-only metrics snapshots for one queue. It still does not schedule
work, does not execute work, does not execute a retry, does not route
a dead-lettered item anywhere, does not allocate or notify a worker,
and does not know about workers, providers, businesses, or sessions —
see the module docstring above and queues/queue_manager.py's module
docstring for the manager-level equivalent of this same boundary.

TODO(future milestones):
    - Phase 4.4 (Worker Liveness): heartbeat.py will track whether the
      worker holding a lease is still alive, which is a distinct
      concept from the lease itself lapsing (this milestone). Whether
      a live-but-slow worker gets its lease renewed, and by what
      mechanism, is not decided here.
    - A future Queue Framework milestone will actually act on
      can_retry()'s answer: re-enqueueing an eligible QueueItem (per
      RetryPolicy.retry_delay_seconds/strategy — retry_policy.py), or
      calling dead_letter() for a permanently ineligible one. None of
      that decision logic exists yet — record_attempt() and
      dead_letter() only update this queue's private bookkeeping; they
      do not touch the underlying QueueItem and do not re-enqueue,
      dequeue, route, or execute anything.
    - A future milestone may build an actual routing/inspection
      mechanism on top of dead_letter_count() / is_dead_letter() (e.g.
      surfacing dead-lettered items to an operator). Nothing here
      builds that.
    - A future monitoring/allocation-policy layer may poll metrics()
      on a timer, or expose it over an API, to make scaling or
      alerting decisions (see queue_metrics.py's own TODO). Nothing
      here builds that; this milestone only produces the snapshot.
"""

from __future__ import annotations

import heapq
import threading
from collections import deque
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional, Tuple
from uuid import uuid4

from queues.dead_letter import DeadLetter, DeadLetterReason
from queues.dead_letter_record import DeadLetterRecord
from queues.lease import Lease
from queues.queue_definition import QueueDefinition
from queues.queue_item import QueueItem
from queues.queue_metrics import QueueMetrics
from queues.queue_record import QueueRecord
from queues.reservation import Reservation
from queues.reservation_record import ReservationRecord
from queues.retry_record import RetryRecord


class QueueReservationError(RuntimeError):
    """
    Raised for illegal reservation operations on a Queue: reserving a
    queue_item_id that does not exist in this queue, reserving a
    queue_item_id that is already reserved (Phase 1.4 "Only one Worker
    may own one reservation at a time"), or releasing a queue_item_id
    that has no active reservation.

    This says nothing about a QueueItem's FIFO position or a Queue's
    pending count — it is reservation bookkeeping validation only,
    mirroring how QueueManagerError (queue_manager.py) is
    manager-level bookkeeping validation only. Lease expiration
    (expire_leases()) never raises this — a lapsed lease is expected,
    routine behavior, not an illegal operation.
    """


class QueueDeadLetterError(RuntimeError):
    """
    Raised for illegal dead-letter operations on a Queue: dead
    lettering a queue_item_id that has already been dead-lettered.

    This says nothing about a QueueItem's FIFO position, its
    reservation status, or its retry eligibility — it is dead-letter
    bookkeeping validation only, mirroring how QueueReservationError
    is reservation bookkeeping validation only. Unlike reserve(),
    dead_letter() does not require `queue_item_id` to currently be
    present in this queue's FIFO storage (see Queue.dead_letter()'s
    docstring), so this error is never raised for that reason.
    """


class _ReservationIndex:
    """
    Private, internal helper owned by exactly one Queue instance.
    Maps queue_item_id -> Reservation for every QueueItem currently
    Reserved in that Queue. Not part of any public API — no code
    outside this module touches an instance of this class.

    Keeping this index separate from QueueItem (rather than adding a
    `reservation` field to that frozen dataclass) is what lets
    QueueItem stay immutable and unchanged by reserve()/release(): a
    QueueItem's Reserved/Unreserved status is a fact *about* the item,
    looked up here by the item's id, not a field carried *on* the
    item. It also keeps reservation lookup, release, and any future
    expiration sweep O(1) / O(active reservations) rather than
    requiring a scan of the FIFO deque.

    This class has no lock of its own — every call into it happens
    from inside a Queue method that already holds Queue._lock (see
    the Queue class docstring's "Thread Safety" note), so it does not
    need to be thread-safe on its own.
    """

    def __init__(self) -> None:
        self._by_item_id: Dict[str, Reservation] = {}

    def add(self, queue_item_id: str, reservation: Reservation) -> None:
        self._by_item_id[queue_item_id] = reservation

    def get(self, queue_item_id: str) -> Optional[Reservation]:
        return self._by_item_id.get(queue_item_id)

    def remove(self, queue_item_id: str) -> Optional[Reservation]:
        return self._by_item_id.pop(queue_item_id, None)

    def __contains__(self, queue_item_id: str) -> bool:
        return queue_item_id in self._by_item_id


class _LeaseIndex:
    """
    Private, internal helper owned by exactly one Queue instance.
    Tracks every Lease (lease.py) currently outstanding for that
    Queue's reservations, and answers "which leases are due by time
    T?" without scanning every active reservation.

    Not part of any public API — no code outside this module touches
    an instance of this class. Has no lock of its own, for the same
    reason `_ReservationIndex` does not: every call into it happens
    from inside a Queue method that already holds Queue._lock.

    Internal structure
    -------------------
    A dict (lease_id -> (Lease, queue_item_id)) is the source of
    truth for "is this lease still outstanding, and which QueueItem
    does it belong to". Alongside it, a binary min-heap of
    (expires_at, lease_id) tuples gives expire_due() cheap access to
    the *soonest*-expiring lease without sorting or scanning the
    whole set on every call — popping from a heap while its root is
    already due is O(log n) per lease popped, not O(n) per call.

    Stale heap entries: remove() (called by Queue.release() and by
    Queue.dequeue()'s defensive cleanup) deletes a lease from the
    dict but deliberately leaves any corresponding heap entry in
    place — removing an arbitrary element from a heap is O(n), and
    doing that on every release() would reintroduce the full-scan cost
    this structure exists to avoid. Instead, expire_due() treats a
    popped heap entry whose lease_id is no longer in the dict as
    stale and silently discards it. This is safe because the dict is
    always the source of truth; the heap is only ever a hint about
    ordering, never authoritative about what is still outstanding.
    """

    def __init__(self) -> None:
        self._by_lease_id: Dict[str, Tuple[Lease, str]] = {}
        self._heap: List[Tuple[datetime, str]] = []

    def add(self, lease: Lease, queue_item_id: str) -> None:
        self._by_lease_id[lease.lease_id] = (lease, queue_item_id)
        heapq.heappush(self._heap, (lease.expires_at, lease.lease_id))

    def remove(self, lease_id: str) -> None:
        # Drop from the dict only; the matching heap entry (if any)
        # is left in place and discarded lazily by expire_due() — see
        # the class docstring's "Stale heap entries" note.
        self._by_lease_id.pop(lease_id, None)

    def expire_due(self, now: datetime) -> List[Tuple[Lease, str]]:
        """
        Pop and return every (Lease, queue_item_id) pair whose
        expires_at <= now, removing each from this index. Leaves any
        lease with expires_at > now untouched. O(k log n) where k is
        the number of entries returned (including stale ones
        discarded along the way) and n is the current heap size —
        never a scan of every outstanding lease.
        """
        due: List[Tuple[Lease, str]] = []
        while self._heap and self._heap[0][0] <= now:
            _expires_at, lease_id = heapq.heappop(self._heap)
            entry = self._by_lease_id.pop(lease_id, None)
            if entry is None:
                # Stale: already removed via release() (or a previous
                # expire_due() call already consumed it). Not a
                # violation of anything — just skip it.
                continue
            lease, queue_item_id = entry
            due.append((lease, queue_item_id))
        return due

    def __len__(self) -> int:
        return len(self._by_lease_id)


class _RetryIndex:
    """
    Private, internal helper owned by exactly one Queue instance.
    Maps queue_item_id -> RetryRecord (retry_record.py) for every
    QueueItem this Queue has recorded at least one retry attempt
    against. Not part of any public API — no code outside this module
    touches an instance of this class.

    Keeping this index separate from QueueItem (rather than adding an
    `attempts` field to that frozen dataclass) is exactly the same
    reasoning `_ReservationIndex` above already documents for
    reservations — see that class's docstring and queue_item.py's
    "Retry ownership" section.

    Unlike `_ReservationIndex`, entries here are never removed by this
    milestone: there is no release()/expire_leases() equivalent for
    retry bookkeeping, and no dequeue()-triggered cleanup, because
    nothing in this milestone ever decides a QueueItem is "done"
    retrying and reclaims its RetryRecord — that decision belongs to
    whichever future milestone builds retry execution and dead-letter
    handling (see retry_policy.py's Status section).

    This class has no lock of its own — every call into it happens
    from inside a Queue method that already holds Queue._lock (see
    the Queue class docstring's "Thread Safety" note), so it does not
    need to be thread-safe on its own.
    """

    def __init__(self) -> None:
        self._by_item_id: Dict[str, RetryRecord] = {}

    def get(self, queue_item_id: str) -> Optional[RetryRecord]:
        return self._by_item_id.get(queue_item_id)

    def get_or_create(self, queue_item_id: str) -> RetryRecord:
        record = self._by_item_id.get(queue_item_id)
        if record is None:
            record = RetryRecord(queue_item_id=queue_item_id)
            self._by_item_id[queue_item_id] = record
        return record

    def count_eligible(self) -> int:
        """
        (Milestone 4.7) Number of RetryRecords currently tracked here
        whose eligible_for_retry is True — i.e. QueueItems that have
        failed at least once (record_attempt() has been called for
        them) and remain eligible for a further attempt right now.
        Read-only: does not create, mutate, or remove any
        RetryRecord. Used only by Queue.metrics() /
        Queue.processed_count()'s sibling Queue.utilization() context
        to populate QueueMetrics.retrying_items — see
        queue_metrics.py.
        """
        return sum(
            1 for record in self._by_item_id.values() if record.eligible_for_retry
        )


class _DeadLetterIndex:
    """
    Private, internal helper owned by exactly one Queue instance.
    Maps queue_item_id -> DeadLetter (dead_letter.py) for every
    QueueItem this Queue has recorded as permanently failed. Not part
    of any public API — no code outside this module touches an
    instance of this class.

    Keeping this index separate from QueueItem (rather than adding a
    `dead_letter` field to that frozen dataclass) is exactly the same
    reasoning `_ReservationIndex` and `_RetryIndex` above already
    document — see those classes' docstrings and queue_item.py's
    "Dead letter ownership" section.

    Unlike `_ReservationIndex`, entries here are never removed by this
    milestone: there is no "un-dead-letter" operation, because a
    permanent failure is exactly that — permanent. A queue_item_id
    already present here is exactly how dead_letter() recognizes a
    duplicate call and raises QueueDeadLetterError instead of silently
    overwriting the first record.

    This class has no lock of its own — every call into it happens
    from inside a Queue method that already holds Queue._lock (see
    the Queue class docstring's "Thread Safety" note), so it does not
    need to be thread-safe on its own.
    """

    def __init__(self) -> None:
        self._by_item_id: Dict[str, DeadLetter] = {}

    def add(self, queue_item_id: str, dead_letter: DeadLetter) -> None:
        self._by_item_id[queue_item_id] = dead_letter

    def get(self, queue_item_id: str) -> Optional[DeadLetter]:
        return self._by_item_id.get(queue_item_id)

    def __contains__(self, queue_item_id: str) -> bool:
        return queue_item_id in self._by_item_id

    def __len__(self) -> int:
        return len(self._by_item_id)


class Queue:
    """
    Owns FIFO storage of QueueItems for one QueueDefinition, plus that
    queue's QueueRecord counters. Performs no scheduling, no retry,
    and never references a Worker, WorkerPool, WorkerAllocator,
    Provider, or Session — see the module docstring for exactly what
    is (and is not) in scope.

    All public methods — including the reservation methods added in
    Milestone 4.2 (reserve(), release(), is_reserved(), reservation()),
    the lease-expiration methods added in Milestone 4.3
    (expire_leases(), expired_count()), the retry-bookkeeping methods
    added in Milestone 4.5 (can_retry(), record_attempt(),
    attempt_count()), and the dead-letter bookkeeping methods added in
    Milestone 4.6 (dead_letter(), is_dead_letter(),
    dead_letter_count()) — are protected by the *same single*
    `threading.RLock` (re-entrant, not an async primitive) that
    already guards FIFO storage and QueueRecord counters, so this
    queue's FIFO storage, its QueueRecord counters, its reservation
    index, its lease index, its retry index, and its dead-letter index
    can all be read and mutated safely from multiple threads at once
    (e.g. one producer enqueuing while another caller reserves, a
    third releases, a fourth calls expire_leases(), a fifth calls
    record_attempt() for a failed item, and a sixth calls
    dead_letter() for a permanently failed one). Concurrent
    record_attempt() calls for the same queue_item_id can never
    interleave — whichever call acquires the lock first fully applies
    its increment (and recomputes eligible_for_retry) before the next
    even reads the record, so two concurrent failures are never lost
    or double-counted. The same holds for dead_letter(): two
    concurrent calls for the same queue_item_id can never both
    succeed — whichever acquires the lock first records the
    DeadLetter and increments the counters; the other, running after,
    finds the queue_item_id already present in the dead-letter index
    and raises QueueDeadLetterError instead of double-counting it.
    Reusing the existing lock rather than adding a
    second one means these operations can never interleave with each
    other: whichever call acquires the lock first runs to completion
    before the next is even evaluated. In particular, expire_leases()
    and release() racing on the *same* queue_item_id can never both
    "win" — one of them acquires the lock, finds the reservation (and
    removes it), and the other, running after, finds nothing left to
    remove and is a clean no-op (release() raises
    QueueReservationError for a queue_item_id with no active
    reservation, which is exactly correct: by the time it ran, the
    lease had already reclaimed it).
    """

    def __init__(self, definition: QueueDefinition) -> None:
        self._lock = threading.RLock()
        self._definition = definition
        self._record = QueueRecord(
            queue_id=definition.queue_id,
            created_at=self._now(),
        )
        # FIFO storage: enqueue() appends right, dequeue() pops left.
        # This Queue is the only object that ever reads or mutates
        # this deque.
        self._items: "deque[QueueItem]" = deque()
        # Milestone 4.2: private reservation bookkeeping. Neither of
        # these is exposed as a public attribute or property — the
        # public surface for reservations is exactly reserve() /
        # release() / is_reserved() / reservation().
        self._reservations = _ReservationIndex()
        self._reservation_record = ReservationRecord(
            queue_id=definition.queue_id,
            created_at=self._now(),
        )
        # Milestone 4.3: private lease bookkeeping. Not exposed as a
        # public attribute — the public surface for leases is exactly
        # expire_leases() / expired_count() (reserve()/release()
        # manage it internally too, as part of managing reservations).
        self._leases = _LeaseIndex()
        # Milestone 4.5: private retry bookkeeping. Not exposed as a
        # public attribute — the public surface for retries is exactly
        # can_retry() / record_attempt() / attempt_count().
        self._retries = _RetryIndex()
        # Milestone 4.6: private dead-letter bookkeeping. Not exposed
        # as a public attribute — the public surface for dead letters
        # is exactly dead_letter() / is_dead_letter() /
        # dead_letter_count().
        self._dead_letters = _DeadLetterIndex()
        self._dead_letter_record = DeadLetterRecord(
            queue_id=definition.queue_id,
            created_at=self._now(),
        )

    @property
    def definition(self) -> QueueDefinition:
        """The QueueDefinition this queue was configured with."""
        return self._definition

    @property
    def record(self) -> QueueRecord:
        """
        This queue's live QueueRecord. Returned by reference — the
        counters on it change as enqueue()/dequeue() are called.
        """
        return self._record

    # -- FIFO operations -----------------------------------------------------

    def enqueue(
        self,
        pipeline_id: str,
        stage: Optional[str] = None,
        payload: Optional[Any] = None,
    ) -> QueueItem:
        """
        Create a new QueueItem for `pipeline_id` (Phase 1.4 "Pipeline
        Ownership" — the constant identity of the Business this item
        belongs to) and append it to the back of this queue.

        Mints a new queue_item_id (uuid4 hex) and created_at timestamp
        — a caller never supplies either. retry_count is always 0 for
        a freshly enqueued item (this milestone's Queue never
        constructs an item with a nonzero retry_count; see
        queue_item.py).

        Returns the QueueItem that was stored.
        """
        with self._lock:
            item = QueueItem(
                queue_item_id=uuid4().hex,
                pipeline_id=pipeline_id,
                stage=stage,
                payload=payload,
                created_at=self._now(),
                retry_count=0,
            )
            self._items.append(item)
            self._record.pending_count += 1
            return item

    def dequeue(self) -> Optional[QueueItem]:
        """
        Remove and return the QueueItem at the front of this queue
        (FIFO — the oldest still-pending item), or None if the queue
        is empty.

        Plain FIFO pop only. No reservation is created and nothing
        tracks who called this — see the module docstring's TODO for
        where reservation semantics will be layered on in a future
        milestone.
        """
        with self._lock:
            if not self._items:
                return None
            item = self._items.popleft()
            self._record.pending_count -= 1
            # Milestone 4.2 safety net: if this item happened to have
            # an active reservation, purge it (and its lease, if any
            # — Milestone 4.3) so neither index ever points at a
            # queue_item_id that has left this Queue's FIFO storage.
            # This milestone's intended flow is reserve() -> ... ->
            # release()/expiration on items that stay in the deque
            # throughout (see reserve()'s docstring); a reserved item
            # being dequeued out from under its reservation is not a
            # case Phase 1.4 describes for this milestone, so this is
            # defensive cleanup only, not a feature (it does not
            # decide whether the item "completed" or "failed" — a
            # future ack/retry milestone owns that).
            removed = self._reservations.remove(item.queue_item_id)
            if removed is not None:
                self._reservation_record.active_count -= 1
                if removed.lease_id is not None:
                    self._leases.remove(removed.lease_id)
                    self._reservation_record.active_lease_count -= 1
            return item

    def peek(self) -> Optional[QueueItem]:
        """
        Return the QueueItem at the front of this queue (the item the
        next dequeue() would return) without removing it, or None if
        the queue is empty.
        """
        with self._lock:
            if not self._items:
                return None
            return self._items[0]

    # -- counts --------------------------------------------------------------

    def size(self) -> int:
        """Number of QueueItems currently pending in this queue."""
        with self._lock:
            return len(self._items)

    def is_empty(self) -> bool:
        """Whether this queue currently has no pending QueueItems."""
        with self._lock:
            return len(self._items) == 0

    # -- reservations (Milestone 4.2) -----------------------------------

    def reserve(
        self,
        queue_item_id: str,
        worker_id: str,
        ttl_seconds: Optional[float] = None,
    ) -> Reservation:
        """
        Claim temporary ownership of the QueueItem identified by
        `queue_item_id` on behalf of `worker_id` (Phase 1.4
        "Reservation Model" — "Only one Worker may own one reservation
        at a time").

        The QueueItem stays exactly where it is in this queue's FIFO
        storage; reserve() does not dequeue it and does not otherwise
        change size()/peek()/dequeue() behavior. It only records, in
        this Queue's private reservation index, that `worker_id` now
        owns it — so a caller can still see the item (e.g. via
        peek()) while knowing not to act on it if is_reserved() says
        it's already claimed.

        `ttl_seconds`, if given, mints a Lease (lease.py) expiring
        `ttl_seconds` seconds after now, and attaches it to the
        returned Reservation via its lease_id. A future
        expire_leases() call will reclaim this reservation once that
        Lease lapses (Milestone 4.3). If `ttl_seconds` is omitted, no
        Lease is created and this reservation never expires on its
        own — only an explicit release() (or a dequeue() of the
        underlying item) will end it.

        Raises QueueReservationError if `queue_item_id` is not
        currently present in this queue, or if it already has an
        active reservation. Mints a new reservation_id (uuid4 hex)
        every call — a caller never supplies one, mirroring how
        enqueue() mints queue_item_id.
        """
        if not worker_id:
            raise ValueError("reserve() requires a non-empty worker_id")
        with self._lock:
            if self._find_item(queue_item_id) is None:
                raise QueueReservationError(
                    f"no QueueItem {queue_item_id!r} is present in this queue"
                )
            if queue_item_id in self._reservations:
                raise QueueReservationError(
                    f"QueueItem {queue_item_id!r} is already reserved"
                )
            reservation_id = uuid4().hex
            reserved_at = self._now()

            lease: Optional[Lease] = None
            if ttl_seconds is not None:
                lease = Lease(
                    lease_id=uuid4().hex,
                    reservation_id=reservation_id,
                    created_at=reserved_at,
                    expires_at=reserved_at + timedelta(seconds=ttl_seconds),
                )

            reservation = Reservation(
                reservation_id=reservation_id,
                queue_item_id=queue_item_id,
                worker_id=worker_id,
                reserved_at=reserved_at,
                lease_id=lease.lease_id if lease is not None else None,
            )
            self._reservations.add(queue_item_id, reservation)
            self._reservation_record.active_count += 1

            if lease is not None:
                self._leases.add(lease, queue_item_id)
                self._reservation_record.active_lease_count += 1

            return reservation

    def release(self, queue_item_id: str) -> None:
        """
        Give up the active reservation on the QueueItem identified by
        `queue_item_id`, returning it to Unreserved status (Phase 1.4
        "Reservation expiration returns the QueueItem to the Queue" —
        this is that same return, triggered explicitly by a caller
        rather than by a clock).

        The QueueItem itself is untouched and was never removed from
        this queue's FIFO storage, so nothing needs to be re-enqueued
        — release() only removes the reservation entry (and its Lease,
        if it had one — Milestone 4.3), after which the same
        queue_item_id is eligible for reserve() again.

        Raises QueueReservationError if `queue_item_id` has no active
        reservation in this queue.
        """
        with self._lock:
            reservation = self._reservations.remove(queue_item_id)
            if reservation is None:
                raise QueueReservationError(
                    f"QueueItem {queue_item_id!r} has no active reservation"
                )
            self._reservation_record.active_count -= 1
            if reservation.lease_id is not None:
                self._leases.remove(reservation.lease_id)
                self._reservation_record.active_lease_count -= 1

    def is_reserved(self, queue_item_id: str) -> bool:
        """
        Whether the QueueItem identified by `queue_item_id` currently
        has an active reservation in this queue. False for a
        queue_item_id that is not even present in this queue, exactly
        as it is for one that is present but Unreserved — this method
        answers only the Reserved/Unreserved question, not presence.
        """
        with self._lock:
            return queue_item_id in self._reservations

    def reservation(self, queue_item_id: str) -> Optional[Reservation]:
        """
        Return the active Reservation for `queue_item_id`, or None if
        it has no active reservation (whether because it was never
        reserved, was already released, expired, or is not present in
        this queue at all).
        """
        with self._lock:
            return self._reservations.get(queue_item_id)

    # -- lease expiration (Milestone 4.3) --------------------------------

    def expire_leases(self) -> int:
        """
        Reclaim every Lease whose expires_at has been reached
        (Phase 1.4 "Fairness" — "If a Worker exceeds its reservation
        timeout, the reservation expires and another Worker may
        continue.").

        For each lapsed Lease: its Reservation is removed from this
        queue's reservation index, and the underlying QueueItem
        immediately becomes available for reserve() again — it was
        never removed from FIFO storage, so nothing else changes
        about it. Nothing else happens: no retry, no worker
        notification, no logging, no callback, and no QueueManager
        interaction. A caller that wants expiration to actually run
        must call this method (e.g. on a timer, or before attempting
        a reserve()) — nothing calls it automatically.

        Never raises QueueReservationError — an empty or all-current
        set of leases is a normal, silent no-op. Does not scan every
        active reservation: see `_LeaseIndex` for how this stays
        cheap as the number of outstanding reservations grows.

        Returns the number of leases reclaimed by this call (0 if
        none were due).
        """
        with self._lock:
            now = self._now()
            due = self._leases.expire_due(now)
            reclaimed = 0
            for _lease, queue_item_id in due:
                removed = self._reservations.remove(queue_item_id)
                if removed is None:
                    # Already gone (e.g. dequeue()'s defensive cleanup
                    # beat us to it in a prior call). Nothing to
                    # reclaim twice.
                    continue
                self._reservation_record.active_count -= 1
                self._reservation_record.active_lease_count -= 1
                self._reservation_record.expired_count += 1
                self._reservation_record.expired_lease_count += 1
                reclaimed += 1
            return reclaimed

    def expired_count(self) -> int:
        """
        Cumulative number of leases this queue has reclaimed via
        expire_leases() over its lifetime. Monotonically
        non-decreasing — reads this queue's ReservationRecord counter
        rather than tracking anything separately.
        """
        with self._lock:
            return self._reservation_record.expired_lease_count

    # -- retry bookkeeping (Milestone 4.5) --------------------------------

    def can_retry(self, queue_item_id: str) -> bool:
        """
        Whether the QueueItem identified by `queue_item_id` may still
        be retried, per this queue's QueueDefinition.retry_policy
        (retry_policy.py).

        Answers only "may this item be retried again?" — never "when
        should it retry", "who retries it", or "where should it go if
        not" (see retry_policy.py's module docstring for the full
        list of questions this milestone does not answer).

        Returns False if this queue has no retry_policy configured at
        all — no policy means no retries are permitted, mirroring how
        a reservation created with no ttl_seconds simply never
        produces a Lease. Otherwise reflects the RetryRecord's
        eligible_for_retry field for `queue_item_id` if one exists
        (attempts < policy.max_attempts, last computed by
        record_attempt()), or — for a `queue_item_id` that has never
        had record_attempt() called on it — whether the policy allows
        any attempts at all (policy.max_attempts > 0, always true for
        a valid RetryPolicy). Does not require `queue_item_id` to be
        present in this queue's FIFO storage, and does not create a
        RetryRecord as a side effect of asking.
        """
        with self._lock:
            policy = self._definition.retry_policy
            if policy is None:
                return False
            record = self._retries.get(queue_item_id)
            if record is None:
                return policy.max_attempts > 0
            return record.eligible_for_retry

    def record_attempt(self, queue_item_id: str) -> None:
        """
        Record one failed attempt against the QueueItem identified by
        `queue_item_id` (Phase 1.4 "Retry Philosophy" — "QueueItem
        retry count increases").

        Increments its recorded attempt count by one, stamps
        last_attempt_at with the current time, and recomputes
        eligible_for_retry against this queue's
        QueueDefinition.retry_policy (False, unconditionally, if this
        queue has no retry_policy configured). Creates a RetryRecord
        for `queue_item_id` on first call — a caller does not need to
        call anything else first.

        Pure bookkeeping only: does not enqueue, dequeue, sleep,
        delay, or execute a retry, and does not require
        `queue_item_id` to currently be present in this queue's FIFO
        storage — the normal case is a QueueItem that has already
        left this queue (via dequeue(), or via a reservation that has
        since been released or expired) and failed elsewhere; see
        retry_record.py's module docstring for why this index does
        not check presence.
        """
        with self._lock:
            record = self._retries.get_or_create(queue_item_id)
            record.attempts += 1
            record.last_attempt_at = self._now()
            policy = self._definition.retry_policy
            record.eligible_for_retry = (
                policy is not None and record.attempts < policy.max_attempts
            )

    def attempt_count(self, queue_item_id: str) -> int:
        """
        Number of attempts recorded so far for `queue_item_id` via
        record_attempt(). Zero for a `queue_item_id` that has never
        had record_attempt() called on it (Milestone 4.5 rule:
        "attempt count starts at zero") — does not require presence
        in this queue's FIFO storage.
        """
        with self._lock:
            record = self._retries.get(queue_item_id)
            return record.attempts if record is not None else 0

    # -- dead letter bookkeeping (Milestone 4.6) --------------------------

    def dead_letter(
        self,
        queue_item_id: str,
        reason: DeadLetterReason,
        detail: Optional[str] = None,
    ) -> DeadLetter:
        """
        Record that the QueueItem identified by `queue_item_id` has
        permanently failed (Phase 1.4 "Retry Philosophy" — the
        permanent-failure outcome that "Queue reassigns later" never
        arrives for).

        Creates and stores a DeadLetter (dead_letter.py) carrying a
        freshly minted dead_letter_id (uuid4 hex — a caller never
        supplies one, mirroring enqueue()'s queue_item_id and
        reserve()'s reservation_id), the current time as failed_at,
        and the given structured `reason` (with optional free-form
        `detail`). Also increments this queue's DeadLetterRecord
        counters and QueueRecord.failed_count — the transition
        queue_record.py's Milestone 4.1 TODO anticipated ("a permanent
        failure... will move it to failed_count").

        This is bookkeeping only: it does not remove, move, or
        duplicate the underlying QueueItem, does not retry it, does
        not schedule anything, and does not notify a Worker,
        WorkerPool, or QueueManager — see dead_letter.py's "Explicitly
        not a queue" section. Does not require `queue_item_id` to
        currently be present in this queue's FIFO storage, for the
        same reason record_attempt() does not (retry_record.py) — the
        normal case is a QueueItem that has already left this queue
        and failed permanently elsewhere.

        Raises QueueDeadLetterError if `queue_item_id` has already
        been dead-lettered — a QueueItem may be recorded as
        permanently failed at most once; this method does not
        overwrite or update an existing DeadLetter.

        Returns the DeadLetter that was stored.
        """
        with self._lock:
            if queue_item_id in self._dead_letters:
                raise QueueDeadLetterError(
                    f"QueueItem {queue_item_id!r} has already been dead-lettered"
                )
            failed_at = self._now()
            record = DeadLetter(
                dead_letter_id=uuid4().hex,
                queue_item_id=queue_item_id,
                failed_at=failed_at,
                reason=reason,
                detail=detail,
            )
            self._dead_letters.add(queue_item_id, record)
            self._dead_letter_record.total_dead_letters += 1
            self._dead_letter_record.last_dead_letter_at = failed_at
            self._record.failed_count += 1
            return record

    def is_dead_letter(self, queue_item_id: str) -> bool:
        """
        Whether the QueueItem identified by `queue_item_id` has been
        recorded as permanently failed via dead_letter(). False for a
        `queue_item_id` that has never been dead-lettered, whether or
        not it is currently present in this queue's FIFO storage.
        """
        with self._lock:
            return queue_item_id in self._dead_letters

    def dead_letter_count(self) -> int:
        """
        Cumulative number of QueueItems this queue has dead-lettered
        over its lifetime. Monotonically non-decreasing — reads this
        queue's DeadLetterRecord counter rather than tracking anything
        separately.
        """
        with self._lock:
            return self._dead_letter_record.total_dead_letters

    # -- metrics (Milestone 4.7) ------------------------------------------

    def metrics(self) -> QueueMetrics:
        """
        Collect a single QueueMetrics (queue_metrics.py) snapshot of
        this queue's current operational statistics (Phase 1.4's
        Concurrency/Fairness sections, AD-017's "Resource
        Utilization" priority).

        Every field is read fresh, under this queue's existing lock,
        from state Milestones 4.1 through 4.6 already built and
        already keep current: this queue's own FIFO storage (for
        pending_items), its ReservationRecord (for reserved_items /
        active_leases), its private retry index (for retrying_items),
        its DeadLetterRecord (for dead_letter_items), and its
        QueueRecord (for total_processed). Collecting every field
        under one `with self._lock:` block is what makes the returned
        snapshot internally consistent — every number on it describes
        the same instant, not a mix of instants from separate,
        unsynchronized reads (see the class docstring's "Thread
        Safety" note).

        Purely observational: does not create, mutate, move, retry,
        expire, release, or remove anything, and does not touch
        QueueRecord, ReservationRecord, the retry index, or the
        dead-letter index beyond reading them. Calling this method
        any number of times, in any order relative to any other
        method on this Queue, never changes this queue's behavior —
        see queue_metrics.py's "Explicitly not a second source of
        truth" section.

        Returns a new QueueMetrics each call; nothing is cached or
        reused between calls.
        """
        with self._lock:
            pending_items = len(self._items)
            reserved_items = self._reservation_record.active_count
            active_leases = self._reservation_record.active_lease_count
            retrying_items = self._retries.count_eligible()
            dead_letter_items = self._dead_letter_record.total_dead_letters
            total_processed = self._record.completed_count + self._record.failed_count
            utilization = self._utilization_locked(pending_items, reserved_items)
            return QueueMetrics(
                queue_id=self._definition.queue_id,
                generated_at=self._now(),
                pending_items=pending_items,
                reserved_items=reserved_items,
                active_leases=active_leases,
                retrying_items=retrying_items,
                dead_letter_items=dead_letter_items,
                total_processed=total_processed,
                utilization=utilization,
            )

    def processed_count(self) -> int:
        """
        (Milestone 4.7) QueueRecord.completed_count +
        QueueRecord.failed_count at the moment of the call — the same
        figure metrics() places on QueueMetrics.total_processed,
        available on its own for a caller that does not need a full
        snapshot. completed_count is always 0 as of this milestone
        (queue_record.py's Milestone 4.1 TODO), so this currently
        equals failed_count exactly; read-only, changes nothing.
        """
        with self._lock:
            return self._record.completed_count + self._record.failed_count

    def utilization(self) -> float:
        """
        (Milestone 4.7) reserved_items / (pending_items +
        reserved_items) at the moment of the call, or 0.0 if that sum
        is zero — the same figure metrics() places on
        QueueMetrics.utilization, available on its own for a caller
        that does not need a full snapshot. This queue has no
        configured capacity or concurrency ceiling for this
        milestone's scope, so this is deliberately relative to this
        queue's own current work (waiting plus being worked on), not
        against any external limit — see queue_metrics.py's
        "utilization" field documentation. Read-only, changes
        nothing.
        """
        with self._lock:
            return self._utilization_locked(
                len(self._items), self._reservation_record.active_count
            )

    def _utilization_locked(self, pending_items: int, reserved_items: int) -> float:
        """
        Shared utilization calculation for metrics() and
        utilization(). Must only be called while holding self._lock —
        not itself locking, exactly like _find_item() below, so a
        caller that already holds the lock (metrics()) does not
        re-acquire it and a caller that does not (utilization()) is
        responsible for holding it first.
        """
        total = pending_items + reserved_items
        if total == 0:
            return 0.0
        return reserved_items / total

    # -- internal --------------------------------------------------------

    def _find_item(self, queue_item_id: str) -> Optional[QueueItem]:
        """
        Locate the QueueItem with `queue_item_id` in this queue's FIFO
        storage, or None if no such item is currently present. Used
        only by reserve() to confirm an item exists in this queue
        before claiming it; O(n) in this queue's current size, which
        is acceptable at this milestone's scope (no priority/indexed
        lookup exists elsewhere in Queue either).
        """
        for item in self._items:
            if item.queue_item_id == queue_item_id:
                return item
        return None

    @staticmethod
    def _now() -> datetime:
        return datetime.now(timezone.utc)
