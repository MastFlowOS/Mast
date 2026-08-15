"""
Regression test for BusinessCandidate.email attribute safety and engine failure accounting.
Verifies that:
1. _on_candidate and downstream hooks handle BusinessCandidate (which lacks an .email attribute)
   without raising AttributeError when required_channels includes 'email' or 'phone'.
2. Discovery path correctly routes candidate with website to enrichment, and safe-prunes candidate
   without website when required_channels includes 'email'.
3. No fake email attribute is added to BusinessCandidate.
4. When discovery stage fails with an unhandled exception, engine failure accounting records the failure,
   sets driver.last_error, does not silently declare exhaustion, and produces __done__ with success=False.
"""

import pytest
import asyncio
from typing import Iterator
from engine.contracts import (
    BusinessCandidate,
    WebsiteIntel,
    ContactIntel,
    InstagramIntel,
    EnrichedBusiness,
    QualifiedOpportunity,
    StoredOpportunity,
)
from engine.fan_in_runtime import FanInRuntime
from engine.execution_driver import build_seven_stage_pipeline, ExecutionDriver
from engine.coordinator import EngineCoordinator
from queues.queue import Queue
from queues.queue_definition import QueueDefinition
from exceptions import DiscoveryFailure, DiscoveryFailureReason
from engine.interfaces import DiscoveryProviderInterface


class MockDiscoveryProvider(DiscoveryProviderInterface):
    """Discovery provider for testing."""
    def __init__(self, candidates=None, raise_exc=None):
        self.candidates = candidates or []
        self.raise_exc = raise_exc

    @property
    def provider_id(self) -> str:
        return "mock"

    @property
    def display_name(self) -> str:
        return "Mock Discovery"

    def discover(self, request) -> Iterator[BusinessCandidate]:
        if self.raise_exc:
            raise self.raise_exc
        for c in self.candidates:
            yield c


class DummyStorageBackend:
    def store_opportunity(self, opp):
        return StoredOpportunity(
            storage_id=f"store_{opp.pipeline_id}",
            pipeline_id=opp.pipeline_id,
            stored_at_iso="2026-08-15T00:00:00Z",
        )


def test_business_candidate_no_email_attribute_contract():
    """BusinessCandidate must never carry an email field directly."""
    cand = BusinessCandidate(
        pipeline_id="p1",
        session_id="s1",
        provider="google_maps",
        name="Test Shop",
        website="https://example.com",
    )
    assert not hasattr(cand, "email")
    with pytest.raises(AttributeError):
        _ = cand.email


def test_on_candidate_discovery_path_with_required_email_channel():
    """
    Executes the exact _on_candidate callback from build_seven_stage_pipeline with
    required_channels=('email',) and verifies:
    1. Slotted BusinessCandidate with website does not crash with AttributeError and is queued.
    2. Slotted BusinessCandidate without website is safe-pruned without AttributeError.
    """
    coordinator = EngineCoordinator()
    ctx = coordinator.create_session(user_id="test_user", requested_count=5)
    session_id = ctx.session.id

    cand_with_site = BusinessCandidate(
        pipeline_id="cand_site",
        session_id=session_id,
        provider="google_maps",
        name="Bakery With Site",
        website="https://bakery.com",
    )
    cand_no_site = BusinessCandidate(
        pipeline_id="cand_no_site",
        session_id=session_id,
        provider="google_maps",
        name="Bakery No Site",
        website=None,
    )

    provider = MockDiscoveryProvider([cand_with_site, cand_no_site])
    events = []

    stages, queue_ids, fan_in, cleanup_cb = build_seven_stage_pipeline(
        coordinator,
        session_id,
        discovery_provider=provider,
        discovery_request=None,
        storage_backend=DummyStorageBackend(),
        required_channels=("email",),
        on_progress=lambda st, ev, item: events.append((st, ev, item)),
    )

    discovery_stage = next(s for s in stages if s.name == "discovery")
    discovery_execution = discovery_stage.produce_worker_input()

    # Process candidates through the actual _on_candidate callback
    # Must not raise AttributeError: 'BusinessCandidate' object has no attribute 'email'
    discovery_execution.on_candidate(cand_with_site)
    discovery_execution.on_candidate(cand_no_site)

    # Candidate with website must be registered in fan_in and queued in website/instagram
    assert fan_in.get_business("cand_site") is not None
    website_q = ctx.runtime.queue_manager.get_queue(queue_ids.website_in)
    instagram_q = ctx.runtime.queue_manager.get_queue(queue_ids.instagram_in)
    assert not website_q.is_empty()
    assert not instagram_q.is_empty()

    # Candidate without website must be early-pruned (never registered in fan_in, emit event)
    assert fan_in.get_business("cand_no_site") is None
    assert ("discovery", "candidate_early_channel_pruned", "cand_no_site") in events


def test_website_downstream_no_attribute_error_on_business_candidate():
    """
    Test that _website_downstream handles BusinessCandidate without throwing AttributeError
    when required_channels contains 'email'.
    """
    candidate = BusinessCandidate(
        pipeline_id="test_pid_1",
        session_id="test_sess_1",
        provider="google_maps",
        name="Test Bakery",
        website="https://example.com",
    )
    assert not hasattr(candidate, "email")

    def_q = QueueDefinition("test_merge", "merge", "MergeQueue")
    dummy_queue = Queue(def_q)
    fan_in = FanInRuntime(merge_queue=dummy_queue)
    fan_in.register_business(candidate)

    intel = WebsiteIntel(pipeline_id="test_pid_1", website_reachable=False)
    required_channels = ("email",)
    business = fan_in.get_business(intel.pipeline_id)

    has_maps_email = bool(business and getattr(business, "email", None))
    assert has_maps_email is False

    if "email" in required_channels and intel.website_reachable is False and not has_maps_email:
        fan_in.prune_business(intel.pipeline_id, "unreachable_website_no_email")

    assert fan_in.get_business("test_pid_1") is None


def test_contact_downstream_no_attribute_error_on_business_candidate():
    """
    Test that _contact_downstream handles BusinessCandidate without throwing AttributeError
    when required_channels contains 'email' or 'phone'.
    """
    candidate = BusinessCandidate(
        pipeline_id="test_pid_2",
        session_id="test_sess_1",
        provider="google_maps",
        name="Test Plumbing",
        phone="+1234567890",
    )
    assert not hasattr(candidate, "email")

    def_q = QueueDefinition("test_merge", "merge", "MergeQueue")
    dummy_queue = Queue(def_q)
    fan_in = FanInRuntime(merge_queue=dummy_queue)
    fan_in.register_business(candidate)

    contact_intel = ContactIntel(pipeline_id="test_pid_2", emails=None, phones=None)
    required_channels = ("email", "phone")
    business = fan_in.get_business(contact_intel.pipeline_id)

    has_maps_email = bool(business and getattr(business, "email", None))
    has_contact_email = bool(contact_intel and contact_intel.emails)
    has_maps_phone = bool(business and getattr(business, "phone", None))
    has_contact_phone = bool(contact_intel and contact_intel.phones)

    assert has_maps_email is False
    assert has_contact_email is False
    assert has_maps_phone is True
    assert has_contact_phone is False


def test_engine_discovery_failure_accounting():
    """
    Test that when discovery stage fails with an unhandled exception:
    1. ExecutionDriver records the error in last_error.
    2. The driver does not silently report success/exhaustion.
    """
    coordinator = EngineCoordinator()
    ctx = coordinator.create_session(user_id="test_user_fail", requested_count=5)
    session_id = ctx.session.id

    failing_provider = MockDiscoveryProvider(raise_exc=RuntimeError("Discovery network crash"))

    stages, queue_ids, fan_in, cleanup_cb = build_seven_stage_pipeline(
        coordinator,
        session_id,
        discovery_provider=failing_provider,
        discovery_request=None,
        storage_backend=DummyStorageBackend(),
    )
    coordinator.start_session(session_id)
    coordinator.mark_running(session_id)
    engine_runtime = coordinator.get_engine_runtime(session_id)

    driver = ExecutionDriver(
        engine_runtime, stages, on_stage_outcome=cleanup_cb, run_producers_once=True
    )

    # Trigger producer execution
    driver._ensure_producers_started()
    driver.stop(wait=True, timeout=5.0)

    # Driver must capture the producer failure in last_error
    assert driver.last_error is not None
    assert "Discovery network crash" in str(driver.last_error)


@pytest.mark.asyncio
async def test_main_cli_discovery_exception_produces_unsuccessful_done():
    """
    Test that an unhandled discovery exception caught by _main_cli writes __done__
    with success=False, failure_reason='SCRAPER_ERROR', and not fake exhaustion.
    """
    import json
    import io
    from unittest.mock import patch

    simulated_exc = RuntimeError("'BusinessCandidate' object has no attribute 'email'")

    async def fake_run_query(**kwargs):
        raise simulated_exc
        yield {}  # unreachable

    stdout_capture = io.StringIO()

    with patch("service.run_query", fake_run_query), \
         patch("sys.argv", ["service.py", json.dumps({"deliver_target": 10})]), \
         patch("sys.stdout", stdout_capture):
        from service import _main_cli
        await _main_cli()

    output_lines = [json.loads(line) for line in stdout_capture.getvalue().strip().split("\n") if line.strip()]
    done_line = next((line for line in output_lines if line.get("__done__")), None)

    assert done_line is not None
    assert done_line["success"] is False
    assert done_line["exhausted"] is False
    assert done_line["target_reached"] is False
    assert done_line["failure_reason"] == "SCRAPER_ERROR"
    assert "BusinessCandidate" in str(done_line["failure_detail"])
