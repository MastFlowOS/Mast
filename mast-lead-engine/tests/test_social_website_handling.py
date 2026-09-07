"""
Unit tests for social / ordering platform URL handling in candidate.website:
- Detect Instagram/Facebook/social/order-platform URLs arriving in candidate.website.
- Do NOT pretend they are company websites: candidate.website is cleared.
- Preserve social info: If candidate.website is Instagram and candidate.instagram_url is unset,
  extract and normalize Instagram handle into candidate.instagram_url.
- When required_channels includes 'website', candidate with social/ordering website is pruned at discovery.
- When required_channels includes 'instagram', candidate with IG URL in website has IG preserved and is enqueued.
"""

from unittest.mock import MagicMock

from engine.contracts import BusinessCandidate
from engine.coordinator import EngineCoordinator
from engine.execution_driver import build_seven_stage_pipeline
from engine.interfaces import DiscoveryProviderInterface
from utils.parsing import is_ordering_platform, is_social_platform


class _MockDiscovery(DiscoveryProviderInterface):
    def __init__(self, candidates):
        self._candidates = candidates

    @property
    def provider_id(self) -> str:
        return "mock_discovery"

    @property
    def display_name(self) -> str:
        return "Mock Discovery"

    def discover(self, request):
        return iter(self._candidates)


class _MockStorage:
    def persist(self, opp):
        return opp


def test_social_and_ordering_platform_detection():
    """Verify is_social_platform and is_ordering_platform correctly identify respective domains."""
    assert is_social_platform("https://www.instagram.com/my_restaurant") is True
    assert is_social_platform("https://facebook.com/my_page") is True
    assert is_social_platform("https://twitter.com/biz") is True
    assert is_social_platform("https://linktr.ee/coolbiz") is True
    assert is_social_platform("https://normal-business.com") is False

    assert is_ordering_platform("https://www.ubereats.com/store/123") is True
    assert is_ordering_platform("https://doordash.com/store/abc") is True
    assert is_ordering_platform("https://normal-business.com") is False


def test_candidate_with_instagram_in_website_promotes_to_instagram_url():
    """When candidate.website has Instagram URL and candidate.instagram_url is None,

    _on_candidate promotes it to candidate.instagram_url and sets candidate.website = None.
    """
    coordinator = EngineCoordinator()
    ctx = coordinator.create_session(
        user_id="u1",
        provider="mock_discovery",
        requested_count=1,
    )
    session_id = ctx.session.id
    coordinator.start_session(session_id)

    raw_candidate = BusinessCandidate(
        pipeline_id="p1",
        session_id=session_id,
        provider="mock_discovery",
        name="Taco Place",
        website="https://www.instagram.com/tacoplace_official?igsh=123",
        instagram_url=None,
    )

    stages, queue_ids, fan_in, on_stage_outcome = build_seven_stage_pipeline(
        coordinator,
        session_id,
        discovery_provider=_MockDiscovery([raw_candidate]),
        discovery_request=type("Req", (), {"session_id": session_id})(),
        storage_backend=_MockStorage(),
        required_channels={"instagram"},
    )

    # Run discovery stage
    runtime = coordinator.get_engine_runtime(session_id)
    disc_stage = next(s for s in stages if s.name == "discovery")
    outcome = runtime.execute_stage(disc_stage)
    assert outcome.ran is True
    assert outcome.success is True

    # Candidate should NOT have been pruned because required channel 'instagram' is satisfied by promoted URL!
    q_mgr = coordinator.get_session(session_id).runtime.queue_manager
    ig_queue = q_mgr.get_queue(queue_ids.instagram_in)
    assert ig_queue.size() == 1

    queued_item = ig_queue.peek()
    assert queued_item is not None
    assert queued_item.payload.website is None
    assert queued_item.payload.instagram_url == "https://www.instagram.com/tacoplace_official/"


def test_candidate_with_social_website_is_pruned_when_website_channel_required():
    """When required_channels={'website'}, a candidate having only a social URL in candidate.website

    is pruned at discovery with missing website for website channel.
    """
    coordinator = EngineCoordinator()
    ctx = coordinator.create_session(
        user_id="u1",
        provider="mock_discovery",
        requested_count=1,
    )
    session_id = ctx.session.id
    coordinator.start_session(session_id)

    raw_candidate = BusinessCandidate(
        pipeline_id="p2",
        session_id=session_id,
        provider="mock_discovery",
        name="Burger Joint",
        website="https://www.facebook.com/burgerjoint",
        instagram_url=None,
    )

    stages, queue_ids, fan_in, on_stage_outcome = build_seven_stage_pipeline(
        coordinator,
        session_id,
        discovery_provider=_MockDiscovery([raw_candidate]),
        discovery_request=type("Req", (), {"session_id": session_id})(),
        storage_backend=_MockStorage(),
        required_channels={"website"},
    )

    runtime = coordinator.get_engine_runtime(session_id)
    disc_stage = next(s for s in stages if s.name == "discovery")
    outcome = runtime.execute_stage(disc_stage)
    assert outcome.ran is True

    # Website queue must be empty because candidate was pruned
    q_mgr = coordinator.get_session(session_id).runtime.queue_manager
    site_queue = q_mgr.get_queue(queue_ids.website_in)
    assert site_queue.size() == 0
