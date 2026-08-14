"""
Unit and Integration Tests for Dynamic Channel-Aware Pruning and Qualification.

Tests all supported channel combinations:
- ["email", "phone"]
- ["website", "instagram"]
- ["phone"]
- ["email"]
- ["website"]
- ["instagram"]
- ["email", "instagram"]
- ["phone", "website", "instagram"]
"""

import pytest
from engine.contracts import (
    BusinessCandidate,
    ContactIntel,
    EnrichedBusiness,
    InstagramIntel,
    WebsiteIntel,
)
from workers.qualification_worker import QualificationWorker


def make_enriched_business(
    *,
    phone: str = "",
    website: str = "",
    instagram_url: str = "",
    emails: tuple[str, ...] | None = None,
    phones: tuple[str, ...] | None = None,
    website_reachable: bool = True,
    profile_reachable: bool = True,
) -> EnrichedBusiness:
    candidate = BusinessCandidate(
        pipeline_id="p1",
        session_id="s1",
        provider="google_maps",
        name="Test Business",
        address="123 Main St",
        city="Toronto",
        country="CA",
        category="Bakery",
        phone=phone,
        website=website,
        instagram_url=instagram_url,
    )
    w_intel = (
        WebsiteIntel(
            pipeline_id="p1",
            website_reachable=website_reachable,
            final_url=website if website_reachable else None,
        )
        if website
        else None
    )
    c_intel = (
        ContactIntel(
            pipeline_id="p1",
            emails=emails,
            phones=phones,
        )
        if (emails or phones)
        else None
    )
    ig_intel = (
        InstagramIntel(
            pipeline_id="p1",
            profile_reachable=profile_reachable,
        )
        if instagram_url
        else None
    )

    return EnrichedBusiness(
        pipeline_id="p1",
        business=candidate,
        website_intel=w_intel,
        instagram_intel=ig_intel,
        contact_intel=c_intel,
    )


class TestDynamicChannelQualification:
    """Test QualificationWorker behavior for generic required_channels combinations."""

    def test_email_and_phone_qualification(self):
        worker = QualificationWorker(required_channels=("email", "phone"))

        # Candidate with phone on Maps and email on website contact page -> QUALIFIED
        lead1 = make_enriched_business(
            phone="+14165550199",
            website="https://bakery.com",
            emails=("info@bakery.com",),
        )
        res1 = worker.process(lead1)
        assert res1.qualified is True

        # Candidate with phone on Maps but NO email on contact page -> REJECTED
        lead2 = make_enriched_business(
            phone="+14165550199",
            website="https://bakery.com",
            emails=None,
        )
        res2 = worker.process(lead2)
        assert res2.qualified is False
        assert "missing required channel: email" in res2.reasons

    def test_website_and_instagram_qualification(self):
        worker = QualificationWorker(required_channels=("website", "instagram"))

        # Candidate with website and Instagram profile -> QUALIFIED
        lead1 = make_enriched_business(
            website="https://coffeebar.com",
            instagram_url="https://instagram.com/coffeebar",
            profile_reachable=True,
        )
        res1 = worker.process(lead1)
        assert res1.qualified is True

        # Candidate with website but NO Instagram profile -> REJECTED
        lead2 = make_enriched_business(
            website="https://coffeebar.com",
            instagram_url="",
        )
        res2 = worker.process(lead2)
        assert res2.qualified is False
        assert "missing required channel: instagram" in res2.reasons

    def test_phone_only_qualification(self):
        worker = QualificationWorker(required_channels=("phone",))

        # Candidate with phone on Maps but NO website -> QUALIFIED
        lead1 = make_enriched_business(phone="+14165550199", website="")
        res1 = worker.process(lead1)
        assert res1.qualified is True

        # Candidate with NO phone anywhere -> REJECTED
        lead2 = make_enriched_business(phone="", website="https://nophone.com")
        res2 = worker.process(lead2)
        assert res2.qualified is False
        assert "missing required channel: phone" in res2.reasons

    def test_email_only_qualification(self):
        worker = QualificationWorker(required_channels=("email",))

        # Candidate with website and email -> QUALIFIED
        lead1 = make_enriched_business(
            website="https://consulting.com", emails=("contact@consulting.com",)
        )
        res1 = worker.process(lead1)
        assert res1.qualified is True

        # Candidate with website but no email -> REJECTED
        lead2 = make_enriched_business(website="https://consulting.com", emails=None)
        res2 = worker.process(lead2)
        assert res2.qualified is False
        assert "missing required channel: email" in res2.reasons

    def test_website_only_qualification(self):
        worker = QualificationWorker(required_channels=("website",))

        # Candidate with reachable website -> QUALIFIED
        lead1 = make_enriched_business(website="https://site.com", website_reachable=True)
        res1 = worker.process(lead1)
        assert res1.qualified is True

        # Candidate with unreachable website -> REJECTED
        lead2 = make_enriched_business(
            website="https://site.com", website_reachable=False
        )
        res2 = worker.process(lead2)
        assert res2.qualified is False
        assert "missing required channel: website" in res2.reasons

    def test_instagram_only_qualification(self):
        worker = QualificationWorker(required_channels=("instagram",))

        # Candidate with reachable Instagram profile -> QUALIFIED
        lead1 = make_enriched_business(
            instagram_url="https://instagram.com/mybrand", profile_reachable=True
        )
        res1 = worker.process(lead1)
        assert res1.qualified is True

        # Candidate without Instagram -> REJECTED
        lead2 = make_enriched_business(instagram_url="")
        res2 = worker.process(lead2)
        assert res2.qualified is False
        assert "missing required channel: instagram" in res2.reasons

    def test_email_and_instagram_qualification(self):
        worker = QualificationWorker(required_channels=("email", "instagram"))

        # Both present -> QUALIFIED
        lead1 = make_enriched_business(
            website="https://shop.com",
            instagram_url="https://instagram.com/shop",
            emails=("hello@shop.com",),
        )
        res1 = worker.process(lead1)
        assert res1.qualified is True

        # Email missing -> REJECTED
        lead2 = make_enriched_business(
            website="https://shop.com",
            instagram_url="https://instagram.com/shop",
            emails=None,
        )
        res2 = worker.process(lead2)
        assert res2.qualified is False
        assert "missing required channel: email" in res2.reasons

    def test_phone_website_instagram_qualification(self):
        worker = QualificationWorker(
            required_channels=("phone", "website", "instagram")
        )

        # All 3 present -> QUALIFIED
        lead1 = make_enriched_business(
            phone="+14165550199",
            website="https://salon.com",
            instagram_url="https://instagram.com/salon",
        )
        res1 = worker.process(lead1)
        assert res1.qualified is True

        # Phone missing -> REJECTED
        lead2 = make_enriched_business(
            phone="",
            website="https://salon.com",
            instagram_url="https://instagram.com/salon",
        )
        res2 = worker.process(lead2)
        assert res2.qualified is False
        assert "missing required channel: phone" in res2.reasons
