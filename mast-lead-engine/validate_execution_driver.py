"""
Validation script -- Phase 6.7 Execution Driver, post-cleanup.

Re-validates the original end-to-end pipeline claims AND specifically
exercises the three corrective fixes applied in this cleanup pass:

    1. run_producers_once now genuinely controls once-vs-repeat.
    2. _EnrichedBusinessStash entries are removed on the dead-letter
       path, not just the success path.
    3. stop(wait=True) called from the driver's own thread no longer
       raises RuntimeError.

Run with: python3 validate_execution_driver.py
"""

from __future__ import annotations

import logging
import sys
import threading
import time
from typing import Iterator, List, Optional

sys.path.insert(0, ".")

from engine.contracts import BusinessCandidate, QualifiedOpportunity, StoredOpportunity
from engine.coordinator import EngineCoordinator
from engine.execution_driver import ExecutionDriver, build_seven_stage_pipeline
from engine.interfaces import DiscoveryProviderInterface
from engine.runtime import StageOutcome
from workers.qualification_worker import QualificationWorker
from workers.storage_worker import _StoragePersistenceProtocol  # for isinstance-style clarity only


PASS = "PASS"
FAIL = "FAIL"
results: List[str] = []


def check(label: str, condition: bool, detail: str = "") -> None:
    status = PASS if condition else FAIL
    line = f"[{status}] {label}" + (f" -- {detail}" if detail else "")
    print(line)
    results.append(line)


# ---------------------------------------------------------------------------
# Test doubles (validation-only; nothing production imports these)
# ---------------------------------------------------------------------------


class ListDiscoveryProvider(DiscoveryProviderInterface):
    """Yields a fixed, caller-supplied list of BusinessCandidates once per discover() call."""

    def __init__(self, candidates: List[BusinessCandidate]) -> None:
        self._candidates = candidates
        self.discover_call_count = 0

    @property
    def provider_id(self) -> str:
        return "list_provider"

    @property
    def display_name(self) -> str:
        return "List Provider (validation only)"

    def discover(self, request) -> Iterator[BusinessCandidate]:
        self.discover_call_count += 1
        for c in self._candidates:
            yield c


class InMemoryStorageBackend:
    """Minimal _StoragePersistenceProtocol implementation, in memory only."""

    def __init__(self) -> None:
        self.stored: List[StoredOpportunity] = []

    def persist(self, opportunity: QualifiedOpportunity) -> StoredOpportunity:
        stored = StoredOpportunity(
            opportunity_id=f"opp-{len(self.stored) + 1}",
            pipeline_id=opportunity.pipeline_id,
        )
        self.stored.append(stored)
        return stored


class AlwaysFailQualificationWorker(QualificationWorker):
    """Used only to deterministically drive one real failed attempt for Test 2."""

    def process(self, item):  # noqa: D401 - test double
        raise RuntimeError("validation: forced QualificationWorker failure")


def make_candidate(pipeline_id: str, session_id: str, *, website=None, phone=None) -> BusinessCandidate:
    return BusinessCandidate(
        pipeline_id=pipeline_id,
        session_id=session_id,
        provider="list_provider",
        name=f"Business {pipeline_id}",
        website=website,
        phone=phone,
    )


def drain(driver: ExecutionDriver, max_passes: int = 200) -> None:
    """Synchronously run_once() until a full pass produces no ran=True outcome."""
    for _ in range(max_passes):
        outcomes = driver.run_once()
        if not any(o.ran for o in outcomes):
            return
    raise AssertionError("drain() exceeded max_passes without settling")


# ---------------------------------------------------------------------------
# Test 1: end-to-end pipeline still works (rejected path + qualified path)
# ---------------------------------------------------------------------------

print("\n=== Test 1: full pipeline, end-to-end ===")

coordinator = EngineCoordinator()
ctx = coordinator.create_session(user_id="validation-user", provider="list_provider", requested_count=2)
session_id = ctx.session.id
coordinator.start_session(session_id)

candidates = [
    make_candidate("pid-rejected", session_id, website=None, phone=None),
    make_candidate("pid-qualified", session_id, website="https://pypi.org", phone="+1-555-0100"),
]
provider = ListDiscoveryProvider(candidates)
backend = InMemoryStorageBackend()

stages, queue_ids, fan_in, cleanup_cb = build_seven_stage_pipeline(
    coordinator,
    session_id,
    discovery_provider=provider,
    discovery_request=object(),
    storage_backend=backend,
)
engine_runtime = coordinator.get_engine_runtime(session_id)

stage_outcomes: List[StageOutcome] = []


def _record(outcome: StageOutcome) -> None:
    stage_outcomes.append(outcome)


driver = ExecutionDriver(
    engine_runtime,
    stages,
    on_stage_outcome=lambda o: (cleanup_cb(o), _record(o)),
    idle_poll_seconds=0.0,
)

drain(driver)

ran_stage_names = {o.stage_name for o in stage_outcomes if o.ran}
check(
    "Discovery executed",
    "discovery" in ran_stage_names,
)
check("Website executed", "website" in ran_stage_names)
check("Instagram executed", "instagram" in ran_stage_names)
check("Contact executed", "contact" in ran_stage_names)
check("Merge executed", "merge" in ran_stage_names)
check("Qualification executed", "qualification" in ran_stage_names)
check("Storage executed", "storage" in ran_stage_names)

qm = ctx.runtime.queue_manager
check(
    "All queues drained (empty)",
    all(qm.get_queue(qid).is_empty() for qid in [
        queue_ids.website_in, queue_ids.instagram_in, queue_ids.contact_in,
        queue_ids.merge_in, queue_ids.qualification_in, queue_ids.storage_in,
    ]),
)
check("FanInRuntime has no pending correlation state left", fan_in.pending_count() == 0)
check(
    "StorageWorker became reachable and persisted the qualified candidate",
    len(backend.stored) == 1 and backend.stored[0].pipeline_id == "pid-qualified",
    detail=f"stored={[s.pipeline_id for s in backend.stored]}",
)
check("Discovery ran exactly once (default run_producers_once=True)", provider.discover_call_count == 1)

driver.stop()

# ---------------------------------------------------------------------------
# Test 2: run_producers_once now genuinely controls behavior
# ---------------------------------------------------------------------------

print("\n=== Test 2: run_producers_once flag ===")

ctx2 = coordinator.create_session(user_id="validation-user", provider="list_provider", requested_count=1)
session_id2 = ctx2.session.id
coordinator.start_session(session_id2)

provider_once = ListDiscoveryProvider([make_candidate("pid-once", session_id2)])
backend2 = InMemoryStorageBackend()
stages2, queue_ids2, fan_in2, cleanup_cb2 = build_seven_stage_pipeline(
    coordinator, session_id2,
    discovery_provider=provider_once, discovery_request=object(), storage_backend=backend2,
)
runtime2 = coordinator.get_engine_runtime(session_id2)

driver_once = ExecutionDriver(runtime2, stages2, on_stage_outcome=cleanup_cb2, run_producers_once=True)
driver_once.run_once()
driver_once.run_once()
driver_once.run_once()
check(
    "run_producers_once=True: discover() called exactly once across 3 passes",
    provider_once.discover_call_count == 1,
    detail=f"discover_call_count={provider_once.discover_call_count}",
)

ctx3 = coordinator.create_session(user_id="validation-user", provider="list_provider", requested_count=1)
session_id3 = ctx3.session.id
coordinator.start_session(session_id3)
provider_repeat = ListDiscoveryProvider([make_candidate("pid-repeat", session_id3)])
backend3 = InMemoryStorageBackend()
stages3, queue_ids3, fan_in3, cleanup_cb3 = build_seven_stage_pipeline(
    coordinator, session_id3,
    discovery_provider=provider_repeat, discovery_request=object(), storage_backend=backend3,
)
runtime3 = coordinator.get_engine_runtime(session_id3)
driver_repeat = ExecutionDriver(runtime3, stages3, on_stage_outcome=cleanup_cb3, run_producers_once=False)
driver_repeat.run_once()
driver_repeat.run_once()
driver_repeat.run_once()
check(
    "run_producers_once=False: discover() called more than once across 3 passes",
    provider_repeat.discover_call_count > 1,
    detail=f"discover_call_count={provider_repeat.discover_call_count}",
)

# ---------------------------------------------------------------------------
# Test 3: _EnrichedBusinessStash cleanup on the dead-letter path
# ---------------------------------------------------------------------------

print("\n=== Test 3: stash cleanup on dead-letter ===")

ctx4 = coordinator.create_session(user_id="validation-user", provider="list_provider", requested_count=1)
session_id4 = ctx4.session.id
coordinator.start_session(session_id4)

provider4 = ListDiscoveryProvider([make_candidate("pid-deadletter", session_id4)])
backend4 = InMemoryStorageBackend()
stages4, queue_ids4, fan_in4, cleanup_cb4 = build_seven_stage_pipeline(
    coordinator, session_id4,
    discovery_provider=provider4, discovery_request=object(), storage_backend=backend4,
    qualification_worker_factory=lambda: AlwaysFailQualificationWorker(),
)
runtime4 = coordinator.get_engine_runtime(session_id4)

# Capture the module's own logger so we can prove, from the outside, that
# stash.pop() genuinely found and removed a real entry (see module
# docstring's _on_qualification_outcome for why this is the only externally
# observable signal -- the stash and the in-flight tracker are pure
# closures, not attributes of anything returned).
log_records: List[str] = []


class _Capture(logging.Handler):
    def emit(self, record: logging.LogRecord) -> None:
        log_records.append(record.getMessage())


exec_logger = logging.getLogger("mast.engine.execution_driver")
exec_logger.setLevel(logging.INFO)
handler = _Capture()
exec_logger.addHandler(handler)

driver4 = ExecutionDriver(runtime4, stages4, on_stage_outcome=cleanup_cb4)

# Drive discovery -> website -> instagram -> contact -> merge only, stopping
# just short of qualification, so a real EnrichedBusiness is legitimately
# stashed for pid-deadletter (via the real, shipped _merge_downstream).
pre_qualification_stages = [s for s in stages4 if s.name != "qualification" and s.name != "storage"]
driver_pre = ExecutionDriver(runtime4, pre_qualification_stages, on_stage_outcome=cleanup_cb4)
drain(driver_pre)

qual_queue = ctx4.runtime.queue_manager.get_queue(queue_ids4.qualification_in)
check("qualification_in has exactly one pending item before qualification runs", qual_queue.size() == 1)

# One real execute_stage() call against the always-failing worker: this is
# the real _qualification_worker_input closure recording queue_item_id ->
# pipeline_id, and the real Queue.record_attempt() bookkeeping (attempt 1 of
# the queue's real 2-attempt retry_policy -- not yet eligible for dead
# letter, exactly as engine/runtime.py's own retry semantics require).
qualification_stage = next(s for s in stages4 if s.name == "qualification")
outcome_1 = runtime4.execute_stage(qualification_stage)
cleanup_cb4(outcome_1)
check(
    "first failed attempt is recorded but not yet dead-lettered",
    outcome_1.success is False and outcome_1.dead_lettered is False,
    detail=str(outcome_1),
)
check(
    "no stash-cleanup log line yet (nothing dead-lettered yet)",
    not any("permanently" in m for m in log_records),
)

# Advance that same, real queue_item_id to a real, permanent dead-letter,
# using the same public Queue API engine/runtime.py's own _handle_failure
# already calls -- this reflects what a future retry-execution milestone
# would eventually trigger automatically; it is not new engine behavior,
# only performed directly here because retry re-circulation itself is a
# separate, already-flagged, out-of-scope gap (see audit notes).
from queues.dead_letter import DeadLetterReason  # local import: validation-only

real_queue_item_id = outcome_1.queue_item_id
assert real_queue_item_id is not None
qual_queue.record_attempt(real_queue_item_id)  # attempts now 2, exhausted
qual_queue.dead_letter(
    real_queue_item_id,
    reason=DeadLetterReason.RETRY_EXHAUSTED,
    detail="validation: simulating a permanently exhausted retry",
)
check("queue now reports this item as a real dead letter", qual_queue.is_dead_letter(real_queue_item_id))

synthetic_dead_letter_outcome = StageOutcome(
    stage_name="qualification",
    ran=True,
    success=False,
    worker_id=outcome_1.worker_id,
    queue_item_id=real_queue_item_id,
    dead_lettered=True,
    detail="validation: simulated permanent-failure notification",
)
cleanup_cb4(synthetic_dead_letter_outcome)

check(
    "stash-cleanup log line fired exactly once for the dead-lettered pipeline_id",
    sum(1 for m in log_records if "pid-deadletter" in m and "permanently" in m) == 1,
    detail=str(log_records),
)

# Idempotency: calling cleanup again for the same outcome must be a silent
# no-op (in-flight entry already popped), not a second cleanup log line.
records_before = len(log_records)
cleanup_cb4(synthetic_dead_letter_outcome)
check(
    "cleanup callback is idempotent (no duplicate cleanup on repeat call)",
    len(log_records) == records_before,
)

exec_logger.removeHandler(handler)

# ---------------------------------------------------------------------------
# Test 4: stop(wait=True) is safe from inside the driver's own thread
# ---------------------------------------------------------------------------

print("\n=== Test 4: stop(wait=True) self-join safety ===")

ctx5 = coordinator.create_session(user_id="validation-user", provider="list_provider", requested_count=1)
session_id5 = ctx5.session.id
coordinator.start_session(session_id5)
provider5 = ListDiscoveryProvider([make_candidate("pid-selfstop", session_id5)])
backend5 = InMemoryStorageBackend()
stages5, queue_ids5, fan_in5, cleanup_cb5 = build_seven_stage_pipeline(
    coordinator, session_id5,
    discovery_provider=provider5, discovery_request=object(), storage_backend=backend5,
)
runtime5 = coordinator.get_engine_runtime(session_id5)

self_stop_exception: List[BaseException] = []
warning_logged = threading.Event()


class _WarnCapture(logging.Handler):
    def emit(self, record: logging.LogRecord) -> None:
        if record.levelno == logging.WARNING and "own drive thread" in record.getMessage():
            warning_logged.set()


warn_handler = _WarnCapture()
exec_logger.addHandler(warn_handler)

driver5 = ExecutionDriver(runtime5, stages5, on_stage_outcome=cleanup_cb5, idle_poll_seconds=0.01)


def _self_stopping_observer(outcome: StageOutcome) -> None:
    cleanup_cb5(outcome)
    if outcome.stage_name == "discovery" and outcome.ran:
        try:
            driver5.stop(wait=True, timeout=2.0)  # called from the drive thread itself
        except BaseException as exc:  # noqa: BLE001 - we want to know if this ever raises
            self_stop_exception.append(exc)


driver5._on_stage_outcome = _self_stopping_observer  # type: ignore[attr-defined]
driver5.start()

deadline = time.monotonic() + 5.0
while driver5.is_running() and time.monotonic() < deadline:
    time.sleep(0.05)

check(
    "stop(wait=True) from inside the drive thread raised no exception",
    len(self_stop_exception) == 0,
    detail=str(self_stop_exception),
)
check("warning was logged for the self-join case", warning_logged.is_set())
check("driver eventually stopped running", not driver5.is_running())

exec_logger.removeHandler(warn_handler)

# ---------------------------------------------------------------------------
# Test 5: imports remain acyclic / module still loads cleanly
# ---------------------------------------------------------------------------

print("\n=== Test 5: imports acyclic ===")
import subprocess

proc = subprocess.run(
    [sys.executable, "-c", "import engine.execution_driver; print('OK')"],
    cwd=".", capture_output=True, text=True,
)
check(
    "fresh interpreter import of engine.execution_driver succeeds",
    proc.returncode == 0 and "OK" in proc.stdout,
    detail=proc.stderr.strip()[-300:] if proc.returncode != 0 else "",
)

# ---------------------------------------------------------------------------

print("\n=== Summary ===")
n_fail = sum(1 for r in results if r.startswith("[FAIL]"))
print(f"{len(results) - n_fail}/{len(results)} checks passed")
if n_fail:
    sys.exit(1)
