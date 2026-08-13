"""
Phase 3C-4B — tests for early persistent dedup before enrichment.

Exercises the REAL production composition
(`engine.execution_driver.build_seven_stage_pipeline` +
`ExecutionDriver`), the same components `service.run_query()`'s
production branch drives — not a reimplementation, following the same
approach test_pipeline_continuous_flow.py and validate_execution_driver.py
already use for this pipeline.

Two things are substituted, and only two:
  * a `FakeEarlyDedupChecker` in place of `PersistentEarlyDedupChecker` —
    an in-memory set instead of a real Supabase/PostgREST call, so these
    tests never touch the network. `is_duplicate()`'s call signature and
    fail-open contract are identical to the real checker's.
  * counting Website/Instagram/Contact worker subclasses that skip real
    network I/O entirely (this sandbox has no network access) but exactly
    mirror the real workers' own "no target field -> reachable=False,
    still succeeds" short-circuit — see WebsiteWorker.process()/
    InstagramWorker.process() for the equivalent real behavior when
    `item.website` / `item.instagram_url` is falsy.

Everything else — QualificationWorker, MergeWorker, FanInRuntime,
ExecutionDriver, the real `_on_candidate`/`_early_dedup_decision` closures
in execution_driver.py — runs unmodified and for real.

Run: pytest tests/test_early_persistent_dedup.py -v
"""

from __future__ import annotations

import os
import sys
import threading
from typing import Iterable, Iterator, List, Optional

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

from engine.contracts import (
    BusinessCandidate,
    ContactIntel,
    InstagramIntel,
    QualifiedOpportunity,
    StoredOpportunity,
    WebsiteIntel,
)
from engine.coordinator import EngineCoordinator
from engine.execution_driver import ExecutionDriver, build_seven_stage_pipeline
from engine.interfaces import DiscoveryProviderInterface
from workers.contact_worker import ContactWorker
from workers.instagram_worker import InstagramWorker
from workers.website_worker import WebsiteWorker

from storage.early_persistent_dedup import early_fingerprint_keys, maps_place_id_from_keys


# ---------------------------------------------------------------------------
# Test doubles
# ---------------------------------------------------------------------------


class ListDiscoveryProvider(DiscoveryProviderInterface):
    """Yields a fixed, caller-supplied list of BusinessCandidates once per
    discover() call — same shape as validate_execution_driver.py's own
    ListDiscoveryProvider."""

    def __init__(self, candidates: List[BusinessCandidate]) -> None:
        self._candidates = candidates
        self.discover_call_count = 0

    @property
    def provider_id(self) -> str:
        return "list_provider"

    @property
    def display_name(self) -> str:
        return "List Provider (Phase 3C-4B tests)"

    def discover(self, request) -> Iterator[BusinessCandidate]:
        self.discover_call_count += 1
        for c in self._candidates:
            yield c


class InMemoryStorageBackend:
    def __init__(self) -> None:
        self.stored: List[StoredOpportunity] = []

    def persist(self, opportunity: QualifiedOpportunity) -> StoredOpportunity:
        stored = StoredOpportunity(
            opportunity_id=f"opp-{len(self.stored) + 1}",
            pipeline_id=opportunity.pipeline_id,
        )
        self.stored.append(stored)
        return stored


class FakeEarlyDedupChecker:
    """Test double for storage.early_persistent_dedup.PersistentEarlyDedupChecker.
    Same `is_duplicate(fingerprint_keys) -> bool` contract, backed by an
    in-memory set instead of a real Supabase lookup. Records every call so
    tests can assert whether (and how often) a lookup was even attempted —
    e.g. Test C asserts it's never called for a candidate with no usable
    early identity."""

    def __init__(self, duplicate_keys: Iterable[str] = ()) -> None:
        self.duplicate_keys = set(duplicate_keys)
        self.calls: List[set] = []
        self._lock = threading.Lock()

    def is_duplicate(self, fingerprint_keys) -> bool:
        keys = set(fingerprint_keys)
        with self._lock:
            self.calls.append(keys)
        return bool(keys & self.duplicate_keys)


def _counting(counter: List[str]):
    def _record(pipeline_id: str) -> None:
        counter.append(pipeline_id)
    return _record


class CountingWebsiteWorker(WebsiteWorker):
    """Records every pipeline_id it's asked to process and returns a
    canned, always-network-free WebsiteIntel — mirrors the real
    WebsiteWorker's own `if not item.website: return WebsiteIntel(...,
    website_reachable=False)` short-circuit, except unconditionally (so
    these tests never need real network access), while still reporting
    website_reachable=True so QualificationWorker's Rule 2 doesn't reject
    it -- these tests care about "did enrichment run", not qualification
    outcome specifics."""

    def __init__(self, counter: List[str]) -> None:
        super().__init__()
        self._on_process = _counting(counter)

    def process(self, item: BusinessCandidate) -> WebsiteIntel:
        self._on_process(item.pipeline_id)
        return WebsiteIntel(pipeline_id=item.pipeline_id, website_reachable=True, https=True)


class CountingInstagramWorker(InstagramWorker):
    def __init__(self, counter: List[str]) -> None:
        super().__init__()
        self._on_process = _counting(counter)

    def process(self, item: BusinessCandidate) -> InstagramIntel:
        self._on_process(item.pipeline_id)
        return InstagramIntel(pipeline_id=item.pipeline_id, profile_reachable=False)


class CountingContactWorker(ContactWorker):
    def __init__(self, counter: List[str]) -> None:
        super().__init__()
        self._on_process = _counting(counter)

    def process(self, item: WebsiteIntel) -> ContactIntel:
        self._on_process(item.pipeline_id)
        return ContactIntel(pipeline_id=item.pipeline_id)


def _candidate(
    pipeline_id: str,
    session_id: str,
    *,
    maps_url: Optional[str] = None,
    website: Optional[str] = "https://example.test",
    phone: Optional[str] = "+1-555-0100",
) -> BusinessCandidate:
    return BusinessCandidate(
        pipeline_id=pipeline_id,
        session_id=session_id,
        provider="list_provider",
        maps_url=maps_url,
        name=f"Business {pipeline_id}",
        category="Coffee Shop",
        address="123 Main St",
        city="Testville",
        country="US",
        website=website,
        phone=phone,
    )


def _run(
    candidates: List[BusinessCandidate],
    *,
    checker=None,
    timeout_s: float = 5.0,
    poll_s: float = 0.01,
):
    """Drives the real seven-stage pipeline to completion using
    ExecutionDriver's own background-thread loop (start()/stop()), polling
    for genuine exhaustion the same way service.py's own `_fully_drained()`
    does: producers finished, every input queue empty, and FanInRuntime has
    no pending correlation state left. A tight `run_once()`-until-idle loop
    (no polling delay) is NOT safe here -- Discovery runs on its own
    dedicated thread (see execution_driver.py's producer-thread decoupling)
    so a transformer-stage pass can easily observe "nothing ran" before
    discovery has even enqueued its first candidate."""
    website_calls: List[str] = []
    instagram_calls: List[str] = []
    contact_calls: List[str] = []

    coordinator = EngineCoordinator()
    ctx = coordinator.create_session(
        user_id="test-user", provider="list_provider", requested_count=len(candidates) or 1
    )
    session_id = ctx.session.id
    coordinator.start_session(session_id)

    provider = ListDiscoveryProvider(candidates)
    backend = InMemoryStorageBackend()

    stages, queue_ids, fan_in, cleanup_cb = build_seven_stage_pipeline(
        coordinator,
        session_id,
        discovery_provider=provider,
        discovery_request=object(),
        storage_backend=backend,
        website_worker_factory=lambda: CountingWebsiteWorker(website_calls),
        instagram_worker_factory=lambda: CountingInstagramWorker(instagram_calls),
        contact_worker_factory=lambda: CountingContactWorker(contact_calls),
        early_dedup_checker=checker,
        scrape_job_id="test-scrape-job",
    )
    engine_runtime = coordinator.get_engine_runtime(session_id)
    driver = ExecutionDriver(
        engine_runtime, stages, on_stage_outcome=cleanup_cb, idle_poll_seconds=0.0
    )

    queue_manager = ctx.runtime.queue_manager
    all_input_queue_ids = [
        queue_ids.website_in, queue_ids.instagram_in, queue_ids.contact_in,
        queue_ids.merge_in, queue_ids.qualification_in, queue_ids.storage_in,
    ]

    def _fully_drained() -> bool:
        return (
            driver.producers_finished()
            and all(queue_manager.get_queue(qid).is_empty() for qid in all_input_queue_ids)
            and fan_in.pending_count() == 0
        )

    driver.start()
    try:
        import time as _time
        deadline = _time.perf_counter() + timeout_s
        while _time.perf_counter() < deadline:
            if _fully_drained():
                break
            _time.sleep(poll_s)
        else:
            raise AssertionError(f"pipeline did not fully drain within {timeout_s}s")
    finally:
        driver.stop()

    return {
        "backend": backend,
        "website_calls": website_calls,
        "instagram_calls": instagram_calls,
        "contact_calls": contact_calls,
        "fan_in": fan_in,
        "session_id": session_id,
    }


PLACE_ID = "ChIJN1t_tDeuEmsRUsoyG83frY4"
MAPS_URL_WITH_PLACE = f"https://maps.google.com/?q=Test&cid=1&{PLACE_ID}"


# ---------------------------------------------------------------------------
# Test A — existing Maps place duplicate: rejected BEFORE enrichment
# ---------------------------------------------------------------------------


def test_a_known_place_id_rejected_before_enrichment():
    keys = early_fingerprint_keys(maps_url=MAPS_URL_WITH_PLACE, website=None, phone=None)
    assert any(k.startswith("place:") for k in keys), "test fixture must produce a place: key"

    checker = FakeEarlyDedupChecker(duplicate_keys=keys)
    cand = _candidate("pid-dup", "s1", maps_url=MAPS_URL_WITH_PLACE)

    result = _run([cand], checker=checker)

    assert result["website_calls"] == [], "enrichment workers must NOT be invoked for an early duplicate"
    assert result["instagram_calls"] == []
    assert result["contact_calls"] == []
    assert result["backend"].stored == [], "an early duplicate must not count toward the accepted target"
    assert result["fan_in"].pending_count() == 0, "an early duplicate must never be registered with FanInRuntime"
    assert len(checker.calls) == 1


# ---------------------------------------------------------------------------
# Test B — new Maps place: passes early dedup, enters enrichment normally
# ---------------------------------------------------------------------------


def test_b_new_place_enters_enrichment_normally():
    checker = FakeEarlyDedupChecker(duplicate_keys=set())  # nothing on file
    cand = _candidate("pid-new", "s2", maps_url=MAPS_URL_WITH_PLACE)

    result = _run([cand], checker=checker)

    assert result["website_calls"] == ["pid-new"]
    assert result["instagram_calls"] == ["pid-new"]
    assert len(result["backend"].stored) == 1
    assert result["backend"].stored[0].pipeline_id == "pid-new"
    assert len(checker.calls) == 1


# ---------------------------------------------------------------------------
# Test C — no usable early identity: still reaches normal enrichment
# ---------------------------------------------------------------------------


def test_c_no_early_identity_still_reaches_enrichment():
    checker = FakeEarlyDedupChecker(duplicate_keys={"place:something-else"})
    # No maps_url, no website (so no web: key), no phone (so no tel: key) --
    # early_fingerprint_keys() has nothing to work with.
    cand = _candidate("pid-no-identity", "s3", maps_url=None, website=None, phone=None)
    assert early_fingerprint_keys(maps_url=None, website=None, phone=None) == set()

    result = _run([cand], checker=checker)

    assert checker.calls == [], "is_duplicate() must never be called with an empty key set"
    assert result["website_calls"] == ["pid-no-identity"], "must still reach enrichment"
    # Rule 1 (QualificationWorker) rejects a candidate with no website at
    # all -- that's an existing, unrelated qualification rule, not this
    # phase's concern. What this test asserts is that the candidate was
    # never short-circuited by early dedup: it visibly reached enrichment.


# ---------------------------------------------------------------------------
# Test D — a candidate that clears early dedup is still fully delivered for
# the (unmodified) final dedup to see
# ---------------------------------------------------------------------------


def test_d_pipeline_still_hands_off_every_non_early_duplicate_for_final_dedup():
    """
    The final persistent dedup (deliverLead.ts::findExistingBusiness) lives
    entirely on the Node side, after this Python pipeline hands off a
    completed lead -- see Phase 3C-4B report. This module makes zero
    changes to that function. What this test proves on the Python side is
    the precondition final dedup depends on: a candidate that early dedup
    does NOT catch (whether because it's genuinely new, or because it has
    no usable early identity, or because the early checker simply didn't
    have a match yet) is never silently dropped -- it is always fully
    enriched and handed to Storage exactly as before this phase, so
    Node's own findExistingBusiness still gets a real chance to run
    against it downstream.
    """
    checker = FakeEarlyDedupChecker(duplicate_keys=set())
    cand = _candidate("pid-eventually-final-dup", "s4", maps_url=MAPS_URL_WITH_PLACE)

    result = _run([cand], checker=checker)

    assert len(result["backend"].stored) == 1
    assert result["backend"].stored[0].pipeline_id == "pid-eventually-final-dup"


# ---------------------------------------------------------------------------
# Test E — concurrent race: early dedup may race; that's fine, because it
# never claims to be authoritative
# ---------------------------------------------------------------------------


def test_e_concurrent_same_place_both_clear_early_dedup():
    """
    Two workers "discover" the same new Maps place at effectively the same
    moment. `PersistentEarlyDedupChecker` only ever READS the businesses
    table -- it never registers a key the moment a candidate clears it --
    so both candidates legitimately see "not a duplicate yet" and both
    proceed to enrichment/Storage in this harness. That is the expected,
    documented behavior (Step 4 / "no early match != definitely new"):
    early dedup is a fast-reject optimization, not a concurrency guarantee.
    The guarantee that no duplicate BUSINESS record is ultimately created
    is unchanged and still lives entirely in the untouched Node-side
    findExistingBusiness + the unique-key behavior of the businesses table
    it writes to.
    """
    checker = FakeEarlyDedupChecker(duplicate_keys=set())
    same_place_a = _candidate("pid-race-a", "s5", maps_url=MAPS_URL_WITH_PLACE)
    same_place_b = _candidate("pid-race-b", "s5", maps_url=MAPS_URL_WITH_PLACE)

    result = _run([same_place_a, same_place_b], checker=checker)

    stored_ids = {s.pipeline_id for s in result["backend"].stored}
    assert stored_ids == {"pid-race-a", "pid-race-b"}
    assert len(checker.calls) == 2


# ---------------------------------------------------------------------------
# Test F — early duplicates do not cause overshoot / incorrect accounting
# ---------------------------------------------------------------------------


def test_f_early_duplicates_never_reach_storage_so_never_overshoot():
    """
    `run_query()`'s LeadAcceptanceGate only ever advances on a real
    StorageWorker persist (`_on_persisted`, service.py) -- gate accounting
    itself is untouched by this phase. What this phase must guarantee, at
    the level this test can actually exercise, is the precondition: an
    early duplicate must NEVER reach Storage, for any mix of duplicate and
    new candidates in the same run -- so it can never contribute to
    gate.accepted, and therefore can never cause overshoot.
    """
    known_keys = early_fingerprint_keys(maps_url=MAPS_URL_WITH_PLACE, website=None, phone=None)
    checker = FakeEarlyDedupChecker(duplicate_keys=known_keys)

    candidates = [
        _candidate("pid-f-dup-1", "s6", maps_url=MAPS_URL_WITH_PLACE),
        _candidate("pid-f-new-1", "s6", maps_url="https://maps.google.com/?q=Other&cid=999"),
        _candidate("pid-f-dup-2", "s6", maps_url=MAPS_URL_WITH_PLACE),
        _candidate("pid-f-new-2", "s6", maps_url="https://maps.google.com/?q=Third&cid=888"),
    ]

    result = _run(candidates, checker=checker)

    stored_ids = {s.pipeline_id for s in result["backend"].stored}
    assert stored_ids == {"pid-f-new-1", "pid-f-new-2"}
    assert "pid-f-dup-1" not in result["website_calls"]
    assert "pid-f-dup-2" not in result["website_calls"]
