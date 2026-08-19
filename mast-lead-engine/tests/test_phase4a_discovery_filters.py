"""
Phase 4A — Safe Zero-Cost Discovery Filters
=============================================

Regression coverage for the three deterministic, zero-extra-fetch
prunes added to `engine.execution_driver._on_candidate` (the
discovery-time gate — see `engine/prune_reason_taxonomy.py`'s own
docstring, "THIRD prune point", for why this is the earliest safe
place to act on a BusinessCandidate):

    A. closed business            (BusinessCandidate.closed)
    B. chain / cannabis keyword    (workers.scoring_worker._is_chain /
                                     _is_cannabis, reused verbatim)
    C. dead candidate.email logic  (has_maps_valid_email removal)

Each test drives the real `_on_candidate` closure through the public
`build_seven_stage_pipeline()` composition root (the same pattern
`tests/test_issue1_prune_stops_downstream.py` uses), not a reimplemented
copy of the pruning logic, so these are genuine behavioral proofs.
"""

from __future__ import annotations

import pytest

from engine.contracts import BusinessCandidate
from engine.coordinator import EngineCoordinator
from engine.execution_driver import build_seven_stage_pipeline
from engine.interfaces import DiscoveryProviderInterface


class DummyDiscoveryProvider(DiscoveryProviderInterface):
    @property
    def provider_id(self) -> str:
        return "dummy"

    @property
    def display_name(self) -> str:
        return "Dummy"

    def discover(self, request):
        return iter([])


class DummyStorageBackend:
    def __init__(self):
        self.persisted = []

    def persist(self, opportunity):
        self.persisted.append(opportunity)
        return opportunity


def _make_candidate(
    pipeline_id: str,
    *,
    name: str = "Joe's Bakery",
    category: str = "Bakery",
    website: str = "https://example.com",
    phone: str = "+14165550199",
    closed: bool = False,
) -> BusinessCandidate:
    return BusinessCandidate(
        pipeline_id=pipeline_id,
        session_id="session-test",
        provider="google_maps",
        name=name,
        category=category,
        address="123 Street",
        city="Mexico City",
        country="MX",
        website=website,
        phone=phone,
        closed=closed,
    )


def _setup_pipeline(required_channels=None):
    """Mirrors tests/test_issue1_prune_stops_downstream.py::_setup_pipeline,
    additionally returning the discovery `on_candidate` closure and the
    website/instagram queues so a test can drive a candidate through
    `_on_candidate` directly and assert on what did/didn't get queued or
    registered."""
    coordinator = EngineCoordinator()
    ctx = coordinator.create_session(
        user_id="test-user",
        provider="dummy",
        requested_count=10,
    )
    session_id = ctx.session.id
    coordinator.start_session(session_id)
    provider = DummyDiscoveryProvider()
    backend = DummyStorageBackend()

    stages, queue_ids, fan_in, on_stage_outcome = build_seven_stage_pipeline(
        coordinator,
        session_id,
        discovery_provider=provider,
        discovery_request=type("Req", (), {"session_id": session_id})(),
        storage_backend=backend,
        required_channels=required_channels,
    )
    stage_map = {s.name: s for s in stages}
    on_candidate = stage_map["discovery"].produce_worker_input().on_candidate

    session_ctx = coordinator.get_session(session_id)
    queue_manager = session_ctx.runtime.queue_manager
    website_queue = queue_manager.get_queue(queue_ids.website_in)
    instagram_queue = queue_manager.get_queue(queue_ids.instagram_in)

    return on_candidate, fan_in, website_queue, instagram_queue


# ---------------------------------------------------------------------------
# A. Closed business
# ---------------------------------------------------------------------------


def test_closed_candidate_is_pruned_before_enrichment():
    on_candidate, fan_in, website_queue, instagram_queue = _setup_pipeline()
    candidate = _make_candidate("p-closed", closed=True)

    on_candidate(candidate)

    # Never registered with FanInRuntime, never enqueued for
    # Website/Instagram enrichment.
    assert fan_in.get_business("p-closed") is None
    assert website_queue.size() == 0
    assert instagram_queue.size() == 0


def test_closed_false_candidate_follows_current_path():
    on_candidate, fan_in, website_queue, instagram_queue = _setup_pipeline()
    candidate = _make_candidate("p-open", closed=False)

    on_candidate(candidate)

    assert fan_in.get_business("p-open") is not None
    assert website_queue.size() == 1
    assert instagram_queue.size() == 1


def test_closed_unknown_default_follows_current_path():
    """A BusinessCandidate built without specifying `closed` at all
    defaults to False (see the field's docstring) — same current path
    as an explicit closed=False."""
    on_candidate, fan_in, website_queue, instagram_queue = _setup_pipeline()
    candidate = BusinessCandidate(
        pipeline_id="p-unknown",
        session_id="session-test",
        provider="google_maps",
        name="Unknown Closed-Status Cafe",
        category="Cafe",
        website="https://example.com",
        phone="+14165550199",
    )
    assert candidate.closed is False  # sanity check on the default itself

    on_candidate(candidate)

    assert fan_in.get_business("p-unknown") is not None
    assert website_queue.size() == 1
    assert instagram_queue.size() == 1


def test_no_valid_open_business_is_affected_by_closed_check():
    """A batch of open businesses, run through the same on_candidate,
    all proceed identically regardless of the new closed check."""
    on_candidate, fan_in, website_queue, instagram_queue = _setup_pipeline()
    for i in range(5):
        on_candidate(_make_candidate(f"p-open-{i}", closed=False))

    for i in range(5):
        assert fan_in.get_business(f"p-open-{i}") is not None
    assert website_queue.size() == 5
    assert instagram_queue.size() == 5


# ---------------------------------------------------------------------------
# B. Existing chain / cannabis filter, reused at discovery time
# ---------------------------------------------------------------------------


def test_chain_candidate_is_pruned_before_enrichment():
    on_candidate, fan_in, website_queue, instagram_queue = _setup_pipeline()
    candidate = _make_candidate("p-chain", name="Starbucks Downtown", category="Cafe")

    on_candidate(candidate)

    assert fan_in.get_business("p-chain") is None
    assert website_queue.size() == 0
    assert instagram_queue.size() == 0


def test_cannabis_candidate_is_pruned_before_enrichment():
    on_candidate, fan_in, website_queue, instagram_queue = _setup_pipeline()
    candidate = _make_candidate(
        "p-cannabis", name="Green Leaf Co", category="Cannabis Dispensary"
    )

    on_candidate(candidate)

    assert fan_in.get_business("p-cannabis") is None
    assert website_queue.size() == 0
    assert instagram_queue.size() == 0


def test_non_matching_candidates_remain_unchanged():
    on_candidate, fan_in, website_queue, instagram_queue = _setup_pipeline()
    candidate = _make_candidate("p-normal", name="Joe's Bakery", category="Bakery")

    on_candidate(candidate)

    assert fan_in.get_business("p-normal") is not None
    assert website_queue.size() == 1
    assert instagram_queue.size() == 1


def test_discovery_keyword_prune_agrees_with_scoring_worker_verdict():
    """The final qualification/scoring semantics remain identical: the
    exact same predicate ScoringWorker uses to hard-disqualify a
    chain/cannabis EnrichedBusiness (opportunity_score 0/10) is what
    _on_candidate now reuses, so a candidate discovery prunes is always
    one scoring would have zeroed out anyway — never a candidate
    scoring would otherwise have scored normally."""
    from workers.scoring_worker import _is_cannabis, _is_chain

    chain_candidate = _make_candidate("p-c1", name="McDonald's", category="Fast Food")
    cannabis_candidate = _make_candidate(
        "p-c2", name="Herb House", category="Cannabis Dispensary"
    )
    normal_candidate = _make_candidate("p-c3", name="Joe's Bakery", category="Bakery")

    for candidate, expected in (
        (chain_candidate, True),
        (cannabis_candidate, True),
        (normal_candidate, False),
    ):
        would_be_disqualified = _is_cannabis(
            candidate.name, candidate.category
        ) or _is_chain(candidate.name)
        assert would_be_disqualified is expected


# ---------------------------------------------------------------------------
# C. Dead candidate.email logic
# ---------------------------------------------------------------------------


def test_business_candidate_has_no_email_field():
    """Confirms the premise Phase 4A-C relies on: BusinessCandidate
    never had an `email` field, so `getattr(candidate, "email", None)`
    in the old `has_maps_valid_email` branch was always None."""
    candidate = _make_candidate("p-email-check")
    assert not hasattr(candidate, "email")


def test_email_required_channel_prunes_without_website_regardless_of_maps_email():
    """Email-required candidate with no website is pruned early — this
    is the one behavior the old has_maps_valid_email branch could ever
    have changed (by being True), and since BusinessCandidate has no
    email field it could never be True. Confirms removing the dead
    branch didn't change this outcome."""
    on_candidate, fan_in, website_queue, instagram_queue = _setup_pipeline(
        required_channels=["email"]
    )
    candidate = _make_candidate("p-no-site", website="", phone="")

    on_candidate(candidate)

    assert fan_in.get_business("p-no-site") is None
    assert website_queue.size() == 0
    assert instagram_queue.size() == 0


def test_email_required_channel_preserved_website_fallback_exactly():
    """Email-required candidate WITH a website is NOT pruned at
    discovery time — email discovery is deferred to ContactWorker via
    the website, exactly as before. This is the "existing website-based
    email fallback behavior" the task requires stay exactly intact."""
    on_candidate, fan_in, website_queue, instagram_queue = _setup_pipeline(
        required_channels=["email"]
    )
    candidate = _make_candidate("p-has-site", website="https://bakery.com")

    on_candidate(candidate)

    assert fan_in.get_business("p-has-site") is not None
    assert website_queue.size() == 1
    assert instagram_queue.size() == 1
