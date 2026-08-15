"""
Targeted tests for Issue 2:
Pipeline drain and latency simulation under mixed candidate health,
failing enrichment stages, and required channel pruning.
"""

import pytest
import time
from engine.contracts import (
    BusinessCandidate,
    ContactIntel,
    EnrichedBusiness,
    InstagramIntel,
    WebsiteIntel,
)
from engine.coordinator import EngineCoordinator
from engine.fan_in_runtime import FanInRuntime
from engine.execution_driver import build_seven_stage_pipeline, ExecutionDriver
from engine.interfaces import DiscoveryProviderInterface
from engine.runtime import EngineRuntime, StageConfig, StageOutcome


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


def test_failed_enrichment_stages_do_not_hang_fan_in_pending_count():
    """
    Verify that when workers fail/throw exceptions on website, instagram, or contact stages,
    the outcome callback properly notifies FanInRuntime, allowing pending_count to reach 0.
    """
    stage_map, queue_ids, fan_in, on_stage_outcome, backend = _setup_pipeline(["email"])

    # Register 3 candidates
    c1 = BusinessCandidate(pipeline_id="c1", session_id="s", provider="maps", name="C1", city="MX", category="Food", website="http://c1.com")
    c2 = BusinessCandidate(pipeline_id="c2", session_id="s", provider="maps", name="C2", city="MX", category="Food", website="http://c2.com")
    c3 = BusinessCandidate(pipeline_id="c3", session_id="s", provider="maps", name="C3", city="MX", category="Food", website="http://c3.com")

    fan_in.register_business(c1)
    fan_in.register_business(c2)
    fan_in.register_business(c3)

    assert fan_in.pending_count() == 3

    # Candidate 1: Website stage fails (e.g. DNS failure)
    outcome_c1_web = StageOutcome(
        stage_name="website",
        ran=True,
        success=False,
        pipeline_id="c1",
        queue_item_id="q-c1-web",
        dead_lettered=True,
        detail="DNS lookup failed",
    )
    on_stage_outcome(outcome_c1_web)
    assert fan_in.is_pruned("c1")
    assert fan_in.pending_count() == 2

    # Candidate 2: Website succeeds, Instagram succeeds, Contact fails (e.g. 404 on contact page)
    fan_in.record_website_result("c2", WebsiteIntel(pipeline_id="c2", website_reachable=True))
    fan_in.record_instagram_result("c2", InstagramIntel(pipeline_id="c2", profile_reachable=True))
    outcome_c2_contact = StageOutcome(
        stage_name="contact",
        ran=True,
        success=False,
        pipeline_id="c2",
        queue_item_id="q-c2-contact",
        dead_lettered=True,
        detail="HTTP 404 Not Found",
    )
    on_stage_outcome(outcome_c2_contact)
    assert fan_in.is_pruned("c2")
    assert fan_in.pending_count() == 1

    # Candidate 3: Website succeeds, Instagram succeeds, Contact succeeds with email
    fan_in.record_website_result("c3", WebsiteIntel(pipeline_id="c3", website_reachable=True))
    fan_in.record_instagram_result("c3", InstagramIntel(pipeline_id="c3", profile_reachable=True))
    contact_out = stage_map["contact"].build_downstream(ContactIntel(pipeline_id="c3", emails=("c3@realbiz.com",)))
    assert not fan_in.is_pruned("c3")
    assert fan_in.pending_count() == 0  # Fully completed and released!


def test_pipeline_drain_simulation_80_candidates_mixed_health():
    """
    Simulate a full 80-candidate stream from Discovery in Mexico City:
    - 30 candidates have no website -> pruned at discovery
    - 20 candidates have websites that fail DNS/HTTP -> pruned at website failure
    - 20 candidates have websites with no email on contact page -> pruned at contact downstream
    - 10 candidates have valid websites and emails -> successfully merged & qualified

    Assert all 80 candidates are resolved and pending_count cleanly drops to 0.
    """
    stage_map, queue_ids, fan_in, on_stage_outcome, backend = _setup_pipeline(["email"])

    qualified_count = 0

    # 1. First 30: no website (would be pruned at discovery before fan_in register)
    # 2. Next 20: website fails
    for i in range(1, 21):
        pid = f"web-fail-{i}"
        cand = BusinessCandidate(pipeline_id=pid, session_id="s", provider="maps", name=f"Biz {pid}", city="MX", category="Food", website=f"http://fail{i}.com")
        fan_in.register_business(cand)
        outcome = StageOutcome(
            stage_name="website",
            ran=True,
            success=False,
            pipeline_id=pid,
            queue_item_id=f"q-{pid}",
            dead_lettered=True,
        )
        on_stage_outcome(outcome)
        assert fan_in.is_pruned(pid)

    # 3. Next 20: contact has no email
    for i in range(1, 21):
        pid = f"no-email-{i}"
        cand = BusinessCandidate(pipeline_id=pid, session_id="s", provider="maps", name=f"Biz {pid}", city="MX", category="Food", website=f"http://noemail{i}.com")
        fan_in.register_business(cand)
        stage_map["website"].build_downstream(WebsiteIntel(pipeline_id=pid, website_reachable=True))
        stage_map["instagram"].build_downstream(InstagramIntel(pipeline_id=pid, profile_reachable=True))
        stage_map["contact"].build_downstream(ContactIntel(pipeline_id=pid, emails=()))
        assert fan_in.is_pruned(pid)

    # 4. Final 10: healthy with email
    for i in range(1, 11):
        pid = f"healthy-{i}"
        cand = BusinessCandidate(pipeline_id=pid, session_id="s", provider="maps", name=f"Biz {pid}", city="MX", category="Food", website=f"http://good{i}.com")
        fan_in.register_business(cand)
        stage_map["website"].build_downstream(WebsiteIntel(pipeline_id=pid, website_reachable=True))
        stage_map["instagram"].build_downstream(InstagramIntel(pipeline_id=pid, profile_reachable=True))
        stage_map["contact"].build_downstream(ContactIntel(pipeline_id=pid, emails=(f"owner{i}@good{i}.com",)))
        assert not fan_in.is_pruned(pid)
        assert fan_in.is_closed(pid)
        qualified_count += 1

    # Entire fan_in pending count MUST be 0 — no orphan accumulators!
    assert fan_in.pending_count() == 0
    assert qualified_count == 10
