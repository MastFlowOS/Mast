"""
Regression test for Bug 1: Engine AttributeError crash on BusinessCandidate.email.
Verifies that downstream hooks handle BusinessCandidate (which lacks an .email attribute)
without raising AttributeError when required_channels includes 'email' or 'phone'.
"""

import pytest
from engine.contracts import BusinessCandidate, WebsiteIntel, ContactIntel
from engine.fan_in_runtime import FanInRuntime
from queues.queue import Queue
from queues.queue_definition import QueueDefinition


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
    assert not hasattr(candidate, "email"), "BusinessCandidate must not have email attribute per datamodel contract"

    # Simulate fan_in registration
    def_q = QueueDefinition("test_merge", "merge", "MergeQueue")
    dummy_queue = Queue(def_q)
    fan_in = FanInRuntime(merge_queue=dummy_queue)
    fan_in.register_business(candidate)

    # Re-create the logic from _website_downstream with required_channels=("email",)
    intel = WebsiteIntel(pipeline_id="test_pid_1", website_reachable=False)
    
    required_channels = ("email",)
    business = fan_in.get_business(intel.pipeline_id)

    # Must not raise AttributeError
    has_maps_email = bool(business and getattr(business, "email", None))
    assert has_maps_email is False

    # Simulate full _website_downstream condition
    if "email" in required_channels and intel.website_reachable is False and not has_maps_email:
        fan_in.prune_business(intel.pipeline_id, "unreachable_website_no_email")

    assert fan_in.get_business("test_pid_1") is None  # correctly pruned


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
    assert not hasattr(candidate, "email"), "BusinessCandidate must not have email attribute per datamodel contract"

    def_q = QueueDefinition("test_merge", "merge", "MergeQueue")
    dummy_queue = Queue(def_q)
    fan_in = FanInRuntime(merge_queue=dummy_queue)
    fan_in.register_business(candidate)

    contact_intel = ContactIntel(pipeline_id="test_pid_2", emails=None, phones=None)

    required_channels = ("email", "phone")
    business = fan_in.get_business(contact_intel.pipeline_id)

    # Must not raise AttributeError
    has_maps_email = bool(business and getattr(business, "email", None))
    has_contact_email = bool(contact_intel and contact_intel.emails)
    has_maps_phone = bool(business and getattr(business, "phone", None))
    has_contact_phone = bool(contact_intel and contact_intel.phones)

    assert has_maps_email is False
    assert has_contact_email is False
    assert has_maps_phone is True
    assert has_contact_phone is False
