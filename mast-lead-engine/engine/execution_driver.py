"""
MAST Engine V2 — Execution Driver
====================================

Source: Phase 6.7 implementation prompt ("Execution Driver
Implementation"). Runtime Integration sequence item 5/6 boundary:
`engine/runtime.py` (item 3) already implements `EngineRuntime.
execute_stage()` — exactly one stage cycle — and its own Status
section says so explicitly: "Nothing yet constructs an EngineRuntime
for a real session or drives it in a loop." `engine/coordinator.py`
(item 4) already implements the composition root
(`build_runtime_context()` / `build_fan_in_runtime()` /
`get_engine_runtime()` / `get_fan_in_runtime()`), but its own
`start_discovery()` docstring says just as explicitly: "It does not
execute a single stage cycle itself -- driving `EngineRuntime.
execute_stage()` in a loop remains unimplemented." This file is that
missing loop.

Architecture review (performed before writing this file, per the same
discipline `engine/fan_in_runtime.py` used)
--------------------------------------------------------------------
1. New component, or a method bolted onto EngineRuntime /
   EngineCoordinator?
   New component. `engine/runtime.py`'s own module docstring closes
   its scope at "exactly one stage cycle" and lists, as something it
   deliberately does NOT do, calling `heartbeat()`/`shutdown()` or
   deciding scheduling cadence ("a caller/timer concern"). Adding a
   `while True` loop inside `EngineRuntime` would contradict that
   file's own documented boundary. `EngineCoordinator` already has a
   documented, closed scope too (session lifecycle + composition
   root); its own module docstring's TODO list still names
   `allocate_workers`/`monitor_queues`/`resume_failed_work` as
   *placeholders*, not "the execution loop" — nothing there claims
   coordinator-owned scheduling either. A sibling module, the same
   shape `FanInRuntime` already took relative to `EngineRuntime`, is
   the only reading consistent with all three files.

2. Where does it live?
   `engine/`, alongside `runtime.py`, `runtime_context.py`,
   `coordinator.py`, and `fan_in_runtime.py` — same package as every
   other per-session runtime-shaped component.

3. Who owns its lifetime?
   Whatever caller constructs it (a future `service.py` cutover, a
   test, this milestone's own validation script). Not
   `EngineCoordinator` — unlike `EngineRuntime`/`FanInRuntime`,
   `ExecutionDriver` is not per-session bookkeeping the coordinator
   must hand back out via a `get_*` accessor; it is an active thread
   a caller starts and stops directly, the same way nothing in this
   codebase makes `EngineCoordinator` responsible for joining threads.
   Wiring it into `EngineCoordinator.start_discovery()` is left to the
   future `service.py` cutover (Runtime Integration item 6), per that
   method's own docstring boundary quoted above — not invented here.

4. How does it reach `EngineRuntime.execute_stage()`?
   By calling it directly, once per `StageConfig`, once per pass. No
   new method is added to `EngineRuntime`; this file only calls the
   public `execute_stage()` it already exposes.

5. How does it interact with `FanInRuntime`?
   Indirectly, the same way `EngineRuntime` does (see
   `fan_in_runtime.py` review point 5): this file does not call
   `FanInRuntime` itself. It builds the `StageConfig.build_downstream`
   closures that call `FanInRuntime.record_*_result()` /
   `register_business()`, and `FanInRuntime`'s own `_maybe_release()`
   performs the one `Queue.enqueue()` into the Merge queue when AD-042
   is satisfied. `ExecutionDriver` then drives `EngineRuntime.
   execute_stage()` for the Merge `StageConfig` against that same
   queue, on its own schedule, exactly like every other stage.

6. A pipeline-shape fact this file must resolve, not invent
   -----------------------------------------------------------------
   `engine/fan_in_runtime.py`'s own review (point 5) describes
   Website/Instagram/Contact as symmetric: all three take a
   BusinessCandidate and become "terminal, from EngineRuntime's point
   of view" (`output_queue_id=None`). That description does not match
   this codebase's actual `ContactWorker`, whose own module docstring
   and `process()` signature are unambiguous:
   `ContactWorker(BaseWorker[WebsiteIntel, ContactIntel])` —
   ContactWorker's input is WebsiteIntel (the pages WebsiteWorker
   already located), never a BusinessCandidate. This is a real,
   inspectable fact about already-implemented code, not a contradiction
   between two architecture documents — `engine/coordinator.py`'s own
   `build_runtime_context()` docstring already flags that "how...
   Website + Instagram + Contact intel... are correlated... is a
   pipeline-shape / business-logic decision" left entirely to
   whichever caller assembles real `StageConfig`s. This file is that
   caller, so resolving it here (Website's `StageConfig` both records
   its fan-in result *and* forwards the same `WebsiteIntel` on to a
   Contact-input queue, via one `build_downstream` closure returning a
   non-`None` value) is exactly the delegated decision, not a
   redesign of `EngineRuntime`, `FanInRuntime`, or `ContactWorker`.
   Instagram and Contact remain terminal from `EngineRuntime`'s point
   of view exactly as `fan_in_runtime.py` describes; only Website
   additionally feeds a real downstream queue, because only Contact's
   already-implemented input type requires it.

No ownership conflict found once the ContactWorker input-type fact
above is accounted for. Proceeding.

Responsibility
--------------
Two pieces, kept in one file because the second exists only to
produce the first's constructor arguments (see review point 6):

    `ExecutionDriver` — owns:
        - repeatedly executing stage cycles (calls
          `EngineRuntime.execute_stage()` once per `StageConfig`,
          every pass)
        - scheduling (a background thread looping over every
          `StageConfig` it was given; idle back-off when a full pass
          finds no work; producer stages, per `StageConfig.
          input_queue_id is None`, run at most once per driver
          lifetime — see "Producer stages run once" below)
        - starting execution (`start()`)
        - stopping execution (`stop()` — graceful: signals the loop,
          optionally joins the thread; never kills mid-`execute_stage`
          call)
        - nothing else: no worker/queue/session construction, no
          retry-execution, no health monitoring — none of those are
          `execute_stage()`'s job either, and this file does not grow
          scope `EngineRuntime` itself was explicitly told not to have.

    `build_seven_stage_pipeline()` — the composition-root function
        that gives `ExecutionDriver` something real to drive: builds
        the `QueueDefinition`s and `StageBlueprint`s for
        `EngineCoordinator.build_runtime_context()`, then — once that
        RuntimeContext and this session's `FanInRuntime` both exist —
        assembles the seven `StageConfig`s (`engine/runtime.py`),
        including the `DiscoveryExecution`/`on_candidate` closure
        `workers/discovery_worker.py`'s own "Ownership of on_candidate"
        section names "Engine Runtime" (this composition layer) as
        responsible for building. This is pipeline-shape data, not
        pipeline-shape *logic* baked into `EngineRuntime`,
        `EngineCoordinator`, or any Worker — every one of those stays
        unmodified.

Producer stages run once
-------------------------
`StageConfig.input_queue_id is None` marks a producer (today: only
Discovery — see `engine/runtime.py`'s own module docstring, "Why one
generic implementation, not six"). `DiscoveryWorker.process()` drives
its provider to full exhaustion inside one call
(`workers/discovery_worker.py`, "Revision history, v3"); calling
`execute_stage()` for that `StageConfig` a second time would start a
second, independent discovery run against whatever `request` object
`produce_worker_input` was closed over — duplicating every business
the first run already streamed. Nothing in `engine/runtime.py` or
`workers/discovery_worker.py` limits a producer to running once; this
file adds that as scheduling policy, not a change to either. Once a
producer `StageConfig` has produced one `ran=True` `StageOutcome`,
`ExecutionDriver` never calls `execute_stage()` for it again for the
lifetime of that driver instance. A future milestone wanting a
producer that legitimately runs more than once per driver (e.g. a
polling discovery source) is free to construct `ExecutionDriver`
directly with `run_producers_once=False`; this file does not decide
that milestone's shape, only defaults to the behavior correct for the
one producer that exists today.

What this file deliberately does NOT do
------------------------------------------
    - does not modify `engine/runtime.py`, `engine/runtime_context.py`,
      `engine/fan_in_runtime.py`, `engine/coordinator.py`, any Worker,
      any Queue, or `service.py` (all unmodified by this change)
    - does not construct a RuntimeContext, WorkerRegistry, WorkerPool,
      WorkerAllocator, or QueueManager itself — `build_seven_stage_
      pipeline()` calls `EngineCoordinator.build_runtime_context()`
      for that, exactly as `start_discovery()` already does
    - does not implement retry *execution*, health monitoring, or
      session-status transitions — none of those are this milestone's
      scope either (see `engine/runtime.py` / `engine/coordinator.py`
      own TODOs, unchanged)
    - does not enforce `DiscoveryWorker.timeout_seconds()` or any other
      worker's declared timeout — declared-but-unenforced timeouts are
      an existing, explicitly flagged gap across this codebase
      (`workers/discovery_worker.py` "Timeout (unchanged ambiguity)"),
      not something this scheduling loop invents an enforcement
      mechanism for

Thread safety
-------------
One `threading.Event` (`_stop_event`) signals shutdown; one
`threading.Lock` (`_lifecycle_lock`) guards `start()`/`stop()` against
being called concurrently with each other. The loop itself runs on a
single background thread — `execute_stage()` calls are never made
concurrently by this file, so nothing here contends with
`EngineRuntime`'s own "no lock held across more than one call" design
(its module docstring). Two threads calling `execute_stage()` for two
different `ExecutionDriver`s (two different sessions) already don't
contend, per that same design; this file adds no new shared state
between driver instances.

Post-audit correction (Item 4 — found via execution, not the earlier
static review)
--------------------------------------------------------------------
The prior audit (static review) found three implementation defects,
all fixed above. Actually *running* the validation script surfaced a
fourth, more serious defect the static review missed entirely:
`engine/runtime.py`'s own `_handle_success()` only calls a stage's
`build_downstream()` when `stage.output_queue_id is not None`.
Instagram and Contact were originally wired with `output_queue_id=
None` (they have nothing further to forward — see review point 6
above), which meant `_instagram_downstream`/`_contact_downstream` —
whose entire job is calling `fan_in.record_instagram_result()` /
`record_contact_result()` — were **never invoked at all**, for any
candidate, ever. `FanInRuntime`'s completion check (AD-042) therefore
could never be satisfied, and Merge could never fire. This was not a
contradiction in `EngineRuntime` (its gate is intentional and
documented); it was this file's own incorrect assumption that
`build_downstream` runs unconditionally.

Fix: Instagram and Contact are now wired with a real, non-`None`
`output_queue_id` pointing at `fan_in_sink` — a queue no `StageConfig`
ever lists as its `input_queue_id`, so nothing ever dequeues from it.
Both stages' `build_downstream` closures are otherwise unchanged and
still return `None`, so `_handle_success`'s `if payload is not None`
check means nothing is ever actually enqueued into `fan_in_sink` — it
exists purely to make the `output_queue_id is not None` check pass so
`build_downstream`'s side effect (the `record_*_result` call) runs at
all. This is a composition-root-only change: one additional
`QueueDefinition`, one additional `PipelineQueueIds` field, and two
`StageConfig.output_queue_id`/`output_stage` values, all inside
`build_seven_stage_pipeline()`. `EngineRuntime`, `FanInRuntime`,
`RuntimeContext`, and every Worker remain untouched.

Status
------
Phase 6.7. Implements `ExecutionDriver` and
`build_seven_stage_pipeline()` only. `service.py` is not modified —
routing real discovery requests through this driver instead of
service.py's current inline orchestration remains the Runtime
Integration sequence's own item 6 ("service.py cutover"), explicitly
not this milestone (Phase 1.5 Migration Rule #1 — never replace
something that hasn't already been rebuilt).
"""

from __future__ import annotations

import datetime as _dt
import threading
import time
from dataclasses import dataclass
from typing import Any, Callable, Dict, List, Optional, Sequence

from engine.contracts import (
    BusinessCandidate,
    EnrichedBusiness,
    QualificationResult,
    QualifiedOpportunity,
    WebsiteIntel,
)
from engine.coordinator import EngineCoordinator, StageBlueprint
from engine.fan_in_runtime import FanInRuntime
from engine.runtime import EngineRuntime, StageConfig, StageOutcome
from queues.queue_definition import QueueDefinition
from queues.retry_policy import RetryPolicy
from workers.base_worker import BaseWorker
from workers.contact_worker import ContactWorker
from workers.discovery_worker import DiscoveryExecution, DiscoveryWorker
from workers.instagram_worker import InstagramWorker
from workers.merge_worker import MergeWorker
from workers.qualification_worker import QualificationWorker
from workers.scoring_worker import ScoringWorker
# Phase 4A (discovery-time keyword disqualification): the exact same
# predicate ScoringWorker uses to hard-disqualify a chain/cannabis
# EnrichedBusiness at scoring time (opportunity_score 0/10) — imported
# directly rather than reimplemented, per this module's own reuse
# convention (see _site_class below, which already reuses
# utils.parsing.is_weak_site the same way). Both functions read only
# `name`/`category`, exactly the shape BusinessCandidate exposes, so no
# adapter is needed. Reusing the functions themselves (not just the
# CHAIN_KEYWORDS/CANNABIS_KEYWORDS data they're built on) guarantees the
# discovery-time check can never drift from the scoring-time one.
from workers.scoring_worker import _is_cannabis as _keyword_is_cannabis
from workers.scoring_worker import _is_chain as _keyword_is_chain
from workers.storage_worker import StorageWorker
from utils.parsing import is_valid_email, is_weak_site

# -- Batch intelligence chain (Part 3, MAST Lead Engine 2.0 continuation) --
# The domain-layer subsystems Prioritization/Ranking/Mission Generation/
# Workflow Initialization consume, per engine/adapters.py's own docstring.
# Imported here (the pipeline's composition root) rather than in
# engine/coordinator.py, which stays a pure session-lifecycle/registry
# owner per its own module docstring ("the Engine ... does NOT ... store
# opportunities").
from engine import adapters as engine_adapters
from mission_generation.service import MissionGenerationService
from opportunity_prioritization.models import PrioritizationPolicy, PrioritizationStrategy
from opportunity_prioritization.service import OpportunityPrioritizationService
from opportunity_ranking.service import OpportunityRankingService
from workflow.service import WorkflowEngineService
from workers.website_worker import WebsiteWorker
from workers.worker_capability import WorkerCapability
from workers.worker_definition import WorkerDefinition
from utils.runtime import get_logger
from storage.early_persistent_dedup import (
    EarlyDedupDecision,
    PersistentEarlyDedupChecker,
    maps_place_id_from_keys,
    early_fingerprint_keys,
    log_early_dedup_decision,
)

log = get_logger("engine.execution_driver")

__all__ = [
    "ExecutionDriverError",
    "ExecutionDriver",
    "PipelineQueueIds",
    "build_seven_stage_pipeline",
]


class ExecutionDriverError(RuntimeError):
    """
    Raised for ExecutionDriver lifecycle misuse (double-start,
    stop-before-start) or for a fatal error surfaced from the drive
    loop (an `EngineRuntimeError` propagated out of `execute_stage()`,
    i.e. a RuntimeContext/StageConfig consistency bug — never raised
    for an ordinary worker `process()` failure, which `execute_stage()`
    already converts into a `StageOutcome(success=False, ...)` and
    which this driver treats as a normal, loggable cycle, not an
    error).
    """


class ExecutionDriver:
    """
    Repeatedly drives one session's `EngineRuntime.execute_stage()`
    across every `StageConfig` it is given, on a background thread,
    until stopped. See module docstring for full scope.
    """

    def __init__(
        self,
        engine_runtime: EngineRuntime,
        stages: Sequence[StageConfig],
        *,
        run_producers_once: bool = True,
        active_poll_seconds: float = 0.0,
        idle_poll_seconds: float = 0.25,
        on_stage_outcome: Optional[Callable[[StageOutcome], None]] = None,
        on_stage_wallclock: Optional[Callable[[str, float], None]] = None,
    ) -> None:
        """
        Parameters
        ----------
        engine_runtime:
            An already-constructed `EngineRuntime` (`engine/runtime.py`)
            for one session — this class never constructs one itself,
            mirroring `EngineRuntime`'s own "never constructs a
            RuntimeContext" stance one layer up. Typically
            `EngineCoordinator.get_engine_runtime(session_id)`.
        stages:
            The ordered `StageConfig`s to drive, once built. Order is
            the pass order every cycle (Discovery first is
            conventional but not required — `execute_stage()` for any
            transformer stage is simply a no-op, `ran=False`, if its
            input queue is empty).
        run_producers_once:
            See module docstring, "Producer stages run once". Default
            `True` matches the one producer this codebase has today
            (Discovery).
        active_poll_seconds:
            Sleep between passes when the previous pass had at least
            one stage with `ran=True`. Default `0.0` — keep draining
            while there is evidence of work, without a busy-loop
            (still an ordinary Python loop iteration, not a spin on a
            CPU-bound check).
        idle_poll_seconds:
            Sleep between passes when the previous pass produced
            `ran=False` for every stage (every queue empty, every
            producer already exhausted) — avoids busy-polling empty
            queues.
        on_stage_outcome:
            Optional observer called with every `StageOutcome` this
            driver produces, in-line on the driver's own thread (e.g.
            for a caller that wants to log/count executed stages, or
            for this milestone's own validation script). Never called
            concurrently with itself, since there is only one drive
            thread.
        on_stage_wallclock:
            PHASE 2B (discovery wall-clock instrumentation) addition.
            Optional observer called once per `_execute_one()` call
            with `(stage.name, elapsed_ms)` — the REAL wall-clock time
            that single `execute_stage()` call took, timed here at the
            outermost boundary this class controls, independent of
            (and not derived from) any timer internal to the worker
            itself. For a producer stage (Discovery today), a single
            call already blocks until the provider is fully exhausted
            (see the "PHASE 2B FIX (continuous pipeline flow)" note
            just below), so for that stage this elapsed time IS the
            authoritative `discovery_total_ms` service.py's
            `[area-sla]` report now surfaces — not a sum of any
            sub-stage timers, a single direct measurement of the one
            call that matters. For a transformer stage (Website,
            Instagram, ...), each call only ever processes whatever
            was queued at that moment, so a caller wanting a
            *cumulative* total across many calls (as opposed to one
            call's duration) is expected to accumulate these callbacks
            itself — this driver does not do so on a caller's behalf.
            `None` (the default) is a no-op, identical to
            `on_stage_outcome` immediately above.
        """
        if not stages:
            raise ValueError("ExecutionDriver requires at least one StageConfig")
        self._runtime = engine_runtime
        self._stages: List[StageConfig] = list(stages)
        self._run_producers_once = run_producers_once
        self._active_poll_seconds = active_poll_seconds
        self._idle_poll_seconds = idle_poll_seconds
        self._on_stage_outcome = on_stage_outcome
        self._on_stage_wallclock = on_stage_wallclock

        self._producer_names = {
            s.name for s in self._stages if s.input_queue_id is None
        }
        self._producers_done: set = set()

        self._stop_event = threading.Event()
        self._thread: Optional[threading.Thread] = None
        self._lifecycle_lock = threading.Lock()
        self.last_error: Optional[BaseException] = None

        # PHASE 2B FIX (continuous pipeline flow): a producer stage
        # (Discovery) is one single, long-running, synchronous
        # `execute_stage()` call -- `DiscoveryWorker.process()` blocks
        # until its provider is fully exhausted (workers/discovery_worker.py
        # "Revision history, v3"). Before this fix, that call was made
        # inline, in stage order, by the SAME thread that then goes on to
        # drive every transformer stage (Website/Instagram/Contact/Merge/
        # Qualification/Storage) -- so the entire first pass (and,
        # therefore, all downstream progress) blocked for as long as
        # discovery took to finish. Candidates streamed into website_in /
        # instagram_in via `on_candidate` during that call, but nothing
        # dequeued them because the one thread capable of doing so was
        # still inside `execute_stage(discovery)`.
        #
        # Fix: producer stages are launched on their own dedicated
        # thread(s), started once (mirroring "Producer stages run once"
        # above) as soon as this driver starts producing passes at all
        # (`run_once()` or `_run_loop()` — see `_ensure_producers_started`
        # below). The main pass loop no longer executes producer stages
        # inline; it skips them (they are neither re-executed nor waited
        # on) and spends every pass cycling the six transformer stages,
        # which can now actually dequeue and process candidates the
        # instant `on_candidate` enqueues them — while discovery is still
        # running. This changes scheduling only; `EngineRuntime`,
        # `StageConfig`, every Worker, and every Queue are untouched, and
        # the underlying components' own "Thread Safety" sections already
        # document the per-object locking that makes a second concurrent
        # caller of `execute_stage()` (this producer thread, running
        # alongside the transformer-stage thread) safe.
        self._producer_threads: Dict[str, threading.Thread] = {}
        self._producers_started: set = set()
        self._producers_finished: set = set()
        self._producer_lock = threading.Lock()

    # -- lifecycle -------------------------------------------------------

    def start(self) -> None:
        """
        Start the background drive thread. Raises ExecutionDriverError
        if already running. Non-blocking: returns as soon as the
        thread is launched, not once any stage has executed.
        """
        with self._lifecycle_lock:
            if self._thread is not None and self._thread.is_alive():
                raise ExecutionDriverError(
                    "ExecutionDriver.start() called while already running"
                )
            self._stop_event.clear()
            self.last_error = None
            self._thread = threading.Thread(
                target=self._run_loop,
                name="mast-execution-driver",
                daemon=True,
            )
            self._thread.start()
            log.info(
                "ExecutionDriver started stages=%d producers=%s",
                len(self._stages), sorted(self._producer_names),
            )

    def stop(self, *, wait: bool = True, timeout: Optional[float] = None) -> None:
        """
        Signal the drive loop to stop after its current
        `execute_stage()` call (if any) returns, and, if `wait` is
        True, join the background thread (with `timeout`, forwarded
        to `Thread.join()` unchanged — `None` waits indefinitely).
        Safe to call whether or not the driver was ever started, and
        safe to call more than once. Never interrupts an in-flight
        `execute_stage()` call — this is graceful shutdown: a worker
        that is mid-`process()` when `stop()` is called still runs
        `_handle_success`/`_handle_failure` and is released normally
        before the loop notices the stop signal and exits.

        Safe to call from inside an `on_stage_outcome` callback (i.e.
        from the drive thread itself, mid-pass) even with `wait=True`:
        `Thread.join()` on the thread's own current thread would
        otherwise raise `RuntimeError` ("cannot join current thread").
        This method detects that case and skips the join instead of
        propagating that error — the stop signal is set either way,
        so the loop still exits on its own once this call stack
        returns control to it; the caller just does not block waiting
        for a join that could never legally happen.
        """
        self._stop_event.set()
        thread = self._thread
        if wait and thread is not None:
            if thread is threading.current_thread():
                log.warning(
                    "ExecutionDriver.stop(wait=True) called from its own "
                    "drive thread (e.g. from an on_stage_outcome callback) "
                    "-- cannot join the current thread; stop signal is "
                    "set and the loop will exit once this call stack "
                    "returns, but stop() is not blocking for it."
                )
            else:
                thread.join(timeout=timeout)
        # PHASE 2B FIX: producer stage(s) now run on their own thread(s)
        # (see `_ensure_producers_started`) -- join them too, best-effort,
        # so a caller that has called stop() can trust the driver is
        # genuinely quiescent afterwards, not just that the transformer
        # loop stopped while a producer thread (e.g. Discovery, honoring
        # its own cooperative `should_stop` checkpoint) is still winding
        # down. Discovery's own `GoogleMapsDiscoveryRequest.should_stop`
        # is the actual mechanism that makes it stop promptly -- this
        # join does not request that itself, it only waits for it.
        if wait:
            with self._producer_lock:
                producer_threads = list(self._producer_threads.values())
            for producer_thread in producer_threads:
                if producer_thread is threading.current_thread():
                    log.warning(
                        "ExecutionDriver.stop(wait=True) called from its own "
                        "drive thread (a producer stage's own dedicated "
                        "thread, e.g. from an on_stage_outcome callback "
                        "fired for that producer's StageOutcome) -- cannot "
                        "join the current thread; stop signal is set and "
                        "that thread will exit once this call stack "
                        "returns, but stop() is not blocking for it."
                    )
                    continue
                producer_thread.join(timeout=timeout)

    def is_running(self) -> bool:
        """True while the background drive thread is alive."""
        thread = self._thread
        return thread is not None and thread.is_alive()

    def _ensure_producers_started(self) -> None:
        """
        Idempotently launch one dedicated thread per producer StageConfig
        (today: only Discovery), the first time this driver is asked to
        produce any pass at all (from `run_once()` or `_run_loop()`).
        Safe to call every pass -- after the first call, every producer
        name is already in `_producers_started` and this is a no-op.

        Only applies when `run_producers_once=True` (the default, and
        what `build_seven_stage_pipeline`'s production configuration
        uses). `run_producers_once=False` is a distinct, pre-existing,
        deliberately-supported mode (re-invoke the producer's
        `execute_stage()` inline, every pass, forever) that a persistent
        background thread is fundamentally incompatible with -- so that
        mode is left entirely untouched, below, in `run_once()` /
        `_run_loop()`.

        See the constructor's own comment for why this exists: decoupling
        a producer's one long, blocking `execute_stage()` call from the
        thread that cycles the transformer stages is the fix that lets
        candidates flow into enrichment while discovery is still running.
        """
        if not self._producer_names or not self._run_producers_once:
            return
        with self._producer_lock:
            to_start = [
                name for name in self._producer_names
                if name not in self._producers_started
            ]
            for name in to_start:
                self._producers_started.add(name)
            stages_to_start = [s for s in self._stages if s.name in to_start]
        for stage in stages_to_start:
            thread = threading.Thread(
                target=self._run_producer_stage,
                args=(stage,),
                name=f"mast-execution-driver-producer-{stage.name}",
                daemon=True,
            )
            try:
                thread.start()
            except BaseException:
                # Do not leave this failed launch marked as started.  Setting
                # the driver stop flag prevents any subsequent stage work;
                # callers retain the original start exception and execute
                # their normal stop()/join cleanup for previously-started
                # producers only.
                self._stop_event.set()
                with self._producer_lock:
                    self._producers_started.discard(stage.name)
                raise
            # `Thread.join()` is only legal after `start()` succeeds.  If
            # resource exhaustion makes start() raise, leave this thread out
            # of the cleanup registry so stop() cannot mask that root error
            # with "cannot join thread before it is started".  Producers
            # started earlier in this loop remain registered and are still
            # handled by the ordinary stop()/join cleanup path.
            with self._producer_lock:
                self._producer_threads[stage.name] = thread
            log.info("ExecutionDriver: producer stage=%s started on its own thread", stage.name)

    def _run_producer_stage(self, stage: StageConfig) -> None:
        """
        Thread target: run this producer stage's single, exhausting
        `execute_stage()` call to completion, exactly once, entirely off
        the transformer-stage pass loop. Errors are captured the same way
        `_execute_one()` already captures a fatal error for any other
        stage (`self.last_error` + `self._stop_event.set()`); an ordinary
        `StageOutcome(success=False, ...)` (ran=True) still marks the
        producer done -- it made real progress and drove the provider,
        even if the underlying worker.process() call itself failed.
        """
        try:
            outcome = self._execute_one(stage)
            if outcome is not None:
                if outcome.ran and outcome.success:
                    with self._producer_lock:
                        self._producers_done.add(stage.name)
                elif outcome.ran and not outcome.success:
                    err_detail = outcome.detail or f"Producer stage {stage.name} failed"
                    log.error("ExecutionDriver: producer stage=%s failed: %s", stage.name, err_detail)
                    if self.last_error is None:
                        from exceptions import DiscoveryFailure, DiscoveryFailureReason
                        self.last_error = DiscoveryFailure(
                            DiscoveryFailureReason.SCRAPER_ERROR,
                            f"Producer stage '{stage.name}' failed: {err_detail}",
                        )
                    self._stop_event.set()
        finally:
            with self._producer_lock:
                self._producers_finished.add(stage.name)
            log.info("ExecutionDriver: producer stage=%s finished", stage.name)

    def producers_finished(self) -> bool:
        """
        True once every producer stage's dedicated thread has completed
        (successfully or not). A caller (e.g. service.py's own
        exhaustion check) MUST consult this before treating "every queue
        is currently empty" as genuine pipeline exhaustion -- discovery
        may simply be between candidates, not actually done. False if
        this driver has no producer stages configured (nothing to wait
        on) is intentionally not special-cased here: with zero producer
        stages, `_producer_names` is empty and the set-comparison below
        is vacuously true, which is the correct answer either way.
        """
        with self._producer_lock:
            return self._producer_names <= self._producers_finished

    def run_once(self) -> List[StageOutcome]:
        """
        Synchronously run exactly one pass over every stage (skipping
        any producer already exhausted) and return every
        `StageOutcome` produced, in stage order. Does not touch the
        background thread or `_stop_event` — intended for tests and
        for a caller that wants deterministic, single-threaded control
        instead of `start()`/`stop()`. Safe to call whether or not the
        background thread is also running, though doing both at once
        would let two callers drive `execute_stage()` concurrently,
        which this class does not itself guard against (see module
        docstring, "Thread safety" — the guarantee is one drive thread
        *per ExecutionDriver instance calling _run_loop*, not a lock
        around `execute_stage()` itself).
        """
        self._ensure_producers_started()
        outcomes = []
        for stage in self._stages:
            if self._run_producers_once and stage.name in self._producer_names:
                # PHASE 2B FIX: producer stages are driven by their own
                # dedicated thread (`_ensure_producers_started` above),
                # never inline here -- see the constructor comment for
                # why. Every pass simply skips them and spends its time
                # on the transformer stages, which is what lets those
                # stages actually dequeue candidates while discovery is
                # still streaming more in.
                continue
            outcome = self._execute_one(stage)
            if outcome is None:
                break
            outcomes.append(outcome)
        return outcomes

    # -- internal ----------------------------------------------------------

    def _run_loop(self) -> None:
        self._ensure_producers_started()
        try:
            while not self._stop_event.is_set():
                any_ran = False
                for stage in self._stages:
                    if self._stop_event.is_set():
                        break
                    if stage.name in self._producer_names and self._run_producers_once:
                        # PHASE 2B FIX: see run_once()'s identical skip --
                        # producer stages run on their own thread, never
                        # inline in this loop.
                        continue
                    outcome = self._execute_one(stage)
                    if outcome is None:
                        # Fatal error already recorded in self.last_error;
                        # stop this driver rather than spin on the same
                        # structural problem forever.
                        return
                    if outcome.ran:
                        any_ran = True

                if self._stop_event.is_set():
                    return
                delay = (
                    self._active_poll_seconds if any_ran else self._idle_poll_seconds
                )
                if delay > 0:
                    self._stop_event.wait(delay)
        finally:
            log.info("ExecutionDriver loop exiting")

    def _execute_one(self, stage: StageConfig) -> Optional[StageOutcome]:
        """
        Run one `execute_stage()` call, translating a fatal
        `EngineRuntimeError` (or any other exception `execute_stage()`
        propagates outside its own worker-failure handling — see that
        method's own docstring) into a recorded `self.last_error` and
        a stopped loop, rather than letting it crash the background
        thread silently or spin forever on the same misconfiguration.
        An ordinary worker failure never reaches this except block —
        `execute_stage()` already converts that into a returned
        `StageOutcome(success=False, ...)`.
        """
        try:
            _t0 = time.perf_counter()
            outcome = self._runtime.execute_stage(stage)
        except Exception as exc:  # noqa: BLE001 - fatal, not a worker failure
            if self._on_stage_wallclock is not None:
                self._on_stage_wallclock(stage.name, (time.perf_counter() - _t0) * 1000.0)
            self.last_error = exc
            self._stop_event.set()
            log.error(
                "ExecutionDriver: fatal error executing stage=%s: %s",
                stage.name, exc,
            )
            return None
        if self._on_stage_wallclock is not None:
            self._on_stage_wallclock(stage.name, (time.perf_counter() - _t0) * 1000.0)
        if self._on_stage_outcome is not None:
            self._on_stage_outcome(outcome)
        return outcome


# ===========================================================================
# Composition root: assembling the seven-stage pipeline
# ===========================================================================


@dataclass(frozen=True)
class PipelineQueueIds:
    """
    The queue_id strings `build_seven_stage_pipeline()` wires the
    seven stages together with. Returned alongside the `StageConfig`
    list purely for observability/tests (e.g. asserting a queue drains
    by id) — nothing about `ExecutionDriver` or `EngineRuntime` reads
    this dataclass itself.

    `fan_in_sink` (Item 4, see module docstring "Item 4" section
    below): a queue nothing ever dequeues from -- no `StageConfig`
    lists it as an `input_queue_id`. Its only purpose is giving
    Instagram and Contact a non-`None` `output_queue_id`, because
    `engine/runtime.py`'s own `_handle_success()` only calls a stage's
    `build_downstream()` at all when `stage.output_queue_id is not
    None`. Both stages' `build_downstream` closures already return
    `None`, so nothing is ever actually enqueued into it -- it stays
    permanently empty; it exists purely to make that `is not None`
    check pass so `build_downstream`'s *side effect*
    (`fan_in.record_instagram_result` / `record_contact_result`) runs
    at all.
    """

    website_in: str
    instagram_in: str
    contact_in: str
    merge_in: str
    qualification_in: str
    storage_in: str
    fan_in_sink: str


class _EnrichedBusinessStash:
    """
    Composition-root-only bookkeeping, not a new engine/ subsystem:
    holds the `EnrichedBusiness` MergeWorker just produced for a
    `pipeline_id`, so Qualification's own `build_downstream` closure
    (below) can compose `QualifiedOpportunity` from it once
    QualificationWorker returns. This exists for the same reason
    `FanInRuntime` exists — StageConfig is strictly one-input/one-
    output, so combining "this cycle's QualificationResult" with "the
    EnrichedBusiness from an earlier cycle" needs somewhere to live
    that isn't `EngineRuntime` (whose own docstring already forbids it
    holding cross-call state) or `StageConfig` (frozen, one shot).
    Guarded by one lock, mirroring `FanInRuntime`'s own single-lock
    design for its correlation table.
    """

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._by_pipeline_id: Dict[str, EnrichedBusiness] = {}

    def put(self, enriched: EnrichedBusiness) -> None:
        with self._lock:
            self._by_pipeline_id[enriched.pipeline_id] = enriched

    def pop(self, pipeline_id: str) -> Optional[EnrichedBusiness]:
        with self._lock:
            return self._by_pipeline_id.pop(pipeline_id, None)


class _QualificationInFlight:
    """
    Composition-root-only bookkeeping, added specifically to close the
    `_EnrichedBusinessStash` leak an earlier audit found: if a
    qualification_in QueueItem is ever dead-lettered, `StageOutcome`
    carries that item's `queue_item_id` but never its `pipeline_id`
    (see `engine/runtime.py`'s `StageOutcome` — `pipeline_id` is a
    local inside `execute_stage()`/`_handle_failure()`, never
    returned), so the dead-letter path has no way to know which
    `_EnrichedBusinessStash` entry to remove without this. This class
    remembers `queue_item_id -> pipeline_id` for exactly as long as
    one qualification attempt is outstanding — recorded by the
    qualification stage's `build_worker_input` (called on every
    attempt, including retries, before `process()` runs), and removed
    the moment that `queue_item_id` reaches either terminal outcome
    (`success` or `dead_lettered` — see `_on_qualification_outcome`
    below). Deliberately not merged into `_EnrichedBusinessStash`
    itself (that class's existing `put`/`pop`-by-`pipeline_id` shape
    is left unchanged) — this is a second, narrower table for a
    second, narrower purpose: recovering a `pipeline_id` from a
    `queue_item_id` when nothing else in this cycle's `StageOutcome`
    can. Same single-lock discipline as `_EnrichedBusinessStash` and
    `FanInRuntime`.
    """

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._pipeline_id_by_item: Dict[str, str] = {}

    def record(self, queue_item_id: str, pipeline_id: str) -> None:
        with self._lock:
            self._pipeline_id_by_item[queue_item_id] = pipeline_id

    def pop(self, queue_item_id: str) -> Optional[str]:
        with self._lock:
            return self._pipeline_id_by_item.pop(queue_item_id, None)


# Phase 3B-VALIDATION (observability only, no behavior change): classifies
# a candidate's Maps `website` as "weak" (matches the existing, already
# shipped `utils.parsing.is_weak_site` classifier — social/directory/
# page-builder placeholder domains) or "normal" (anything else). Reused at
# every `_emit`-adjacent point below so the resulting `site_class_*`
# progress events can be bucketed by `service.py`'s `_on_progress` into
# `early_new_weak_site` / `early_new_normal_site` (and the matching
# per-stage counters) without altering `_on_candidate`'s existing pruning
# decision, `_website_downstream`/`_contact_downstream`'s existing gating,
# or `_qualification_downstream`'s existing accept/reject logic in any way
# — this only ever reads `candidate.website` to *label* an event that was
# (or would have been) emitted regardless.
def _site_class(website: Optional[str]) -> str:
    return "weak" if is_weak_site(website) else "normal"


def build_seven_stage_pipeline(
    coordinator: EngineCoordinator,
    session_id: str,
    *,
    discovery_provider: Any,
    discovery_request: Any,
    storage_backend: Any,
    niche: Optional[str] = None,
    required_categories: Optional[frozenset] = None,
    website_worker_factory: Optional[Callable[[], BaseWorker]] = None,
    instagram_worker_factory: Optional[Callable[[], BaseWorker]] = None,
    contact_worker_factory: Optional[Callable[[], BaseWorker]] = None,
    merge_worker_factory: Optional[Callable[[], BaseWorker]] = None,
    qualification_worker_factory: Optional[Callable[[], BaseWorker]] = None,
    scoring_worker_factory: Optional[Callable[[], BaseWorker]] = None,
    storage_worker_factory: Optional[Callable[[], BaseWorker]] = None,
    instance_counts: Optional[Dict[str, int]] = None,
    on_progress: Optional[Callable[[str, str, Optional[str]], None]] = None,
    on_stage_timing: Optional[Callable[[StageOutcome], None]] = None,
    early_dedup_checker: Optional[PersistentEarlyDedupChecker] = None,
    scrape_job_id: Optional[str] = None,
    required_channels: Optional[Tuple[str, ...] | list[str]] = None,
) -> "tuple[List[StageConfig], PipelineQueueIds, FanInRuntime, Callable[[StageOutcome], None]]":
    """
    Composition root wiring every already-implemented worker
    (DiscoveryWorker, WebsiteWorker, InstagramWorker, ContactWorker,
    MergeWorker, QualificationWorker, StorageWorker) into one runnable
    seven-stage `StageConfig` list, via `EngineCoordinator`'s existing
    `build_runtime_context()` / `build_fan_in_runtime()` /
    `get_engine_runtime()` (unmodified). Must be called after
    `coordinator.create_session(...)` and `coordinator.start_session(
    session_id)` — mirrors `start_discovery()`'s own precondition,
    since `build_runtime_context()` requires a STARTING session.

    Queue graph (see module docstring, review point 6, for why Website
    is not terminal from EngineRuntime's point of view the way
    Instagram/Contact are; see "Item 4" for why Instagram/Contact are
    routed to fan_in_sink rather than truly having output_queue_id=None):

        Discovery --(on_candidate)--> website_in
                  \\-(on_candidate)--> instagram_in
                  \\-(register_business)--> FanInRuntime accumulator

        website_in    -> WebsiteWorker    -> [record_website_result,
                                               forward WebsiteIntel]
                                                      |
                                                      v
        contact_in    -> ContactWorker    -> record_contact_result -> fan_in_sink (never dequeued)
        instagram_in  -> InstagramWorker  -> record_instagram_result -> fan_in_sink (never dequeued)

        FanInRuntime, once all three branches are terminal (AD-042),
        enqueues one MergeInput into:

        merge_in         -> MergeWorker         -> EnrichedBusiness
                                                    (stashed + forwarded)
        qualification_in -> QualificationWorker -> QualifiedOpportunity
                                                    (only if qualified;
                                                    ScoringWorker is
                                                    invoked directly,
                                                    not via a queue --
                                                    see "Scoring" note
                                                    above
                                                    _qualification_downstream)
        storage_in        -> StorageWorker      -> StoredOpportunity
                                                    (terminal)

    Returns
    -------
    A 4-tuple: the ordered `StageConfig` list (Discovery first, then
    Website/Instagram/Contact, then Merge/Qualification/Storage —
    ready to pass straight to `ExecutionDriver`), the `PipelineQueueIds`
    naming every queue created, the session's `FanInRuntime` (for a
    caller/test that wants to inspect `pending_count()`/`is_closed()`
    directly), and a cleanup callback the caller should pass as
    `ExecutionDriver(..., on_stage_outcome=<that callback>)`. That
    callback's only job is guaranteeing every `_EnrichedBusinessStash`
    entry this pipeline stashes is eventually removed -- on a
    successful Qualification cycle (already handled by
    `_qualification_downstream` below) as well as on a dead-lettered
    one (which `_qualification_downstream` is never called for at
    all, since `build_downstream` only runs on the success path -- see
    `_on_qualification_outcome`). A caller that also wants its own
    `on_stage_outcome` observer can chain both, e.g.
    `lambda o: (cleanup(o), my_observer(o))`; `ExecutionDriver` itself
    still accepts exactly one such callback, unchanged.
    """
    instance_counts = dict(instance_counts or {})

    def _count(worker_type: str) -> int:
        return instance_counts.get(worker_type, 1)

    queue_ids = PipelineQueueIds(
        website_in="website_in",
        instagram_in="instagram_in",
        contact_in="contact_in",
        merge_in="merge_in",
        qualification_in="qualification_in",
        storage_in="storage_in",
        fan_in_sink="fan_in_sink",
    )

    # A short, real RetryPolicy (rather than none at all) so a failing
    # cycle gets one retry before dead-letter, matching AD-042's own
    # completion policy expecting a real terminal outcome per branch
    # eventually, not "no retry_policy means dead-letter on the very
    # first failure" for every queue by default.
    default_retry_policy = RetryPolicy(
        max_attempts=2, retry_delay_seconds=0.0, strategy="immediate"
    )

    queue_definitions = [
        QueueDefinition(
            queue_id=queue_ids.website_in,
            queue_name="Website Input",
            stage="website",
            retry_policy=default_retry_policy,
        ),
        QueueDefinition(
            queue_id=queue_ids.instagram_in,
            queue_name="Instagram Input",
            stage="instagram",
            retry_policy=default_retry_policy,
        ),
        QueueDefinition(
            queue_id=queue_ids.contact_in,
            queue_name="Contact Input",
            stage="contact",
            retry_policy=default_retry_policy,
        ),
        QueueDefinition(
            queue_id=queue_ids.merge_in,
            queue_name="Merge Input",
            stage="merge",
            retry_policy=default_retry_policy,
        ),
        QueueDefinition(
            queue_id=queue_ids.qualification_in,
            queue_name="Qualification Input",
            stage="qualification",
            retry_policy=default_retry_policy,
        ),
        QueueDefinition(
            queue_id=queue_ids.storage_in,
            queue_name="Storage Input",
            stage="storage",
            retry_policy=default_retry_policy,
        ),
        QueueDefinition(
            queue_id=queue_ids.fan_in_sink,
            queue_name="Fan-In Sink (never dequeued)",
            stage="fan_in_sink",
            retry_policy=default_retry_policy,
        ),
    ]

    def _definition(definition_id: str, worker_type: str) -> WorkerDefinition:
        return WorkerDefinition(
            definition_id=definition_id,
            worker_type=worker_type,
            capabilities=(WorkerCapability(name=worker_type),),
        )

    stage_blueprints = [
        StageBlueprint(
            definition=_definition("discovery-v1", "discovery"),
            worker_factory=lambda: DiscoveryWorker(provider=discovery_provider),
            instance_count=_count("discovery"),
        ),
        StageBlueprint(
            definition=_definition("website-v1", "website"),
            worker_factory=website_worker_factory or (lambda: WebsiteWorker()),
            instance_count=_count("website"),
        ),
        StageBlueprint(
            definition=_definition("instagram-v1", "instagram"),
            worker_factory=instagram_worker_factory or (lambda: InstagramWorker()),
            instance_count=_count("instagram"),
        ),
        StageBlueprint(
            definition=_definition("contact-v1", "contact"),
            worker_factory=contact_worker_factory or (lambda: ContactWorker()),
            instance_count=_count("contact"),
        ),
        StageBlueprint(
            definition=_definition("merge-v1", "merge"),
            worker_factory=merge_worker_factory or (lambda: MergeWorker()),
            instance_count=_count("merge"),
        ),
        StageBlueprint(
            definition=_definition("qualification-v1", "qualification"),
            worker_factory=qualification_worker_factory
            or (
                lambda: QualificationWorker(
                    niche=niche,
                    required_categories=required_categories,
                    required_channels=required_channels,
                )
            ),
            instance_count=_count("qualification"),
        ),
        StageBlueprint(
            definition=_definition("storage-v1", "storage"),
            worker_factory=storage_worker_factory
            or (lambda: StorageWorker(backend=storage_backend)),
            instance_count=_count("storage"),
        ),
    ]

    coordinator.build_runtime_context(
        session_id, stages=stage_blueprints, queue_definitions=queue_definitions
    )
    fan_in = coordinator.build_fan_in_runtime(
        session_id, merge_queue_id=queue_ids.merge_in, merge_output_stage="merge"
    )
    engine_runtime = coordinator.get_engine_runtime(session_id)
    ctx = coordinator.get_session(session_id)
    queue_manager = ctx.runtime.queue_manager
    website_queue = queue_manager.get_queue(queue_ids.website_in)
    instagram_queue = queue_manager.get_queue(queue_ids.instagram_in)

    stash = _EnrichedBusinessStash()
    qualification_in_flight = _QualificationInFlight()

    # PART A/C (Phase 2B instrumentation): minimal, additive lifecycle
    # progress signal. `on_progress`, if supplied, is called with
    # (stage, event, item_id) for the handful of events cheap to observe
    # from this composition root without threading a new identifier
    # through every worker (`item_id` is a pipeline_id where discovery
    # already has one, otherwise the queue_item_id `StageOutcome` already
    # carries -- enough to reconstruct per-item timing, per the task's own
    # "Do NOT spam massive payloads" instruction). Never allowed to raise
    # into pipeline code -- an observer failing must never affect
    # discovery/enrichment itself.
    def _emit(stage: str, event: str, item_id: Optional[str]) -> None:
        if on_progress is None:
            return
        try:
            on_progress(stage, event, item_id)
        except Exception:
            log.debug("on_progress observer raised — ignored", exc_info=True)

    def _emit_stage_outcome(outcome: StageOutcome) -> None:
        if not outcome.ran:
            return
        item_id = outcome.queue_item_id or outcome.worker_id
        event = "stage_completed" if outcome.success else "stage_failed"
        _emit(outcome.stage_name, event, item_id)
        # Phase 3B-VALIDATION (observability only): for the two stages the
        # audit is validating (website, contact), also emit a weak/normal
        # site label for this same outcome, keyed by pipeline_id (not
        # queue_item_id/worker_id like the line above — pipeline_id is what
        # the "site_class_queued" event from _on_candidate used, so the two
        # can be joined). Looked up via `fan_in.get_business`, the same
        # accessor `_website_downstream`/`_contact_downstream` already use
        # for their own (unmodified) required-channel checks — no new
        # state, no new lookup path. A miss (business no longer registered)
        # is silently skipped; this is telemetry, never a gate.
        if outcome.stage_name in ("website", "contact") and outcome.pipeline_id:
            business = fan_in.get_business(outcome.pipeline_id)
            if business is not None:
                _emit(
                    outcome.stage_name,
                    f"site_class_{event}:{_site_class(business.website)}",
                    outcome.pipeline_id,
                )

    # -- Discovery: producer, per StageConfig's own contract -------------

    def _early_dedup_decision(candidate: BusinessCandidate) -> EarlyDedupDecision:
        """
        Phase 3C-4B Step 1/2 — the earliest safe dedup point: right here,
        the moment a BusinessCandidate exists and before any enrichment
        worker has touched it. Uses only the identity fields a
        BusinessCandidate can actually carry (maps_url, and website/phone
        when the Maps provider happened to expose them) — see
        storage/early_persistent_dedup.py for exactly which fingerprint
        keys that produces and why it's intentionally narrower than the
        full post-enrichment fingerprint set.
        """
        keys = early_fingerprint_keys(
            maps_url=candidate.maps_url,
            website=candidate.website,
            phone=candidate.phone,
        )
        checked = early_dedup_checker is not None and bool(keys)
        is_dup = checked and early_dedup_checker.is_duplicate(keys)
        return EarlyDedupDecision(
            pipeline_id=candidate.pipeline_id,
            session_id=candidate.session_id,
            scrape_job_id=scrape_job_id,
            maps_place_id=maps_place_id_from_keys(keys),
            fingerprint_keys=tuple(sorted(keys)),
            is_duplicate=is_dup,
            checked=checked,
        )

    def _on_candidate(candidate: BusinessCandidate) -> None:
        """
        See workers/discovery_worker.py's own "Ownership of
        on_candidate" section, which names this composition layer as
        the one responsible for this closure. Seeds the FanInRuntime
        accumulator (needed for MergeInput.business, per AD-042 §6's
        "correlation key" requirement) and fans the candidate out to
        both branch-input queues that take a BusinessCandidate
        directly. Contact's queue is deliberately not fed here — its
        input is WebsiteIntel, populated once WebsiteWorker's own
        `build_downstream` (below) forwards its output, per module
        docstring review point 6.

        Phase 3C-4B: before any of that, a cheap persistent-dedup check
        runs (see `_early_dedup_decision` above). A duplicate is neither
        registered with FanInRuntime nor enqueued into any branch —
        Website/Instagram/Contact enrichment simply never sees it, and
        because it's never registered/enqueued/stored, it also never
        counts toward the caller's requested accepted-lead target (Step
        6) — discovery just keeps searching for the next candidate. This
        is a fast-reject optimization only: the final persistent dedup
        (deliverLead.ts::findExistingBusiness, Node-side, post-enrichment)
        is completely unmodified and remains authoritative — see Step 4 /
        module docstring for why a "no early match" here is never treated
        as "definitely new".
        """
        _emit("discovery", "candidate_discovered", candidate.pipeline_id)

        decision = _early_dedup_decision(candidate)
        log_early_dedup_decision(decision)
        if decision.is_duplicate:
            _emit("discovery", "candidate_early_duplicate", candidate.pipeline_id)
            return

        # PHASE 4A — SAFE ZERO-COST DISCOVERY FILTERS
        # Both checks below use only data that already exists on
        # BusinessCandidate at this point (no extra fetch, no extra
        # enrichment call) and, like the dedup check just above, prune
        # by returning before the candidate is ever registered with
        # FanInRuntime or enqueued into any branch — so a pruned
        # candidate is invisible to Website/Instagram/Contact
        # enrichment and never counts toward the accepted-lead target.

        # A. CLOSED BUSINESS: BusinessCandidate.closed is a straight
        # trace of RawPlace.closed (see that field's docstring in
        # engine/contracts.py) — no new closed-business rule is
        # invented here, this only acts earlier on a value Maps
        # discovery already produced.
        if candidate.closed:
            _emit("discovery", "candidate_closed_pruned", candidate.pipeline_id)
            log.info(
                "discovery: pipeline_id=%s safe-pruned (reason=closed_business)",
                candidate.pipeline_id,
            )
            return

        # B. EXISTING CHAIN/CANNABIS FILTER: the exact same predicate
        # ScoringWorker uses (see the import above) — reused here, not
        # duplicated, so a chain/cannabis candidate that would be
        # hard-disqualified at scoring time anyway (opportunity_score
        # 0/10 — see workers/scoring_worker.py's process()) is instead
        # recognized before it burns a Website/Instagram/Contact
        # enrichment call. Final qualification semantics are
        # unaffected: this predicate always agreed with scoring's
        # verdict, it just now also gets consulted earlier.
        if _keyword_is_cannabis(candidate.name, candidate.category) or _keyword_is_chain(candidate.name):
            _emit("discovery", "candidate_keyword_pruned", candidate.pipeline_id)
            log.info(
                "discovery: pipeline_id=%s safe-pruned (reason=discovery_keyword_pruned)",
                candidate.pipeline_id,
            )
            return

        # GENERIC SAFE CHANNEL PRUNING:
        # A candidate is pruned early ONLY if it is definitely impossible to satisfy
        # a required channel based on current evidence (no direct evidence on Maps
        # AND no website to enable downstream discovery).
        if required_channels:
            has_site = bool(candidate.website)
            for ch in required_channels:
                if ch == "website" and not has_site:
                    _emit("discovery", "candidate_early_channel_pruned", candidate.pipeline_id)
                    log.info("discovery: pipeline_id=%s safe-pruned (missing website for website channel)", candidate.pipeline_id)
                    return
                elif ch == "email" and not has_site:
                    # BusinessCandidate carries no `email` field (Google
                    # Maps discovery never surfaces one — see
                    # BusinessCandidate's own docstring: "no email").
                    # The `has_maps_valid_email` branch this replaced
                    # read `getattr(candidate, "email", None)`, which is
                    # always None, so that branch was structurally dead:
                    # it could never evaluate to True and never changed
                    # this decision. The website-based email fallback
                    # (email is only ever discoverable once a website
                    # exists, via ContactWorker downstream) is preserved
                    # exactly — this condition is unchanged for every
                    # real input, since has_maps_valid_email was always
                    # False.
                    _emit("discovery", "candidate_early_channel_pruned", candidate.pipeline_id)
                    log.info("discovery: pipeline_id=%s safe-pruned (no valid email on Maps and no website to discover email)", candidate.pipeline_id)
                    return
                elif ch == "phone" and not candidate.phone and not has_site:
                    _emit("discovery", "candidate_early_channel_pruned", candidate.pipeline_id)
                    log.info("discovery: pipeline_id=%s safe-pruned (no phone on Maps and no website to discover phone)", candidate.pipeline_id)
                    return
                elif ch == "instagram" and not getattr(candidate, "instagram_url", None) and not has_site:
                    _emit("discovery", "candidate_early_channel_pruned", candidate.pipeline_id)
                    log.info("discovery: pipeline_id=%s safe-pruned (no instagram handle and no website to discover instagram)", candidate.pipeline_id)
                    return

        fan_in.register_business(candidate)
        website_queue.enqueue(
            pipeline_id=candidate.pipeline_id, stage="website", payload=candidate
        )
        instagram_queue.enqueue(
            pipeline_id=candidate.pipeline_id, stage="instagram", payload=candidate
        )
        _emit("discovery", "candidate_queued", candidate.pipeline_id)
        # Phase 3B-VALIDATION: label this early_new candidate weak vs
        # normal site. Purely additive — a new, distinctly-named event
        # alongside the existing "candidate_queued" one above, not a
        # replacement for it.
        _emit(
            "discovery",
            f"site_class_queued:{_site_class(candidate.website)}",
            candidate.pipeline_id,
        )

    discovery_stage = StageConfig(
        name="discovery",
        definition_id="discovery-v1",
        input_queue_id=None,
        output_queue_id=None,
        produce_worker_input=lambda: DiscoveryExecution(
            request=discovery_request, on_candidate=_on_candidate
        ),
        build_downstream=lambda _count: None,
    )

    # -- Website: records its own branch result AND forwards WebsiteIntel
    #    on to Contact's input queue (module docstring review point 6).

    def _website_downstream(intel: WebsiteIntel) -> Optional[WebsiteIntel]:
        if required_channels:
            business = fan_in.get_business(intel.pipeline_id)
            has_maps_email = bool(business and is_valid_email(getattr(business, "email", None)))
            if "website" in required_channels and intel.website_reachable is False:
                _emit("website", "candidate_early_channel_pruned", intel.pipeline_id)
                fan_in.prune_business(intel.pipeline_id, "unreachable_website")
                return None
            if "email" in required_channels and intel.website_reachable is False and not has_maps_email:
                _emit("website", "candidate_early_channel_pruned", intel.pipeline_id)
                fan_in.prune_business(intel.pipeline_id, "unreachable_website_no_email")
                return None
        fan_in.record_website_result(intel.pipeline_id, intel)
        # Phase 9.1 (audit follow-up, additive/observational only): report
        # which broadened contact-page hint keyword (if any) matched, so
        # the audit's "contact_page_hint=<keyword>" telemetry ask is
        # answerable from real run counters (see service.py's
        # `_on_progress`) without touching pruning/qualification here.
        if intel.contact_page_hint:
            _emit(
                "website",
                f"contact_page_hint:{intel.contact_page_hint}",
                intel.pipeline_id,
            )
        if intel.website_reachable is False:
            return None
        return intel

    website_stage = StageConfig(
        name="website",
        definition_id="website-v1",
        input_queue_id=queue_ids.website_in,
        output_queue_id=queue_ids.contact_in,
        output_stage="contact",
        build_downstream=_website_downstream,
    )

    # -- Instagram: reports its own branch result to FanInRuntime, then
    #    forwards nothing meaningful (see Item 4 fix note below).

    def _instagram_downstream(intel) -> None:
        fan_in.record_instagram_result(intel.pipeline_id, intel)
        return None

    instagram_stage = StageConfig(
        name="instagram",
        definition_id="instagram-v1",
        input_queue_id=queue_ids.instagram_in,
        # Item 4 fix: this MUST be non-None. engine/runtime.py's own
        # _handle_success() only calls build_downstream() at all when
        # output_queue_id is not None -- with output_queue_id=None,
        # _instagram_downstream (and therefore record_instagram_result)
        # was silently never invoked for any candidate, ever. Routed to
        # fan_in_sink, a queue nothing ever dequeues from; since
        # _instagram_downstream still returns None, nothing is actually
        # enqueued into it -- this exists only to satisfy that check.
        output_queue_id=queue_ids.fan_in_sink,
        output_stage="fan_in_sink",
        build_downstream=_instagram_downstream,
    )

    # -- Contact: same shape and same Item 4 fix as Instagram.

    def _contact_downstream(intel) -> None:
        if required_channels:
            business = fan_in.get_business(intel.pipeline_id)
            has_maps_email = bool(business and is_valid_email(getattr(business, "email", None)))
            has_contact_email = bool(intel and any(is_valid_email(e) for e in (intel.emails or ())))
            has_maps_phone = bool(business and getattr(business, "phone", None))
            has_contact_phone = bool(intel and intel.phones)

            if "email" in required_channels and not (has_contact_email or has_maps_email):
                _emit("contact", "candidate_early_channel_pruned", intel.pipeline_id)
                fan_in.prune_business(intel.pipeline_id, "missing_required_channel:email")
                return None
            if "phone" in required_channels and not (has_contact_phone or has_maps_phone):
                _emit("contact", "candidate_early_channel_pruned", intel.pipeline_id)
                fan_in.prune_business(intel.pipeline_id, "missing_required_channel:phone")
                return None

        # Phase 8.1 (ContactWorker resilience fix): these are plain
        # facts ContactWorker already computed about its own run (see
        # workers/contact_worker.py's module docstring) — this is only
        # where they're translated into the same _emit/profiler.incr
        # plumbing every other stage counter in this file already
        # uses. Never gates/prunes anything; purely additive
        # observability alongside the existing contact_stage_failed
        # counter above, which this does not touch.
        if getattr(intel, "contact_page_fetch_failed", False):
            _emit("contact", "contact_page_fetch_failed", intel.pipeline_id)
        if getattr(intel, "homepage_fetch_failed", False):
            _emit("contact", "homepage_fetch_failed", intel.pipeline_id)
        if getattr(intel, "mailto_extracted", False):
            _emit("contact", "mailto_link_extracted", intel.pipeline_id)
        if getattr(intel, "tel_extracted", False):
            _emit("contact", "tel_link_extracted", intel.pipeline_id)
        if getattr(intel, "partial_contact_success", False):
            _emit("contact", "partial_contact_success", intel.pipeline_id)

        fan_in.record_contact_result(intel.pipeline_id, intel)
        return None

    contact_stage = StageConfig(
        name="contact",
        definition_id="contact-v1",
        input_queue_id=queue_ids.contact_in,
        # Item 4 fix: see instagram_stage's comment above -- identical
        # reasoning and identical fix.
        output_queue_id=queue_ids.fan_in_sink,
        output_stage="fan_in_sink",
        build_downstream=_contact_downstream,
    )

    # -- Merge: fed by FanInRuntime's own enqueue() (not by this
    #    StageConfig's output_queue_id — nothing upstream of Merge
    #    enqueues into merge_in directly). Stashes the EnrichedBusiness
    #    Qualification will need, then forwards it unchanged.

    def _merge_downstream(enriched: EnrichedBusiness) -> Optional[EnrichedBusiness]:
        if fan_in.is_pruned(enriched.pipeline_id):
            log.info("merge: pipeline_id=%s was pruned; dropping downstream", enriched.pipeline_id)
            return None
        stash.put(enriched)
        return enriched

    merge_stage = StageConfig(
        name="merge",
        definition_id="merge-v1",
        input_queue_id=queue_ids.merge_in,
        output_queue_id=queue_ids.qualification_in,
        output_stage="qualification",
        build_downstream=_merge_downstream,
    )

    # -- Scoring: NOT a StageConfig/queue -- there is no scoring_in
    #    queue and no ScoringWorker WorkerDefinition anywhere in this
    #    pipeline (deliberately -- adding one would turn this into an
    #    eight-stage pipeline, which was explicitly not authorized).
    #    ScoringWorker is stateless and pure (no I/O, no queue import --
    #    see its own module docstring), so one shared instance is
    #    invoked as a plain function call from the existing
    #    QualifiedOpportunity composition point below
    #    (`_qualification_downstream`), the same place `score` was
    #    already a named field being populated (previously hardcoded to
    #    None -- see that function for what changed).
    _scoring_worker = (scoring_worker_factory or (lambda: ScoringWorker()))()

    # -- Qualification: composes QualifiedOpportunity from this cycle's
    #    QualificationResult plus the EnrichedBusiness Merge stashed for
    #    the same pipeline_id, and (per the composition-point review
    #    above) this cycle's OpportunityScore, computed synchronously
    #    from the same stashed EnrichedBusiness via ScoringWorker. A
    #    rejected result is not forwarded to Storage at all --
    #    QualificationResult's own docstring already calls a rejected
    #    result "effectively terminal for that pipeline"; StorageWorker
    #    is never given a QualifiedOpportunity to persist for one, and
    #    ScoringWorker is correspondingly never invoked for one either
    #    (no point scoring an opportunity that will never be stored).

    def _qualification_worker_input(item: Any) -> EnrichedBusiness:
        # Recorded on every attempt (including a retried one), before
        # process() runs -- so a dead-lettered attempt's StageOutcome
        # (which carries queue_item_id but never pipeline_id; see
        # _QualificationInFlight's own docstring) can still be traced
        # back to the right stash entry by _on_qualification_outcome
        # below. Otherwise identical to StageConfig.build_worker_input's
        # own default (`item.payload`) -- no other behavior added.
        qualification_in_flight.record(item.queue_item_id, item.pipeline_id)
        return item.payload

    def _qualification_downstream(
        result: QualificationResult,
    ) -> Optional[QualifiedOpportunity]:
        if fan_in.is_pruned(result.pipeline_id):
            log.info("qualification: pipeline_id=%s was pruned; dropping downstream", result.pipeline_id)
            return None
        enriched = stash.pop(result.pipeline_id)
        if enriched is None:
            log.warning(
                "qualification: no stashed EnrichedBusiness for "
                "pipeline_id=%s; dropping (cannot build QualifiedOpportunity "
                "without it)",
                result.pipeline_id,
            )
            return None
        if not result.qualified:
            log.info(
                "qualification: pipeline_id=%s rejected (%s); not "
                "forwarded to Storage",
                result.pipeline_id, ", ".join(result.reasons) or "no reason given",
            )
            return None
        business_session_id = (
            enriched.business.session_id if enriched.business is not None else session_id
        )
        _emit("qualification", "candidate_qualified", result.pipeline_id)
        # Phase 3B-VALIDATION: label this qualified candidate weak vs
        # normal site, using the same stashed `EnrichedBusiness.business`
        # this function already popped above — no new lookup.
        if enriched.business is not None:
            _emit(
                "qualification",
                f"site_class_qualified:{_site_class(enriched.business.website)}",
                result.pipeline_id,
            )
        score = _scoring_worker.process(enriched)
        qualified_opportunity = QualifiedOpportunity(
            pipeline_id=result.pipeline_id,
            session_id=business_session_id,
            business=enriched,
            qualification=result,
            score=score,
        )

        # -- Prioritization: NOT a StageConfig/queue, for the identical
        #    reason Scoring (above) is not one -- adding one would turn
        #    this into an eight/nine-stage pipeline, which was
        #    explicitly not authorized. OpportunityPrioritizationService
        #    is stateless and pure, so it is invoked as a plain function
        #    call from this same composition point, the same way Scoring
        #    already is. Unlike Scoring, its inputs live in the domain
        #    layer (opportunities.Opportunity /
        #    opportunity_qualification.OpportunityQualification /
        #    opportunity_scoring.OpportunityScore), not the production
        #    layer -- engine/adapters.py bridges that gap. Per that
        #    module's own contract, any of the three adapters may
        #    legitimately return None (no fabricated data); when that
        #    happens this opportunity is silently excluded from the
        #    batch intelligence chain (Prioritization/Ranking/Mission
        #    Generation/Workflow Initialization) but is still returned
        #    below unchanged, so Storage persists it exactly as before --
        #    this integration adds a side channel, it does not gate the
        #    existing Storage path.
        domain_opportunity = engine_adapters.to_domain_opportunity(qualified_opportunity)
        domain_qualification = engine_adapters.to_domain_qualification(qualified_opportunity)
        domain_score = engine_adapters.to_domain_score(qualified_opportunity)
        if domain_opportunity is not None and domain_qualification is not None and domain_score is not None:
            policy = PrioritizationPolicy(
                strategy=PrioritizationStrategy.BALANCED,
                evaluation_at=_dt.datetime.now(_dt.timezone.utc),
            )
            priority = OpportunityPrioritizationService.evaluate_priority(
                domain_opportunity, domain_qualification, domain_score, policy
            )
            coordinator.record_prioritized_opportunity(
                session_id,
                (domain_opportunity, domain_qualification, domain_score, priority),
            )
        else:
            log.info(
                "prioritization: pipeline_id=%s could not be adapted to the "
                "Engine 2.0 domain layer; excluded from the batch "
                "intelligence chain (Storage is unaffected)",
                result.pipeline_id,
            )

        return qualified_opportunity

    def _on_qualification_outcome(outcome: StageOutcome) -> None:
        """
        Guarantees every `_EnrichedBusinessStash` entry this pipeline
        creates is eventually removed, regardless of whether
        Qualification succeeds or permanently fails. `build_downstream`
        (above) already removes the stash entry on success; that
        function is simply never called for a dead-lettered attempt
        (`EngineRuntime._handle_success` -- the only caller of
        `build_downstream` -- is only reached on the success path), so
        this is the only place that can close the leak an earlier
        audit found: a dead-lettered qualification_in item whose
        stashed EnrichedBusiness would otherwise never be popped.

        Intended to be passed as `ExecutionDriver(...,
        on_stage_outcome=...)` -- this is that existing, unmodified
        extension point; nothing new was added to ExecutionDriver
        itself to support this.
        """
        if outcome.stage_name != "qualification" or outcome.queue_item_id is None:
            return
        if not (outcome.success or outcome.dead_lettered):
            # Neither terminal outcome yet (an ordinary attempt
            # recorded for a possible future retry) -- the tracking
            # entry must stay so a later dead-lettered attempt can
            # still be traced back to its pipeline_id.
            return
        pipeline_id = qualification_in_flight.pop(outcome.queue_item_id)
        if outcome.dead_lettered and pipeline_id is not None:
            if stash.pop(pipeline_id) is not None:
                log.info(
                    "qualification: pipeline_id=%s permanently "
                    "dead-lettered (queue_item_id=%s); discarding its "
                    "stashed EnrichedBusiness",
                    pipeline_id, outcome.queue_item_id,
                )

    def _on_enrichment_failure_outcome(outcome: StageOutcome) -> None:
        """
        Guarantees failed/dead-lettered enrichment branches (website, instagram, contact)
        are reported to FanInRuntime so correlation state is not orphaned forever.
        """
        if not outcome.ran or outcome.success:
            return
        pipeline_id = outcome.pipeline_id
        if not pipeline_id:
            return
        if fan_in.is_closed(pipeline_id) or fan_in.is_pruned(pipeline_id):
            return

        if outcome.stage_name == "website":
            if required_channels:
                business = fan_in.get_business(pipeline_id)
                has_maps_email = bool(business and is_valid_email(getattr(business, "email", None)))
                if "website" in required_channels or ("email" in required_channels and not has_maps_email):
                    _emit("website", "candidate_early_channel_pruned", pipeline_id)
                    fan_in.prune_business(pipeline_id, "website_stage_failed")
                    return
            fan_in.record_website_dead_letter(pipeline_id)
        elif outcome.stage_name == "instagram":
            if required_channels and "instagram" in required_channels:
                _emit("instagram", "candidate_early_channel_pruned", pipeline_id)
                fan_in.prune_business(pipeline_id, "instagram_stage_failed")
                return
            fan_in.record_instagram_dead_letter(pipeline_id)
        elif outcome.stage_name == "contact":
            if required_channels:
                business = fan_in.get_business(pipeline_id)
                has_maps_email = bool(business and is_valid_email(getattr(business, "email", None)))
                has_maps_phone = bool(business and getattr(business, "phone", None))
                if ("email" in required_channels and not has_maps_email) or ("phone" in required_channels and not has_maps_phone):
                    _emit("contact", "candidate_early_channel_pruned", pipeline_id)
                    fan_in.prune_business(pipeline_id, "contact_stage_failed")
                    return
            fan_in.record_contact_dead_letter(pipeline_id)

    qualification_stage = StageConfig(
        name="qualification",
        definition_id="qualification-v1",
        input_queue_id=queue_ids.qualification_in,
        output_queue_id=queue_ids.storage_in,
        output_stage="storage",
        build_worker_input=_qualification_worker_input,
        build_downstream=_qualification_downstream,
    )

    # -- Storage: terminal.

    storage_stage = StageConfig(
        name="storage",
        definition_id="storage-v1",
        input_queue_id=queue_ids.storage_in,
        output_queue_id=None,
    )

    stages = [
        discovery_stage,
        website_stage,
        instagram_stage,
        contact_stage,
        merge_stage,
        qualification_stage,
        storage_stage,
    ]

    log.info(
        "build_seven_stage_pipeline: session=%s stages=%d queues=%d",
        session_id, len(stages), len(queue_definitions),
    )

    def _combined_on_stage_outcome(outcome: StageOutcome) -> None:
        # Composition-root-only fan-out to this pipeline's two existing
        # `on_stage_outcome` consumers: the pre-existing stash-cleanup
        # callback (unchanged) and this phase's additive progress
        # instrumentation. `ExecutionDriver` itself still accepts exactly
        # one such callback -- this is that single callback.
        #
        # PHASE 2 (per-area latency profiling): `on_stage_timing`, if
        # supplied, is a third consumer, fanned out the same way. It
        # receives the raw `StageOutcome` (not just stage/event/item_id
        # like `on_progress`) specifically so a caller can read
        # `duration_ms` / `queue_wait_ms` / `success` — none of which
        # `on_progress`'s narrower signature carries. Never allowed to
        # raise into pipeline code, matching `_emit`'s own posture above.
        _on_qualification_outcome(outcome)
        _on_enrichment_failure_outcome(outcome)
        _emit_stage_outcome(outcome)
        if on_stage_timing is not None:
            try:
                on_stage_timing(outcome)
            except Exception:
                log.debug("on_stage_timing observer raised — ignored", exc_info=True)

    return stages, queue_ids, fan_in, _combined_on_stage_outcome


def run_batch_intelligence(coordinator: EngineCoordinator, session_id: str) -> Dict[str, Any]:
    """
    Session-scoped completion of the batch intelligence chain: Ranking ->
    Mission Generation -> Workflow Initialization (Part 3, MAST Lead
    Engine 2.0 continuation).

    Must be called AFTER coordinator.finish_session(session_id) (or
    cancel_session/fail_session -- ranking whatever a session actually
    accumulated before early termination is still a legitimate ranking of
    that cohort, not a redesign of when Ranking runs). Drains this
    session's accumulated cohort (per-opportunity Prioritization results
    recorded by `_qualification_downstream` during the run, via
    `coordinator.record_prioritized_opportunity`) with
    `coordinator.pop_batch_cohort()`, then:

      1. Ranking -- OpportunityRankingService.rank_opportunities() over
         the ENTIRE cohort's OpportunityPriority values. Session-scoped,
         never opportunity-scoped, per the locked architecture ("Ranking
         compares the entire discovery cohort").
      2. Mission Generation -- MissionGenerationService.generate_missions()
         for every ranked opportunity whose OpportunityPriority.is_eligible
         is True. is_eligible is a value the domain layer already computed
         during Prioritization (not a new rule invented here); Ranking
         itself does not filter on it (pure sort -- see
         OpportunityRankingService's own module docstring), so this
         wiring layer honors the flag before generating missions,
         rather than generating outreach missions for opportunities
         Prioritization already marked ineligible.
      3. Workflow Initialization -- WorkflowEngineService.initialize_workflow()
         for every generated Mission.

    Returns a dict of the three output tuples and stores it via
    coordinator.set_batch_result() for later on-demand retrieval (e.g. by
    the `workflow` CLI mode's "transition" action, or a future API route).
    Never raises for an empty/fully-ineligible cohort (returns empty
    tuples); only propagates a domain service's own exception, since that
    indicates a genuine integration defect (e.g. a lineage mismatch)
    rather than "nothing to rank this time."
    """
    cohort = coordinator.pop_batch_cohort(session_id)

    priorities = [record[3] for record in cohort]
    opportunities_by_id = {record[0].opportunity_id: record[0] for record in cohort}

    ranked = OpportunityRankingService.rank_opportunities(priorities)

    eligible_by_id = {p.opportunity_id: p.is_eligible for p in priorities}
    mission_pairs = [
        (ranked_opp, opportunities_by_id[ranked_opp.opportunity_id])
        for ranked_opp in ranked
        if eligible_by_id.get(ranked_opp.opportunity_id, False)
    ]
    missions = MissionGenerationService.generate_missions(mission_pairs)

    workflow_states = tuple(
        WorkflowEngineService.initialize_workflow(mission) for mission in missions
    )

    result: Dict[str, Any] = {
        # Part 4 (Persistence Integration milestone) addition: the
        # cohort's own Prioritization output was already computed above
        # (`priorities`, drained from the cohort tuples) but was never
        # surfaced in this dict before -- only consumed internally to
        # build `ranked`. Storage needs it too (opportunity_priorities
        # is one of the five tables the persistence milestone
        # introduces), so it is added here, additively -- every key
        # that existed before is unchanged.
        "priorities": tuple(priorities),
        "ranked_opportunities": ranked,
        "missions": missions,
        "workflow_states": workflow_states,
    }
    coordinator.set_batch_result(session_id, result)

    log.info(
        "run_batch_intelligence: session=%s cohort=%d ranked=%d "
        "eligible_missions=%d workflow_states=%d",
        session_id, len(cohort), len(ranked), len(missions), len(workflow_states),
    )
    return result
