"""
Regression tests for placeholder email pruning and canonical email validation.

Verifies:
1. is_valid_email() mirrors Node leadValidation.ts isValidEmail() rules.
2. Candidates with placeholder/invalid emails ("787 coffee" patterns, user@domain.com,
   someone@example.com, etc.) are pruned at the Contact stage before Merge and never
   reach Qualification, Storage, or Node delivery on email-required requests.
"""

from __future__ import annotations

import pytest

from engine.contracts import (
    BusinessCandidate,
    ContactIntel,
    InstagramIntel,
    WebsiteIntel,
)
from engine.coordinator import EngineCoordinator
from engine.execution_driver import build_seven_stage_pipeline
from utils.parsing import is_valid_email, extract_emails, pick_best_email


# ──────────────────────────────────────────────────────────────────────────────
# 1. Unit Tests for is_valid_email()
# ──────────────────────────────────────────────────────────────────────────────

def test_is_valid_email_valid_addresses():
    assert is_valid_email("info@realcompany.com") is True
    assert is_valid_email("hello@coffeebeans.co.uk") is True
    assert is_valid_email("support@my-business.io") is True
    assert is_valid_email("john.doe@techfirm.org") is True
    assert is_valid_email("contact@shop787.com") is True


def test_is_valid_email_rejects_placeholders_and_synthetics():
    # Node leadValidation.ts PLACEHOLDER_EMAIL_LOCAL_PARTS
    assert is_valid_email("test@realcompany.com") is False
    assert is_valid_email("example@realcompany.com") is False
    assert is_valid_email("someone@realcompany.com") is False
    assert is_valid_email("user@realcompany.com") is False
    assert is_valid_email("youremail@realcompany.com") is False
    assert is_valid_email("your-email@realcompany.com") is False
    assert is_valid_email("name@realcompany.com") is False
    assert is_valid_email("firstname.lastname@realcompany.com") is False
    assert is_valid_email("email@realcompany.com") is False

    # Node leadValidation.ts PLACEHOLDER_EMAIL_DOMAINS
    assert is_valid_email("founder@example.com") is False
    assert is_valid_email("founder@example.org") is False
    assert is_valid_email("founder@test.com") is False
    assert is_valid_email("founder@domain.com") is False
    assert is_valid_email("founder@email.com") is False
    assert is_valid_email("founder@yourdomain.com") is False

    # System & automated prefixes
    assert is_valid_email("noreply@realcompany.com") is False
    assert is_valid_email("no-reply@realcompany.com") is False
    assert is_valid_email("sentry@realcompany.com") is False
    assert is_valid_email("mailer-daemon@realcompany.com") is False

    # Malformed / empty
    assert is_valid_email("") is False
    assert is_valid_email(None) is False
    assert is_valid_email("not-an-email") is False
    assert is_valid_email("@nodomain.com") is False
    assert is_valid_email("nolocal@") is False


def test_extract_emails_and_pick_best_email_filter_placeholders():
    html = """
    <div>
        <a href="mailto:someone@example.com">Placeholder 1</a>
        <a href="mailto:contact@787coffee.com">Real Contact</a>
        <span>user@domain.com</span>
        <span>hello@787coffee.com</span>
        <a href="mailto:noreply@787coffee.com">No reply</a>
    </div>
    """
    extracted = extract_emails(html)
    assert "contact@787coffee.com" in extracted
    assert "hello@787coffee.com" in extracted
    assert "someone@example.com" not in extracted
    assert "user@domain.com" not in extracted
    assert "noreply@787coffee.com" not in extracted

    best = pick_best_email(["someone@example.com", "user@domain.com", "contact@787coffee.com"])
    assert best == "contact@787coffee.com"


# ──────────────────────────────────────────────────────────────────────────────
# 2. Pipeline Integration: Placeholder email candidates pruned before Merge
# ──────────────────────────────────────────────────────────────────────────────

class DummyDiscoveryProvider:
    def discover(self, request, on_candidate):
        pass


class DummyStorageBackend:
    def __init__(self):
        self.persisted = []

    def persist(self, opportunity):
        self.persisted.append(opportunity)
        return opportunity


def test_placeholder_email_pruned_before_merge():
    coordinator = EngineCoordinator()
    ctx = coordinator.create_session(user_id="user-1", requested_count=5)
    sid = ctx.session.id
    coordinator.start_session(sid)

    backend = DummyStorageBackend()
    stages, queue_ids, fan_in, on_stage_outcome = build_seven_stage_pipeline(
        coordinator=coordinator,
        session_id=sid,
        discovery_provider=DummyDiscoveryProvider(),
        discovery_request=type("Req", (), {"session_id": sid})(),
        storage_backend=backend,
        required_channels=["email"],
    )
    stage_map = {s.name: s for s in stages}

    # 1. Candidate with only a placeholder email on Contact
    candidate_placeholder = BusinessCandidate(
        pipeline_id="pipe-placeholder-1",
        session_id=sid,
        provider="google_maps",
        name="787 Coffee (Placeholder Email)",
        website="https://placeholder-coffee.com",
    )
    # 2. Candidate with a valid email on Contact
    candidate_valid = BusinessCandidate(
        pipeline_id="pipe-valid-1",
        session_id=sid,
        provider="google_maps",
        name="787 Coffee (Valid Email)",
        website="https://valid-coffee.com",
    )

    fan_in.register_business(candidate_placeholder)
    fan_in.register_business(candidate_valid)

    # Provide Website Intel
    stage_map["website"].build_downstream(
        WebsiteIntel(pipeline_id="pipe-placeholder-1", website_reachable=True)
    )
    stage_map["website"].build_downstream(
        WebsiteIntel(pipeline_id="pipe-valid-1", website_reachable=True)
    )

    # Provide Instagram Intel
    stage_map["instagram"].build_downstream(
        InstagramIntel(pipeline_id="pipe-placeholder-1")
    )
    stage_map["instagram"].build_downstream(
        InstagramIntel(pipeline_id="pipe-valid-1")
    )

    # Provide Contact Intel: pipe-placeholder-1 has placeholder email, pipe-valid-1 has real email
    placeholder_contact = ContactIntel(
        pipeline_id="pipe-placeholder-1",
        emails=("someone@example.com", "user@domain.com"),
    )
    valid_contact = ContactIntel(
        pipeline_id="pipe-valid-1",
        emails=("info@787coffee.com",),
    )

    # Call contact downstream
    stage_map["contact"].build_downstream(placeholder_contact)
    stage_map["contact"].build_downstream(valid_contact)

    # Verify: pipe-placeholder-1 is pruned and never enqueued to Merge
    assert fan_in.is_pruned("pipe-placeholder-1") is True
    # Verify: pipe-valid-1 is NOT pruned and successfully merged/closed
    assert fan_in.is_pruned("pipe-valid-1") is False
    assert fan_in.is_closed("pipe-valid-1") is True
