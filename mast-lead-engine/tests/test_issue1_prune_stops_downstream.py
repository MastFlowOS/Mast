"""
Targeted tests for Issue 1:
Contact / Website prune fires -> candidate is terminally pruned ->
NO Merge, NO Qualification, NO Storage.
"""

import pytest
from engine.contracts import (
    BusinessCandidate,
    ContactIntel,
    EnrichedBusiness,
    InstagramIntel,
    QualificationResult,
    WebsiteIntel,
)
from workers.merge_worker import MergeInput
from engine.coordinator import EngineCoordinator
from engine.fan_in_runtime import FanInRuntime
from engine.execution_driver import build_seven_stage_pipeline
from engine.interfaces import DiscoveryProviderInterface
from queues.queue import Queue
from queues.queue_definition import QueueDefinition


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


def _make_candidate(pipeline_id: str, website: str = "https://example.com", phone: str = "+1234567890") -> BusinessCandidate:
    return BusinessCandidate(
        pipeline_id=pipeline_id,
        session_id="session-test",
        provider="google_maps",
        name=f"Business {pipeline_id}",
        address="123 Street",
        city="Mexico City",
        country="MX",
        category="Restaurant",
        website=website,
        phone=phone,
    )


def _setup_pipeline(required_channels: list[str]):
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
    return stage_map, queue_ids, fan_in, on_stage_outcome, backend


def test_contact_determines_email_impossible_prunes_and_merge_never_executes():
    """
    1. Website/Contact determines email impossible -> prune -> Merge never executes.
    """
    stage_map, queue_ids, fan_in, on_stage_outcome, backend = _setup_pipeline(["email"])
    candidate = _make_candidate("p1")

    # Seed FanIn
    fan_in.register_business(candidate)

    # Website succeeds and is reachable
    web_intel = WebsiteIntel(pipeline_id="p1", website_reachable=True)
    web_out = stage_map["website"].build_downstream(web_intel)
    assert web_out is not None

    # Instagram succeeds
    ig_intel = InstagramIntel(pipeline_id="p1", profile_reachable=True)
    stage_map["instagram"].build_downstream(ig_intel)

    # Contact finishes with NO emails found
    contact_intel = ContactIntel(pipeline_id="p1", emails=(), phones=("+1234567890",))
    contact_out = stage_map["contact"].build_downstream(contact_intel)

    # Must have pruned and not returned downstream output
    assert contact_out is None
    assert fan_in.is_pruned("p1")
    assert fan_in.pending_count() == 0
    assert fan_in.is_closed("p1")


def test_phone_becomes_impossible_prunes_and_merge_never_executes():
    """
    2. Phone becomes impossible -> prune -> Merge never executes.
    """
    stage_map, queue_ids, fan_in, on_stage_outcome, backend = _setup_pipeline(["phone"])
    # Candidate with no maps phone
    candidate = _make_candidate("p2", phone=None)
    fan_in.register_business(candidate)

    web_intel = WebsiteIntel(pipeline_id="p2", website_reachable=True)
    stage_map["website"].build_downstream(web_intel)

    ig_intel = InstagramIntel(pipeline_id="p2", profile_reachable=True)
    stage_map["instagram"].build_downstream(ig_intel)

    # Contact finishes with no phone found
    contact_intel = ContactIntel(pipeline_id="p2", emails=("info@example.com",), phones=())
    contact_out = stage_map["contact"].build_downstream(contact_intel)

    assert contact_out is None
    assert fan_in.is_pruned("p2")
    assert fan_in.pending_count() == 0


def test_candidate_remains_satisfiable_merge_executes_normally():
    """
    3. Candidate remains satisfiable -> Merge executes normally.
    """
    stage_map, queue_ids, fan_in, on_stage_outcome, backend = _setup_pipeline(["email"])
    candidate = _make_candidate("p3")
    fan_in.register_business(candidate)

    web_intel = WebsiteIntel(pipeline_id="p3", website_reachable=True)
    stage_map["website"].build_downstream(web_intel)

    ig_intel = InstagramIntel(pipeline_id="p3", profile_reachable=True)
    stage_map["instagram"].build_downstream(ig_intel)

    # Contact finds valid email
    contact_intel = ContactIntel(pipeline_id="p3", emails=("owner@example.com",))
    stage_map["contact"].build_downstream(contact_intel)

    assert not fan_in.is_pruned("p3")
    assert fan_in.is_closed("p3")
    assert fan_in.pending_count() == 0


def test_prune_occurs_just_before_fan_in_completion_no_downstream_work():
    """
    4. Prune occurs just before FanIn completion -> no downstream work.
    """
    stage_map, queue_ids, fan_in, on_stage_outcome, backend = _setup_pipeline(["email"])

    candidate = _make_candidate("p4")
    fan_in.register_business(candidate)

    # Explicit prune before branches complete
    fan_in.prune_business("p4", "manual_test_prune")
    assert fan_in.is_pruned("p4")

    # Late branch results arrive
    res1 = fan_in.record_website_result("p4", WebsiteIntel(pipeline_id="p4", website_reachable=True))
    res2 = fan_in.record_instagram_result("p4", InstagramIntel(pipeline_id="p4", profile_reachable=True))
    res3 = fan_in.record_contact_result("p4", ContactIntel(pipeline_id="p4", emails=("a@b.com",)))

    assert res1 is None
    assert res2 is None
    assert res3 is None
    assert fan_in.pending_count() == 0


def test_prune_races_with_merge_downstream_defensive_drop():
    """
    5. Prune races with Merge -> Merge downstream and Qualification drop it.
    """
    stage_map, queue_ids, fan_in, on_stage_outcome, backend = _setup_pipeline(["email"])

    candidate = _make_candidate("p5")
    enriched = EnrichedBusiness(
        pipeline_id="p5",
        business=candidate,
        website_intel=WebsiteIntel(pipeline_id="p5", website_reachable=True),
        contact_intel=ContactIntel(pipeline_id="p5", emails=()),
    )

    # Pruned
    fan_in.prune_business("p5", "test_race")

    # Merge downstream called
    merge_out = stage_map["merge"].build_downstream(enriched)
    assert merge_out is None  # Dropped!

    # Qualification downstream called defensively
    qual_res = QualificationResult(
        pipeline_id="p5",
        qualified=True,
        niche="Restaurant",
    )
    qual_out = stage_map["qualification"].build_downstream(qual_res)
    assert qual_out is None  # Dropped!


def test_replayed_duplicate_prune_is_safe():
    """
    6. Replayed / duplicate prune calls are safe and idempotent.
    """
    q_def = QueueDefinition(queue_id="q1", queue_name="merge_in")
    q = Queue(q_def)
    fan_in = FanInRuntime(merge_queue=q)

    candidate = _make_candidate("p6")
    fan_in.register_business(candidate)
    assert fan_in.pending_count() == 1

    fan_in.prune_business("p6", "reason1")
    assert fan_in.is_pruned("p6")
    assert fan_in.pending_count() == 0

    # Duplicate calls
    fan_in.prune_business("p6", "reason2")
    fan_in.prune_business("p6", "reason3")
    assert fan_in.is_pruned("p6")
    assert fan_in.pending_count() == 0
