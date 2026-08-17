"""
MAST Engine V2 — Fan-In Runtime
===================================

Source: AD-042 ("Merge Completion Policy", Architecture Decisions.md),
Phase 6.5 implementation prompt ("Fan-In Runtime"). Closes the gap
`engine/coordinator.py`'s own `build_runtime_context()` docstring
already named and flagged rather than worked around: "No fan-in
primitive exists anywhere in Queue/QueueManager/EngineRuntime for
correlating independent per-business outputs (Website, Instagram,
Contact) back into one MergeInput by pipeline_id... a join is a new
kind of subsystem no Phase 1-6 document defines the shape of."

Architecture review (performed before writing this file)
--------------------------------------------------------------------
1. New component, or extension of EngineRuntime?
   New component. `engine/runtime.py`'s own module docstring defines
   its scope exhaustively as one generic `execute_stage()` cycle
   (dequeue -> allocate -> process -> enqueue-or-fail), explicitly
   "owns no state of its own beyond the RuntimeContext/session_id it
   was constructed with." Correlating three independent stages'
   outputs by pipeline_id is not one execute_stage() cycle over one
   queue — it is cross-stage state accumulated over time, which
   EngineRuntime's own documented scope has no room for without
   inventing new responsibility onto a class whose docstring already
   closes that door. AD-042 §6 itself calls this "the future fan-in
   runtime" throughout, treating it as its own subsystem. Building it
   as a sibling to EngineRuntime, not a mode inside it, is the only
   reading consistent with both files.

2. Where does it live?
   `engine/`, alongside `runtime.py` and `runtime_context.py` — same
   package as every other runtime-shaped, per-session component, and
   the same package AD-042 itself lives in (Engine BluePrint's
   Architecture Decisions.md is engine-level, not worker- or
   queue-level).

3. Who owns its lifetime?
   `EngineCoordinator`, exactly the way it already owns `EngineRuntime`
   — see `engine/coordinator.py`'s `self._runtimes: Dict[str,
   EngineRuntime]` and its own comment explaining why: EngineRuntime
   "is not one of RuntimeContext's four owned services... tracked as
   coordinator-level bookkeeping, the same way `_sessions` itself is."
   That reasoning applies identically here. `RuntimeContext`
   (engine/runtime_context.py) documents its four fields as an
   *exhaustive*, closed list ("does nothing else"); adding a fifth
   field for fan-in state would contradict that file's own explicit
   "not this milestone" stance on growing new fields without a defined
   shape landing first. FanInRuntime is therefore coordinator-level
   bookkeeping, a sibling to `self._runtimes`, never a RuntimeContext
   field. This is not treated as an ownership conflict requiring a
   stop: RuntimeContext's docstring already anticipated and resolved
   this exact class of question for EngineRuntime; FanInRuntime is the
   same class of question again, not a new one.

4. How does EngineCoordinator construct it?
   Via a new, additive composition method on EngineCoordinator,
   `build_fan_in_runtime()`, called after `build_runtime_context()`
   (it needs that session's QueueManager to resolve the merge queue).
   Stored in a new `self._fan_in_runtimes: Dict[str, FanInRuntime]`
   dict, retrieved via `get_fan_in_runtime()` — the same
   build/get shape already established for EngineRuntime
   (`build_runtime_context()` / `get_engine_runtime()`). No existing
   EngineCoordinator method's behavior changes; this is purely
   additive.

5. How does EngineRuntime interact with it?
   It doesn't, directly — EngineRuntime is not modified by this
   change (MUST NOT). Instead, whatever caller assembles a Website /
   Instagram / Contact `StageConfig` (engine/runtime.py) supplies a
   `build_downstream` closure that calls this class's
   `record_website_result` / `record_instagram_result` /
   `record_contact_result` and returns `None` — exactly the shape
   `StageConfig.build_downstream` already documents ("`None` ... to
   enqueue nothing this cycle"). `output_queue_id` for those three
   stages is `None` (Website/Instagram/Contact become, from
   EngineRuntime's point of view, terminal stages — the same shape it
   already gives Storage). FanInRuntime — not EngineRuntime — performs
   the one enqueue into the Merge queue, once, when AD-042's policy is
   satisfied, using the same public `Queue.enqueue()` any producer
   already uses. This keeps EngineRuntime's own documented contract
   ("does not invent queue behaviour beyond calling the public APIs")
   intact: FanInRuntime is a caller of that public API, not a change
   to it. A worker's dead-letter outcome (`_handle_failure`) is
   EngineRuntime-internal and is not hooked into automatically — see
   "Known dependency, not resolved here" below.

6. How is state cleaned up after Merge executes?
   Immediately: the moment AD-042's completion policy is satisfied for
   a `pipeline_id`, its accumulator is popped out of the live
   correlation table in the same locked critical section that builds
   and enqueues its `MergeInput`, and the `pipeline_id` is recorded in
   a small closed-set used only to make any further, late call for
   that `pipeline_id` a safe, logged no-op (AD-042 §5 flags "what
   happens to a branch result that arrives after [release]" as an open
   question for this file, not for the completion policy, to resolve
   — this is that resolution). The closed-set is bounded by this
   FanInRuntime's own per-session lifetime (owned by EngineCoordinator,
   released with the session), the same lifetime bound every other
   per-session runtime structure in this codebase already has
   (WorkerRegistry, every Queue, ...).

No ownership conflict found. Proceeding.

Responsibility
--------------
FanInRuntime enforces AD-042 exactly, and nothing more:

    - correlates Website / Instagram / Contact results by pipeline_id
    - accumulates partial enrichment state (AD-042 §2's two-outcome
      terminal test: SUCCEEDED-with-real-object or DEAD-LETTERED-with-
      no-object; nothing else counts as terminal — see AD-042 §2/§3)
    - evaluates AD-042 §1's completion policy: only once every one of
      the three branches has reached a terminal state
    - emits exactly one `MergeInput` (workers/merge_worker.py) per
      pipeline_id when that policy is satisfied, by calling the merge
      queue's own public `enqueue()` (AD-042 §5: release-exactly-once)
    - releases (removes) that pipeline_id's correlation state the
      moment it is emitted (see review §6 above)

It deliberately does NOT:

    - modify MergeWorker, Queue, Worker lifecycle, RuntimeContext, or
      EngineRuntime (all unmodified by this change)
    - invent a completion rule beyond AD-042's own text (no partial or
      best-effort release; no "skip" case per AD-042 §3; no new
      terminal-state vocabulary beyond SUCCEEDED/DEAD-LETTERED per
      AD-042 §2)
    - implement Storage, scoring, or qualification
    - decide *when* Website/Instagram/Contact workers run, or drive any
      execute_stage() loop — it only reacts to results it is handed

Known dependency, not resolved here (per AD-042's own text)
------------------------------------------------------------------------
AD-042 itself documents that retry *execution* does not exist yet, so
a branch that is RETRYING today has no path to ever reach SUCCEEDED or
DEAD-LETTERED — this file cannot and does not work around that; a
pipeline_id whose branch is stuck RETRYING simply never completes here,
exactly as AD-042 says it shouldn't. Similarly, no execute_stage() loop
yet drives real Website/Instagram/Contact/Merge queues end-to-end (see
`engine/runtime.py`'s own Status section), so nothing yet calls
`record_*_dead_letter()` from a live failure path in production — that
wiring belongs to whichever future milestone builds the execute-loop
(engine/runtime.py's own TODO), the same way this file's own
`build_downstream` wiring for the success path belongs to whichever
future milestone assembles real StageConfigs. This file supplies the
correct, complete API surface for both outcomes; it does not invent a
driver loop to reach it, since inventing one is explicitly out of
scope (MUST NOT: invent new completion rules; the "how workers are
actually driven" question belongs to Runtime Integration item 4/5, not
this one).

Thread safety
-------------
One `threading.RLock` guards this class's entire correlation table
(`_pending`) and closed-set (`_closed`). Every public method acquires
it for its full duration, including the completion check and the
resulting `Queue.enqueue()` call, so two threads racing to deliver the
final terminal result for the same pipeline_id can never both observe
"complete" and both enqueue a MergeInput — see AD-042 §5,
release-exactly-once. This mirrors Queue's own single-lock-per-
instance approach (queues/queue.py), not a new locking strategy.

Status
------
Phase 6.5. Implements `FanInRuntime` only. Does NOT modify
workers/merge_worker.py, queues/queue.py, queues/queue_manager.py,
engine/runtime.py, or engine/runtime_context.py. Adds two small,
additive composition methods to engine/coordinator.py
(`build_fan_in_runtime()` / `get_fan_in_runtime()`) mirroring the
existing `build_runtime_context()` / `get_engine_runtime()` shape
exactly; no existing EngineCoordinator method's behavior changes.

TODO(future milestones):
    - Wiring `record_website_dead_letter()` / etc. into a real
      execute_stage() failure path once an execute-loop exists
      (Runtime Integration item 4/5's own remaining scope).
    - Wiring `build_downstream` closures that call
      `record_website_result()` / etc. into real Website/Instagram/
      Contact StageConfigs, once a caller assembles the full
      seven-stage blueprint (the second of the two gaps
      `build_runtime_context()`'s docstring names — Storage — remains
      separately unresolved and is not this file's concern).
    - Deciding whether a very-late branch result for an already-closed
      pipeline_id should ever be surfaced anywhere (metrics, logging
      only, today) is left exactly as open as AD-042 §5 leaves it;
      this file's choice (safe, logged no-op) is a default, not a
      final answer to a question AD-042 explicitly declined to settle.
"""

from __future__ import annotations

import threading
from dataclasses import dataclass, field
from typing import Any, Dict, Optional, Set

from engine.contracts import BusinessCandidate, ContactIntel, InstagramIntel, WebsiteIntel
from engine.prune_reason_taxonomy import classify_prune_reason
from queues.queue import Queue
from utils.runtime import get_logger
from workers.merge_worker import MergeInput

log = get_logger("engine.fan_in_runtime")

#: Sentinel distinguishing "this branch has not yet reached a terminal
#: state" from "this branch reached a terminal state with no data"
#: (dead-lettered, or a real object is simply not applicable). Using a
#: private object() instance rather than `None` is required precisely
#: because `None` is itself a legitimate *terminal* value here (AD-042
#: §4: a dead-lettered branch and a "found nothing" branch look
#: identical at the EnrichedBusiness level, by design) — `None` cannot
#: also mean "still pending" without collapsing that distinction.
_UNSET = object()


class FanInRuntimeError(RuntimeError):
    """
    Raised for FanInRuntime configuration/precondition failures only
    (e.g. a construction-time misconfiguration). Never raised for a
    duplicate or late branch result — see `_record` below, which
    handles those as safe no-ops per AD-042 §5, not as errors.
    """


@dataclass
class _PipelineAccumulator:
    """
    Correlation state for exactly one pipeline_id, held only until
    AD-042's completion policy is satisfied for it (see this module's
    "Cleanup lifecycle" review point 6 — popped out the instant it
    completes).

    `business` is `Optional` only because it may not have arrived yet
    relative to a branch result (no ordering guarantee is assumed
    between `register_business()` and `record_*_result()` /
    `record_*_dead_letter()` calls — see `register_business()`'s own
    docstring). Once required for completion, its absence alone is
    enough to keep this pipeline_id open.

    Each of `website_intel` / `instagram_intel` / `contact_intel`
    holds exactly one of three things:
        - `_UNSET`      -- branch has not yet reached a terminal state
        - `None`        -- branch reached a terminal state with no
                            data (dead-lettered; see AD-042 §4)
        - the real Intel object -- branch SUCCEEDED, per AD-042 §2
    """

    pipeline_id: str
    business: Optional[BusinessCandidate] = None
    website_intel: Any = field(default=_UNSET)
    instagram_intel: Any = field(default=_UNSET)
    contact_intel: Any = field(default=_UNSET)

    def is_complete(self) -> bool:
        """
        AD-042 §1's completion policy, applied to this accumulator:
        every one of the three branches must have reached a terminal
        state (§2), and the business this MergeInput will be built
        around must be known. Never fires on a partial/best-effort
        basis — an accumulator missing even one branch (still
        `_UNSET`) is not complete, full stop.
        """
        return (
            self.business is not None
            and self.website_intel is not _UNSET
            and self.instagram_intel is not _UNSET
            and self.contact_intel is not _UNSET
        )

    def to_merge_input(self) -> MergeInput:
        """
        Build this pipeline_id's MergeInput. Only ever called once
        `is_complete()` is True (asserted by the caller, not
        re-checked here) — mirrors MergeWorker's own "no fabrication"
        stance: passes each field through exactly as accumulated,
        never defaulting or inferring a replacement for a dead-lettered
        (`None`) branch.
        """
        return MergeInput(
            business=self.business,
            website_intel=self.website_intel,
            instagram_intel=self.instagram_intel,
            contact_intel=self.contact_intel,
        )


class FanInRuntime:
    """
    Per-session Merge fan-in correlator. See module docstring for the
    full architecture review, responsibility list, and what this class
    deliberately does not do.
    """

    def __init__(self, *, merge_queue: Queue, merge_output_stage: str = "merge") -> None:
        """
        Parameters
        ----------
        merge_queue:
            This session's Merge input Queue (queues/queue.py),
            already constructed and registered with this session's
            QueueManager — resolved by the caller (EngineCoordinator's
            `build_fan_in_runtime()`) via
            `RuntimeContext.queue_manager.get_queue(...)`, exactly the
            way EngineRuntime resolves queues, rather than constructed
            here. FanInRuntime never constructs a Queue, a
            QueueDefinition, or a QueueManager.
        merge_output_stage:
            The `stage` label attached to the QueueItem this class
            enqueues into `merge_queue` (`Queue.enqueue(...,
            stage=merge_output_stage, ...)`) — mirrors
            `StageConfig.output_stage`'s own free-form role in
            engine/runtime.py. Defaults to `"merge"`.
        """
        if merge_queue is None:
            raise FanInRuntimeError("FanInRuntime requires a non-None merge_queue")
        self._merge_queue = merge_queue
        self._merge_output_stage = merge_output_stage
        self._lock = threading.RLock()
        self._pending: Dict[str, _PipelineAccumulator] = {}
        self._closed: Set[str] = set()
        self._pruned: Set[str] = set()
        # Lead-Yield Waste Fix — observability step (item 6): counts by
        # canonical category (see engine/prune_reason_taxonomy.py). Purely
        # additive bookkeeping — never read by any pruning decision, never
        # affects _pending/_closed/_pruned. Only covers reasons passed to
        # prune_business() below (website-stage and contact-stage prunes);
        # see prune_reason_taxonomy.py's module docstring for the explicit
        # discovery-stage scope limit.
        self._prune_reason_counts: Dict[str, int] = {}

    # -- correlation inputs ------------------------------------------------

    def prune_business(self, pipeline_id: str, reason: str = "early_pruned") -> None:
        """
        Prune a pipeline_id early when a required channel is proven impossible.
        Removes correlation state, tombstones the pipeline_id in _pruned and _closed,
        and ensures no MergeInput is ever emitted for this business.
        """
        with self._lock:
            self._pruned.add(pipeline_id)
            self._closed.add(pipeline_id)
            self._pending.pop(pipeline_id, None)
            # Lead-Yield Waste Fix — observability step (item 6): classify
            # the already-supplied `reason` into a small canonical taxonomy
            # and count it. Additive only — does not change what gets
            # pruned, when, or why; see get_prune_reason_counts() below.
            category = classify_prune_reason(reason)
            self._prune_reason_counts[category] = self._prune_reason_counts.get(category, 0) + 1
            log.info(
                "fan-in: pipeline_id=%s early-pruned (%s) [category=%s]",
                pipeline_id,
                reason,
                category,
            )

    def get_prune_reason_counts(self) -> Dict[str, int]:
        """
        Lead-Yield Waste Fix — observability step (item 6). Returns a copy
        of the running counts, keyed by canonical category (see
        engine/prune_reason_taxonomy.py). Read-only bookkeeping — never
        consulted by any pruning decision. Covers only prunes that went
        through prune_business() above (website-stage and contact-stage);
        see prune_reason_taxonomy.py's module docstring for why the
        discovery-stage channel prune is out of scope for this method.
        """
        with self._lock:
            return dict(self._prune_reason_counts)

    def is_pruned(self, pipeline_id: str) -> bool:
        """Whether `pipeline_id` was terminally pruned before completing FanIn."""
        with self._lock:
            return pipeline_id in self._pruned

    def get_business(self, pipeline_id: str) -> Optional[BusinessCandidate]:
        """Retrieve the registered BusinessCandidate for a pipeline_id if available."""
        with self._lock:
            acc = self._pending.get(pipeline_id)
            return acc.business if acc else None

    def register_business(self, business: BusinessCandidate) -> Optional[MergeInput]:
        """
        Seed this pipeline_id's accumulator with the BusinessCandidate
        MergeInput will require (MergeInput.business is required — see
        workers/merge_worker.py's own docstring: "a pipeline_id must
        come from *somewhere*, and business.pipeline_id is the only
        field anywhere in this bundle guaranteed to carry one").
        Idempotent and order-independent: safe to call before, after,
        or interleaved with any `record_*` call below for the same
        pipeline_id — completion is evaluated fresh on every call,
        from whichever side arrives last.

        Returns the emitted MergeInput if this call happens to be the
        one that completes the pipeline_id (all three branches were
        already terminal); otherwise None. A duplicate call for a
        pipeline_id that already has a business registered, or one
        that already closed or was pruned, is a safe, logged no-op.
        """
        with self._lock:
            if business.pipeline_id in self._pruned or business.pipeline_id in self._closed:
                log.warning(
                    "fan-in: register_business for already-closed/pruned "
                    "pipeline_id=%s ignored",
                    business.pipeline_id,
                )
                return None
            acc = self._pending.setdefault(
                business.pipeline_id, _PipelineAccumulator(pipeline_id=business.pipeline_id)
            )
            if acc.business is not None:
                log.warning(
                    "fan-in: duplicate register_business for "
                    "pipeline_id=%s ignored",
                    business.pipeline_id,
                )
                return None
            acc.business = business
            return self._maybe_release(acc)

    def record_website_result(
        self, pipeline_id: str, intel: Optional[WebsiteIntel]
    ) -> Optional[MergeInput]:
        """
        Record WebsiteWorker's terminal outcome for `pipeline_id`:
        `intel` is the real `WebsiteIntel` object on SUCCEEDED (AD-042
        §2 — a negative-fact object such as
        `WebsiteIntel(website_reachable=False)` is just as SUCCEEDED as
        a data-rich one), or `None` on DEAD-LETTERED (AD-042 §4). Never
        call this for a PENDING/IN-FLIGHT/RETRYING branch — only once
        WebsiteWorker (via `worker.complete()`) or its Queue (via
        `dead_letter()`) has actually reached one of those two terminal
        outcomes.
        """
        return self._record(pipeline_id, "website_intel", intel)

    def record_website_dead_letter(self, pipeline_id: str) -> Optional[MergeInput]:
        """Convenience wrapper: `record_website_result(pipeline_id, None)`."""
        return self.record_website_result(pipeline_id, None)

    def record_instagram_result(
        self, pipeline_id: str, intel: Optional[InstagramIntel]
    ) -> Optional[MergeInput]:
        """Same contract as `record_website_result`, for InstagramWorker."""
        return self._record(pipeline_id, "instagram_intel", intel)

    def record_instagram_dead_letter(self, pipeline_id: str) -> Optional[MergeInput]:
        """Convenience wrapper: `record_instagram_result(pipeline_id, None)`."""
        return self.record_instagram_result(pipeline_id, None)

    def record_contact_result(
        self, pipeline_id: str, intel: Optional[ContactIntel]
    ) -> Optional[MergeInput]:
        """Same contract as `record_website_result`, for ContactWorker."""
        return self._record(pipeline_id, "contact_intel", intel)

    def record_contact_dead_letter(self, pipeline_id: str) -> Optional[MergeInput]:
        """Convenience wrapper: `record_contact_result(pipeline_id, None)`."""
        return self.record_contact_result(pipeline_id, None)

    # -- observability (read-only, changes nothing) -------------------------

    def is_closed(self, pipeline_id: str) -> bool:
        """Whether `pipeline_id` has already had its MergeInput emitted."""
        with self._lock:
            return pipeline_id in self._closed

    def pending_count(self) -> int:
        """Number of pipeline_ids currently mid-correlation (not yet complete)."""
        with self._lock:
            return len(self._pending)

    # -- internal ------------------------------------------------------------

    def _record(self, pipeline_id: str, field_name: str, value: Any) -> Optional[MergeInput]:
        """
        Shared implementation for every `record_*_result` method.
        `field_name` is one of `"website_intel"` / `"instagram_intel"`
        / `"contact_intel"` — the exact attribute name on
        `_PipelineAccumulator` this branch owns.

        A duplicate result for a branch already terminal (this
        pipeline_id's accumulator already holds something other than
        `_UNSET` for `field_name`) is a safe, logged no-op — this is
        what guarantees duplicate enrichment results never produce
        duplicate merges, per this milestone's validation requirement.
        A result for an already-closed pipeline_id is likewise a safe,
        logged no-op (AD-042 §5).
        """
        with self._lock:
            if pipeline_id in self._pruned or pipeline_id in self._closed:
                log.warning(
                    "fan-in: %s result for already-closed/pruned pipeline_id=%s "
                    "ignored",
                    field_name,
                    pipeline_id,
                )
                return None
            acc = self._pending.setdefault(
                pipeline_id, _PipelineAccumulator(pipeline_id=pipeline_id)
            )
            if getattr(acc, field_name) is not _UNSET:
                log.warning(
                    "fan-in: duplicate %s result for pipeline_id=%s ignored",
                    field_name,
                    pipeline_id,
                )
                return None
            setattr(acc, field_name, value)
            return self._maybe_release(acc)

    def _maybe_release(self, acc: _PipelineAccumulator) -> Optional[MergeInput]:
        """
        Caller must already hold `self._lock`. If `acc` now satisfies
        AD-042 §1's completion policy, build its MergeInput, enqueue it
        into the Merge queue exactly once (AD-042 §5), release
        (pop) its correlation state (review point 6), and record it as
        closed so any further, late call for the same pipeline_id is a
        safe no-op instead of a second release. Returns the emitted
        MergeInput, or None if `acc` is still incomplete.
        """
        if acc.pipeline_id in self._pruned:
            self._pending.pop(acc.pipeline_id, None)
            return None
        if not acc.is_complete():
            return None
        merge_input = acc.to_merge_input()
        self._merge_queue.enqueue(
            pipeline_id=acc.pipeline_id,
            stage=self._merge_output_stage,
            payload=merge_input,
        )
        del self._pending[acc.pipeline_id]
        self._closed.add(acc.pipeline_id)
        log.info(
            "fan-in: pipeline_id=%s complete, MergeInput enqueued, "
            "correlation state released",
            acc.pipeline_id,
        )
        return merge_input
