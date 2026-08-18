"""
Regression tests — Instagram Discovery Fix (4-channel blocker).

Production analysis found that requests requiring
[website, email, phone, instagram] could never be satisfied:
BusinessCandidate.instagram_url was never populated by any provider,
InstagramWorker only inspects a profile that already has a URL, and
ContactIntel had no instagram_url field at all — so QualificationWorker's
"instagram" required-channel rule rejected every candidate, even ones
with a fully valid website/email/phone.

This file proves the fix end-to-end without any network access:

    1. ContactWorker discovers and canonicalizes a valid Instagram URL
       found on the scanned website HTML (the same anchor scan already
       used for WhatsApp/Telegram/LinkedIn), and it reaches
       ContactIntel.instagram_url.
    2. A candidate with valid website + email + phone + Instagram
       (Instagram supplied only via the ContactWorker-discovered
       ContactIntel.instagram_url — nothing on BusinessCandidate or
       InstagramIntel) now passes QualificationWorker's
       required_channels=("website", "email", "phone", "instagram")
       check.
    3. Fake/invalid Instagram links (reserved paths, numeric-only
       segments, no real handle) are never extracted by ContactWorker
       and never satisfy the "instagram" required channel.
    4. Existing non-Instagram channel behavior (email/phone dedup,
       WhatsApp/Telegram/LinkedIn extraction, website qualification)
       is unchanged by this fix.
"""

from __future__ import annotations

from typing import Optional, Tuple

import pytest

from engine.contracts import (
    BusinessCandidate,
    ContactIntel,
    EnrichedBusiness,
    InstagramIntel,
    WebsiteIntel,
)
from workers.contact_worker import ContactWorker
from workers.qualification_worker import QualificationWorker


# ---------------------------------------------------------------------------
# Test helpers
# ---------------------------------------------------------------------------


def _run_contact_worker(html: str, *, final_url: str = "https://bakery.com") -> ContactIntel:
    """
    Run ContactWorker.process() against a WebsiteIntel pointing at
    `final_url`, with the worker's own network fetch monkeypatched to
    return `html` directly — no real HTTP call is made.
    """
    worker = ContactWorker()

    def _fake_fetch(url: str) -> Tuple[str, str, float]:
        return html, url, 0.01

    worker._fetch = _fake_fetch  # type: ignore[method-assign]

    website_intel = WebsiteIntel(
        pipeline_id="p1",
        website_reachable=True,
        final_url=final_url,
    )
    return worker.process(website_intel)


def _make_enriched_business(
    *,
    website: str = "https://bakery.com",
    website_reachable: bool = True,
    phone_on_candidate: Optional[str] = None,
    contact_intel: Optional[ContactIntel] = None,
    instagram_intel: Optional[InstagramIntel] = None,
    business_instagram_url: Optional[str] = None,
) -> EnrichedBusiness:
    candidate = BusinessCandidate(
        pipeline_id="p1",
        session_id="s1",
        provider="google_maps",
        name="Test Bakery",
        website=website,
        phone=phone_on_candidate,
        instagram_url=business_instagram_url,
    )
    website_intel = WebsiteIntel(
        pipeline_id="p1",
        website_reachable=website_reachable,
        final_url=website if website_reachable else None,
    )
    return EnrichedBusiness(
        pipeline_id="p1",
        business=candidate,
        website_intel=website_intel,
        instagram_intel=instagram_intel,
        contact_intel=contact_intel,
    )


# ---------------------------------------------------------------------------
# 1. Instagram URLs discovered by ContactWorker are canonical and reach
#    ContactIntel.instagram_url.
# ---------------------------------------------------------------------------


class TestContactWorkerInstagramDiscovery:
    def test_valid_instagram_link_is_discovered_and_canonicalized(self):
        html = """
        <html><body>
          <footer>
            <a href="https://www.instagram.com/thebakery/">Follow us</a>
            <a href="https://wa.me/14165550199">WhatsApp</a>
          </footer>
        </body></html>
        """
        intel = _run_contact_worker(html)

        assert intel.instagram_url == "https://www.instagram.com/thebakery/"
        # Existing WhatsApp extraction is unaffected by this change.
        assert intel.whatsapp_link == "https://wa.me/14165550199"

    def test_bare_relative_instagram_link_is_normalized(self):
        # Some sites link with a trailing query string / no scheme
        # normalization applied by the site itself; ContactWorker's
        # reused extract_ig_urls() still canonicalizes it.
        html = '<a href="https://instagram.com/the_bakery?hl=en">IG</a>'
        intel = _run_contact_worker(html)
        assert intel.instagram_url == "https://www.instagram.com/the_bakery/"

    def test_first_instagram_link_wins_when_multiple_present(self):
        html = """
        <a href="https://instagram.com/first_handle">one</a>
        <a href="https://instagram.com/second_handle">two</a>
        """
        intel = _run_contact_worker(html)
        assert intel.instagram_url == "https://www.instagram.com/first_handle/"

    def test_no_instagram_link_present_leaves_field_none(self):
        html = "<html><body>No social links here.</body></html>"
        intel = _run_contact_worker(html)
        assert intel.instagram_url is None


# ---------------------------------------------------------------------------
# 2. Fake / invalid Instagram URLs are rejected, not counted.
# ---------------------------------------------------------------------------


class TestFakeInstagramUrlsRejected:
    @pytest.mark.parametrize(
        "href",
        [
            "https://instagram.com/p/CxYz123abc/",       # a post, not a profile
            "https://instagram.com/reel/CxYz123abc/",    # a reel, not a profile
            "https://instagram.com/explore/tags/bakery/",  # reserved path
            "https://instagram.com/accounts/login/",     # reserved path
            "https://instagram.com/12345/",               # numeric-only "handle"
        ],
    )
    def test_reserved_and_non_profile_paths_are_not_extracted(self, href):
        html = f'<a href="{href}">link</a>'
        intel = _run_contact_worker(html)
        assert intel.instagram_url is None

    def test_fake_instagram_url_does_not_satisfy_required_channel(self):
        # Even though something Instagram-shaped was on the page, it
        # resolves to no usable profile, so ContactIntel.instagram_url
        # stays None and the required "instagram" channel must still
        # be rejected downstream. Email/phone are supplied so the
        # earlier required-channel checks don't short-circuit before
        # reaching "instagram" (rules are evaluated in fixed order,
        # first match wins).
        html = """
        <a href="https://instagram.com/explore/">Explore</a>
        <a href="mailto:hello@bakery.com">Email us</a>
        <a href="tel:+14165550199">Call us</a>
        """
        contact_intel = _run_contact_worker(html)
        assert contact_intel.instagram_url is None

        lead = _make_enriched_business(contact_intel=contact_intel)
        worker = QualificationWorker(
            required_channels=("website", "email", "phone", "instagram")
        )
        result = worker.process(lead)
        assert result.qualified is False
        assert "missing required channel: instagram" in result.reasons


# ---------------------------------------------------------------------------
# 3. A candidate with valid website/email/phone/Instagram — Instagram
#    supplied only via ContactWorker discovery — passes Qualification.
#    This is the exact production blocker being fixed.
# ---------------------------------------------------------------------------


class TestFourChannelQualificationUnblocked:
    def test_website_email_phone_instagram_all_satisfied(self):
        html = """
        <a href="mailto:hello@bakery.com">Email us</a>
        <a href="tel:+14165550199">Call us</a>
        <a href="https://www.instagram.com/thebakery/">Instagram</a>
        """
        contact_intel = _run_contact_worker(html)
        assert contact_intel.emails == ("hello@bakery.com",)
        assert contact_intel.phones == ("+14165550199",)
        assert contact_intel.instagram_url == "https://www.instagram.com/thebakery/"

        lead = _make_enriched_business(
            website="https://bakery.com",
            website_reachable=True,
            contact_intel=contact_intel,
        )
        worker = QualificationWorker(
            required_channels=("website", "email", "phone", "instagram")
        )
        result = worker.process(lead)

        assert result.qualified is True
        assert result.reasons == ()

    def test_still_rejects_when_instagram_genuinely_absent(self):
        # Same website/email/phone, but no Instagram link anywhere —
        # the AND semantics across all four required channels must
        # still hold; this fix does not loosen that.
        html = """
        <a href="mailto:hello@bakery.com">Email us</a>
        <a href="tel:+14165550199">Call us</a>
        """
        contact_intel = _run_contact_worker(html)
        assert contact_intel.instagram_url is None

        lead = _make_enriched_business(
            website="https://bakery.com",
            website_reachable=True,
            contact_intel=contact_intel,
        )
        worker = QualificationWorker(
            required_channels=("website", "email", "phone", "instagram")
        )
        result = worker.process(lead)

        assert result.qualified is False
        assert "missing required channel: instagram" in result.reasons

    def test_business_instagram_url_still_takes_priority_when_present(self):
        # If a future provider ever does populate
        # BusinessCandidate.instagram_url directly, that authoritative
        # discovery-time fact should still satisfy the channel exactly
        # as it did before this fix — ContactWorker discovery is a
        # fallback, not a replacement.
        lead = _make_enriched_business(
            website="https://bakery.com",
            business_instagram_url="https://www.instagram.com/thebakery/",
            contact_intel=None,
        )
        worker = QualificationWorker(
            required_channels=("website", "email", "phone", "instagram")
        )
        # email/phone deliberately absent -> still rejected, but NOT
        # for "instagram", proving the business-level URL alone
        # satisfies that one channel.
        result = worker.process(lead)
        assert "missing required channel: instagram" not in result.reasons


# ---------------------------------------------------------------------------
# 4. Existing non-Instagram channel behavior is unchanged.
# ---------------------------------------------------------------------------


class TestExistingChannelsUnaffected:
    def test_email_phone_whatsapp_linkedin_extraction_unchanged(self):
        html = """
        <a href="mailto:info@bakery.com">Email</a>
        <a href="mailto:info@bakery.com">Duplicate email</a>
        <a href="tel:+14165550199">Call</a>
        <a href="https://wa.me/14165550199">WhatsApp</a>
        <a href="https://t.me/thebakery">Telegram</a>
        <a href="https://www.linkedin.com/company/thebakery">LinkedIn</a>
        """
        intel = _run_contact_worker(html)

        assert intel.emails == ("info@bakery.com",)  # deduped
        assert intel.phones == ("+14165550199",)
        assert intel.whatsapp_link == "https://wa.me/14165550199"
        assert intel.telegram_link == "https://t.me/thebakery"
        assert intel.linkedin_url == "https://www.linkedin.com/company/thebakery"
        # New field present and correctly None when absent.
        assert intel.instagram_url is None

    def test_website_only_qualification_unaffected(self):
        lead = _make_enriched_business(
            website="https://bakery.com", website_reachable=True
        )
        worker = QualificationWorker(required_channels=("website",))
        result = worker.process(lead)
        assert result.qualified is True

    def test_default_legacy_rules_unaffected_by_new_field(self):
        # No required_channels configured -> legacy rule set. A
        # candidate with a website and an email still qualifies
        # exactly as before; presence/absence of the new
        # instagram_url field must not change this path.
        contact_intel = ContactIntel(
            pipeline_id="p1", emails=("info@bakery.com",), instagram_url=None
        )
        lead = _make_enriched_business(
            website="https://bakery.com",
            website_reachable=True,
            contact_intel=contact_intel,
        )
        worker = QualificationWorker()
        result = worker.process(lead)
        assert result.qualified is True
