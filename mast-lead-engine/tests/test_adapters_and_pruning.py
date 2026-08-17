"""
Unit tests for Engine 2.0 Adapters and Early Channel Pruning in Execution Driver.
"""

import pytest
from engine.adapters import to_domain_opportunity
from engine.contracts import (
    BusinessCandidate,
    ContactIntel,
    EnrichedBusiness,
    QualificationResult,
    QualifiedOpportunity,
    WebsiteIntel,
)
from engine.fan_in_runtime import FanInRuntime
from queues.queue import Queue
from queues.queue_definition import QueueDefinition


def test_fan_in_prune_business():
    """Verify prune_business removes candidate from pending and closes it without emitting MergeInput."""
    q_def = QueueDefinition(queue_id="q1", queue_name="merge_in")
    q = Queue(q_def)
    fan_in = FanInRuntime(merge_queue=q)

    candidate = BusinessCandidate(
        pipeline_id="p100",
        session_id="s100",
        provider="google_maps",
        name="Test Shop",
        address="123 Main",
        city="Austin",
        country="US",
        category="Retail",
    )
    fan_in.register_business(candidate)
    assert fan_in.pending_count() == 1
    assert not fan_in.is_closed("p100")

    fan_in.prune_business("p100", reason="missing_email")

    assert fan_in.pending_count() == 0
    assert fan_in.is_closed("p100")


def test_fan_in_prune_reason_counts():
    """
    Lead-Yield Waste Fix — observability step (item 6).

    get_prune_reason_counts() must count by canonical category, purely
    additively, without changing anything prune_business() already does
    (pending/closed/pruned state — see test_fan_in_prune_business above,
    unaffected by this).
    """
    q_def = QueueDefinition(queue_id="q1", queue_name="merge_in")
    q = Queue(q_def)
    fan_in = FanInRuntime(merge_queue=q)

    # No prunes yet — counts start empty, not pre-seeded with zeros.
    assert fan_in.get_prune_reason_counts() == {}

    fan_in.prune_business("p1", reason="missing_required_channel:email")
    fan_in.prune_business("p2", reason="missing_required_channel:email")
    fan_in.prune_business("p3", reason="missing_required_channel:phone")
    fan_in.prune_business("p4", reason="unreachable_website")
    fan_in.prune_business("p5", reason="unreachable_website_no_email")

    counts = fan_in.get_prune_reason_counts()
    assert counts == {
        "missing_email": 2,
        "missing_phone": 1,
        "unreachable_website": 2,
    }

    # Returned dict is a copy — mutating it must not affect internal state.
    counts["missing_email"] = 999
    assert fan_in.get_prune_reason_counts()["missing_email"] == 2


def test_adapter_refuses_fabricated_opportunity_type():
    """Verify to_domain_opportunity returns None when needed_services and reasons are empty (no fake value generated)."""
    candidate = BusinessCandidate(
        pipeline_id="p200",
        session_id="s200",
        provider="google_maps",
        name="Healthy Business",
        address="456 Elm",
        city="Dallas",
        country="US",
        category="Bakery",
    )
    enriched = EnrichedBusiness(
        pipeline_id="p200",
        business=candidate,
        website_intel=WebsiteIntel(pipeline_id="p200", website_reachable=True),
        contact_intel=ContactIntel(pipeline_id="p200", emails=("contact@bakery.com",)),
    )
    # Qualified but with 0 needed_services and 0 reasons
    qual_result = QualificationResult(
        pipeline_id="p200",
        qualified=True,
        niche="Bakery",
        reasons=(),
        business_problems=(),
        needed_services=(),
    )
    opportunity = QualifiedOpportunity(
        pipeline_id="p200",
        session_id="s200",
        business=enriched,
        qualification=qual_result,
        score=None,
    )

    domain_opp = to_domain_opportunity(opportunity)
    assert domain_opp is None  # Safely excluded rather than fabricating opportunity_type_id


def test_adapter_adapts_valid_opportunity():
    """Verify to_domain_opportunity correctly maps supporting_signal_ids when signals are present."""
    candidate = BusinessCandidate(
        pipeline_id="p201",
        session_id="s201",
        provider="google_maps",
        name="Unoptimized Business",
        address="789 Oak",
        city="Houston",
        country="US",
        category="Plumber",
    )
    enriched = EnrichedBusiness(
        pipeline_id="p201",
        business=candidate,
        website_intel=WebsiteIntel(pipeline_id="p201", website_reachable=True),
        contact_intel=ContactIntel(pipeline_id="p201", emails=("info@plumber.com",)),
    )
    qual_result = QualificationResult(
        pipeline_id="p201",
        qualified=True,
        niche="Plumber",
        reasons=("needs_seo",),
        business_problems=("no_meta_description",),
        needed_services=("seo_audit",),
    )
    opportunity = QualifiedOpportunity(
        pipeline_id="p201",
        session_id="s201",
        business=enriched,
        qualification=qual_result,
        score=None,
    )

    domain_opp = to_domain_opportunity(opportunity)
    assert domain_opp is not None
    assert domain_opp.opportunity_id == "p201"
    assert domain_opp.opportunity_type_id == "seo_audit"
    assert "seo_audit" in domain_opp.supporting_signal_ids
    assert "needs_seo" in domain_opp.supporting_signal_ids
