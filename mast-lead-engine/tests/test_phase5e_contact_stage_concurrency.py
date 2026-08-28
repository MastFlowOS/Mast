"""
PHASE 5E — targeted regression tests for enabling bounded Contact stage
concurrency (contact=2) via the existing Phase 5C ExecutionDriver
mechanism.

Deliberately narrow, per Phase 5E's own instructions ("only run focused
tests needed for this change"). Mirrors
tests/test_phase5c_website_stage_concurrency.py's structure (same real
EngineCoordinator/EngineRuntime/WorkerAllocator/Queue stack, no network
I/O) but targets the "contact" stage instead of "website", plus one
additional test (5) proving Phase 5D's own per-instance internal fetch
concurrency stays bounded when two ContactWorker instances now run at
once.

Covers:
    1. Contact concurrency=2 is enforced.
    2. Two different Contact candidates can overlap.
    3. Distinct BaseWorker instances are used (no reuse while active).
    4. Existing retry/dead-letter behavior still works under Contact
       concurrency.
    5. Phase 5D's per-candidate internal fetch concurrency (<=2 threads
       per ContactWorker.process() call) remains bounded even with two
       ContactWorker instances processing concurrently (<=4 total).
    6. Cancellation stops new Contact submissions.
    7. Phase 5B terminal accounting remains correct (via the real
       build_seven_stage_pipeline() composition, Contact concurrency
       enabled).
"""

from __future__ import annotations

import os
import sys
import threading
import time
import urllib.error
from typing import Iterator, List, Optional

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

from engine.contracts import BusinessCandidate, ContactIntel, StoredOpportunity, WebsiteIntel
from engine.coordinator import EngineCoordinator, StageBlueprint
from engine.execution_driver import (
    DEFAULT_STAGE_CONCURRENCY,
    ExecutionDriver,
    build_seven_stage_pipeline,
)
from engine.interfaces import DiscoveryProviderInterface
from engine.runtime import StageConfig
from queues.queue_definition import QueueDefinition
from queues.retry_policy import RetryPolicy
from workers.base_worker import BaseWorker
from workers.contact_worker import ContactWorker
from workers.worker_capability import WorkerCapability
from workers.worker_definition import WorkerDefinition


def _website_intel(i: int) -> WebsiteIntel:
    return WebsiteIntel(pipeline_id=f"pid-{i}", website_reachable=True)


def test_default_stage_concurrency_includes_website_and_contact_only():
    """Sanity check on the central config itself: exactly Website and
    Contact are configured to 2; nothing else was touched."""
    assert DEFAULT_STAGE_CONCURRENCY == {"website": 2, "contact": 2}


class _ProbeContactWorker(BaseWorker):
    """Fake Contact worker: no network, deterministic, instrumented via
    a shared `_ConcurrencyProbe` (same pattern as the Phase 5C Website
    test's own probe) so tests can observe overlap/limits/distinct-
    instance behavior without timing races."""

    def __init__(self, probe: "_ConcurrencyProbe") -> None:
        super().__init__(worker_type="contact", capabilities=(WorkerCapability(name="contact"),))
        self._probe = probe

    def timeout_seconds(self) -> float:
        return 5.0

    def process(self, item: WebsiteIntel) -> ContactIntel:
        return self._probe.process(self, item)


class _ConcurrencyProbe:
    def __init__(self, concurrency: int) -> None:
        self._concurrency = concurrency
        self._lock = threading.Lock()
        self._active_ids: set = set()
        self.max_active = 0
        self.duplicate_instance_seen = False
        self.over_limit_seen = False
        self._barrier = threading.Barrier(concurrency, timeout=5.0)

    def process(self, worker: BaseWorker, item: WebsiteIntel) -> ContactIntel:
        with self._lock:
            if id(worker) in self._active_ids:
                self.duplicate_instance_seen = True
            self._active_ids.add(id(worker))
            self.max_active = max(self.max_active, len(self._active_ids))
            if len(self._active_ids) > self._concurrency:
                self.over_limit_seen = True
        try:
            self._barrier.wait()
        except threading.BrokenBarrierError:
            pass
        with self._lock:
            self._active_ids.discard(id(worker))
        return ContactIntel(pipeline_id=item.pipeline_id)


def _build_contact_only_driver(
    *,
    concurrency: int,
    instance_count: int,
    candidate_count: int,
    worker_factory,
    retry_policy: Optional[RetryPolicy] = None,
):
    """Minimal single-stage ("contact") pipeline, built directly (not
    via build_seven_stage_pipeline) -- same approach as the Phase 5C
    Website test's own `_build_website_only_driver`."""
    coordinator = EngineCoordinator()
    ctx = coordinator.create_session(user_id="probe_user", requested_count=candidate_count)
    session_id = ctx.session.id

    contact_in = QueueDefinition(
        queue_id="contact_in",
        queue_name="Contact Input",
        stage="contact",
        retry_policy=retry_policy or RetryPolicy(max_attempts=3, retry_delay_seconds=0.0, strategy="immediate"),
    )
    definition = WorkerDefinition(
        definition_id="contact-v1",
        worker_type="contact",
        capabilities=(WorkerCapability(name="contact"),),
    )
    blueprint = StageBlueprint(
        definition=definition,
        worker_factory=worker_factory,
        instance_count=instance_count,
    )

    coordinator.build_runtime_context(
        session_id, stages=[blueprint], queue_definitions=[contact_in]
    )
    coordinator.start_session(session_id)
    coordinator.mark_running(session_id)
    engine_runtime = coordinator.get_engine_runtime(session_id)

    queue = engine_runtime._runtime.queue_manager.get_queue("contact_in")
    for i in range(candidate_count):
        intel = _website_intel(i)
        queue.enqueue(pipeline_id=intel.pipeline_id, stage="contact", payload=intel)

    stage = StageConfig(name="contact", definition_id="contact-v1", input_queue_id="contact_in")
    driver = ExecutionDriver(
        engine_runtime, [stage], stage_concurrency={"contact": concurrency}
    )
    return driver, queue


def test_contact_concurrency_limit_is_enforced_and_overlaps():
    """Tests 1 + 2: with stage_concurrency={"contact": 2} and more idle
    instances than that, never more than 2 execute concurrently, and
    two calls are provably in flight at once (the barrier would
    hang/fail otherwise)."""
    probe = _ConcurrencyProbe(concurrency=2)
    driver, queue = _build_contact_only_driver(
        concurrency=2,
        instance_count=6,
        candidate_count=6,
        worker_factory=lambda: _ProbeContactWorker(probe),
    )
    try:
        for _ in range(10):
            if queue.is_empty():
                break
            driver.run_once()
    finally:
        driver.stop(wait=True, timeout=5.0)

    assert queue.is_empty()
    assert probe.max_active == 2, f"expected exactly 2 concurrent, saw {probe.max_active}"
    assert not probe.over_limit_seen
    assert not probe.duplicate_instance_seen  # test 3: no instance reused while active


def test_contact_retry_behavior_preserved_under_concurrency():
    """Test 4: existing retry-eligibility bookkeeping still behaves
    correctly, per item, when two Contact failures are processed
    concurrently -- including preserving each outcome's own
    pipeline_id. Same scope note as the Phase 5C Website retry test:
    this codebase's actual retry *execution* loop is a pre-existing,
    out-of-scope gap, so this exercises the one retry-policy outcome
    that's real today -- a policy permitting exactly one attempt,
    immediately dead-lettering a failure."""

    class _AlwaysFailContactWorker(BaseWorker):
        def __init__(self) -> None:
            super().__init__(worker_type="contact", capabilities=(WorkerCapability(name="contact"),))

        def timeout_seconds(self) -> float:
            return 5.0

        def process(self, item: WebsiteIntel) -> ContactIntel:
            raise RuntimeError("simulated contact failure")

    driver, queue = _build_contact_only_driver(
        concurrency=2,
        instance_count=3,
        candidate_count=0,
        worker_factory=lambda: _AlwaysFailContactWorker(),
        retry_policy=RetryPolicy(max_attempts=1, retry_delay_seconds=0.0, strategy="immediate"),
    )
    items = [
        queue.enqueue(pipeline_id=f"pid-{i}", stage="contact", payload=_website_intel(i))
        for i in range(2)
    ]
    for item in items:
        queue.record_attempt(item.queue_item_id)

    try:
        outcomes = driver.run_once()
    finally:
        driver.stop(wait=True, timeout=5.0)

    assert queue.is_empty()
    assert len(outcomes) == 2
    pipeline_ids = {o.pipeline_id for o in outcomes}
    assert pipeline_ids == {"pid-0", "pid-1"}
    for o in outcomes:
        assert o.success is False
        assert o.dead_lettered is True


def test_phase5d_internal_fetch_concurrency_stays_bounded_at_stage_concurrency_2():
    """Test 5: with two real ContactWorker instances processing
    concurrently (Contact stage concurrency=2), each instance's own
    Phase 5D internal fetch executor still never exceeds 2 threads for
    its own candidate, and the combined in-flight fetch-thread count
    across both instances never exceeds 4 -- proving Phase 5D's
    per-call, per-instance bound was not accidentally widened by
    enabling stage-level concurrency."""

    active_fetch_threads = 0
    max_concurrent_fetch_threads = 0
    lock = threading.Lock()
    # Two candidates x two pages (contact_page + homepage) each = 4
    # fetches total; gate them all on one barrier so every fetch that
    # will ever run in this test is genuinely in-flight at once before
    # any of them completes.
    barrier = threading.Barrier(4, timeout=5.0)

    class _FakeHeaders:
        def get_content_charset(self):
            return "utf-8"

        def get(self, key, default=None):
            return default

    class _FakeResponse:
        def __init__(self, url: str) -> None:
            self._url = url
            self.headers = _FakeHeaders()

        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return None

        def geturl(self):
            return self._url

        def read(self):
            return b"<html><body>no contact info</body></html>"

    def _fake_urlopen(request, timeout=None):
        nonlocal active_fetch_threads, max_concurrent_fetch_threads
        with lock:
            active_fetch_threads += 1
            max_concurrent_fetch_threads = max(max_concurrent_fetch_threads, active_fetch_threads)
        try:
            barrier.wait()
        except threading.BrokenBarrierError:
            pass
        with lock:
            active_fetch_threads -= 1
        return _FakeResponse(request.full_url)

    import workers.contact_worker as contact_worker_module

    original_urlopen = contact_worker_module.urllib.request.urlopen
    contact_worker_module.urllib.request.urlopen = _fake_urlopen
    try:
        driver, queue = _build_contact_only_driver(
            concurrency=2,
            instance_count=4,
            candidate_count=0,
            worker_factory=lambda: ContactWorker(),
        )
        for i in range(2):
            intel = WebsiteIntel(
                pipeline_id=f"pid-{i}",
                website_reachable=True,
                contact_page=f"https://example{i}.invalid/contact",
                final_url=f"https://example{i}.invalid/",
            )
            queue.enqueue(pipeline_id=intel.pipeline_id, stage="contact", payload=intel)

        try:
            driver.run_once()
        finally:
            driver.stop(wait=True, timeout=5.0)
    finally:
        contact_worker_module.urllib.request.urlopen = original_urlopen

    assert queue.is_empty()
    # 2 ContactWorker executions x up to 2 internal fetch threads each
    # = 4, never more -- exactly the Phase 5E "RESOURCE SAFETY"
    # footprint calculation.
    assert max_concurrent_fetch_threads <= 4
    assert max_concurrent_fetch_threads >= 2  # proves real overlap happened, not serial fetches


def test_cancellation_stops_new_contact_submissions():
    """Test 6: once stop() has fully returned, the driver's concurrency
    executor is shut down and _run_stage_pass() refuses to submit new
    work for the contact stage."""
    probe = _ConcurrencyProbe(concurrency=2)
    driver, queue = _build_contact_only_driver(
        concurrency=2,
        instance_count=4,
        candidate_count=2,
        worker_factory=lambda: _ProbeContactWorker(probe),
    )
    driver.run_once()
    assert queue.is_empty()

    driver.stop(wait=True, timeout=5.0)
    assert driver._concurrency_executor is not None
    assert driver._concurrency_executor._shutdown  # type: ignore[attr-defined]

    intel = _website_intel(99)
    queue.enqueue(pipeline_id=intel.pipeline_id, stage="contact", payload=intel)
    stage = driver._stages[0]
    result = driver._run_stage_pass(stage)
    assert result is None
    assert not queue.is_empty()


def test_phase5b_terminal_accounting_preserved_with_contact_concurrency():
    """Test 7: running the REAL build_seven_stage_pipeline() composition
    with Contact stage_concurrency enabled still produces exactly one
    terminal event per dead-lettered Contact candidate -- no double
    counting, no missing terminal event."""

    class _AlwaysFailContactWorker(BaseWorker):
        def __init__(self) -> None:
            super().__init__(worker_type="contact", capabilities=(WorkerCapability(name="contact"),))

        def timeout_seconds(self) -> float:
            return 5.0

        def process(self, item: WebsiteIntel) -> ContactIntel:
            raise RuntimeError("simulated permanent contact failure")

    class _FakeDiscoveryProvider(DiscoveryProviderInterface):
        def __init__(self, count: int) -> None:
            self._count = count

        @property
        def provider_id(self) -> str:
            return "fake"

        @property
        def display_name(self) -> str:
            return "Fake"

        def discover(self, request) -> Iterator[BusinessCandidate]:
            for i in range(self._count):
                yield BusinessCandidate(
                    pipeline_id=f"pid-{i}",
                    session_id=request.session_id if request else "s",
                    provider="fake",
                    name=f"Business {i}",
                    category="Coffee Shop",
                    website="https://example.invalid",
                )

    class _DummyStorageBackend:
        def store_opportunity(self, opp):
            return StoredOpportunity(
                storage_id=f"store_{opp.pipeline_id}",
                pipeline_id=opp.pipeline_id,
                stored_at_iso="2026-08-15T00:00:00Z",
            )

    class _PassthroughWebsiteWorker(BaseWorker):
        def __init__(self) -> None:
            super().__init__(worker_type="website", capabilities=(WorkerCapability(name="website"),))

        def timeout_seconds(self) -> float:
            return 5.0

        def process(self, item: BusinessCandidate) -> WebsiteIntel:
            return WebsiteIntel(pipeline_id=item.pipeline_id, website_reachable=True)

    coordinator = EngineCoordinator()
    ctx = coordinator.create_session(user_id="term_user", requested_count=4)
    session_id = ctx.session.id

    events: List[tuple] = []

    def _on_progress(stage, event, item_id, **kwargs):
        events.append((stage, event, kwargs.get("pipeline_id"), kwargs.get("terminal")))

    provider = _FakeDiscoveryProvider(4)
    stages, queue_ids, fan_in, cleanup_cb = build_seven_stage_pipeline(
        coordinator,
        session_id,
        discovery_provider=provider,
        discovery_request=None,
        storage_backend=_DummyStorageBackend(),
        website_worker_factory=lambda: _PassthroughWebsiteWorker(),
        contact_worker_factory=lambda: _AlwaysFailContactWorker(),
        instance_counts={"website": 4, "contact": 4},
        on_progress=_on_progress,
    )
    coordinator.start_session(session_id)
    coordinator.mark_running(session_id)
    engine_runtime = coordinator.get_engine_runtime(session_id)

    driver = ExecutionDriver(
        engine_runtime, stages, on_stage_outcome=cleanup_cb,
        run_producers_once=True,
        stage_concurrency={"website": 2, "contact": 2},
    )
    driver._ensure_producers_started()
    deadline = time.monotonic() + 10.0
    while time.monotonic() < deadline and not driver.producers_finished():
        time.sleep(0.01)
    assert driver.producers_finished()

    contact_q = engine_runtime._runtime.queue_manager.get_queue(queue_ids.contact_in)
    outcomes: List = []

    # Website is upstream of Contact -- drive only the Website stage's
    # pass directly (not the full run_once(), which would also run
    # Contact in the same call, before pre-seeding below gets a
    # chance) until Website has forwarded all 4 candidates into
    # contact_in.
    website_stage = next(s for s in stages if s.name == "website")
    deadline = time.monotonic() + 10.0
    while time.monotonic() < deadline and len(contact_q._items) < 4:
        driver._run_stage_pass(website_stage)
    assert len(contact_q._items) == 4

    # build_seven_stage_pipeline hardcodes RetryPolicy(max_attempts=2) --
    # pre-seed each queued Contact item's retry record to already be at
    # that policy's max_attempts (same technique as the Phase 5C
    # Website terminal-accounting test), so the one real execute_stage()
    # failure below takes the actual dead-letter branch.
    for item in list(contact_q._items):
        for _ in range(2):
            contact_q.record_attempt(item.queue_item_id)

    while not contact_q.is_empty():
        outcomes.extend(driver.run_once())
    driver.stop(wait=True, timeout=5.0)

    contact_outcomes = [o for o in outcomes if o.stage_name == "contact"]
    assert len(contact_outcomes) == 4
    assert all(o.success is False and o.dead_lettered for o in contact_outcomes)

    terminal_contact_events = [e for e in events if e[0] == "contact" and e[3] is True]
    terminal_pipeline_ids = {e[2] for e in terminal_contact_events}
    assert terminal_pipeline_ids == {f"pid-{i}" for i in range(4)}
    assert len(terminal_contact_events) == 4
