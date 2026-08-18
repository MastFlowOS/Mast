"""
Regression tests — Node/Python `instagram` channel schema mismatch.

PRODUCTION FINDING this fixes:
    Python Qualification (workers/qualification_worker.py) treats the
    "instagram" required channel as satisfied by ANY of three sources
    on an `EnrichedBusiness`:

        1. business.instagram_url        (BusinessCandidate)
        2. instagram_intel.profile_reachable is True  (InstagramWorker)
        3. contact_intel.instagram_url   (ContactWorker — see
           test_instagram_discovery_fix.py, the "4-channel blocker fix")

    `candidate_qualified` events in production confirmed Qualification
    was passing all 4 channels for 50 candidates, which then reached
    Storage successfully and were handed to Node — but Node's
    `channelFilter.ts` (`channelsSatisfied`) independently re-checks
    `lead.instagram` on the flat lead dict Storage streams back, and
    rejected every one of them with
    `channel_filter:["email","phone","instagram","website"]`.

    Root cause: `service._opportunity_to_lead_dict` (the function that
    builds that flat dict — the exact payload shape
    `src/scraperBridge/pythonBridge.ts` parses and casts `as EngineLead`
    with no field renaming) only ever read
    `instagram_intel.profile_url`, silently dropping sources 1 and 3.
    A candidate qualified via ContactWorker's site-discovered Instagram
    link (source 3 — the common case whenever the profile itself is
    private/rate-limited/unreachable) reached Node with an empty
    `instagram` field despite Qualification having already accepted it.

    The fix (`service._resolve_instagram_url`) makes the lead dict's
    `instagram` field agree with Qualification's own source priority —
    no channel semantics changed, only the schema mismatch closed.

This file proves the fix end-to-end using the ACTUAL
`QualifiedOpportunity` -> `_opportunity_to_lead_dict` conversion Storage
uses (not a hand-rolled dict), then feeds the resulting payload through
Node's `channelsSatisfied` via `tests/fixtures/*` — see
`src/lib/__tests__/channelFilter.instagramSchema.test.ts` for the Node
half of this same regression.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

import pytest

import service
from engine.contracts import (
    BusinessCandidate,
    ContactIntel,
    EnrichedBusiness,
    InstagramIntel,
    OpportunityScore,
    QualificationResult,
    QualifiedOpportunity,
    StoredOpportunity,
    WebsiteIntel,
)


def _build_opportunity(
    *,
    business_instagram_url: str | None = None,
    instagram_intel: InstagramIntel | None = None,
    contact_instagram_url: str | None = None,
    email: str | None = "hello@bakery.com",
    phone: str | None = "+14165550199",
    website: str | None = "https://bakery.com",
) -> tuple[QualifiedOpportunity, StoredOpportunity]:
    candidate = BusinessCandidate(
        pipeline_id="p1",
        session_id="s1",
        provider="google_maps",
        name="Test Bakery",
        website=website,
        phone=phone,
        instagram_url=business_instagram_url,
    )
    website_intel = WebsiteIntel(
        pipeline_id="p1", website_reachable=True, final_url=website
    )
    contact_intel = ContactIntel(
        pipeline_id="p1",
        emails=(email,) if email else (),
        phones=(phone,) if phone else (),
        instagram_url=contact_instagram_url,
    )
    enriched = EnrichedBusiness(
        pipeline_id="p1",
        business=candidate,
        website_intel=website_intel,
        instagram_intel=instagram_intel,
        contact_intel=contact_intel,
    )
    qualification = QualificationResult(pipeline_id="p1", qualified=True, reasons=())
    score = OpportunityScore(pipeline_id="p1", opportunity_score=80.0, tier="A")
    opportunity = QualifiedOpportunity(
        pipeline_id="p1",
        session_id="s1",
        business=enriched,
        qualification=qualification,
        score=score,
    )
    stored = StoredOpportunity(
        opportunity_id="opp_1",
        pipeline_id="p1",
        created_at=datetime.now(timezone.utc).isoformat(),
    )
    return opportunity, stored


class TestResolveInstagramUrlMirrorsQualificationPriority:
    def test_prefers_business_level_instagram_url(self):
        # Source 1 (business.instagram_url) wins even if the other two
        # are also present — same priority QualificationWorker uses.
        url = service._resolve_instagram_url(
            candidate=BusinessCandidate(
                pipeline_id="p1",
                session_id="s1",
                provider="google_maps",
                name="X",
                instagram_url="https://www.instagram.com/business_level/",
            ),
            instagram_intel=InstagramIntel(
                pipeline_id="p1",
                profile_reachable=True,
                profile_url="https://www.instagram.com/intel_level/",
            ),
            contact_intel=ContactIntel(
                pipeline_id="p1", instagram_url="https://www.instagram.com/contact_level/"
            ),
        )
        assert url == "https://www.instagram.com/business_level/"

    def test_falls_back_to_reachable_instagram_intel(self):
        url = service._resolve_instagram_url(
            candidate=BusinessCandidate(
                pipeline_id="p1", session_id="s1", provider="google_maps", name="X"
            ),
            instagram_intel=InstagramIntel(
                pipeline_id="p1",
                profile_reachable=True,
                profile_url="https://www.instagram.com/intel_level/",
            ),
            contact_intel=ContactIntel(
                pipeline_id="p1", instagram_url="https://www.instagram.com/contact_level/"
            ),
        )
        assert url == "https://www.instagram.com/intel_level/"

    def test_unreachable_instagram_intel_is_skipped_in_favor_of_contact_intel(self):
        # THE production case: InstagramWorker could not reach the
        # profile (private/blocked/rate-limited), but ContactWorker
        # found a valid Instagram link on the business's own website.
        # Qualification counts this as satisfied via source 3 — the
        # resolver must too.
        url = service._resolve_instagram_url(
            candidate=BusinessCandidate(
                pipeline_id="p1", session_id="s1", provider="google_maps", name="X"
            ),
            instagram_intel=InstagramIntel(
                pipeline_id="p1",
                profile_reachable=False,
                profile_url=None,
            ),
            contact_intel=ContactIntel(
                pipeline_id="p1", instagram_url="https://www.instagram.com/contact_level/"
            ),
        )
        assert url == "https://www.instagram.com/contact_level/"

    def test_no_source_present_returns_none(self):
        url = service._resolve_instagram_url(
            candidate=BusinessCandidate(
                pipeline_id="p1", session_id="s1", provider="google_maps", name="X"
            ),
            instagram_intel=None,
            contact_intel=ContactIntel(pipeline_id="p1", instagram_url=None),
        )
        assert url is None


class TestOpportunityToLeadDictInstagramField:
    def test_contact_worker_discovered_instagram_reaches_lead_dict(self):
        # Full end-to-end: EnrichedBusiness -> QualifiedOpportunity ->
        # _opportunity_to_lead_dict, with Instagram supplied ONLY via
        # ContactIntel.instagram_url (nothing on BusinessCandidate or
        # InstagramIntel) — exactly the production scenario the bug
        # report describes.
        opportunity, stored = _build_opportunity(
            business_instagram_url=None,
            instagram_intel=None,
            contact_instagram_url="https://www.instagram.com/thebakery/",
        )
        lead_dict = service._opportunity_to_lead_dict(opportunity, stored)

        assert lead_dict["instagram"] == "https://www.instagram.com/thebakery/"
        assert lead_dict["email"] == "hello@bakery.com"
        assert lead_dict["phone"] == "+14165550199"
        assert lead_dict["website"] == "https://bakery.com"

    def test_genuinely_missing_instagram_stays_empty_in_lead_dict(self):
        # No Instagram source anywhere -> lead_dict.instagram must stay
        # None/falsy. This fix must not manufacture an Instagram value
        # out of nothing.
        opportunity, stored = _build_opportunity(
            business_instagram_url=None,
            instagram_intel=None,
            contact_instagram_url=None,
        )
        lead_dict = service._opportunity_to_lead_dict(opportunity, stored)
        assert not lead_dict["instagram"]


class TestActualLeadPayloadFixtureForNode:
    """
    Writes the REAL dict `_opportunity_to_lead_dict` produces (the same
    shape serialized to stdout as JSONL and parsed verbatim by
    `pythonBridge.ts` as `EngineLead`) to a fixture file consumed by the
    Node/TS regression test
    (`src/lib/__tests__/channelFilter.instagramSchema.test.ts`), so the
    Node-side assertion runs against the actual Python engine's output
    shape rather than a hand-typed approximation of it.
    """

    def test_write_fixture_for_node_channel_filter_test(self):
        opportunity, stored = _build_opportunity(
            business_instagram_url=None,
            instagram_intel=None,
            contact_instagram_url="https://www.instagram.com/thebakery/",
        )
        lead_dict = service._opportunity_to_lead_dict(opportunity, stored)

        missing_ig_opportunity, missing_ig_stored = _build_opportunity(
            business_instagram_url=None,
            instagram_intel=None,
            contact_instagram_url=None,
        )
        missing_ig_lead_dict = service._opportunity_to_lead_dict(
            missing_ig_opportunity, missing_ig_stored
        )

        fixture_path = (
            Path(__file__).parent.parent.parent
            / "src"
            / "lib"
            / "__tests__"
            / "fixtures"
            / "pythonEngineLeadPayload.json"
        )
        fixture_path.parent.mkdir(parents=True, exist_ok=True)
        fixture_path.write_text(
            json.dumps(
                {
                    "qualifiedAllFourChannels": lead_dict,
                    "missingInstagram": missing_ig_lead_dict,
                },
                default=str,
                indent=2,
            )
            + "\n"
        )

        # Sanity check on the fixture we just wrote — the whole point of
        # this file is that this key is populated, not empty.
        assert lead_dict["instagram"]
        assert not missing_ig_lead_dict["instagram"]
