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
    Same `is_duplicate(fingerprint_keys, *, user_id=None) -> bool` contract
    (Phase 1A added the keyword-only `user_id`), backed by in-memory state
    instead of a real Supabase lookup. Records every call (keys + user_id)
    so tests can assert whether (and how, and for whom) a lookup was even
    attempted — e.g. Test C asserts it's never called for a candidate with
    no usable early identity.

    Phase 1A ownership model: `owned_by` maps a fingerprint key to the set
    of user_ids that own a business matching that key (mirrors the real
    `leads(user_id, business_id)` semantics). `global_duplicate_keys` is
    the pre-Phase-1A "exists globally, no matter who owns it" set, used
    only when `user_id` is None — exactly like
    `PersistentEarlyDedupChecker._is_duplicate_global`.
    """

    def __init__(
        self,
        duplicate_keys: Iterable[str] = (),
        *,
        owned_by: Optional[dict] = None,
    ) -> None:
        self.global_duplicate_keys = set(duplicate_keys)
        self.owned_by: dict = {k: set(v) for k, v in (owned_by or {}).items()}
        self.calls: List[tuple] = []
        self._lock = threading.Lock()

    def is_duplicate(self, fingerprint_keys, *, user_id: Optional[str] = None) -> bool:
        keys = set(fingerprint_keys)
        with self._lock:
            self.calls.append((keys, user_id))
        if user_id:
            owning_users: set = set()
            for k in keys:
                owning_users |= self.owned_by.get(k, set())
            return user_id in owning_users
        return bool(keys & self.global_duplicate_keys)


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
    requesting_user_id: Optional[str] = None,
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
        requesting_user_id=requesting_user_id,
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


# ---------------------------------------------------------------------------
# PHASE 1A — user-scoped early dedup ownership
#
# Product invariant (see Phase 1A task): `businesses` is a GLOBAL
# identity/enrichment pool; `leads(user_id, business_id)` is the PER-USER
# ownership table. A business existing globally must never, by itself,
# early-reject it for a user who doesn't yet own it.
# ---------------------------------------------------------------------------


def test_g_same_user_same_business_is_duplicate():
    """Requirement 1: same user + same business -> duplicate."""
    keys = early_fingerprint_keys(maps_url=MAPS_URL_WITH_PLACE, website=None, phone=None)
    checker = FakeEarlyDedupChecker(owned_by={k: {"user-a"} for k in keys})
    cand = _candidate("pid-g", "s7", maps_url=MAPS_URL_WITH_PLACE)

    result = _run([cand], checker=checker, requesting_user_id="user-a")

    assert result["website_calls"] == [], "owning user's repeat discovery must be rejected before enrichment"
    assert result["backend"].stored == []
    assert len(checker.calls) == 1 and checker.calls[0][1] == "user-a"


def test_h_different_user_same_business_is_not_duplicate():
    """Requirement 2: different user + same business -> NOT duplicate.

    This is the exact regression Phase 1A fixes: User A already owns the
    business (so `businesses` has a matching row AND a `leads` row for
    user-a), but User B discovering the same business must NOT be
    early-rejected.
    """
    keys = early_fingerprint_keys(maps_url=MAPS_URL_WITH_PLACE, website=None, phone=None)
    checker = FakeEarlyDedupChecker(owned_by={k: {"user-a"} for k in keys})
    cand = _candidate("pid-h", "s8", maps_url=MAPS_URL_WITH_PLACE)

    result = _run([cand], checker=checker, requesting_user_id="user-b")

    assert result["website_calls"] == ["pid-h"], "a non-owning user must still reach enrichment"
    assert len(result["backend"].stored) == 1
    assert len(checker.calls) == 1 and checker.calls[0][1] == "user-b"


def test_i_global_exists_but_requesting_user_does_not_own_it_is_not_duplicate():
    """Requirement 3: business exists globally but requesting user does not
    own it -> NOT duplicate. Same scenario as Test H, phrased from the
    "global existence must not leak into user-scoped rejection" angle:
    the SAME key set is a known GLOBAL duplicate (would reject under the
    pre-Phase-1A / no-user_id path — see Test A) but must NOT reject once
    a real, non-owning user_id is supplied.
    """
    keys = early_fingerprint_keys(maps_url=MAPS_URL_WITH_PLACE, website=None, phone=None)
    checker = FakeEarlyDedupChecker(duplicate_keys=keys, owned_by={})  # globally known, owned by no one
    cand = _candidate("pid-i", "s9", maps_url=MAPS_URL_WITH_PLACE)

    result = _run([cand], checker=checker, requesting_user_id="user-c")

    assert result["website_calls"] == ["pid-i"], "global existence alone must never early-reject a specific user"
    assert len(result["backend"].stored) == 1


def test_j_no_user_id_preserves_existing_global_fingerprint_behavior():
    """Requirement 4: no user_id / pool-building path -> preserve existing
    global fingerprint behavior, unchanged. Exercises `requesting_user_id`
    left at its default (None) — exactly how poolExpandJob.ts's callers
    reach this pipeline (see execution_driver.py / service.py comments) —
    against a checker configured with the SAME globally-known key set as
    Test I, but this time expecting the pre-Phase-1A global reject.
    """
    keys = early_fingerprint_keys(maps_url=MAPS_URL_WITH_PLACE, website=None, phone=None)
    checker = FakeEarlyDedupChecker(duplicate_keys=keys)
    cand = _candidate("pid-j", "s10", maps_url=MAPS_URL_WITH_PLACE)

    result = _run([cand], checker=checker)  # requesting_user_id defaults to None

    assert result["website_calls"] == [], "pool-building path must keep rejecting on global existence"
    assert result["backend"].stored == []
    assert len(checker.calls) == 1 and checker.calls[0][1] is None


def test_k_early_lookup_failure_preserves_fail_open_semantics():
    """Requirement 5: early lookup failure -> preserve fail-open semantics,
    in BOTH the global (`_is_duplicate_global`) and user-scoped
    (`_is_duplicate_for_user`) code paths. Exercises the REAL
    `PersistentEarlyDedupChecker` (not the fake), with `urllib.request.
    urlopen` monkeypatched to raise -- the exact exception classes
    `is_duplicate()` catches -- so both branches are proven to return
    False (never raise) rather than a re-implementation.
    """
    import urllib.error

    from storage.early_persistent_dedup import PersistentEarlyDedupChecker

    checker = PersistentEarlyDedupChecker(
        supabase_url="https://example.invalid", supabase_key="test-key"
    )

    def _boom(*args, **kwargs):
        raise urllib.error.URLError("simulated network failure")

    import storage.early_persistent_dedup as mod

    original_urlopen = mod.urllib.request.urlopen
    mod.urllib.request.urlopen = _boom
    try:
        keys = {"place:doesnotmatter"}
        assert checker.is_duplicate(keys) is False, "global path must fail open"
        assert checker.is_duplicate(keys, user_id="user-x") is False, "user-scoped path must fail open"
    finally:
        mod.urllib.request.urlopen = original_urlopen
