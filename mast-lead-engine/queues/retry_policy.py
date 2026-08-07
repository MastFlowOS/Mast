"""
MAST Engine V2 — Retry Policy
================================

Source: Engine BluePrint, Phase 1.4 ("Queue System, Concurrency &
Recovery" — "Retry Philosophy": "Retries belong to QueueItems...
Workers do not implement retry logic... QueueItem retry count
increases... Queue reassigns later"), AD ("Retry information belongs
to QueueItems", "Workers never implement retry policies"). Milestone
4.5 ("Retry Policy").

Responsibility
--------------
RetryPolicy is the immutable configuration describing how many times,
and under what general shape, a QueueItem belonging to one Queue may
be retried. It carries identity and configuration only — exactly the
same role QueueDefinition (queue_definition.py) already plays for a
Queue as a whole, and the same role RetryPolicy has occupied as an
*opaque* placeholder on QueueDefinition.retry_policy since Milestone
4.1 (queue_definition.py's module docstring: "this milestone's Queue
... is explicitly FIFO-only with 'No retries' in scope. This field
exists so a queue's retry configuration can be attached and carried
now, without this milestone inventing or enforcing what a retry
policy's shape is or does"). This module is that deferred shape,
finally given a concrete definition.

Fields
------
    max_attempts        -- the maximum number of attempts a QueueItem
                            governed by this policy may accumulate
                            (via Queue.record_attempt() — see
                            queue.py) before it is no longer eligible
                            for retry. Queue.can_retry() compares a
                            QueueItem's recorded attempt count
                            (RetryRecord.attempts, retry_record.py)
                            against this value; it does not enforce
                            anything on its own.
    retry_delay_seconds -- how long, in seconds, a caller should wait
                            before attempting a retry. Carried only —
                            this module and Queue.record_attempt() /
                            Queue.can_retry() do not sleep, delay, or
                            schedule anything using this value. A
                            future scheduling milestone (see Status
                            below) is what will actually act on it.
    strategy             -- a free-form, descriptive label for the
                            shape of delay a future scheduler should
                            apply (e.g. "immediate", "fixed_delay";
                            future milestones may introduce others
                            such as "exponential_backoff"). This
                            module does not interpret the string
                            beyond requiring it be non-empty — no
                            branching on its value happens anywhere in
                            this milestone's code.

No Worker, no WorkerPool, no WorkerAllocator, no Provider, no Session,
no Business logic, and no Dead Letter Queue — this module does not
import anything from workers/ or engine/, on purpose, for exactly the
same reason reservation.py and lease.py do not (see those modules'
docstrings and queues/README.md for the full independence statement).

Status
------
FOUNDATION ONLY (Milestone 4.5). A plain, frozen data contract with no
behavior beyond the __post_init__ validation below (mirrors
QueueDefinition's, QueueItem's, Reservation's, and Lease's own
__post_init__ validation pattern). It does not decide *whether* a
given QueueItem may still be retried right now — Queue.can_retry()
does that, by reading this policy alongside a RetryRecord
(retry_record.py); this module only describes the policy's numbers
and label.

Explicitly NOT this module's job (see queue.py for where the one
piece of real behavior — eligibility bookkeeping — lives instead, and
see the TODOs below for what remains genuinely unbuilt):
    - executing a retry (no re-enqueue, no requeue, nothing)
    - scheduling *when* a retry should run (retry_delay_seconds is
      carried, not acted on)
    - deciding *who* retries an item (no Worker reference anywhere)
    - deciding *where* a retried item goes (no Dead Letter Queue
      logic; a permanently-ineligible item is not moved anywhere by
      this milestone)
    - interpreting `strategy` beyond requiring it be a non-empty
      string

TODO(future milestones):
    - A future Queue Framework milestone will build the scheduler that
      actually reads retry_delay_seconds and strategy to decide when
      a retry-eligible QueueItem is re-enqueued, and will build the
      Dead Letter Queue that a permanently-ineligible one (can_retry()
      == False) is moved to. Neither exists yet; this milestone only
      answers "may this item be retried again?", per Phase 1.4's
      "Queue reassigns later" — the "later" is still future work.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True, slots=True)
class RetryPolicy:
    """
    Immutable retry configuration for one Queue. See the module
    docstring for exactly what is (and is not) carried, and why this
    is descriptive-only configuration rather than executable retry
    logic.

    Attributes
    ----------
    max_attempts:
        Maximum number of attempts a governed QueueItem may
        accumulate before Queue.can_retry() reports it ineligible.
    retry_delay_seconds:
        How long a caller should wait before retrying. Carried only;
        not acted on by this milestone.
    strategy:
        Free-form, descriptive label for the retry shape (e.g.
        "immediate", "fixed_delay"). Not interpreted by this
        milestone.
    """

    max_attempts: int
    retry_delay_seconds: float
    strategy: str

    def __post_init__(self) -> None:
        if self.max_attempts < 1:
            raise ValueError("RetryPolicy.max_attempts must be >= 1")
        if self.retry_delay_seconds < 0:
            raise ValueError(
                "RetryPolicy.retry_delay_seconds must be >= 0"
            )
        if not self.strategy:
            raise ValueError("RetryPolicy.strategy must be a non-empty string")
