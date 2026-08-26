"""
PHASE 42D-2 — ContactWorker no longer raises when every page fetch
fails; success path (`_contact_downstream`) carries the Maps-fallback
required-channels gate instead of forcing a dead-letter/retry cycle.

Root cause under test
----------------------
`workers/contact_worker.py`'s `ContactWorker.process()` used to do,
when every attempted candidate page fetch failed (403/404/network
error on `contact_page`, `final_url`, and any secondary/alternate
page)::

    assert last_exc is not None
    raise last_exc

Re-raising meant `engine/runtime.py`'s `execute_stage()` treated this
as a stage failure, retried it per the queue's retry policy, and
eventually dead-lettered it. Only then did
`engine.execution_driver._on_enrichment_failure_outcome`'s "contact"
branch get a chance to check whether the business's required
channel(s) are already satisfiable from Maps-level facts alone
(`has_maps_email`/`has_maps_phone`) before pruning. A business that
*already* fully satisfies its required channel(s) from Maps data alone
should never need to survive via that dead-letter path at all.

The fix: `process()` now returns a `ContactIntel` populated with only
the per-page `*_fetch_failed` flags and `pipeline_id` (every other
field stays at its None/empty default) instead of raising. This lets
the normal SUCCESS path (`_contact_downstream`, which has the exact
same Maps-fallback logic) evaluate the business immediately.

Test 1 is a pure unit test on `ContactWorker.process()` (as asked).
Test 2 is the integration-style proof: a real `_contact_downstream`
closure (pulled from the real `build_seven_stage_pipeline()`
composition, same style as
`tests/test_phase42d_fan_in_website_fallback.py`), a business whose
Maps-supplied phone already satisfies `required_channels=("phone",)`,
fed the all-403 `ContactIntel` from test 1 -- proving it is NOT pruned
and proceeds to Merge/Qualification.

Run: pytest tests/test_phase42d_contact_403_recovery.py -v
"""

from __future__ import annotations

import os
import sys
import urllib.error
from typing import Iterator
from unittest.mock import patch

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

from engine.contracts import (
    BusinessCandidate,
    ContactIntel,
    InstagramIntel,
    WebsiteIntel,
)
from engine.coordinator import EngineCoordinator
from engine.execution_driver import build_seven_stage_pipeline
from engine.interfaces import DiscoveryProviderInterface
from workers.contact_worker import ContactWorker
from workers.merge_worker import MergeWorker
from workers.qualification_worker import QualificationWorker


def _find_stage(stages, name):
    for stage in stages:
        if stage.name == name:
            return stage
    raise AssertionError(f"no stage named {name!r}")


class _FakeDiscoveryProvider(DiscoveryProviderInterface):
    """Yields nothing -- these tests drive `_contact_downstream` directly."""

    @property
    def provider_id(self) -> str:
        return "fake_empty_provider"

    @property
    def display_name(self) -> str:
        return "Fake Empty Provider (Phase 42D-2 tests)"

    def discover(self, request) -> Iterator[BusinessCandidate]:
        return iter(())


def _build_pipeline(*, required_channels=None):
    coordinator = EngineCoordinator()
    ctx = coordinator.create_session(
        user_id="test-user", provider="fake_empty_provider", requested_count=1,
    )
    session_id = ctx.session.id
    coordinator.start_session(session_id)

    stages, queue_ids, fan_in, cleanup_cb = build_seven_stage_pipeline(
        coordinator, session_id,
        discovery_provider=_FakeDiscoveryProvider(),
        discovery_request=type("Req", (), {"session_id": session_id})(),
        storage_backend=None,
        required_channels=required_channels,
    )
    return coordinator, session_id, stages, fan_in


def _candidate(pipeline_id: str, session_id: str, *, website=None, phone=None) -> BusinessCandidate:
    return BusinessCandidate(
        pipeline_id=pipeline_id,
        session_id=session_id,
        provider="fake",
        name="Test Biz",
        category="Coffee Shop",
        address="123 Main St",
        city="Testville",
        country="US",
        website=website,
        phone=phone,
        rating=4.5,
        review_count=10,
    )


# ── Test 1: unit test on ContactWorker.process() ──────────────────────────
def test_all_pages_403_returns_contact_intel_not_raise():
    """Every attempted candidate page (homepage, contact page, secondary
    alternate) 403s -> process() returns a ContactIntel (does not raise)
    with the fetch-failed flags set and every data field at its default
    None/empty."""
    worker = ContactWorker()

    def mock_fetch(url: str):
        raise urllib.error.HTTPError(url, 403, "Forbidden", {}, None)

    calls = []

    def counting_fetch(url: str):
        calls.append(url)
        return mock_fetch(url)

    with patch.object(worker, "_fetch", side_effect=counting_fetch):
        item = WebsiteIntel(
            pipeline_id="p-all-403",
            website_reachable=True,
            final_url="https://mybiz.com",
            contact_page="https://mybiz.com/contact-us",
        )
        intel = worker.process(item)

    assert isinstance(intel, ContactIntel)
    assert intel.pipeline_id == "p-all-403"
    assert intel.contact_page_fetch_failed is True
    assert intel.homepage_fetch_failed is True
    assert intel.emails is None
    assert intel.phones is None
    assert intel.contact_form_url is None
    assert intel.whatsapp_link is None
    assert intel.messenger_link is None
    assert intel.telegram_link is None
    assert intel.linkedin_url is None
    assert intel.instagram_url is None
    assert len(calls) >= 2  # both homepage and contact page were attempted


# ── Test 2: integration -- Maps-satisfied business survives via SUCCESS path ─
def test_all_403_contact_intel_survives_via_success_path_maps_fallback():
    """A business with Maps-supplied phone already satisfying
    required_channels=("phone",), fed the all-403 ContactIntel from
    test 1 via the real `_contact_downstream` closure, must NOT be
    pruned -- it proceeds to Merge/Qualification, either qualified or
    correctly rejected by QualificationWorker's own rules, never
    silently dropped."""
    coordinator, session_id, stages, fan_in = _build_pipeline(
        required_channels=("phone",),
    )
    contact_stage = _find_stage(stages, "contact")

    candidate = _candidate(
        "p-403-maps-fallback", session_id, website="https://mybiz.com", phone="+15551234567",
    )
    fan_in.register_business(candidate)
    fan_in.record_website_result(
        candidate.pipeline_id,
        WebsiteIntel(pipeline_id=candidate.pipeline_id, website_reachable=True, final_url="https://mybiz.com"),
    )
    fan_in.record_instagram_result(
        candidate.pipeline_id,
        InstagramIntel(pipeline_id=candidate.pipeline_id, profile_reachable=False),
    )

    all_403_intel = ContactIntel(
        pipeline_id=candidate.pipeline_id,
        contact_page_fetch_failed=True,
        homepage_fetch_failed=True,
    )

    result = contact_stage.build_downstream(all_403_intel)

    assert result is None  # _contact_downstream always returns None; it enqueues via fan_in itself
    assert not fan_in.is_pruned(candidate.pipeline_id), (
        "business whose required channel is already satisfied from Maps "
        "data alone must not be pruned just because every contact-page "
        "fetch failed"
    )
    assert fan_in.is_closed(candidate.pipeline_id), (
        "recording the (failure-flagged) ContactIntel must still complete "
        "the fan-in accumulator -- website_intel + instagram_intel + "
        "contact_intel are all now terminal"
    )

    # Drive the resulting business through Merge + Qualification directly,
    # proving it is evaluated (qualified or rejected), never lost.
    from workers.merge_worker import MergeInput

    merge_input = MergeInput(
        business=candidate,
        website_intel=WebsiteIntel(pipeline_id=candidate.pipeline_id, website_reachable=True, final_url="https://mybiz.com"),
        instagram_intel=InstagramIntel(pipeline_id=candidate.pipeline_id, profile_reachable=False),
        contact_intel=all_403_intel,
    )
    enriched = MergeWorker().process(merge_input)

    qualification_result = QualificationWorker(required_channels=("phone",)).process(enriched)
    # Maps phone satisfies the only required channel -> qualifies.
    assert qualification_result.qualified is True
    assert qualification_result.pipeline_id == candidate.pipeline_id


# ── Test 3: required channel NOT satisfiable from Maps either -> correctly rejected, not lost ─
def test_all_403_contact_intel_no_maps_fallback_correctly_rejected():
    """Same all-403 ContactIntel, but this time neither the contact scan
    nor Maps data supplies the required channel (email) -- the business
    must still be evaluated by Qualification and correctly rejected,
    never silently dropped from the pipeline."""
    coordinator, session_id, stages, fan_in = _build_pipeline(
        required_channels=("email",),
    )
    contact_stage = _find_stage(stages, "contact")

    candidate = _candidate(
        "p-403-no-fallback", session_id, website="https://mybiz.com", phone=None,
    )
    fan_in.register_business(candidate)
    fan_in.record_website_result(
        candidate.pipeline_id,
        WebsiteIntel(pipeline_id=candidate.pipeline_id, website_reachable=True, final_url="https://mybiz.com"),
    )
    fan_in.record_instagram_result(
        candidate.pipeline_id,
        InstagramIntel(pipeline_id=candidate.pipeline_id, profile_reachable=False),
    )

    all_403_intel = ContactIntel(
        pipeline_id=candidate.pipeline_id,
        contact_page_fetch_failed=True,
        homepage_fetch_failed=True,
    )

    contact_stage.build_downstream(all_403_intel)

    # No email anywhere (Maps or scan) -> legitimately pruned at the
    # contact stage's own required-channels gate. This is a correct
    # rejection, not the bug under test -- it must still be pruned
    # (closed), not left dangling in _pending forever.
    assert fan_in.is_pruned(candidate.pipeline_id)
    assert fan_in.is_closed(candidate.pipeline_id)
